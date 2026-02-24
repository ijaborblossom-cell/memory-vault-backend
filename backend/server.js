const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectDB } = require('./connectDB');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SECRET_KEY = String(process.env.JWT_SECRET || 'memory_vault_secret_key_2026').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || '').trim();
const ADMIN_OWNER_EMAIL = String(process.env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();
const PERSONAL_UNLOCK_TTL_MS = 15 * 60 * 1000;
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const MONGO_URI = String(process.env.MONGO_URI || '').trim();

const allowedOriginList = (process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set(allowedOriginList);

app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server calls and same-origin browser calls with no Origin header.
    if (!origin) {
      callback(null, true);
      return;
    }

    // If no allowlist is configured, keep permissive behavior for development.
    if (allowedOrigins.size === 0 || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'src')));

const dataFile = path.join(__dirname, 'users.json');
const knowledgeFile = path.join(__dirname, 'memory_vault_knowledge.json');
const adminDataFile = path.join(__dirname, 'admin_activities.json');
const personalUnlockSessions = new Map();
const authAttemptTracker = new Map();
const MAX_AUTH_ATTEMPTS = 6;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_BLOCK_MS = 15 * 60 * 1000;
let storageMode = 'json';
let pgPool = null;
let mongoReady = false;
let jsonWritable = true;
let storageInitLastError = '';
let MongoUser = null;
let MongoMemory = null;
let MongoAdminActivity = null;
let dataCache = { users: [], memories: {} };
let adminCache = { activities: [] };
let persistQueue = Promise.resolve();
let storageInitPromise = null;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUsername(username) {
  return /^[a-z0-9_]{3,20}$/.test(username);
}

function isStrongPassword(password) {
  if (password.length < 8 || password.length > 128) return false;
  return /[A-Za-z]/.test(password) && /\d/.test(password);
}

function getAuthKey(req, identifier) {
  const ip = getClientIp(req);
  return `${ip}:${String(identifier || '').toLowerCase()}`;
}

function authRateLimitStatus(req, identifier) {
  const key = getAuthKey(req, identifier);
  const now = Date.now();
  const rec = authAttemptTracker.get(key);
  if (!rec) return { blocked: false };
  if (rec.blockedUntil && now < rec.blockedUntil) {
    return { blocked: true, retryAfterMs: rec.blockedUntil - now };
  }
  if (now - rec.firstAttemptAt > AUTH_WINDOW_MS) {
    authAttemptTracker.delete(key);
    return { blocked: false };
  }
  return { blocked: false };
}

function recordAuthFailure(req, identifier) {
  const key = getAuthKey(req, identifier);
  const now = Date.now();
  const rec = authAttemptTracker.get(key);
  if (!rec || now - rec.firstAttemptAt > AUTH_WINDOW_MS) {
    authAttemptTracker.set(key, {
      firstAttemptAt: now,
      attempts: 1,
      blockedUntil: null
    });
    return;
  }
  rec.attempts += 1;
  if (rec.attempts >= MAX_AUTH_ATTEMPTS) {
    rec.blockedUntil = now + AUTH_BLOCK_MS;
  }
  authAttemptTracker.set(key, rec);
}

function clearAuthFailures(req, identifier) {
  authAttemptTracker.delete(getAuthKey(req, identifier));
}

if (!fs.existsSync(dataFile)) {
  try {
    fs.writeFileSync(dataFile, JSON.stringify({ users: [], memories: {} }, null, 2));
  } catch {
    jsonWritable = false;
  }
}

if (!fs.existsSync(adminDataFile)) {
  try {
    fs.writeFileSync(adminDataFile, JSON.stringify({ activities: [] }, null, 2));
  } catch {
    jsonWritable = false;
  }
}

try {
  fs.accessSync(dataFile, fs.constants.W_OK);
  fs.accessSync(adminDataFile, fs.constants.W_OK);
} catch {
  jsonWritable = false;
}

function readJsonData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {
    return { users: [], memories: {} };
  }
}

function readJsonAdminData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(adminDataFile, 'utf8'));
    if (!Array.isArray(parsed.activities)) {
      return { activities: [] };
    }
    return parsed;
  } catch {
    return { activities: [] };
  }
}

function normalizeData(data) {
  const safe = data && typeof data === 'object' ? data : { users: [], memories: {} };
  if (!Array.isArray(safe.users)) safe.users = [];
  if (!safe.memories || typeof safe.memories !== 'object') safe.memories = {};
  const seenUsernames = new Set();
  safe.users = safe.users.map((u, index) => {
    const email = normalizeEmail(u?.email);
    const fallbackUsername = normalizeUsername(u?.username || u?.name || (email.split('@')[0] || 'user'));
    const stableFallback = fallbackUsername || normalizeUsername(`user_${String(u?.id || '').slice(-6)}`) || 'user_default';
    let uniqueUsername = stableFallback;
    let attempt = 1;
    while (seenUsernames.has(uniqueUsername)) {
      uniqueUsername = `${stableFallback}_${attempt + index}`;
      attempt += 1;
    }
    seenUsernames.add(uniqueUsername);
    return {
      ...u,
      email,
      username: uniqueUsername,
      name: String(u?.name || u?.username || uniqueUsername || 'User').trim()
    };
  });
  return safe;
}

function normalizeAdminData(data) {
  const safe = data && typeof data === 'object' ? data : { activities: [] };
  if (!Array.isArray(safe.activities)) safe.activities = [];
  return safe;
}

function loadData() {
  return dataCache;
}

function loadAdminData() {
  return adminCache;
}

function enqueuePersist(task) {
  persistQueue = persistQueue
    .then(task)
    .catch((error) => {
      console.error('Storage persist error:', error.message);
    });
}

function ensureMongoModels() {
  if (MongoUser && MongoMemory && MongoAdminActivity) {
    return;
  }

  const userSchema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      email: { type: String, required: true, unique: true, index: true },
      username: { type: String, default: null, unique: true, index: true, sparse: true },
      password: { type: String, required: true },
      name: { type: String, default: '' },
      personalPinHash: { type: String, default: null },
      createdAt: { type: Date, default: Date.now }
    },
    { collection: 'users', versionKey: false }
  );

  const memorySchema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      user_email: { type: String, required: true, index: true },
      title: { type: String, default: '' },
      content: { type: String, default: '' },
      is_important: { type: Boolean, default: false },
      vault_type: { type: String, default: '' },
      timestamp: { type: Date, default: Date.now },
      isFavorite: { type: Boolean, default: false }
    },
    { collection: 'memories', versionKey: false }
  );

  const adminActivitySchema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      timestamp: { type: Date, default: Date.now, index: true },
      action: { type: String, default: '' },
      email: { type: String, default: null },
      userId: { type: String, default: null },
      method: { type: String, default: '' },
      path: { type: String, default: '' },
      ip: { type: String, default: '' },
      details: { type: mongoose.Schema.Types.Mixed, default: {} }
    },
    { collection: 'admin_activities', versionKey: false }
  );

  MongoUser = mongoose.models.MemoryVaultUser || mongoose.model('MemoryVaultUser', userSchema);
  MongoMemory = mongoose.models.MemoryVaultMemory || mongoose.model('MemoryVaultMemory', memorySchema);
  MongoAdminActivity = mongoose.models.MemoryVaultAdminActivity || mongoose.model('MemoryVaultAdminActivity', adminActivitySchema);
}

async function loadDataFromMongo() {
  const users = await MongoUser.find({}).sort({ createdAt: 1, id: 1 }).lean();
  const memoriesRows = await MongoMemory.find({}).sort({ timestamp: -1, id: -1 }).lean();
  const activitiesRows = await MongoAdminActivity.find({}).sort({ timestamp: -1, id: -1 }).limit(5000).lean();

  const memories = {};
  for (const row of memoriesRows) {
    const email = row.user_email;
    if (!memories[email]) memories[email] = [];
    memories[email].push({
      id: row.id,
      user_email: row.user_email,
      title: row.title,
      content: row.content,
      is_important: Boolean(row.is_important),
      vault_type: row.vault_type,
      timestamp: row.timestamp ? new Date(row.timestamp) : new Date(),
      isFavorite: Boolean(row.isFavorite)
    });
  }

  return {
    data: {
      users: users.map((row) => ({
        id: row.id,
        email: row.email,
        username: normalizeUsername(row.username || row.name || String(row.email || '').split('@')[0]),
        password: row.password,
        name: row.name || '',
        personalPinHash: row.personalPinHash || undefined,
        createdAt: row.createdAt ? new Date(row.createdAt) : new Date()
      })),
      memories
    },
    admin: {
      activities: activitiesRows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
        action: row.action,
        email: row.email,
        userId: row.userId,
        method: row.method,
        path: row.path,
        ip: row.ip,
        details: row.details || {}
      }))
    }
  };
}

async function persistDataToMongo() {
  const data = normalizeData(dataCache);
  for (const user of data.users) {
    const email = String(user.email || '');
    const username = normalizeUsername(user.username || user.name || email.split('@')[0] || 'user');
    await MongoUser.updateOne(
      { email },
      {
        $set: {
          id: String(user.id),
          email,
          username: String(username),
          password: String(user.password || ''),
          name: user.name || '',
          personalPinHash: user.personalPinHash || null,
          createdAt: user.createdAt ? new Date(user.createdAt) : new Date()
        }
      },
      { upsert: true }
    );
  }

  const memoryRows = Object.values(data.memories || {}).flat();
  for (const memory of memoryRows) {
    await MongoMemory.updateOne(
      { id: String(memory.id) },
      {
        $set: {
          id: String(memory.id),
          user_email: String(memory.user_email || ''),
          title: memory.title || '',
          content: memory.content || '',
          is_important: Boolean(memory.is_important),
          vault_type: memory.vault_type || '',
          timestamp: memory.timestamp ? new Date(memory.timestamp) : new Date(),
          isFavorite: Boolean(memory.isFavorite)
        }
      },
      { upsert: true }
    );
  }
}

async function persistAdminToMongo() {
  const adminData = normalizeAdminData(adminCache);
  const cappedActivities = adminData.activities.slice(-5000);
  for (const activity of cappedActivities) {
    await MongoAdminActivity.updateOne(
      { id: String(activity.id) },
      {
        $set: {
          id: String(activity.id),
          timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
          action: activity.action || '',
          email: activity.email || null,
          userId: activity.userId || null,
          method: activity.method || '',
          path: activity.path || '',
          ip: activity.ip || '',
          details: activity.details || {}
        }
      },
      { upsert: true }
    );
  }
}

async function createPgPool() {
  try {
    // Lazy import so local JSON mode works without pg installed.
    const { Pool } = require('pg');
    return new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
  } catch (error) {
    console.error('Postgres requested but "pg" package is missing. Falling back to JSON storage.');
    return null;
  }
}

async function ensurePgSchema() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      personal_pin_hash TEXT,
      created_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      title TEXT,
      content TEXT,
      is_important BOOLEAN DEFAULT FALSE,
      vault_type TEXT,
      timestamp TIMESTAMPTZ,
      is_favorite BOOLEAN DEFAULT FALSE
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS admin_activities (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ,
      action TEXT,
      email TEXT,
      user_id TEXT,
      method TEXT,
      path TEXT,
      ip TEXT,
      details JSONB
    );
  `);
}

async function loadDataFromPostgres() {
  const usersResult = await pgPool.query(`
    SELECT id, email, password, name, personal_pin_hash, created_at
    FROM users
    ORDER BY created_at ASC NULLS LAST, id ASC
  `);
  const memoriesResult = await pgPool.query(`
    SELECT id, user_email, title, content, is_important, vault_type, timestamp, is_favorite
    FROM memories
    ORDER BY timestamp DESC NULLS LAST, id DESC
  `);
  const activitiesResult = await pgPool.query(`
    SELECT id, timestamp, action, email, user_id, method, path, ip, details
    FROM admin_activities
    ORDER BY timestamp DESC NULLS LAST, id DESC
    LIMIT 5000
  `);

  const memories = {};
  for (const row of memoriesResult.rows) {
    const email = row.user_email;
    if (!memories[email]) memories[email] = [];
    memories[email].push({
      id: row.id,
      user_email: row.user_email,
      title: row.title,
      content: row.content,
      is_important: Boolean(row.is_important),
      vault_type: row.vault_type,
      timestamp: row.timestamp ? new Date(row.timestamp) : new Date(),
      isFavorite: Boolean(row.is_favorite)
    });
  }

  return {
    data: {
      users: usersResult.rows.map((row) => ({
        id: row.id,
        email: row.email,
        password: row.password,
        name: row.name,
        personalPinHash: row.personal_pin_hash || undefined,
        createdAt: row.created_at ? new Date(row.created_at) : new Date()
      })),
      memories
    },
    admin: {
      activities: activitiesResult.rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : new Date().toISOString(),
        action: row.action,
        email: row.email,
        userId: row.user_id,
        method: row.method,
        path: row.path,
        ip: row.ip,
        details: row.details || {}
      }))
    }
  };
}

async function persistDataToPostgres() {
  const data = normalizeData(dataCache);
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM memories');

    for (const user of data.users) {
      await client.query(
        `INSERT INTO users (id, email, password, name, personal_pin_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          String(user.id),
          String(user.email || ''),
          String(user.password || ''),
          user.name || '',
          user.personalPinHash || null,
          user.createdAt ? new Date(user.createdAt) : new Date()
        ]
      );
    }

    const memoryRows = Object.values(data.memories || {}).flat();
    for (const memory of memoryRows) {
      await client.query(
        `INSERT INTO memories (id, user_email, title, content, is_important, vault_type, timestamp, is_favorite)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          String(memory.id),
          String(memory.user_email || ''),
          memory.title || '',
          memory.content || '',
          Boolean(memory.is_important),
          memory.vault_type || '',
          memory.timestamp ? new Date(memory.timestamp) : new Date(),
          Boolean(memory.isFavorite)
        ]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function persistAdminToPostgres() {
  const adminData = normalizeAdminData(adminCache);
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM admin_activities');
    const cappedActivities = adminData.activities.slice(-5000);
    for (const activity of cappedActivities) {
      await client.query(
        `INSERT INTO admin_activities (id, timestamp, action, email, user_id, method, path, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          String(activity.id),
          activity.timestamp ? new Date(activity.timestamp) : new Date(),
          activity.action || '',
          activity.email || null,
          activity.userId || null,
          activity.method || '',
          activity.path || '',
          activity.ip || '',
          JSON.stringify(activity.details || {})
        ]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function saveData(data) {
  dataCache = normalizeData(data);
  if (storageMode === 'mongo' && mongoReady) {
    enqueuePersist(async () => {
      await persistDataToMongo();
    });
    return;
  }
  if (storageMode === 'postgres' && pgPool) {
    enqueuePersist(async () => {
      await persistDataToPostgres();
    });
    return;
  }
  if (jsonWritable) {
    fs.writeFileSync(dataFile, JSON.stringify(dataCache, null, 2));
  }
}

function saveAdminData(data) {
  adminCache = normalizeAdminData(data);
  if (storageMode === 'mongo' && mongoReady) {
    enqueuePersist(async () => {
      await persistAdminToMongo();
    });
    return;
  }
  if (storageMode === 'postgres' && pgPool) {
    enqueuePersist(async () => {
      await persistAdminToPostgres();
    });
    return;
  }
  if (jsonWritable) {
    fs.writeFileSync(adminDataFile, JSON.stringify(adminCache, null, 2));
  }
}

async function initializeStorage() {
  dataCache = normalizeData(readJsonData());
  adminCache = normalizeAdminData(readJsonAdminData());

  if (MONGO_URI) {
    try {
      await connectDB();
      ensureMongoModels();
      mongoReady = true;

      const loaded = await loadDataFromMongo();
      const dbHasUsers = Array.isArray(loaded.data.users) && loaded.data.users.length > 0;
      const dbHasMemories = Object.values(loaded.data.memories || {}).flat().length > 0;

      if (!dbHasUsers && !dbHasMemories && (dataCache.users.length > 0 || Object.keys(dataCache.memories || {}).length > 0)) {
        await persistDataToMongo();
      } else {
        dataCache = normalizeData(loaded.data);
      }

      if ((!loaded.admin.activities || loaded.admin.activities.length === 0) && adminCache.activities.length > 0) {
        await persistAdminToMongo();
      } else {
        adminCache = normalizeAdminData(loaded.admin);
      }

      storageMode = 'mongo';
      return;
    } catch (error) {
      console.error('Failed to initialize MongoDB storage, falling back to Postgres/JSON:', error.message);
      storageInitLastError = `mongo: ${error.message}`;
      mongoReady = false;
      dataCache = normalizeData(readJsonData());
      adminCache = normalizeAdminData(readJsonAdminData());
    }
  }

  if (!DATABASE_URL) {
    storageMode = 'json';
    return;
  }

  pgPool = await createPgPool();
  if (!pgPool) {
    storageMode = 'json';
    return;
  }

  try {
    await ensurePgSchema();
    const loaded = await loadDataFromPostgres();
    const dbHasUsers = Array.isArray(loaded.data.users) && loaded.data.users.length > 0;
    const dbHasMemories = Object.values(loaded.data.memories || {}).flat().length > 0;

    if (!dbHasUsers && !dbHasMemories && (dataCache.users.length > 0 || Object.keys(dataCache.memories || {}).length > 0)) {
      await persistDataToPostgres();
    } else {
      dataCache = normalizeData(loaded.data);
    }

    if ((!loaded.admin.activities || loaded.admin.activities.length === 0) && adminCache.activities.length > 0) {
      await persistAdminToPostgres();
    } else {
      adminCache = normalizeAdminData(loaded.admin);
    }

    storageMode = 'postgres';
  } catch (error) {
    console.error('Failed to initialize Postgres storage, falling back to JSON:', error.message);
    storageInitLastError = `postgres: ${error.message}`;
    storageMode = 'json';
    pgPool = null;
    dataCache = normalizeData(readJsonData());
    adminCache = normalizeAdminData(readJsonAdminData());
  }
}

function ensureStorageInitialized() {
  if (!storageInitPromise) {
    storageInitPromise = initializeStorage().catch((error) => {
      storageInitPromise = null;
      throw error;
    });
  }
  return storageInitPromise;
}

async function ensureMongoReadyForRequest() {
  if (!MONGO_URI) return false;
  if (storageMode === 'mongo' && mongoReady) return true;
  try {
    await connectDB();
    ensureMongoModels();
    mongoReady = true;
    storageMode = 'mongo';
    storageInitLastError = '';
    return true;
  } catch (error) {
    storageInitLastError = `mongo: ${error.message}`;
    return false;
  }
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function logActivity(req, action, details = {}) {
  const adminData = loadAdminData();
  const safeDetails = details && typeof details === 'object' ? details : {};
  const activity = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action,
    email: req.user?.email || null,
    userId: req.user?.id || null,
    method: req.method,
    path: req.path,
    ip: getClientIp(req),
    details: safeDetails
  };

  adminData.activities.push(activity);
  if (adminData.activities.length > 5000) {
    adminData.activities = adminData.activities.slice(-5000);
  }
  saveAdminData(adminData);
}

function verifyAdminAccess(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ success: false, message: 'Admin key is not configured' });
  }
  if (!ADMIN_OWNER_EMAIL) {
    return res.status(503).json({ success: false, message: 'Admin owner email is not configured' });
  }

  const requester = String(req.user?.email || '').toLowerCase();
  if (requester !== ADMIN_OWNER_EMAIL) {
    return res.status(403).json({ success: false, message: 'Admin access is restricted to the owner account' });
  }

  const provided = req.headers['x-admin-key'];
  if (provided !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid admin key' });
  }

  return next();
}

function generatePersonalUnlockToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getPersonalSession(email) {
  const session = personalUnlockSessions.get(email);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    personalUnlockSessions.delete(email);
    return null;
  }
  return session;
}

function isPersonalUnlocked(req) {
  const email = req.user?.email;
  if (!email) return false;
  const session = getPersonalSession(email);
  if (!session) return false;
  const headerToken = req.headers['x-personal-unlock-token'];
  if (!headerToken || typeof headerToken !== 'string') return false;
  const expected = Buffer.from(session.token);
  const provided = Buffer.from(headerToken);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function requirePersonalUnlock(req, res, next) {
  if (!isPersonalUnlocked(req)) {
    return res.status(403).json({ success: false, message: 'Personal vault is locked. Verify your PIN to continue.' });
  }
  return next();
}

function getDefaultKnowledgeBase() {
  return {
    version: '1.0.0',
    updatedAt: new Date().toISOString().slice(0, 10),
    entries: []
  };
}

function loadKnowledgeBase() {
  if (!fs.existsSync(knowledgeFile)) {
    const defaultKnowledge = getDefaultKnowledgeBase();
    fs.writeFileSync(knowledgeFile, JSON.stringify(defaultKnowledge, null, 2));
    return defaultKnowledge;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'));
    if (!Array.isArray(parsed.entries)) {
      return getDefaultKnowledgeBase();
    }
    return parsed;
  } catch {
    return getDefaultKnowledgeBase();
  }
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    const mongoReadyForRequest = await ensureMongoReadyForRequest();
    if (MONGO_URI && !mongoReadyForRequest) {
      return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please retry.' });
    }
    const rawEmail = req.body?.email;
    const rawPassword = req.body?.password;
    const rawName = req.body?.name;
    const rawUsername = req.body?.username;
    const email = normalizeEmail(rawEmail);
    const password = String(rawPassword || '');
    const username = normalizeUsername(rawUsername);
    const name = String(rawName || '').trim() || username;
    const data = loadData();

    if (!email || !password || !username) {
      return res.status(400).json({ success: false, message: 'Email, username, and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ success: false, message: 'Username must be 3-20 characters (letters, numbers, underscore)' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters and include letters and numbers' });
    }

    const usernameInUse = data.users.find((u) => normalizeUsername(u.username || u.name) === username);
    if (data.users.find((u) => normalizeEmail(u.email) === email)) {
      return res.status(400).json({ success: false, message: 'Email is already registered' });
    }
    if (usernameInUse) {
      return res.status(400).json({ success: false, message: 'Username is already taken' });
    }
    if (storageMode === 'mongo' && mongoReady && MongoUser) {
      const existingMongo = await MongoUser.findOne({
        $or: [{ email }, { username }]
      }).lean();
      if (existingMongo) {
        return res.status(400).json({
          success: false,
          message: normalizeEmail(existingMongo.email) === email
            ? 'Email is already registered'
            : 'Username is already taken'
        });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      email,
      username,
      password: hashedPassword,
      name,
      createdAt: new Date()
    };

    if (storageMode === 'mongo' && mongoReady && MongoUser) {
      await MongoUser.create({
        id: String(user.id),
        email: String(user.email),
        username: String(user.username),
        password: String(user.password),
        name: user.name || '',
        personalPinHash: null,
        createdAt: user.createdAt ? new Date(user.createdAt) : new Date()
      });
    }

    data.users.push(user);
    data.memories[email] = [];
    saveData(data);

    const token = jwt.sign({ email, id: user.id, username }, SECRET_KEY, { expiresIn: '7d' });

    logActivity(req, 'auth_signup', { createdUserEmail: email });
    return res.json({
      success: true,
      message: 'Signup successful',
      token,
      user: { email, username, name, id: user.id }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const mongoReadyForRequest = await ensureMongoReadyForRequest();
    if (MONGO_URI && !mongoReadyForRequest) {
      return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please retry.' });
    }
    const identifierRaw = String(req.body?.identifier || req.body?.email || req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!identifierRaw || !password) {
      return res.status(400).json({ success: false, message: 'Username/email and password are required' });
    }
    const identifier = identifierRaw.toLowerCase();
    const limiter = authRateLimitStatus(req, identifier);
    if (limiter.blocked) {
      return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again later.' });
    }
    const data = loadData();

    let user = null;
    if (storageMode === 'mongo' && mongoReady && MongoUser) {
      const mongoUser = await MongoUser.findOne({
        $or: [
          { email: normalizeEmail(identifier) },
          { username: normalizeUsername(identifier) }
        ]
      }).lean();
      if (mongoUser) {
        user = {
          id: mongoUser.id,
          email: mongoUser.email,
          username: mongoUser.username || '',
          password: mongoUser.password,
          name: mongoUser.name || '',
          personalPinHash: mongoUser.personalPinHash || undefined,
          createdAt: mongoUser.createdAt ? new Date(mongoUser.createdAt) : new Date()
        };
      }
    } else {
      user = data.users.find((u) => {
        const emailMatch = normalizeEmail(u.email) === normalizeEmail(identifier);
        const usernameMatch = normalizeUsername(u.username || u.name) === normalizeUsername(identifier);
        return emailMatch || usernameMatch;
      });
    }
    if (!user) {
      recordAuthFailure(req, identifier);
      return res.status(401).json({ success: false, message: 'Invalid username/email or password' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      recordAuthFailure(req, identifier);
      return res.status(401).json({ success: false, message: 'Invalid username/email or password' });
    }

    clearAuthFailures(req, identifier);
    const token = jwt.sign({ email: user.email, id: user.id, username: user.username || user.name || '' }, SECRET_KEY, { expiresIn: '7d' });

    logActivity(req, 'auth_signin');
    return res.json({
      success: true,
      message: 'Signin successful',
      token,
      user: { email: user.email, username: user.username || user.name || '', name: user.name, id: user.id }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/personal/pin/status', verifyToken, (req, res) => {
  try {
    const data = loadData();
    const user = data.users.find((u) => u.email === req.user.email);
    const session = getPersonalSession(req.user.email);

    return res.json({
      success: true,
      configured: Boolean(user?.personalPinHash),
      unlocked: Boolean(session),
      expiresAt: session?.expiresAt || null
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/personal/pin/setup', verifyToken, async (req, res) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'PIN must be 4 to 6 digits' });
    }

    const data = loadData();
    const user = data.users.find((u) => u.email === req.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.personalPinHash) {
      return res.status(400).json({ success: false, message: 'PIN already configured' });
    }

    user.personalPinHash = await bcrypt.hash(pin, 12);
    saveData(data);
    logActivity(req, 'personal_pin_setup');

    return res.json({ success: true, message: 'Personal vault PIN created' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/personal/pin/verify', verifyToken, async (req, res) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'PIN must be 4 to 6 digits' });
    }

    const data = loadData();
    const user = data.users.find((u) => u.email === req.user.email);
    if (!user?.personalPinHash) {
      return res.status(400).json({ success: false, message: 'Personal PIN is not configured' });
    }

    const ok = await bcrypt.compare(pin, user.personalPinHash);
    if (!ok) {
      logActivity(req, 'personal_pin_verify_failed');
      return res.status(401).json({ success: false, message: 'Invalid PIN' });
    }

    const token = generatePersonalUnlockToken();
    const expiresAt = Date.now() + PERSONAL_UNLOCK_TTL_MS;
    personalUnlockSessions.set(req.user.email, { token, expiresAt });
    logActivity(req, 'personal_pin_verified', { expiresAt });

    return res.json({
      success: true,
      unlockToken: token,
      expiresAt
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/personal/pin/reset', verifyToken, async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    const newPin = String(req.body?.newPin || '').trim();
    if (!/^\d{4,6}$/.test(newPin)) {
      return res.status(400).json({ success: false, message: 'New PIN must be 4 to 6 digits' });
    }

    const data = loadData();
    const user = data.users.find((u) => u.email === req.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logActivity(req, 'personal_pin_reset_failed');
      return res.status(401).json({ success: false, message: 'Invalid account password' });
    }

    user.personalPinHash = await bcrypt.hash(newPin, 12);
    saveData(data);

    const token = generatePersonalUnlockToken();
    const expiresAt = Date.now() + PERSONAL_UNLOCK_TTL_MS;
    personalUnlockSessions.set(req.user.email, { token, expiresAt });
    logActivity(req, 'personal_pin_reset', { expiresAt });

    return res.json({ success: true, message: 'Personal PIN reset successfully', unlockToken: token, expiresAt });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/personal/pin/lock', verifyToken, (req, res) => {
  personalUnlockSessions.delete(req.user.email);
  logActivity(req, 'personal_pin_lock');
  return res.json({ success: true, message: 'Personal vault locked' });
});

app.get('/api/admin/me', verifyToken, (req, res) => {
  const requester = String(req.user?.email || '').toLowerCase();
  return res.json({
    success: true,
    isAdmin: Boolean(ADMIN_API_KEY && ADMIN_OWNER_EMAIL && requester === ADMIN_OWNER_EMAIL),
    currentEmail: requester || null,
    ownerEmail: ADMIN_OWNER_EMAIL || null
  });
});

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

app.get('/api/memories', verifyToken, (req, res) => {
  try {
    const data = loadData();
    const allMemories = data.memories[req.user.email] || [];
    const includePersonal = isPersonalUnlocked(req);
    const memories = includePersonal ? allMemories : allMemories.filter((m) => m.vault_type !== 'personal');
    logActivity(req, 'memories_list', { total: memories.length, personalUnlocked: includePersonal });
    return res.json({ success: true, data: memories, personalLocked: !includePersonal });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/memories', verifyToken, (req, res) => {
  try {
    const { title, content, is_important, vault_type } = req.body;
    if (vault_type === 'personal' && !isPersonalUnlocked(req)) {
      return res.status(403).json({ success: false, message: 'Unlock personal vault with your PIN first' });
    }

    const data = loadData();

    if (!data.memories[req.user.email]) {
      data.memories[req.user.email] = [];
    }

    const memory = {
      id: Date.now().toString(),
      title,
      content,
      is_important,
      vault_type,
      timestamp: new Date(),
      user_email: req.user.email
    };

    data.memories[req.user.email].push(memory);
    saveData(data);
    logActivity(req, 'memory_create', { vault_type: memory.vault_type, is_important: Boolean(memory.is_important) });

    return res.json({ success: true, data: memory });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/api/memories/:id', verifyToken, (req, res) => {
  try {
    const data = loadData();
    const memories = data.memories[req.user.email] || [];
    const memory = memories.find((m) => m.id === req.params.id);

    if (!memory) {
      return res.status(404).json({ success: false, message: 'Memory not found' });
    }
    if (memory.vault_type === 'personal' && !isPersonalUnlocked(req)) {
      return res.status(403).json({ success: false, message: 'Unlock personal vault with your PIN first' });
    }

    const { isFavorite, title, content, is_important, vault_type } = req.body;
    if (typeof vault_type === 'string' && vault_type === 'personal' && !isPersonalUnlocked(req)) {
      return res.status(403).json({ success: false, message: 'Unlock personal vault with your PIN first' });
    }
    if (typeof isFavorite === 'boolean') memory.isFavorite = isFavorite;
    if (typeof title === 'string') memory.title = title;
    if (typeof content === 'string') memory.content = content;
    if (typeof is_important === 'boolean') memory.is_important = is_important;
    if (typeof vault_type === 'string') memory.vault_type = vault_type;

    saveData(data);
    logActivity(req, 'memory_update', { id: memory.id, vault_type: memory.vault_type });
    return res.json({ success: true, data: memory });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/memories/:id', verifyToken, (req, res) => {
  try {
    const data = loadData();
    const memories = data.memories[req.user.email] || [];
    const index = memories.findIndex((m) => m.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Memory not found' });
    }
    if (memories[index]?.vault_type === 'personal' && !isPersonalUnlocked(req)) {
      return res.status(403).json({ success: false, message: 'Unlock personal vault with your PIN first' });
    }

    const removed = memories[index];
    memories.splice(index, 1);
    saveData(data);
    logActivity(req, 'memory_delete', { id: removed?.id, vault_type: removed?.vault_type });

    return res.json({ success: true, message: 'Memory deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how',
    'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'that',
    'the', 'to', 'was', 'were', 'what', 'when', 'where', 'who', 'why', 'with', 'you'
  ]);

  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

const knowledgeBase = loadKnowledgeBase();
const MEMORY_VAULT_KEYWORDS = new Set([
  'memory', 'memories', 'vault', 'vaults', 'entry', 'entries', 'diary', 'pin',
  'personal', 'learning', 'cultural', 'future', 'wisdom', 'knowledge',
  'favorite', 'favorites', 'search', 'filter', 'export', 'csv', 'txt',
  'signin', 'signup', 'login', 'logout', 'auth', 'token', 'jwt',
  'openai', 'assistant', 'chat', 'backend', 'frontend', 'api',
  'users', 'account', 'health', 'sync', 'offline', 'retry', 'connection',
  'memory vault'
]);

function getKnowledgeScore(entry, queryTokens, lowerMessage) {
  const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
  const combined = normalizeText([
    entry.topic || '',
    entry.answer || '',
    keywords.join(' ')
  ].join(' '));

  let score = 0;
  for (const token of queryTokens) {
    if (combined.includes(token)) score += 2;
  }

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (normalizedKeyword && lowerMessage.includes(normalizedKeyword)) score += 4;
  }

  return score;
}

function getRelevantKnowledgeEntries(message, limit = 4, includeDefaults = true) {
  const entries = Array.isArray(knowledgeBase.entries) ? knowledgeBase.entries : [];
  const queryTokens = tokenize(message);
  const lowerMessage = normalizeText(message);

  if (!entries.length) return [];

  const ranked = entries
    .map((entry) => ({
      entry,
      score: getKnowledgeScore(entry, queryTokens, lowerMessage)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);

  if (ranked.length > 0) return ranked;
  if (includeDefaults) return entries.slice(0, Math.min(limit, 2));
  return [];
}

function isMemoryVaultRelatedQuestion(message) {
  const normalized = normalizeText(message);
  if (!normalized) return false;

  if (normalized.includes('memory vault')) return true;

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.some((token) => MEMORY_VAULT_KEYWORDS.has(token))) return true;
  return false;
}

function getOutOfScopeResponse() {
  return 'I can only answer Memory Vault-related questions. Ask about your memories, vaults, account, AI assistant, or Memory Vault features.';
}

function getMemoryScore(memory, queryTokens) {
  const title = normalizeText(memory.title);
  const content = normalizeText(memory.content);
  const vault = normalizeText(memory.vault_type);
  let score = 0;

  for (const token of queryTokens) {
    if (title.includes(token)) score += 8;
    if (vault.includes(token)) score += 6;
    if (content.includes(token)) score += 3;
  }

  if (memory.is_important) score += 2;

  const timestamp = new Date(memory.timestamp).getTime();
  if (!Number.isNaN(timestamp)) {
    const daysOld = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
    score += Math.max(0, 2 - daysOld / 30);
  }

  return score;
}

function getRelevantMemories(message, userMemories, limit = 8) {
  const queryTokens = tokenize(message);
  if (queryTokens.length === 0) {
    return [...userMemories]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  return userMemories
    .map((memory) => ({ memory, score: getMemoryScore(memory, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);
}

function buildMemoryContextForAI(message, userMemories) {
  const recentMemories = [...userMemories]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 5);
  const relevantMemories = getRelevantMemories(message, userMemories, 8);

  const counts = {
    total: userMemories.length,
    learning: userMemories.filter((m) => m.vault_type === 'learning').length,
    cultural: userMemories.filter((m) => m.vault_type === 'cultural').length,
    future: userMemories.filter((m) => m.vault_type === 'future').length,
    personal: userMemories.filter((m) => m.vault_type === 'personal').length,
    important: userMemories.filter((m) => m.is_important).length
  };

  const relevantSection = relevantMemories.length
    ? relevantMemories
      .map((m, idx) => `${idx + 1}. [${m.vault_type}] ${m.title}\n${String(m.content || '').slice(0, 500)}`)
      .join('\n\n')
    : 'No strongly relevant memory found for this question.';

  const recentSection = recentMemories.length
    ? recentMemories.map((m, idx) => `${idx + 1}. [${m.vault_type}] ${m.title}`).join('\n')
    : 'No memories yet.';

  return {
    relevantMemories,
    contextText: [
      'Memory Vault summary',
      `- Total memories: ${counts.total}`,
      `- Learning: ${counts.learning}`,
      `- Cultural: ${counts.cultural}`,
      `- Future: ${counts.future}`,
      `- Personal: ${counts.personal}`,
      `- Important: ${counts.important}`,
      '',
      'Most relevant memories for this question:',
      relevantSection,
      '',
      'Most recent memory titles:',
      recentSection
    ].join('\n')
  };
}

function buildKnowledgeContextForAI(message) {
  const relevantKnowledge = getRelevantKnowledgeEntries(message, 4);
  const section = relevantKnowledge.length
    ? relevantKnowledge
      .map((entry, idx) => `${idx + 1}. ${entry.topic}\n${entry.answer}`)
      .join('\n\n')
    : 'No Memory Vault knowledge entry matched this question.';

  return {
    relevantKnowledge,
    contextText: [
      'Verified Memory Vault knowledge:',
      section
    ].join('\n')
  };
}

function generateFallbackResponse(message, userMemories, userName, relevantMemories = [], relevantKnowledge = []) {
  const lowerMessage = String(message || '').toLowerCase();
  const learningCount = userMemories.filter((m) => m.vault_type === 'learning').length;
  const culturalCount = userMemories.filter((m) => m.vault_type === 'cultural').length;
  const personalCount = userMemories.filter((m) => m.vault_type === 'personal').length;
  const futureCount = userMemories.filter((m) => m.vault_type === 'future').length;
  const totalCount = userMemories.length;
  const recentMemories = userMemories.slice(0, 3).map((m) => m.title);
  const relevantTitles = relevantMemories.slice(0, 3).map((m) => m.title);
  const topKnowledge = relevantKnowledge[0];
  const userDataIntent = (
    lowerMessage.includes('my ') ||
    lowerMessage.includes(' i ') ||
    lowerMessage.startsWith('i ') ||
    lowerMessage.includes('how many') ||
    lowerMessage.includes('recent') ||
    lowerMessage.includes('saved') ||
    lowerMessage.includes('find') ||
    lowerMessage.includes('show')
  );
  const onboardingIntent = (
    lowerMessage.includes('new user') ||
    lowerMessage.includes('first time') ||
    lowerMessage.includes('getting started') ||
    lowerMessage.includes('get started') ||
    lowerMessage.includes('how to start') ||
    lowerMessage.includes('how do i start') ||
    lowerMessage.includes('how to use') ||
    lowerMessage.includes('how do i use') ||
    lowerMessage.includes('use memory vault')
  );

  if (totalCount === 0 && onboardingIntent) {
    return [
      'Welcome to Memory Vault. Quick start:',
      '1) Sign in and pick a vault (personal, learning, cultural, or future).',
      '2) Add your first memory with a clear title and meaningful content.',
      '3) Mark important memories so they are easier to revisit.',
      '4) Open AI Assistant and ask: "summarize my memories" or "help me organize entries".'
    ].join(' ');
  }

  if (topKnowledge?.answer && !userDataIntent) {
    return topKnowledge.answer;
  }

  if (
    lowerMessage.includes('what is memory vault') ||
    (lowerMessage.includes('what is') && lowerMessage.includes('memory vault'))
  ) {
    return 'Memory Vault is your personal knowledge and reflection app. It helps you save life notes, learning insights, cultural stories, and future goals in one place, then lets AI help you explore them.';
  }

  if (
    lowerMessage.includes('how to use') ||
    lowerMessage.includes('how do i use') ||
    lowerMessage.includes('use memory vault')
  ) {
    return 'Use Memory Vault in 3 steps: sign in, choose a vault type (personal, learning, cultural, or future), and add entries with title and content. Then open AI Assistant to ask for summaries, trends, or specific memory lookups.';
  }

  if (
    lowerMessage.includes('how to write memories') ||
    lowerMessage.includes('how do i write memories') ||
    (lowerMessage.includes('write') && lowerMessage.includes('memory'))
  ) {
    return 'To write a strong memory: give it a clear title, describe what happened, include what you learned or felt, and mark it important if needed. Keep one memory per entry so AI can find and summarize it accurately.';
  }

  if (lowerMessage.includes('name') || lowerMessage.includes('who are you')) {
    return `I am your Memory Vault assistant. Your profile name is ${userName}. I can help with your ${totalCount} stored memories across all vaults.`;
  }

  if (lowerMessage.includes('how many') && lowerMessage.includes('memory')) {
    return `You have ${totalCount} memories: ${learningCount} learning, ${culturalCount} cultural, ${personalCount} personal, and ${futureCount} future.`;
  }

  if (lowerMessage.includes('recent') || lowerMessage.includes('saved')) {
    const recentList = recentMemories.length > 0 ? recentMemories.join(', ') : 'none yet';
    return `Your recent memories are: ${recentList}.`;
  }

  if ((lowerMessage.includes('about') || lowerMessage.includes('find') || lowerMessage.includes('show')) && relevantTitles.length > 0) {
    return `I found related memories: ${relevantTitles.join(', ')}. Ask a follow-up and I can summarize them.`;
  }

  return 'I can answer general Memory Vault questions, help you write better entries, and assist with memory search and summaries. Ask me what you want to do next.';
}

async function askOpenAI(message, userName, memoryContextText, knowledgeContextText) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You are the Memory Vault assistant.',
                'Answer Memory Vault product questions using the provided verified knowledge section.',
                'Answer user-specific questions using the provided memory context.',
                'If a question is not related to Memory Vault, politely refuse and ask for a Memory Vault question.',
                'If the user appears new or has zero memories, provide a short getting-started guide.',
                'If data is missing, state that clearly and avoid guessing.',
                'Be concise, accurate, and practical.',
                `The user name is: ${userName}.`,
                'Keep responses under 140 words unless the user asks for detail.'
              ].join(' ')
            }
          ]
        },
        {
          role: 'system',
          content: [{ type: 'input_text', text: `Memory context:\n${memoryContextText}` }]
        },
        {
          role: 'system',
          content: [{ type: 'input_text', text: `${knowledgeContextText}` }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: String(message || '') }]
        }
      ],
      max_output_tokens: 240
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const messageText = payload?.error?.message || `OpenAI HTTP ${response.status}`;
    throw new Error(messageText);
  }

  const outputText = payload?.output_text?.trim();
  if (!outputText) {
    throw new Error('OpenAI returned an empty response');
  }

  return outputText;
}

app.post('/api/ai/chat', verifyToken, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    if (!isMemoryVaultRelatedQuestion(message)) {
      return res.json({
        success: true,
        response: getOutOfScopeResponse(),
        source: 'policy',
        policy: 'memory-vault-only'
      });
    }

    const data = loadData();
    const userMemories = data.memories[req.user.email] || [];
    const user = data.users.find((u) => u.email === req.user.email);
    const userName = user?.name || 'Friend';
    const { relevantMemories, contextText } = buildMemoryContextForAI(message, userMemories);
    const { relevantKnowledge, contextText: knowledgeContextText } = buildKnowledgeContextForAI(message);

    try {
      const aiMessage = await askOpenAI(message, userName, contextText, knowledgeContextText);
      logActivity(req, 'ai_chat', { source: 'openai' });
      return res.json({
        success: true,
        response: aiMessage,
        source: 'openai',
        model: OPENAI_MODEL
      });
    } catch (openaiError) {
      const fallbackResponse = generateFallbackResponse(
        message,
        userMemories,
        userName,
        relevantMemories,
        relevantKnowledge
      );
      return res.json({
        success: true,
        response: fallbackResponse,
        source: 'fallback',
        note: `Using local AI (${openaiError.message})`,
        knowledge_hits: relevantKnowledge.length
      });
    }
  } catch (error) {
    const data = loadData();
    const userMemories = data.memories[req.user.email] || [];
    const user = data.users.find((u) => u.email === req.user.email);
    const userName = user?.name || 'Friend';
    const relevantMemories = getRelevantMemories(req.body?.message || '', userMemories, 8);
    const { relevantKnowledge } = buildKnowledgeContextForAI(req.body?.message || '');
    const fallbackResponse = generateFallbackResponse(
      req.body?.message || '',
      userMemories,
      userName,
      relevantMemories,
      relevantKnowledge
    );

    return res.json({
      success: true,
      response: fallbackResponse,
      source: 'fallback',
      note: `Using local AI (${error.message})`,
      knowledge_hits: relevantKnowledge.length
    });
  }
});

app.get('/api/admin/activities', verifyToken, verifyAdminAccess, (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 100));
  const data = loadAdminData();
  const activities = [...data.activities].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
  logActivity(req, 'admin_activities_view', { limit });
  return res.json({ success: true, count: activities.length, data: activities });
});

app.get('/api/admin/stats', verifyToken, verifyAdminAccess, (req, res) => {
  const data = loadAdminData();
  const activities = data.activities || [];
  const byAction = activities.reduce((acc, item) => {
    const key = item.action || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return res.json({
    success: true,
    totalActivities: activities.length,
    byAction,
    latest: activities.length ? activities[activities.length - 1].timestamp : null
  });
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Server is running' });
});

app.get('/api/debug/config', (req, res) => {
  const hasApiKey = !!process.env.OPENAI_API_KEY;

  res.json({
    success: true,
    server: 'Running',
    environment: String(process.env.NODE_ENV || 'development').trim(),
    openai: {
      configured: hasApiKey,
      model: OPENAI_MODEL
    },
    knowledge: {
      file: path.basename(knowledgeFile),
      entries: Array.isArray(knowledgeBase.entries) ? knowledgeBase.entries.length : 0,
      updatedAt: knowledgeBase.updatedAt || 'unknown'
    },
    endpoints: {
      health: '/api/health',
      auth: ['/api/auth/signup', '/api/auth/signin'],
      memories: '/api/memories',
      ai: '/api/ai/chat',
      personal: ['/api/personal/pin/status', '/api/personal/pin/setup', '/api/personal/pin/verify'],
      admin: ['/api/admin/activities', '/api/admin/stats']
    },
    admin: {
      configured: Boolean(ADMIN_API_KEY),
      ownerConfigured: Boolean(ADMIN_OWNER_EMAIL),
      storageMode,
      storageFile: path.basename(adminDataFile)
    },
    database: {
      mongoConfigured: Boolean(MONGO_URI),
      postgresConfigured: Boolean(DATABASE_URL),
      initError: storageInitLastError || null
    }
  });
});

async function startServer() {
  await ensureStorageInitialized();

  app.listen(PORT, () => {
    console.log(`Memory Vault Server running on http://localhost:${PORT}`);
    console.log(`Frontend available at http://localhost:${PORT}`);
    console.log(`Storage mode: ${storageMode.toUpperCase()}`);

    const hasApiKey = !!process.env.OPENAI_API_KEY;
    console.log(`OpenAI API Key: ${hasApiKey ? 'Configured' : 'Missing'}`);
    console.log(`OpenAI Model: ${OPENAI_MODEL}`);
    console.log(`Debug endpoint: http://localhost:${PORT}/api/debug/config`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  ensureStorageInitialized
};

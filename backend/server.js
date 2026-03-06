const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { connectDB } = require("./connectDB");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SECRET_KEY = String(
  process.env.JWT_SECRET || "memory_vault_secret_key_2026",
).trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();
const ADMIN_OWNER_EMAIL = String(process.env.ADMIN_OWNER_EMAIL || "")
  .trim()
  .toLowerCase();
const GOOGLE_CLIENT_IDS = String(process.env.GOOGLE_CLIENT_ID || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const FACEBOOK_APP_ID = String(process.env.FACEBOOK_APP_ID || "").trim();
const FACEBOOK_APP_SECRET = String(
  process.env.FACEBOOK_APP_SECRET || "",
).trim();
const MICROSOFT_CLIENT_IDS = String(process.env.MICROSOFT_CLIENT_ID || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ACTIVE_USER_WINDOW_MINUTES = Math.max(
  1,
  Math.min(1440, Number(process.env.ACTIVE_USER_WINDOW_MINUTES) || 5),
);
const PERSONAL_UNLOCK_TTL_MS = 15 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const MONGO_URI = String(process.env.MONGO_URI || "").trim();
const APP_BASE_URL = String(
  process.env.APP_BASE_URL || process.env.FRONTEND_ORIGIN || "",
).trim();

const allowedOriginList = (
  process.env.CORS_ORIGINS ||
  process.env.FRONTEND_ORIGIN ||
  ""
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set(allowedOriginList);

app.use(
  cors({
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
    credentials: true,
  }),
);
app.use(express.json());
const frontendDir = path.join(__dirname, "..", "src");

// Removed admin dashboard static route

app.use(express.static(frontendDir));

const dataFile = path.join(__dirname, "users.json");
const knowledgeFile = path.join(__dirname, "memory_vault_knowledge.json");
const adminDataFile = path.join(__dirname, "admin_activities.json");
const authAttemptTracker = new Map();
const MAX_AUTH_ATTEMPTS = 6;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_BLOCK_MS = 15 * 60 * 1000;
let storageMode = "json";
let pgPool = null;
let mongoReady = false;
let jsonWritable = true;
let storageInitLastError = "";
let MongoUser = null;
let MongoMemory = null;
let MongoAdminActivity = null;
let MongoFolder = null;
let dataCache = { users: [], memories: {} };
let adminCache = { activities: [] };
let persistQueue = Promise.resolve();
let storageInitPromise = null;
let mongoNextRetryAt = 0;
const MONGO_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function usernameBaseFromEmail(email) {
  const localPart = String(email || "").split("@")[0] || "user";
  const normalized = normalizeUsername(localPart);
  if (normalized.length >= 3) return normalized.slice(0, 20);
  return "user";
}

function buildUsernameBase(rawUsername, email) {
  const fromInput = normalizeUsername(rawUsername);
  const fromEmail = usernameBaseFromEmail(email);
  let base = fromInput || fromEmail || "user";
  if (base.length < 3) base = `${base}user`;
  return base.slice(0, 20);
}

function generateUniqueUsername(baseUsername, existingUsernames) {
  const taken =
    existingUsernames instanceof Set ? existingUsernames : new Set();
  const base = buildUsernameBase(baseUsername, "");
  if (!taken.has(base) && isValidUsername(base)) {
    return base;
  }

  let suffix = 2;
  while (suffix < 5000) {
    const suffixText = `_${suffix}`;
    const trimmed = base.slice(0, Math.max(3, 20 - suffixText.length));
    const candidate = `${trimmed}${suffixText}`;
    if (!taken.has(candidate) && isValidUsername(candidate)) {
      return candidate;
    }
    suffix += 1;
  }

  return `user_${Date.now().toString().slice(-6)}`;
}

function isLikelySyntheticEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return false;
  const parts = normalized.split("@");
  if (parts.length !== 2) return false;
  const local = parts[0];
  const domain = parts[1];

  const syntheticDomains = new Set([
    "example.com",
    "example.org",
    "example.net",
    "test.com",
  ]);
  if (syntheticDomains.has(domain)) return true;

  const syntheticLocalPrefixes = [
    "ai-test-",
    "fallback-help-",
    "policycheck_",
    "newuser_",
    "delcheck_",
    "delpersonal_",
    "rendercheck_",
  ];
  return syntheticLocalPrefixes.some((prefix) => local.startsWith(prefix));
}

function isLikelySyntheticUser(user) {
  const email = normalizeEmail(user?.email);
  return isLikelySyntheticEmail(email);
}

function isRealOnlyQueryEnabled(value) {
  const normalized = String(value == null ? "1" : value)
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

function buildSyntheticEmailSet(users) {
  return new Set(
    (Array.isArray(users) ? users : [])
      .filter((user) => isLikelySyntheticUser(user))
      .map((user) => normalizeEmail(user?.email))
      .filter(Boolean),
  );
}

function isLikelySyntheticActivity(activity, syntheticEmails) {
  const email = normalizeEmail(activity?.email);
  if (email && syntheticEmails.has(email)) return true;

  const createdUserEmail = normalizeEmail(activity?.details?.createdUserEmail);
  if (createdUserEmail && isLikelySyntheticEmail(createdUserEmail)) return true;

  return false;
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

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

async function verifyGoogleOAuthToken(payload) {
  const idToken = String(payload?.idToken || "").trim();
  if (idToken) {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(
        idToken,
      )}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data?.error_description ||
          data?.error ||
          "Unable to verify Google token.",
      );
    }

    const aud = String(data.aud || "").trim();
    if (GOOGLE_CLIENT_IDS.length > 0 && !GOOGLE_CLIENT_IDS.includes(aud)) {
      throw new Error("Google token audience mismatch.");
    }

    const email = normalizeEmail(data.email);
    const verified = String(data.email_verified || "").toLowerCase() === "true";
    if (!email || !verified) {
      throw new Error("Google account email is missing or not verified.");
    }

    return {
      provider: "google",
      providerUserId: String(data.sub || ""),
      email,
      name: String(
        data.name || data.given_name || email.split("@")[0] || "",
      ).trim(),
    };
  }

  const accessToken = String(payload?.accessToken || "").trim();
  if (!accessToken) {
    throw new Error("Google sign-in requires an ID token or access token.");
  }

  const userInfoResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  const userInfo = await userInfoResponse.json().catch(() => ({}));
  if (!userInfoResponse.ok) {
    throw new Error(
      userInfo?.error_description ||
        userInfo?.error ||
        "Unable to verify Google access token.",
    );
  }

  const tokenInfoResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(
      accessToken,
    )}`,
    {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    },
  );
  const tokenInfo = await tokenInfoResponse.json().catch(() => ({}));
  if (tokenInfoResponse.ok) {
    const aud = String(tokenInfo.aud || tokenInfo.azp || "").trim();
    if (
      GOOGLE_CLIENT_IDS.length > 0 &&
      aud &&
      !GOOGLE_CLIENT_IDS.includes(aud)
    ) {
      throw new Error("Google token audience mismatch.");
    }
  }

  const email = normalizeEmail(userInfo.email);
  const verified = Boolean(userInfo.email_verified);
  if (!email || !verified) {
    throw new Error("Google account email is missing or not verified.");
  }

  return {
    provider: "google",
    providerUserId: String(userInfo.sub || ""),
    email,
    name: String(
      userInfo.name || userInfo.given_name || email.split("@")[0] || "",
    ).trim(),
  };
}

async function verifyFacebookOAuthToken(payload) {
  const accessToken = String(payload?.accessToken || "").trim();
  if (!accessToken) {
    throw new Error("Facebook sign-in requires an access token.");
  }
  if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
    throw new Error("Facebook OAuth is not configured on the server.");
  }

  const appToken = `${FACEBOOK_APP_ID}|${FACEBOOK_APP_SECRET}`;
  const debugResponse = await fetch(
    `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(
      accessToken,
    )}&access_token=${encodeURIComponent(appToken)}`,
    { method: "GET", signal: AbortSignal.timeout(10000) },
  );
  const debugData = await debugResponse.json().catch(() => ({}));
  const tokenData = debugData?.data || {};
  if (!debugResponse.ok || !tokenData.is_valid) {
    throw new Error("Facebook access token is invalid.");
  }
  if (String(tokenData.app_id || "") !== FACEBOOK_APP_ID) {
    throw new Error("Facebook token app mismatch.");
  }

  const meResponse = await fetch(
    `https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(
      accessToken,
    )}`,
    { method: "GET", signal: AbortSignal.timeout(10000) },
  );
  const meData = await meResponse.json().catch(() => ({}));
  if (!meResponse.ok) {
    throw new Error(
      meData?.error?.message || "Unable to read Facebook profile.",
    );
  }

  const email = normalizeEmail(meData.email);
  if (!email) {
    throw new Error(
      "Facebook account did not provide an email. Ensure email permission is approved.",
    );
  }

  return {
    provider: "facebook",
    providerUserId: String(meData.id || tokenData.user_id || ""),
    email,
    name: String(meData.name || email.split("@")[0] || "").trim(),
  };
}

async function verifyMicrosoftOAuthToken(payload) {
  const accessToken = String(payload?.accessToken || "").trim();
  if (!accessToken) {
    throw new Error("Microsoft sign-in requires an access token.");
  }

  const decoded = decodeJwtPayload(accessToken);
  const audience = String(decoded?.aud || "").trim();
  const acceptedAudiences = new Set([
    ...MICROSOFT_CLIENT_IDS,
    "00000003-0000-0000-c000-000000000000",
    "https://graph.microsoft.com",
  ]);
  if (
    MICROSOFT_CLIENT_IDS.length > 0 &&
    audience &&
    !acceptedAudiences.has(audience)
  ) {
    throw new Error("Microsoft token audience mismatch.");
  }

  const meResponse = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  const meData = await meResponse.json().catch(() => ({}));
  if (!meResponse.ok) {
    throw new Error(
      meData?.error?.message || "Unable to verify Microsoft token.",
    );
  }

  const email = normalizeEmail(meData.mail || meData.userPrincipalName);
  if (!email) {
    throw new Error("Microsoft account email is missing.");
  }

  return {
    provider: "microsoft",
    providerUserId: String(meData.id || decoded?.oid || decoded?.sub || ""),
    email,
    name: String(meData.displayName || email.split("@")[0] || "").trim(),
  };
}

async function verifySocialIdentity(provider, payload) {
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();
  if (normalizedProvider === "google") return verifyGoogleOAuthToken(payload);
  if (normalizedProvider === "facebook")
    return verifyFacebookOAuthToken(payload);
  if (normalizedProvider === "microsoft")
    return verifyMicrosoftOAuthToken(payload);
  throw new Error("Unsupported social provider.");
}

function getAuthKey(req, identifier) {
  const ip = getClientIp(req);
  return `${ip}:${String(identifier || "").toLowerCase()}`;
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
      blockedUntil: null,
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

function createResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

async function sendResetPasswordEmail(email, name, rawToken) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "").trim() === "true";
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const from = String(process.env.SMTP_FROM || user || "").trim();

  if (!host || !user || !pass || !from) {
    return false;
  }

  const base = (APP_BASE_URL || "").replace(/\/+$/, "");
  const resetUrl = `${
    base || "https://memory-vault-coral-seven.vercel.app"
  }?resetToken=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(
    email,
  )}`;

  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from,
      to: email,
      subject: "Memory Vault Password Reset",
      text: [
        `Hi ${name || "there"},`,
        "",
        "We received a request to reset your Memory Vault password.",
        `Reset link: ${resetUrl}`,
        "",
        "This link expires in 30 minutes.",
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
    });
    return true;
  } catch (error) {
    console.error("Reset email send failed:", error.message);
    return false;
  }
}

if (!fs.existsSync(dataFile)) {
  try {
    fs.writeFileSync(
      dataFile,
      JSON.stringify({ users: [], memories: {} }, null, 2),
    );
  } catch {
    jsonWritable = false;
  }
}

if (!fs.existsSync(adminDataFile)) {
  try {
    fs.writeFileSync(
      adminDataFile,
      JSON.stringify({ activities: [] }, null, 2),
    );
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
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return { users: [], memories: {} };
  }
}

function readJsonAdminData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(adminDataFile, "utf8"));
    if (!Array.isArray(parsed.activities)) {
      return { activities: [] };
    }
    return parsed;
  } catch {
    return { activities: [] };
  }
}

function normalizeData(data) {
  const safe =
    data && typeof data === "object"
      ? data
      : { users: [], memories: {}, folders: {} };
  if (!Array.isArray(safe.users)) safe.users = [];
  if (!safe.memories || typeof safe.memories !== "object") safe.memories = {};
  if (!safe.folders || typeof safe.folders !== "object") safe.folders = {};
  const seenUsernames = new Set();
  safe.users = safe.users.map((u, index) => {
    const email = normalizeEmail(u?.email);
    const fallbackUsername = normalizeUsername(
      u?.username || u?.name || email.split("@")[0] || "user",
    );
    const stableFallback =
      fallbackUsername ||
      normalizeUsername(`user_${String(u?.id || "").slice(-6)}`) ||
      "user_default";
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
      name: String(u?.name || u?.username || uniqueUsername || "User").trim(),
      pinFailedAttempts: Math.max(0, Number(u?.pinFailedAttempts) || 0),
      pinLockedUntil: u?.pinLockedUntil
        ? new Date(u.pinLockedUntil).toISOString()
        : null,
      pinLockCycles: Math.max(0, Number(u?.pinLockCycles) || 0),
      resetPasswordTokenHash: u?.resetPasswordTokenHash || null,
      resetPasswordExpiresAt: u?.resetPasswordExpiresAt || null,
    };
  });

  for (const user of safe.users) {
    const email = normalizeEmail(user?.email);
    if (!email) continue;
    if (!Array.isArray(safe.memories[email])) safe.memories[email] = [];
    if (!Array.isArray(safe.folders[email])) safe.folders[email] = [];

    safe.folders[email] = safe.folders[email]
      .map((folder) => ({
        id: String(
          folder?.id ||
            `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ),
        name:
          String(folder?.name || "Untitled Folder")
            .trim()
            .slice(0, 80) || "Untitled Folder",
        parentId: folder?.parentId ? String(folder.parentId) : null,
        createdAt: folder?.createdAt
          ? new Date(folder.createdAt).toISOString()
          : new Date().toISOString(),
      }))
      .filter((folder) => Boolean(folder.id));

    safe.memories[email] = safe.memories[email].map((memory) => {
      const isImportant = Boolean(memory?.is_important);
      const interval = Math.max(
        1,
        Math.min(30, Number(memory?.review_interval_days) || 3),
      );
      return {
        ...memory,
        folder_id: memory?.folder_id ? String(memory.folder_id) : null,
        review_interval_days: interval,
        last_reviewed_at: memory?.last_reviewed_at
          ? new Date(memory.last_reviewed_at).toISOString()
          : null,
        next_review_at: isImportant
          ? memory?.next_review_at
            ? new Date(memory.next_review_at).toISOString()
            : new Date(Date.now() + interval * 86400000).toISOString()
          : null,
      };
    });
  }
  return safe;
}

function normalizeAdminData(data) {
  const safe = data && typeof data === "object" ? data : { activities: [] };
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
  persistQueue = persistQueue.then(task).catch((error) => {
    console.error("Storage persist error:", error.message);
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
      username: {
        type: String,
        default: undefined,
        unique: true,
        index: true,
        sparse: true,
      },
      password: { type: String, required: true },
      name: { type: String, default: "" },
      personalPinHash: { type: String, default: null },
      pinFailedAttempts: { type: Number, default: 0 },
      pinLockedUntil: { type: Date, default: null },
      pinLockCycles: { type: Number, default: 0 },
      resetPasswordTokenHash: { type: String, default: null },
      resetPasswordExpiresAt: { type: Date, default: null },
      createdAt: { type: Date, default: Date.now },
    },
    { collection: "users", versionKey: false },
  );

  const memorySchema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      user_email: { type: String, required: true, index: true },
      title: { type: String, default: "" },
      content: { type: String, default: "" },
      is_important: { type: Boolean, default: false },
      vault_type: { type: String, default: "" },
      folder_id: { type: String, default: null, index: true },
      review_interval_days: { type: Number, default: 3 },
      last_reviewed_at: { type: Date, default: null },
      next_review_at: { type: Date, default: null, index: true },
      timestamp: { type: Date, default: Date.now },
      isFavorite: { type: Boolean, default: false },
    },
    { collection: "memories", versionKey: false },
  );

  const folderSchema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      user_email: { type: String, required: true, index: true },
      name: { type: String, default: "" },
      parent_id: { type: String, default: null, index: true },
      created_at: { type: Date, default: Date.now },
    },
    { collection: "folders", versionKey: false },
  );

  const adminActivitySchema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true, index: true },
      timestamp: { type: Date, default: Date.now, index: true },
      action: { type: String, default: "" },
      email: { type: String, default: null },
      userId: { type: String, default: null },
      method: { type: String, default: "" },
      path: { type: String, default: "" },
      ip: { type: String, default: "" },
      details: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { collection: "admin_activities", versionKey: false },
  );

  MongoUser =
    mongoose.models.MemoryVaultUser ||
    mongoose.model("MemoryVaultUser", userSchema);
  MongoMemory =
    mongoose.models.MemoryVaultMemory ||
    mongoose.model("MemoryVaultMemory", memorySchema);
  MongoAdminActivity =
    mongoose.models.MemoryVaultAdminActivity ||
    mongoose.model("MemoryVaultAdminActivity", adminActivitySchema);
  MongoFolder =
    mongoose.models.MemoryVaultFolder ||
    mongoose.model("MemoryVaultFolder", folderSchema);
}

async function loadDataFromMongo() {
  const users = await MongoUser.find({}).sort({ createdAt: 1, id: 1 }).lean();
  const memoriesRows = await MongoMemory.find({})
    .sort({ timestamp: -1, id: -1 })
    .lean();
  const foldersRows = await MongoFolder.find({})
    .sort({ created_at: 1, id: 1 })
    .lean();
  const activitiesRows = await MongoAdminActivity.find({})
    .sort({ timestamp: -1, id: -1 })
    .limit(5000)
    .lean();

  const memories = {};
  const folders = {};
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
      folder_id: row.folder_id || null,
      review_interval_days: Math.max(
        1,
        Math.min(30, Number(row.review_interval_days) || 3),
      ),
      last_reviewed_at: row.last_reviewed_at
        ? new Date(row.last_reviewed_at)
        : null,
      next_review_at: row.next_review_at ? new Date(row.next_review_at) : null,
      timestamp: row.timestamp ? new Date(row.timestamp) : new Date(),
      isFavorite: Boolean(row.isFavorite),
    });
  }
  for (const row of foldersRows) {
    const email = row.user_email;
    if (!folders[email]) folders[email] = [];
    folders[email].push({
      id: row.id,
      name: row.name || "Untitled Folder",
      parentId: row.parent_id || null,
      createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    });
  }

  return {
    data: {
      users: users.map((row) => ({
        id: row.id,
        email: row.email,
        username: normalizeUsername(
          row.username || row.name || String(row.email || "").split("@")[0],
        ),
        password: row.password,
        name: row.name || "",
        personalPinHash: row.personalPinHash || undefined,
        pinFailedAttempts: Math.max(0, Number(row.pinFailedAttempts) || 0),
        pinLockedUntil: row.pinLockedUntil
          ? new Date(row.pinLockedUntil)
          : null,
        pinLockCycles: Math.max(0, Number(row.pinLockCycles) || 0),
        resetPasswordTokenHash: row.resetPasswordTokenHash || null,
        resetPasswordExpiresAt: row.resetPasswordExpiresAt || null,
        createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
      })),
      memories,
      folders,
    },
    admin: {
      activities: activitiesRows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp
          ? new Date(row.timestamp).toISOString()
          : new Date().toISOString(),
        action: row.action,
        email: row.email,
        userId: row.userId,
        method: row.method,
        path: row.path,
        ip: row.ip,
        details: row.details || {},
      })),
    },
  };
}

async function persistDataToMongo() {
  const data = dataCache;
  const userOps = data.users.map((user) => {
    const email = String(user.email || "");
    const username = normalizeUsername(
      user.username || user.name || email.split("@")[0] || "user",
    );
    return {
      updateOne: {
        filter: { email },
        update: {
          $set: {
            id: String(user.id),
            email,
            username: String(username),
            password: String(user.password || ""),
            name: user.name || "",
            personalPinHash: user.personalPinHash || null,
            pinFailedAttempts: Math.max(0, Number(user.pinFailedAttempts) || 0),
            pinLockedUntil: user.pinLockedUntil
              ? new Date(user.pinLockedUntil)
              : null,
            pinLockCycles: Math.max(0, Number(user.pinLockCycles) || 0),
            resetPasswordTokenHash: user.resetPasswordTokenHash || null,
            resetPasswordExpiresAt: user.resetPasswordExpiresAt
              ? new Date(user.resetPasswordExpiresAt)
              : null,
            createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  const memoryRows = Object.values(data.memories || {}).flat();
  const memoryOps = memoryRows.map((memory) => ({
    updateOne: {
      filter: { id: String(memory.id) },
      update: {
        $set: {
          id: String(memory.id),
          user_email: String(memory.user_email || ""),
          title: memory.title || "",
          content: memory.content || "",
          is_important: Boolean(memory.is_important),
          vault_type: memory.vault_type || "",
          folder_id: memory.folder_id || null,
          review_interval_days: Math.max(
            1,
            Math.min(30, Number(memory.review_interval_days) || 3),
          ),
          last_reviewed_at: memory.last_reviewed_at
            ? new Date(memory.last_reviewed_at)
            : null,
          next_review_at: memory.next_review_at
            ? new Date(memory.next_review_at)
            : null,
          timestamp: memory.timestamp ? new Date(memory.timestamp) : new Date(),
          isFavorite: Boolean(memory.isFavorite),
        },
      },
      upsert: true,
    },
  }));

  const folderRows = Object.entries(data.folders || {}).flatMap(
    ([email, folders]) =>
      Array.isArray(folders) ? folders.map((f) => ({ email, folder: f })) : [],
  );
  const folderOps = folderRows.map((item) => {
    const folder = item.folder || {};
    return {
      updateOne: {
        filter: { id: String(folder.id) },
        update: {
          $set: {
            id: String(folder.id),
            user_email: String(item.email || ""),
            name: String(folder.name || "Untitled Folder"),
            parent_id: folder.parentId ? String(folder.parentId) : null,
            created_at: folder.createdAt
              ? new Date(folder.createdAt)
              : new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  if (userOps.length > 0) await MongoUser.bulkWrite(userOps);
  if (memoryOps.length > 0) await MongoMemory.bulkWrite(memoryOps);
  if (folderOps.length > 0) await MongoFolder.bulkWrite(folderOps);
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
          timestamp: activity.timestamp
            ? new Date(activity.timestamp)
            : new Date(),
          action: activity.action || "",
          email: activity.email || null,
          userId: activity.userId || null,
          method: activity.method || "",
          path: activity.path || "",
          ip: activity.ip || "",
          details: activity.details || {},
        },
      },
      { upsert: true },
    );
  }
}

async function createPgPool() {
  try {
    // Lazy import so local JSON mode works without pg installed.
    const { Pool } = require("pg");
    return new Pool({
      connectionString: DATABASE_URL,
      ssl:
        process.env.PGSSLMODE === "disable"
          ? false
          : { rejectUnauthorized: false },
    });
  } catch (error) {
    console.error(
      'Postgres requested but "pg" package is missing. Falling back to JSON storage.',
    );
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
      pin_failed_attempts INTEGER DEFAULT 0,
      pin_locked_until TIMESTAMPTZ,
      pin_lock_cycles INTEGER DEFAULT 0,
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
      folder_id TEXT,
      review_interval_days INTEGER DEFAULT 3,
      last_reviewed_at TIMESTAMPTZ,
      next_review_at TIMESTAMPTZ,
      timestamp TIMESTAMPTZ,
      is_favorite BOOLEAN DEFAULT FALSE
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      name TEXT,
      parent_id TEXT,
      created_at TIMESTAMPTZ
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
  await pgPool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER DEFAULT 0;`,
  );
  await pgPool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;`,
  );
  await pgPool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_lock_cycles INTEGER DEFAULT 0;`,
  );
  await pgPool.query(
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS folder_id TEXT;`,
  );
  await pgPool.query(
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS review_interval_days INTEGER DEFAULT 3;`,
  );
  await pgPool.query(
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;`,
  );
  await pgPool.query(
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS next_review_at TIMESTAMPTZ;`,
  );
}

async function loadDataFromPostgres() {
  const usersResult = await pgPool.query(`
    SELECT id, email, password, name, personal_pin_hash, pin_failed_attempts, pin_locked_until, pin_lock_cycles, created_at
    FROM users
    ORDER BY created_at ASC NULLS LAST, id ASC
  `);
  const memoriesResult = await pgPool.query(`
    SELECT id, user_email, title, content, is_important, vault_type, folder_id, review_interval_days, last_reviewed_at, next_review_at, timestamp, is_favorite
    FROM memories
    ORDER BY timestamp DESC NULLS LAST, id DESC
  `);
  const foldersResult = await pgPool.query(`
    SELECT id, user_email, name, parent_id, created_at
    FROM folders
    ORDER BY created_at ASC NULLS LAST, id ASC
  `);
  const activitiesResult = await pgPool.query(`
    SELECT id, timestamp, action, email, user_id, method, path, ip, details
    FROM admin_activities
    ORDER BY timestamp DESC NULLS LAST, id DESC
    LIMIT 5000
  `);

  const memories = {};
  const folders = {};
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
      folder_id: row.folder_id || null,
      review_interval_days: Math.max(
        1,
        Math.min(30, Number(row.review_interval_days) || 3),
      ),
      last_reviewed_at: row.last_reviewed_at
        ? new Date(row.last_reviewed_at)
        : null,
      next_review_at: row.next_review_at ? new Date(row.next_review_at) : null,
      timestamp: row.timestamp ? new Date(row.timestamp) : new Date(),
      isFavorite: Boolean(row.is_favorite),
    });
  }
  for (const row of foldersResult.rows) {
    const email = row.user_email;
    if (!folders[email]) folders[email] = [];
    folders[email].push({
      id: row.id,
      name: row.name || "Untitled Folder",
      parentId: row.parent_id || null,
      createdAt: row.created_at ? new Date(row.created_at) : new Date(),
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
        pinFailedAttempts: Math.max(0, Number(row.pin_failed_attempts) || 0),
        pinLockedUntil: row.pin_locked_until
          ? new Date(row.pin_locked_until)
          : null,
        pinLockCycles: Math.max(0, Number(row.pin_lock_cycles) || 0),
        createdAt: row.created_at ? new Date(row.created_at) : new Date(),
      })),
      memories,
      folders,
    },
    admin: {
      activities: activitiesResult.rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp
          ? new Date(row.timestamp).toISOString()
          : new Date().toISOString(),
        action: row.action,
        email: row.email,
        userId: row.user_id,
        method: row.method,
        path: row.path,
        ip: row.ip,
        details: row.details || {},
      })),
    },
  };
}

async function persistDataToPostgres() {
  const data = normalizeData(dataCache);
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM users");
    await client.query("DELETE FROM memories");
    await client.query("DELETE FROM folders");

    for (const user of data.users) {
      await client.query(
        `INSERT INTO users (id, email, password, name, personal_pin_hash, pin_failed_attempts, pin_locked_until, pin_lock_cycles, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          String(user.id),
          String(user.email || ""),
          String(user.password || ""),
          user.name || "",
          user.personalPinHash || null,
          Math.max(0, Number(user.pinFailedAttempts) || 0),
          user.pinLockedUntil ? new Date(user.pinLockedUntil) : null,
          Math.max(0, Number(user.pinLockCycles) || 0),
          user.createdAt ? new Date(user.createdAt) : new Date(),
        ],
      );
    }

    const memoryRows = Object.values(data.memories || {}).flat();
    for (const memory of memoryRows) {
      await client.query(
        `INSERT INTO memories (id, user_email, title, content, is_important, vault_type, folder_id, review_interval_days, last_reviewed_at, next_review_at, timestamp, is_favorite)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          String(memory.id),
          String(memory.user_email || ""),
          memory.title || "",
          memory.content || "",
          Boolean(memory.is_important),
          memory.vault_type || "",
          memory.folder_id || null,
          Math.max(1, Math.min(30, Number(memory.review_interval_days) || 3)),
          memory.last_reviewed_at ? new Date(memory.last_reviewed_at) : null,
          memory.next_review_at ? new Date(memory.next_review_at) : null,
          memory.timestamp ? new Date(memory.timestamp) : new Date(),
          Boolean(memory.isFavorite),
        ],
      );
    }

    const folderRows = Object.entries(data.folders || {}).flatMap(
      ([email, folders]) =>
        Array.isArray(folders)
          ? folders.map((f) => ({ email, folder: f }))
          : [],
    );
    for (const item of folderRows) {
      const folder = item.folder || {};
      await client.query(
        `INSERT INTO folders (id, user_email, name, parent_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          String(folder.id),
          String(item.email || ""),
          String(folder.name || "Untitled Folder"),
          folder.parentId ? String(folder.parentId) : null,
          folder.createdAt ? new Date(folder.createdAt) : new Date(),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistAdminToPostgres() {
  const adminData = normalizeAdminData(adminCache);
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM admin_activities");
    const cappedActivities = adminData.activities.slice(-5000);
    for (const activity of cappedActivities) {
      await client.query(
        `INSERT INTO admin_activities (id, timestamp, action, email, user_id, method, path, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          String(activity.id),
          activity.timestamp ? new Date(activity.timestamp) : new Date(),
          activity.action || "",
          activity.email || null,
          activity.userId || null,
          activity.method || "",
          activity.path || "",
          activity.ip || "",
          JSON.stringify(activity.details || {}),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function saveData(data) {
  // dataCache is already pointing to the same object normally, but we ensure it.
  dataCache = data;
  if (storageMode === "mongo" && mongoReady) {
    enqueuePersist(async () => {
      await persistDataToMongo();
    });
    return;
  }
  if (storageMode === "postgres" && pgPool) {
    enqueuePersist(async () => {
      await persistDataToPostgres();
    });
    return;
  }
  if (jsonWritable) {
    try {
      fs.writeFileSync(dataFile, JSON.stringify(dataCache, null, 2));
    } catch (e) {
      jsonWritable = false;
      console.warn(
        "Local storage write failed (likely EROFS on Vercel), continuing in memory mode.",
      );
    }
  }
}

function saveAdminData(data) {
  adminCache = data;
  if (storageMode === "mongo" && mongoReady) {
    enqueuePersist(async () => {
      await persistAdminToMongo();
    });
    return;
  }
  if (storageMode === "postgres" && pgPool) {
    enqueuePersist(async () => {
      await persistAdminToPostgres();
    });
    return;
  }
  if (jsonWritable) {
    try {
      fs.writeFileSync(adminDataFile, JSON.stringify(adminCache, null, 2));
    } catch (e) {
      jsonWritable = false;
      console.warn("Admin storage write failed, continuing in memory mode.");
    }
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
      const dbHasUsers =
        Array.isArray(loaded.data.users) && loaded.data.users.length > 0;
      const dbHasMemories =
        Object.values(loaded.data.memories || {}).flat().length > 0;

      if (
        !dbHasUsers &&
        !dbHasMemories &&
        (dataCache.users.length > 0 ||
          Object.keys(dataCache.memories || {}).length > 0)
      ) {
        await persistDataToMongo();
      } else {
        dataCache = normalizeData(loaded.data);
      }

      if (
        (!loaded.admin.activities || loaded.admin.activities.length === 0) &&
        adminCache.activities.length > 0
      ) {
        await persistAdminToMongo();
      } else {
        adminCache = normalizeAdminData(loaded.admin);
      }

      storageMode = "mongo";
      return;
    } catch (error) {
      console.error(
        "Failed to initialize MongoDB storage, falling back to Postgres/JSON:",
        error.message,
      );
      storageInitLastError = `mongo: ${error.message}`;
      mongoReady = false;
      dataCache = normalizeData(readJsonData());
      adminCache = normalizeAdminData(readJsonAdminData());
    }
  }

  if (!DATABASE_URL) {
    storageMode = "json";
    return;
  }

  pgPool = await createPgPool();
  if (!pgPool) {
    storageMode = "json";
    return;
  }

  try {
    await ensurePgSchema();
    const loaded = await loadDataFromPostgres();
    const dbHasUsers =
      Array.isArray(loaded.data.users) && loaded.data.users.length > 0;
    const dbHasMemories =
      Object.values(loaded.data.memories || {}).flat().length > 0;

    if (
      !dbHasUsers &&
      !dbHasMemories &&
      (dataCache.users.length > 0 ||
        Object.keys(dataCache.memories || {}).length > 0)
    ) {
      await persistDataToPostgres();
    } else {
      dataCache = normalizeData(loaded.data);
    }

    if (
      (!loaded.admin.activities || loaded.admin.activities.length === 0) &&
      adminCache.activities.length > 0
    ) {
      await persistAdminToPostgres();
    } else {
      adminCache = normalizeAdminData(loaded.admin);
    }

    storageMode = "postgres";
  } catch (error) {
    console.error(
      "Failed to initialize Postgres storage, falling back to JSON:",
      error.message,
    );
    storageInitLastError = `postgres: ${error.message}`;
    storageMode = "json";
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
  if (storageMode === "mongo" && mongoReady) return true;
  if (Date.now() < mongoNextRetryAt) return false;
  try {
    await connectDB();
    ensureMongoModels();
    mongoReady = true;
    storageMode = "mongo";
    storageInitLastError = "";
    mongoNextRetryAt = 0;
    return true;
  } catch (error) {
    storageInitLastError = `mongo: ${error.message}`;
    mongoNextRetryAt = Date.now() + MONGO_RETRY_COOLDOWN_MS;
    return false;
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isLoopbackIp(ip) {
  const value = String(ip || "")
    .trim()
    .toLowerCase();
  return (
    value === "::1" ||
    value === "127.0.0.1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}

function isLocalRequest(req) {
  const host = String(req.hostname || "")
    .trim()
    .toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1")
    return true;
  return isLoopbackIp(getClientIp(req));
}

function readHeaderValue(req, key) {
  const value = req.headers[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

function getRequestGeo(req) {
  const countryCode =
    readHeaderValue(req, "x-vercel-ip-country") ||
    readHeaderValue(req, "cf-ipcountry") ||
    readHeaderValue(req, "x-country-code") ||
    "";

  const region =
    readHeaderValue(req, "x-vercel-ip-country-region") ||
    readHeaderValue(req, "x-region") ||
    "";

  const city =
    readHeaderValue(req, "x-vercel-ip-city") ||
    readHeaderValue(req, "x-city") ||
    "";

  const latitude =
    readHeaderValue(req, "x-vercel-ip-latitude") ||
    readHeaderValue(req, "x-latitude") ||
    "";

  const longitude =
    readHeaderValue(req, "x-vercel-ip-longitude") ||
    readHeaderValue(req, "x-longitude") ||
    "";

  const timezone =
    readHeaderValue(req, "x-vercel-ip-timezone") ||
    readHeaderValue(req, "x-timezone") ||
    "";

  const source = countryCode || region || city ? "edge_headers" : "unknown";

  return {
    countryCode: countryCode || null,
    region: region || null,
    city: city || null,
    latitude: latitude || null,
    longitude: longitude || null,
    timezone: timezone || null,
    source,
  };
}

function logActivity(req, action, details = {}) {
  const adminData = loadAdminData();
  const safeDetails = details && typeof details === "object" ? details : {};
  const geo = getRequestGeo(req);
  const activity = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action,
    email: req.user?.email || safeDetails.email || null,
    userId: req.user?.id || safeDetails.userId || null,
    method: req.method,
    path: req.path,
    ip: getClientIp(req),
    details: {
      ...safeDetails,
      geo,
    },
  };

  adminData.activities.push(activity);
  if (adminData.activities.length > 5000) {
    adminData.activities = adminData.activities.slice(-5000);
  }
  saveAdminData(adminData);
}

function buildRegisteredActiveUsersSnapshot(appData, adminData, options = {}) {
  const minutes = Math.max(
    1,
    Math.min(1440, Number(options.minutes) || ACTIVE_USER_WINDOW_MINUTES),
  );
  const limit = Math.max(1, Math.min(2000, Number(options.limit) || 500));
  const realOnly = Boolean(options.realOnly);
  const cutoffMs = Date.now() - minutes * 60 * 1000;

  const users = Array.isArray(appData?.users) ? appData.users : [];
  const memoriesByEmail =
    appData?.memories && typeof appData.memories === "object"
      ? appData.memories
      : {};
  const syntheticEmails = buildSyntheticEmailSet(users);
  const scopedUsers = realOnly
    ? users.filter((user) => !isLikelySyntheticUser(user))
    : users;
  const userEmailSet = new Set(
    scopedUsers.map((user) => normalizeEmail(user?.email)).filter(Boolean),
  );

  const latestByEmail = new Map();
  const sourceActivities = Array.isArray(adminData?.activities)
    ? adminData.activities
    : [];
  for (const activity of sourceActivities) {
    const email = normalizeEmail(activity?.email);
    if (!email || !userEmailSet.has(email)) continue;
    if (realOnly && syntheticEmails.has(email)) continue;
    const ts = new Date(activity?.timestamp || 0).getTime();
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const previous = latestByEmail.get(email);
    if (!previous || ts > previous.timestampMs) {
      latestByEmail.set(email, {
        timestampMs: ts,
        timestamp: new Date(ts).toISOString(),
        action: activity?.action || "",
        path: activity?.path || "",
      });
    }
  }

  const rows = scopedUsers
    .map((user) => {
      const email = normalizeEmail(user?.email);
      const latest = latestByEmail.get(email) || null;
      const userMemories = Array.isArray(memoriesByEmail[email])
        ? memoriesByEmail[email]
        : [];
      return {
        id: user?.id || null,
        email: user?.email || "",
        username: user?.username || "",
        name: user?.name || "",
        createdAt: user?.createdAt || null,
        memoryCount: userMemories.length,
        lastActivityAt: latest?.timestamp || null,
        lastActivityAction: latest?.action || null,
        lastActivityPath: latest?.path || null,
        isActiveNow: Boolean(latest && latest.timestampMs >= cutoffMs),
      };
    })
    .filter((row) => row.isActiveNow)
    .sort(
      (a, b) =>
        new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0),
    )
    .slice(0, limit);

  return { minutes, rows };
}

function verifyAdminAccess(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res
      .status(503)
      .json({ success: false, message: "Admin key is not configured" });
  }
  if (!ADMIN_OWNER_EMAIL) {
    return res
      .status(503)
      .json({ success: false, message: "Admin owner email is not configured" });
  }

  const provided = String(req.headers["x-admin-key"] || "")
    .trim()
    .toLowerCase();
  const expected = String(ADMIN_API_KEY || "")
    .trim()
    .toLowerCase();
  if (!provided || provided !== expected) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid admin key" });
  }

  return next();
}

function getUserRecord(data, email) {
  return data.users.find(
    (u) => normalizeEmail(u.email) === normalizeEmail(email),
  );
}

function getUserFolders(data, email) {
  const key = normalizeEmail(email);
  if (!Array.isArray(data.folders[key])) data.folders[key] = [];
  return data.folders[key];
}

function clampReviewInterval(value) {
  return Math.max(1, Math.min(30, Number(value) || 3));
}

function collectDescendantFolderIds(folders, parentId) {
  const byParent = new Map();
  for (const folder of folders) {
    const key = folder.parentId ? String(folder.parentId) : "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(String(folder.id));
  }
  const result = new Set();
  const stack = [String(parentId)];
  while (stack.length) {
    const current = stack.pop();
    if (result.has(current)) continue;
    result.add(current);
    const children = byParent.get(current) || [];
    for (const child of children) stack.push(child);
  }
  return result;
}

function toDirectAnswer(text) {
  const raw = String(text || "").trim();
  if (!raw) return "No direct answer available right now.";
  if (/^\s*(yes|no|you can|you cannot|to|use|open|memory vault)\b/i.test(raw))
    return raw;
  return `Direct answer: ${raw}`;
}

function generatePersonalUnlockToken(email) {
  return jwt.sign({ email, scope: "personal_unlock" }, SECRET_KEY, {
    expiresIn: "15m",
  });
}

function parsePersonalUnlockToken(req) {
  const headerToken = req.headers["x-personal-unlock-token"];
  if (!headerToken || typeof headerToken !== "string") return null;

  try {
    const payload = jwt.verify(headerToken, SECRET_KEY);
    if (payload?.scope !== "personal_unlock") return null;
    if (!payload?.email || payload.email !== req.user?.email) return null;
    return payload;
  } catch {
    return null;
  }
}

function isPersonalUnlocked(req) {
  const email = req.user?.email;
  if (!email) return false;
  return Boolean(parsePersonalUnlockToken(req));
}

function requirePersonalUnlock(req, res, next) {
  if (!isPersonalUnlocked(req)) {
    return res.status(403).json({
      success: false,
      message: "Personal vault is locked. Verify your PIN to continue.",
    });
  }
  return next();
}

function getDefaultKnowledgeBase() {
  return {
    version: "1.0.0",
    updatedAt: new Date().toISOString().slice(0, 10),
    entries: [],
  };
}

function loadKnowledgeBase() {
  if (!fs.existsSync(knowledgeFile)) {
    const defaultKnowledge = getDefaultKnowledgeBase();
    try {
      fs.writeFileSync(
        knowledgeFile,
        JSON.stringify(defaultKnowledge, null, 2),
      );
    } catch (err) {
      if (err.code === "EROFS") {
        console.warn(
          "Vercel EROFS detected. Knowledge base will be in-memory only.",
        );
      } else {
        console.error("Failed to initialize knowledge file:", err);
      }
    }
    return defaultKnowledge;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
    if (!Array.isArray(parsed.entries)) {
      return getDefaultKnowledgeBase();
    }
    return parsed;
  } catch {
    return getDefaultKnowledgeBase();
  }
}

app.post("/api/auth/signup", async (req, res) => {
  try {
    const mongoReadyForRequest = await ensureMongoReadyForRequest();
    if (MONGO_URI && !mongoReadyForRequest) {
      console.warn(
        "MongoDB unavailable during signup; continuing with fallback storage mode.",
      );
    }
    const rawEmail = req.body?.email;
    const rawPassword = req.body?.password;
    const rawName = req.body?.name;
    const rawUsername = req.body?.username;
    const email = normalizeEmail(rawEmail);
    const password = String(rawPassword || "");
    const data = loadData();
    const existingUsernames = new Set(
      data.users
        .map((u) => normalizeUsername(u.username || u.name))
        .filter(Boolean),
    );
    let username = generateUniqueUsername(
      buildUsernameBase(rawUsername, email),
      existingUsernames,
    );
    const name = String(rawName || "").trim() || username;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }
    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ success: false, message: "Enter a valid email address" });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters and include letters and numbers",
      });
    }

    const existingByEmail = data.users.find(
      (u) => normalizeEmail(u.email) === email,
    );
    if (existingByEmail) {
      const existingPasswordOk = await bcrypt.compare(
        password,
        existingByEmail.password,
      );
      if (existingPasswordOk) {
        const token = jwt.sign(
          {
            email: existingByEmail.email,
            id: existingByEmail.id,
            username: existingByEmail.username || existingByEmail.name || "",
          },
          SECRET_KEY,
          { expiresIn: "7d" },
        );
        return res.json({
          success: true,
          message: "Account already exists. Signed you in automatically.",
          token,
          user: {
            email: existingByEmail.email,
            username: existingByEmail.username || "",
            name: existingByEmail.name || existingByEmail.username || "",
            id: existingByEmail.id,
          },
        });
      }
      return res.status(409).json({
        success: false,
        message: "Email is already registered. Sign in or use Forgot Password.",
      });
    }
    if (storageMode === "mongo" && mongoReady && MongoUser) {
      const existingMongoByEmail = await MongoUser.findOne({ email }).lean();
      if (existingMongoByEmail) {
        const existingPasswordOk = await bcrypt.compare(
          password,
          existingMongoByEmail.password,
        );
        if (existingPasswordOk) {
          const token = jwt.sign(
            {
              email: existingMongoByEmail.email,
              id: existingMongoByEmail.id,
              username:
                existingMongoByEmail.username ||
                existingMongoByEmail.name ||
                "",
            },
            SECRET_KEY,
            { expiresIn: "7d" },
          );
          return res.json({
            success: true,
            message: "Account already exists. Signed you in automatically.",
            token,
            user: {
              email: existingMongoByEmail.email,
              username: existingMongoByEmail.username || "",
              name:
                existingMongoByEmail.name ||
                existingMongoByEmail.username ||
                "",
              id: existingMongoByEmail.id,
            },
          });
        }
        return res.status(409).json({
          success: false,
          message:
            "Email is already registered. Sign in or use Forgot Password.",
        });
      }

      const mongoTaken = new Set();
      // Keep trying generated variants until one is free in Mongo.
      while (true) {
        const existingMongoByUsername = await MongoUser.findOne({
          username,
        }).lean();
        if (!existingMongoByUsername) break;
        mongoTaken.add(username);
        username = generateUniqueUsername(
          buildUsernameBase(rawUsername, email),
          new Set([...existingUsernames, ...mongoTaken]),
        );
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      email,
      username,
      password: hashedPassword,
      name,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      pinLockCycles: 0,
      createdAt: new Date(),
    };

    if (storageMode === "mongo" && mongoReady && MongoUser) {
      await MongoUser.create({
        id: String(user.id),
        email: String(user.email),
        username: String(user.username),
        password: String(user.password),
        name: user.name || "",
        personalPinHash: null,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        pinLockCycles: 0,
        createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
      });
    }

    data.users.push(user);
    data.memories[email] = [];
    saveData(data);

    const token = jwt.sign({ email, id: user.id, username }, SECRET_KEY, {
      expiresIn: "7d",
    });

    logActivity(req, "auth_signup", { createdUserEmail: email });
    return res.json({
      success: true,
      message: "Signup successful",
      token,
      user: { email, username, name, id: user.id },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  try {
    const mongoReadyForRequest = await ensureMongoReadyForRequest();
    if (MONGO_URI && !mongoReadyForRequest) {
      console.warn(
        "MongoDB unavailable during signin; continuing with fallback storage mode.",
      );
    }
    const identifierRaw = String(
      req.body?.identifier || req.body?.email || req.body?.username || "",
    ).trim();
    const password = String(req.body?.password || "");
    if (!identifierRaw || !password) {
      return res.status(400).json({
        success: false,
        message: "Username/email and password are required",
      });
    }
    const identifier = identifierRaw.toLowerCase();
    const limiter = authRateLimitStatus(req, identifier);
    if (limiter.blocked) {
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Try again later.",
      });
    }
    const data = loadData();

    let user = null;
    if (storageMode === "mongo" && mongoReady && MongoUser) {
      const mongoUser = await MongoUser.findOne({
        $or: [
          { email: normalizeEmail(identifier) },
          { username: normalizeUsername(identifier) },
        ],
      }).lean();
      if (mongoUser) {
        user = {
          id: mongoUser.id,
          email: mongoUser.email,
          username: mongoUser.username || "",
          password: mongoUser.password,
          name: mongoUser.name || "",
          personalPinHash: mongoUser.personalPinHash || undefined,
          pinFailedAttempts: Math.max(
            0,
            Number(mongoUser.pinFailedAttempts) || 0,
          ),
          pinLockedUntil: mongoUser.pinLockedUntil || null,
          pinLockCycles: Math.max(0, Number(mongoUser.pinLockCycles) || 0),
          createdAt: mongoUser.createdAt
            ? new Date(mongoUser.createdAt)
            : new Date(),
        };
      }
    } else {
      user = data.users.find((u) => {
        const emailMatch =
          normalizeEmail(u.email) === normalizeEmail(identifier);
        const usernameMatch =
          normalizeUsername(u.username || u.name) ===
          normalizeUsername(identifier);
        return emailMatch || usernameMatch;
      });
    }
    if (!user) {
      recordAuthFailure(req, identifier);
      return res.status(401).json({
        success: false,
        message: "Invalid username/email or password",
      });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      recordAuthFailure(req, identifier);
      return res.status(401).json({
        success: false,
        message: "Invalid username/email or password",
      });
    }

    clearAuthFailures(req, identifier);
    const token = jwt.sign(
      {
        email: user.email,
        id: user.id,
        username: user.username || user.name || "",
      },
      SECRET_KEY,
      { expiresIn: "7d" },
    );

    logActivity(req, "auth_signin");
    return res.json({
      success: true,
      message: "Signin successful",
      token,
      user: {
        email: user.email,
        username: user.username || user.name || "",
        name: user.name,
        id: user.id,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/auth/oauth", async (req, res) => {
  try {
    const mongoReadyForRequest = await ensureMongoReadyForRequest();
    if (MONGO_URI && !mongoReadyForRequest) {
      console.warn(
        "MongoDB unavailable during oauth signin; continuing with fallback storage mode.",
      );
    }

    const provider = String(req.body?.provider || "")
      .trim()
      .toLowerCase();
    if (!provider) {
      return res
        .status(400)
        .json({ success: false, message: "OAuth provider is required." });
    }

    const identity = await verifySocialIdentity(provider, req.body || {});
    const data = loadData();
    const existingUsernames = new Set(
      data.users
        .map((u) => normalizeUsername(u.username || u.name))
        .filter(Boolean),
    );

    let user = data.users.find(
      (u) => normalizeEmail(u.email) === identity.email,
    );
    let created = false;

    if (!user && storageMode === "mongo" && mongoReady && MongoUser) {
      const mongoUser = await MongoUser.findOne({
        email: identity.email,
      }).lean();
      if (mongoUser) {
        user = {
          id: mongoUser.id,
          email: mongoUser.email,
          username: mongoUser.username || "",
          password: mongoUser.password,
          name: mongoUser.name || "",
          pinFailedAttempts: Math.max(
            0,
            Number(mongoUser.pinFailedAttempts) || 0,
          ),
          pinLockedUntil: mongoUser.pinLockedUntil || null,
          pinLockCycles: Math.max(0, Number(mongoUser.pinLockCycles) || 0),
          createdAt: mongoUser.createdAt
            ? new Date(mongoUser.createdAt)
            : new Date(),
        };
      }
    }

    if (!user) {
      let username = generateUniqueUsername(
        buildUsernameBase(identity.name, identity.email),
        existingUsernames,
      );
      if (storageMode === "mongo" && mongoReady && MongoUser) {
        const mongoTaken = new Set();
        while (true) {
          const existingMongoByUsername = await MongoUser.findOne({
            username,
          }).lean();
          if (!existingMongoByUsername) break;
          mongoTaken.add(username);
          username = generateUniqueUsername(
            buildUsernameBase(identity.name, identity.email),
            new Set([...existingUsernames, ...mongoTaken]),
          );
        }
      }

      const randomPassword = `${crypto
        .randomBytes(18)
        .toString("base64url")}A1`;
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      user = {
        id: Date.now().toString(),
        email: identity.email,
        username,
        password: hashedPassword,
        name: identity.name || username,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        pinLockCycles: 0,
        createdAt: new Date(),
      };

      if (storageMode === "mongo" && mongoReady && MongoUser) {
        await MongoUser.create({
          id: String(user.id),
          email: String(user.email),
          username: String(user.username),
          password: String(user.password),
          name: user.name || "",
          personalPinHash: null,
          pinFailedAttempts: 0,
          pinLockedUntil: null,
          pinLockCycles: 0,
          createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
        });
      }

      data.users.push(user);
      if (!Array.isArray(data.memories[user.email])) {
        data.memories[user.email] = [];
      }
      saveData(data);
      created = true;
    }

    const token = jwt.sign(
      {
        email: user.email,
        id: user.id,
        username: user.username || user.name || "",
      },
      SECRET_KEY,
      { expiresIn: "7d" },
    );

    logActivity(req, created ? "auth_oauth_signup" : "auth_oauth_signin", {
      provider,
      email: user.email,
      created,
    });

    return res.json({
      success: true,
      message: created
        ? "Account created with social sign-in."
        : "Signed in successfully.",
      token,
      user: {
        email: user.email,
        username: user.username || "",
        name: user.name || user.username || "",
        id: user.id,
      },
      provider,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Social sign-in failed.",
    });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const genericResponse = {
      success: true,
      message: "If this email is registered, a reset link has been sent.",
    };
    if (!email || !isValidEmail(email)) {
      return res.json(genericResponse);
    }

    const data = loadData();
    const user = data.users.find((u) => normalizeEmail(u.email) === email);
    if (!user) {
      return res.json(genericResponse);
    }

    const rawToken = createResetToken();
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    user.resetPasswordTokenHash = tokenHash;
    user.resetPasswordExpiresAt = expiresAt.toISOString();
    saveData(data);

    if (storageMode === "mongo" && mongoReady && MongoUser) {
      await MongoUser.updateOne(
        { email },
        {
          $set: {
            resetPasswordTokenHash: tokenHash,
            resetPasswordExpiresAt: expiresAt,
          },
        },
      );
    }

    await sendResetPasswordEmail(
      email,
      user.name || user.username || "",
      rawToken,
    );
    logActivity(req, "auth_forgot_password", { email });
    return res.json(genericResponse);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to process forgot password request.",
    });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const token = String(req.body?.token || "").trim();
    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!email || !token || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Email, token, and new passwords are required",
      });
    }
    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ success: false, message: "New passwords do not match" });
    }
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters and include letters and numbers",
      });
    }

    const data = loadData();
    const user = data.users.find((u) => normalizeEmail(u.email) === email);
    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired reset link" });
    }

    const now = Date.now();
    const tokenHash = hashResetToken(token);
    const expiresAtMs = user.resetPasswordExpiresAt
      ? new Date(user.resetPasswordExpiresAt).getTime()
      : 0;
    const validToken =
      user.resetPasswordTokenHash &&
      user.resetPasswordTokenHash === tokenHash &&
      expiresAtMs > now;
    if (!validToken) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired reset link" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpiresAt = null;
    saveData(data);

    if (storageMode === "mongo" && mongoReady && MongoUser) {
      await MongoUser.updateOne(
        { email },
        {
          $set: {
            password: user.password,
            resetPasswordTokenHash: null,
            resetPasswordExpiresAt: null,
          },
        },
      );
    }

    const tokenJwt = jwt.sign(
      {
        email: user.email,
        id: user.id,
        username: user.username || user.name || "",
      },
      SECRET_KEY,
      { expiresIn: "7d" },
    );

    logActivity(req, "auth_reset_password", { email });
    return res.json({
      success: true,
      message: "Password reset successful. You are now signed in.",
      token: tokenJwt,
      user: {
        email: user.email,
        username: user.username || "",
        name: user.name || user.username || "",
        id: user.id,
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Unable to reset password right now." });
  }
});

app.get("/api/personal/pin/status", verifyToken, (req, res) => {
  try {
    const data = loadData();
    const user = getUserRecord(data, req.user.email);
    const payload = parsePersonalUnlockToken(req);
    const expiresAt = payload?.exp ? Number(payload.exp) * 1000 : null;
    const lockedUntil = user?.pinLockedUntil
      ? new Date(user.pinLockedUntil).getTime()
      : 0;

    return res.json({
      success: true,
      configured: Boolean(user?.personalPinHash),
      unlocked: Boolean(payload),
      expiresAt,
      pinLocked: Boolean(lockedUntil && lockedUntil > Date.now()),
      pinLockedUntil: lockedUntil || null,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/personal/pin/setup", verifyToken, async (req, res) => {
  try {
    const pin = String(req.body?.pin || "").trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res
        .status(400)
        .json({ success: false, message: "PIN must be 4 to 6 digits" });
    }

    const data = loadData();
    const user = getUserRecord(data, req.user.email);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (user.personalPinHash) {
      return res
        .status(400)
        .json({ success: false, message: "PIN already configured" });
    }

    user.personalPinHash = await bcrypt.hash(pin, 12);
    user.pinFailedAttempts = 0;
    user.pinLockedUntil = null;
    user.pinLockCycles = 0;
    saveData(data);
    logActivity(req, "personal_pin_setup");

    return res.json({ success: true, message: "Personal vault PIN created" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/personal/pin/verify", verifyToken, async (req, res) => {
  try {
    const pin = String(req.body?.pin || "").trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res
        .status(400)
        .json({ success: false, message: "PIN must be 4 to 6 digits" });
    }

    const data = loadData();
    const user = getUserRecord(data, req.user.email);
    if (!user?.personalPinHash) {
      return res
        .status(400)
        .json({ success: false, message: "Personal PIN is not configured" });
    }

    const lockedUntilMs = user.pinLockedUntil
      ? new Date(user.pinLockedUntil).getTime()
      : 0;
    if (lockedUntilMs && lockedUntilMs > Date.now()) {
      return res.status(423).json({
        success: false,
        message:
          "PIN is temporarily locked after repeated failures. Try again later.",
        pinLockedUntil: lockedUntilMs,
      });
    }

    const ok = await bcrypt.compare(pin, user.personalPinHash);
    if (!ok) {
      user.pinFailedAttempts =
        Math.max(0, Number(user.pinFailedAttempts) || 0) + 1;
      if (user.pinFailedAttempts >= 7) {
        user.pinFailedAttempts = 0;
        user.pinLockedUntil = new Date(
          Date.now() + 24 * 60 * 60 * 1000,
        ).toISOString();
        user.pinLockCycles = Math.max(0, Number(user.pinLockCycles) || 0) + 1;
        if (user.pinLockCycles >= 3) {
          const list = Array.isArray(data.memories[req.user.email])
            ? data.memories[req.user.email]
            : [];
          data.memories[req.user.email] = list.filter(
            (m) => String(m.vault_type || "").toLowerCase() !== "personal",
          );
          user.pinLockCycles = 0;
          logActivity(req, "personal_pin_data_wipe_after_lock_cycles");
        }
      }
      saveData(data);
      logActivity(req, "personal_pin_verify_failed");
      return res.status(401).json({ success: false, message: "Invalid PIN" });
    }

    user.pinFailedAttempts = 0;
    user.pinLockedUntil = null;
    user.pinLockCycles = 0;
    saveData(data);

    const token = generatePersonalUnlockToken(req.user.email);
    const parsed = jwt.decode(token);
    const expiresAt = parsed?.exp
      ? Number(parsed.exp) * 1000
      : Date.now() + PERSONAL_UNLOCK_TTL_MS;
    logActivity(req, "personal_pin_verified", { expiresAt });

    return res.json({
      success: true,
      unlockToken: token,
      expiresAt,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/personal/pin/reset", verifyToken, async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    const newPin = String(req.body?.newPin || "").trim();
    if (!/^\d{4,6}$/.test(newPin)) {
      return res
        .status(400)
        .json({ success: false, message: "New PIN must be 4 to 6 digits" });
    }

    const data = loadData();
    const user = getUserRecord(data, req.user.email);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      logActivity(req, "personal_pin_reset_failed");
      return res
        .status(401)
        .json({ success: false, message: "Invalid account password" });
    }

    user.personalPinHash = await bcrypt.hash(newPin, 12);
    user.pinFailedAttempts = 0;
    user.pinLockedUntil = null;
    user.pinLockCycles = 0;
    saveData(data);

    const token = generatePersonalUnlockToken(req.user.email);
    const parsed = jwt.decode(token);
    const expiresAt = parsed?.exp
      ? Number(parsed.exp) * 1000
      : Date.now() + PERSONAL_UNLOCK_TTL_MS;
    logActivity(req, "personal_pin_reset", { expiresAt });

    return res.json({
      success: true,
      message: "Personal PIN reset successfully",
      unlockToken: token,
      expiresAt,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/personal/pin/lock", verifyToken, (req, res) => {
  logActivity(req, "personal_pin_lock");
  return res.json({ success: true, message: "Personal vault locked" });
});

app.get("/api/folders", verifyToken, (req, res) => {
  try {
    const data = loadData();
    const folders = getUserFolders(data, req.user.email);
    return res.json({ success: true, data: folders });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not load folders",
    });
  }
});

app.post("/api/folders", verifyToken, (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const parentId = req.body?.parentId ? String(req.body.parentId) : null;
    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Folder name is required" });
    }
    const data = loadData();
    const folders = getUserFolders(data, req.user.email);
    if (parentId && !folders.some((f) => String(f.id) === parentId)) {
      return res
        .status(400)
        .json({ success: false, message: "Parent folder not found" });
    }
    const folder = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.slice(0, 80),
      parentId,
      createdAt: new Date().toISOString(),
    };
    folders.push(folder);
    saveData(data);
    logActivity(req, "folder_create", {
      folderId: folder.id,
      parentId: folder.parentId || null,
    });
    return res.json({ success: true, data: folder });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not create folder",
    });
  }
});

app.patch("/api/folders/:id", verifyToken, (req, res) => {
  try {
    const folderId = String(req.params.id || "");
    const data = loadData();
    const folders = getUserFolders(data, req.user.email);
    const folder = folders.find((f) => String(f.id) === folderId);
    if (!folder) {
      return res
        .status(404)
        .json({ success: false, message: "Folder not found" });
    }
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      folder.name = req.body.name.trim().slice(0, 80);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "parentId")) {
      const nextParentId = req.body.parentId ? String(req.body.parentId) : null;
      if (nextParentId === folderId) {
        return res
          .status(400)
          .json({ success: false, message: "Folder cannot be its own parent" });
      }
      if (nextParentId && !folders.some((f) => String(f.id) === nextParentId)) {
        return res
          .status(400)
          .json({ success: false, message: "Parent folder not found" });
      }
      const descendants = collectDescendantFolderIds(folders, folderId);
      if (nextParentId && descendants.has(nextParentId)) {
        return res.status(400).json({
          success: false,
          message: "Cannot move folder inside its own descendant",
        });
      }
      folder.parentId = nextParentId;
    }
    saveData(data);
    logActivity(req, "folder_update", { folderId: folder.id });
    return res.json({ success: true, data: folder });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not update folder",
    });
  }
});

app.delete("/api/folders/:id", verifyToken, (req, res) => {
  try {
    const folderId = String(req.params.id || "");
    const data = loadData();
    const folders = getUserFolders(data, req.user.email);
    if (!folders.some((f) => String(f.id) === folderId)) {
      return res
        .status(404)
        .json({ success: false, message: "Folder not found" });
    }
    const descendantIds = collectDescendantFolderIds(folders, folderId);
    data.folders[req.user.email] = folders.filter(
      (f) => !descendantIds.has(String(f.id)),
    );
    const userMemories = Array.isArray(data.memories[req.user.email])
      ? data.memories[req.user.email]
      : [];
    for (const memory of userMemories) {
      if (memory.folder_id && descendantIds.has(String(memory.folder_id))) {
        memory.folder_id = null;
      }
    }
    saveData(data);
    logActivity(req, "folder_delete", {
      folderId,
      descendants: descendantIds.size,
    });
    return res.json({ success: true, message: "Folder deleted" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not delete folder",
    });
  }
});

// Duplicate trending endpoint removed. Use the main version below.

app.get("/api/memories/due", verifyToken, (req, res) => {
  try {
    const data = loadData();
    const now = Date.now();
    const includePersonal = isPersonalUnlocked(req);
    const list = Array.isArray(data.memories[req.user.email])
      ? data.memories[req.user.email]
      : [];
    const due = list
      .filter((m) => {
        const important = Boolean(m.is_important);
        if (!important) return false;
        if (
          !includePersonal &&
          String(m.vault_type || "").toLowerCase() === "personal"
        )
          return false;
        const dueAt = m.next_review_at
          ? new Date(m.next_review_at).getTime()
          : 0;
        return Boolean(dueAt && dueAt <= now);
      })
      .sort(
        (a, b) =>
          new Date(a.next_review_at || 0) - new Date(b.next_review_at || 0),
      );
    return res.json({
      success: true,
      data: due.slice(0, 20),
      total: due.length,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not load due memories",
    });
  }
});

app.post("/api/account/reset", verifyToken, async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    const scope =
      String(req.body?.scope || "all").toLowerCase() === "personal"
        ? "personal"
        : "all";
    const data = loadData();
    const user = getUserRecord(data, req.user.email);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid account password" });
    }

    const list = Array.isArray(data.memories[req.user.email])
      ? data.memories[req.user.email]
      : [];
    if (scope === "personal") {
      data.memories[req.user.email] = list.filter(
        (m) => String(m.vault_type || "").toLowerCase() !== "personal",
      );
      user.personalPinHash = null;
      user.pinFailedAttempts = 0;
      user.pinLockedUntil = null;
      user.pinLockCycles = 0;
    } else {
      data.memories[req.user.email] = [];
      data.folders[req.user.email] = [];
      user.personalPinHash = null;
      user.pinFailedAttempts = 0;
      user.pinLockedUntil = null;
      user.pinLockCycles = 0;
    }
    saveData(data);
    logActivity(req, "account_reset", { scope });
    return res.json({
      success: true,
      message:
        scope === "personal"
          ? "Personal vault data wiped."
          : "All memories and folders wiped.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not reset account data",
    });
  }
});

app.patch("/api/user/profile", verifyToken, async (req, res) => {
  try {
    const { name, username } = req.body;
    const data = loadData();
    const user = getUserRecord(data, req.user.email);

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (name !== undefined) {
      user.name = String(name || "")
        .trim()
        .slice(0, 100);
    }

    if (username !== undefined) {
      const normalized = normalizeUsername(username);
      if (normalized.length < 3 || normalized.length > 20) {
        return res.status(400).json({
          success: false,
          message: "Username must be between 3 and 20 alphanumeric characters.",
        });
      }

      // Check if username is taken by another user
      const isTaken = data.users.some(
        (u) =>
          u.email !== user.email &&
          normalizeUsername(u.username) === normalized,
      );

      if (isTaken) {
        return res
          .status(409)
          .json({ success: false, message: "Username is already taken." });
      }

      user.username = normalized;
    }

    if (storageMode === "mongo" && mongoReady && MongoUser) {
      enqueuePersist(async () => {
        await MongoUser.updateOne(
          { email: user.email },
          { $set: { name: user.name, username: user.username } },
        );
      });
    } else if (storageMode === "postgres" && pgPool) {
      enqueuePersist(async () => {
        await pgPool.query(
          "UPDATE users SET name = $1, username = $2 WHERE email = $3",
          [user.name, user.username, user.email],
        );
      });
    } else {
      saveData(data);
    }

    logActivity(req, "profile_update", {
      name: user.name,
      username: user.username,
    });

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      user: {
        email: user.email,
        username: user.username,
        name: user.name,
        id: user.id,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}

function attachUserFromTokenIfPresent(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    req.user = null;
    return;
  }
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
  } catch {
    req.user = null;
  }
}

app.post("/api/session/ping", verifyToken, (req, res) => {
  const page = String(req.body?.page || "").slice(0, 120);
  const visibility = String(req.body?.visibility || "").slice(0, 32);
  logActivity(req, "session_ping", {
    page: page || null,
    visibility: visibility || null,
  });
  return res.json({
    success: true,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/session/logout", verifyToken, (req, res) => {
  const reason = String(req.body?.reason || "user").slice(0, 64);
  logActivity(req, "auth_logout", { reason });
  return res.json({
    success: true,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/memories", verifyToken, (req, res) => {
  try {
    const data = loadData();
    const allMemories = data.memories[req.user.email] || [];
    const includePersonal = isPersonalUnlocked(req);
    const memories = includePersonal
      ? allMemories
      : allMemories.filter((m) => m.vault_type !== "personal");
    logActivity(req, "memories_list", {
      total: memories.length,
      personalUnlocked: includePersonal,
    });
    return res.json({
      success: true,
      data: memories,
      personalLocked: !includePersonal,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/memories/trending", (req, res) => {
  try {
    const data = loadData();
    // Aggregate ALL non-personal memories from ALL users for a global trending feed
    const allPublicMemories = [];

    // Iterate through all memory buckets (by email)
    if (data.memories && typeof data.memories === "object") {
      for (const [email, list] of Object.entries(data.memories)) {
        if (!Array.isArray(list)) continue;

        // Skip synthetic/test users
        if (isLikelySyntheticEmail(email)) continue;

        for (const m of list) {
          // Skip personal vault items
          if (String(m?.vault_type || "").toLowerCase() === "personal")
            continue;

          // Only show memories marked as important in trending
          if (!m.is_important) continue;

          allPublicMemories.push({
            id: m.id,
            title: m.title,
            content: m.content,
            vault_type: m.vault_type,
            timestamp: m.timestamp,
            is_important: m.is_important,
            isFavorite: m.isFavorite,
            user_email: email,
          });
        }
      }
    }

    // Sort by a "trending" score: Favorites/Importance have higher weight, then recency
    const trending = allPublicMemories
      .sort((a, b) => {
        const scoreA = (a.is_important ? 5 : 0) + (a.isFavorite ? 3 : 0);
        const scoreB = (b.is_important ? 5 : 0) + (b.isFavorite ? 3 : 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
      })
      .slice(0, 12) // Top 12 trending
      .map((m) => ({
        id: m.id,
        title: m.title,
        content: m.content,
        vault_type: m.vault_type,
        timestamp: m.timestamp,
        is_important: m.is_important,
        isFavorite: m.isFavorite,
        // Optional: obfuscate contributor email
        contributor: String(m.user_email).split("@")[0],
      }));

    return res.json({ success: true, data: trending });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Could not load trending memories",
    });
  }
});

app.post("/api/memories", verifyToken, async (req, res) => {
  try {
    const { title, content, is_important, vault_type, tags } = req.body;
    if (vault_type === "personal" && !isPersonalUnlocked(req)) {
      return res.status(403).json({
        success: false,
        message: "Unlock personal vault with your PIN first",
      });
    }

    const data = loadData();

    if (!data.memories[req.user.email]) {
      data.memories[req.user.email] = [];
    }

    const memory = {
      id: Date.now().toString() + "_" + Math.random().toString(36).slice(2, 8),
      title,
      content,
      is_important: Boolean(is_important),
      vault_type,
      tags: Array.isArray(tags) ? tags : [],
      timestamp: new Date(),
      user_email: req.user.email,
    };

    data.memories[req.user.email].push(memory);

    // Perform surgical DB update instead of full saveData(data)
    if (storageMode === "mongo" && mongoReady && MongoMemory) {
      enqueuePersist(async () => {
        await MongoMemory.create({
          id: String(memory.id),
          user_email: String(memory.user_email),
          title: String(memory.title || ""),
          content: String(memory.content || ""),
          is_important: Boolean(memory.is_important),
          vault_type: String(memory.vault_type || ""),
          tags: memory.tags,
          timestamp: memory.timestamp,
        });
      });
    } else if (storageMode === "postgres" && pgPool) {
      enqueuePersist(async () => {
        await pgPool.query(
          "INSERT INTO memories (id, user_email, title, content, is_important, vault_type, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [
            memory.id,
            memory.user_email,
            memory.title,
            memory.content,
            memory.is_important,
            memory.vault_type,
            memory.timestamp,
          ],
        );
      });
    } else {
      saveData(data); // Fallback for JSON mode
    }

    logActivity(req, "memory_create", {
      vault_type: memory.vault_type,
      is_important: Boolean(memory.is_important),
    });

    return res.json({ success: true, data: memory });
  } catch (error) {
    console.error("Memory create error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.patch("/api/memories/:id", verifyToken, async (req, res) => {
  try {
    const data = loadData();
    const memories = data.memories[req.user.email] || [];
    const requestedId = String(req.params.id || "");
    const memory = memories.find((m) => String(m?.id || "") === requestedId);

    if (!memory) {
      return res
        .status(404)
        .json({ success: false, message: "Memory not found" });
    }
    if (memory.vault_type === "personal" && !isPersonalUnlocked(req)) {
      return res.status(403).json({
        success: false,
        message: "Unlock personal vault with your PIN first",
      });
    }

    const { isFavorite, title, content, is_important, vault_type, tags } =
      req.body;
    if (
      typeof vault_type === "string" &&
      vault_type === "personal" &&
      !isPersonalUnlocked(req)
    ) {
      return res.status(403).json({
        success: false,
        message: "Unlock personal vault with your PIN first",
      });
    }

    const updates = {};
    if (typeof isFavorite === "boolean") {
      memory.isFavorite = isFavorite;
      updates.isFavorite = isFavorite;
    }
    if (typeof title === "string") {
      memory.title = title;
      updates.title = title;
    }
    if (typeof content === "string") {
      memory.content = content;
      updates.content = content;
    }
    if (typeof is_important === "boolean") {
      memory.is_important = is_important;
      updates.is_important = is_important;
    }
    if (typeof vault_type === "string") {
      memory.vault_type = vault_type;
      updates.vault_type = vault_type;
    }
    if (Array.isArray(tags)) {
      memory.tags = tags;
      updates.tags = tags;
    }

    if (Object.keys(updates).length > 0) {
      if (storageMode === "mongo" && mongoReady && MongoMemory) {
        enqueuePersist(async () => {
          await MongoMemory.updateOne({ id: requestedId }, { $set: updates });
        });
      } else if (storageMode === "postgres" && pgPool) {
        enqueuePersist(async () => {
          const sets = Object.keys(updates).map(
            (k, i) => `${k === "isFavorite" ? "is_favorite" : k} = $${i + 1}`,
          );
          const values = Object.values(updates);
          await pgPool.query(
            `UPDATE memories SET ${sets.join(", ")} WHERE id = $${
              values.length + 1
            }`,
            [...values, requestedId],
          );
        });
      } else {
        saveData(data);
      }
    }

    logActivity(req, "memory_update", {
      id: memory.id,
      vault_type: memory.vault_type,
    });
    return res.json({ success: true, data: memory });
  } catch (error) {
    console.error("Memory update error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/api/memories/:id", verifyToken, async (req, res) => {
  try {
    const data = loadData();
    const memories = data.memories[req.user.email] || [];
    const requestedId = String(req.params.id || "");
    const index = memories.findIndex(
      (m) => String(m?.id || "") === requestedId,
    );

    if (index === -1) {
      return res
        .status(404)
        .json({ success: false, message: "Memory not found" });
    }
    if (
      memories[index]?.vault_type === "personal" &&
      !isPersonalUnlocked(req)
    ) {
      return res.status(403).json({
        success: false,
        message: "Unlock personal vault with your PIN first",
      });
    }

    const removed = memories[index];
    memories.splice(index, 1);

    // Surgical DB delete
    if (storageMode === "mongo" && mongoReady && MongoMemory) {
      enqueuePersist(async () => {
        await MongoMemory.deleteOne({ id: requestedId });
      });
    } else if (storageMode === "postgres" && pgPool) {
      enqueuePersist(async () => {
        await pgPool.query("DELETE FROM memories WHERE id = $1", [requestedId]);
      });
    } else {
      saveData(data);
    }

    logActivity(req, "memory_delete", {
      id: removed?.id,
      vault_type: removed?.vault_type,
    });

    return res.json({ success: true, message: "Memory deleted" });
  } catch (error) {
    console.error("Memory delete error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "how",
    "i",
    "if",
    "in",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "was",
    "were",
    "what",
    "when",
    "where",
    "who",
    "why",
    "with",
    "you",
  ]);

  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

const knowledgeBase = loadKnowledgeBase();
const MEMORY_VAULT_KEYWORDS = new Set([
  "memory",
  "memories",
  "vault",
  "vaults",
  "entry",
  "entries",
  "diary",
  "pin",
  "personal",
  "learning",
  "cultural",
  "future",
  "wisdom",
  "knowledge",
  "favorite",
  "favorites",
  "search",
  "filter",
  "export",
  "csv",
  "txt",
  "signin",
  "signup",
  "login",
  "logout",
  "auth",
  "token",
  "jwt",
  "openai",
  "assistant",
  "chat",
  "backend",
  "frontend",
  "api",
  "users",
  "account",
  "health",
  "sync",
  "offline",
  "retry",
  "connection",
  "memory vault",
]);

function getKnowledgeScore(entry, queryTokens, lowerMessage) {
  const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
  const combined = normalizeText(
    [entry.topic || "", entry.answer || "", keywords.join(" ")].join(" "),
  );

  let score = 0;
  for (const token of queryTokens) {
    if (combined.includes(token)) score += 2;
  }

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (normalizedKeyword && lowerMessage.includes(normalizedKeyword))
      score += 4;
  }

  return score;
}

function getRelevantKnowledgeEntries(
  message,
  limit = 4,
  includeDefaults = true,
) {
  const entries = Array.isArray(knowledgeBase.entries)
    ? knowledgeBase.entries
    : [];
  const queryTokens = tokenize(message);
  const lowerMessage = normalizeText(message);

  if (!entries.length) return [];

  const ranked = entries
    .map((entry) => ({
      entry,
      score: getKnowledgeScore(entry, queryTokens, lowerMessage),
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

  if (normalized.includes("memory vault")) return true;

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.some((token) => MEMORY_VAULT_KEYWORDS.has(token))) return true;
  return false;
}

function getOutOfScopeResponse() {
  return "I am your Memory Vault companion. How can I help you today?";
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
    const daysOld = Math.max(
      0,
      (Date.now() - timestamp) / (1000 * 60 * 60 * 24),
    );
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
    learning: userMemories.filter((m) => m.vault_type === "learning").length,
    cultural: userMemories.filter((m) => m.vault_type === "cultural").length,
    future: userMemories.filter((m) => m.vault_type === "future").length,
    personal: userMemories.filter((m) => m.vault_type === "personal").length,
    important: userMemories.filter((m) => m.is_important).length,
  };

  const relevantSection = relevantMemories.length
    ? relevantMemories
        .map(
          (m, idx) =>
            `${idx + 1}. [${m.vault_type}] ${m.title}\n${String(
              m.content || "",
            ).slice(0, 500)}`,
        )
        .join("\n\n")
    : "No strongly relevant memory found for this question.";

  const recentSection = recentMemories.length
    ? recentMemories
        .map((m, idx) => `${idx + 1}. [${m.vault_type}] ${m.title}`)
        .join("\n")
    : "No memories yet.";

  return {
    relevantMemories,
    contextText: [
      "Memory Vault summary",
      `- Total memories: ${counts.total}`,
      `- Learning: ${counts.learning}`,
      `- Cultural: ${counts.cultural}`,
      `- Future: ${counts.future}`,
      `- Personal: ${counts.personal}`,
      `- Important: ${counts.important}`,
      "",
      "Most relevant memories for this question:",
      relevantSection,
      "",
      "Most recent memory titles:",
      recentSection,
    ].join("\n"),
  };
}

function buildKnowledgeContextForAI(message) {
  const relevantKnowledge = getRelevantKnowledgeEntries(message, 4);
  const section = relevantKnowledge.length
    ? relevantKnowledge
        .map((entry, idx) => `${idx + 1}. ${entry.topic}\n${entry.answer}`)
        .join("\n\n")
    : "No Memory Vault knowledge entry matched this question.";

  return {
    relevantKnowledge,
    contextText: ["Verified Memory Vault knowledge:", section].join("\n"),
  };
}

function buildAppCapabilityContext() {
  return [
    "Memory Vault app capabilities:",
    "- Authentication: sign up, sign in, social OAuth (when configured), forgot/reset password.",
    "- Vaults: personal (PIN-protected), learning, cultural, future.",
    "- Memory actions: create, list, search, update favorite, delete, export JSON/CSV/TXT.",
    "- Dashboard and metrics: streak, prompts, reminders, activity summaries.",
    "- AI assistant: can answer app usage questions and perform memory actions when explicitly requested.",
    "- Admin area (owner only): stats, users, activities, active users.",
    "- If user asks how to do something in the app, provide concrete UI steps.",
    "- If user asks about missing config/integration, explain what is needed and where to set it.",
  ].join("\n");
}

function normalizeVaultType(input) {
  const value = normalizeText(input);
  if (!value) return "learning";
  if (value.includes("personal") || value.includes("diary")) return "personal";
  if (value.includes("cultural") || value.includes("culture"))
    return "cultural";
  if (value.includes("future") || value.includes("goal")) return "future";
  if (
    value.includes("learning") ||
    value.includes("study") ||
    value.includes("knowledge")
  )
    return "learning";
  return "learning";
}

function parseLimitFromText(text, fallback = 5, max = 20) {
  const raw = String(text || "").toLowerCase();
  const match = raw.match(/\b(?:top|last|recent|show|list)?\s*(\d{1,2})\b/);
  const parsed = Number(match?.[1] || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function parseMemoryTarget(rawMessage) {
  const raw = String(rawMessage || "").trim();
  const idMatch = raw.match(/\bid\s*[:=]?\s*([a-z0-9_-]{5,})/i);
  if (idMatch?.[1]) {
    return { id: idMatch[1], text: "" };
  }

  const quoted = raw.match(/["“](.+?)["”]/);
  if (quoted?.[1]) {
    return { id: "", text: quoted[1].trim() };
  }

  const memoryIndex = raw.toLowerCase().indexOf("memory");
  if (memoryIndex >= 0) {
    const rest = raw
      .slice(memoryIndex + "memory".length)
      .replace(/^(\s*(called|named|title|with)\s*)/i, "")
      .trim();
    return { id: "", text: rest };
  }
  return { id: "", text: "" };
}

function resolveMemoryByTarget(memories, target) {
  if (!Array.isArray(memories) || memories.length === 0) return null;
  if (target?.id) {
    return memories.find((m) => String(m.id) === String(target.id)) || null;
  }

  const query = normalizeText(target?.text || "");
  if (!query) return null;
  const matches = memories.filter((m) => {
    const title = normalizeText(m.title);
    const content = normalizeText(m.content);
    return title.includes(query) || content.includes(query);
  });
  if (!matches.length) return null;
  return [...matches].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
  )[0];
}

function parseAIAssistantAction(message) {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();
  if (!lower) return null;

  const createIntent =
    /^(add|create|save)\b.*\bmemory\b/.test(lower) ||
    /^(remember|note|log)\b/.test(lower) ||
    /\b(save|add|create)\b.*\b(this|that)\b/.test(lower);
  if (createIntent) {
    const segments = raw
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    let title = "";
    let content = "";
    let vaultType = "";
    let important = /\bimportant\b/.test(lower);

    for (const segment of segments) {
      const titleMatch = segment.match(/^title\s*[:=]\s*(.+)$/i);
      if (titleMatch) {
        title = titleMatch[1].trim();
        continue;
      }
      const contentMatch = segment.match(/^content\s*[:=]\s*(.+)$/i);
      if (contentMatch) {
        content = contentMatch[1].trim();
        continue;
      }
      const vaultMatch = segment.match(/^vault\s*[:=]\s*(.+)$/i);
      if (vaultMatch) {
        vaultType = vaultMatch[1].trim();
        continue;
      }
      if (/^important\s*[:=]?\s*(yes|true|1)?$/i.test(segment)) {
        important = true;
      }
    }

    if (!content) {
      content = raw
        .replace(/^(add|create|save)\s+memory\s*[:\-]?\s*/i, "")
        .trim();
      if (
        content.toLowerCase().startsWith("title:") ||
        content.toLowerCase().startsWith("content:")
      ) {
        content = "";
      }
    }
    if (!title && content) {
      title = content.slice(0, 60);
    }

    return {
      type: "create_memory",
      title: title || "",
      content: content || "",
      vaultType: normalizeVaultType(vaultType || ""),
      important,
    };
  }

  if (
    /^(list|show|display)\b.*\bmemories?\b/.test(lower) ||
    /\brecent memories\b/.test(lower)
  ) {
    return { type: "list_memories", limit: parseLimitFromText(lower, 5, 20) };
  }

  if (/^(search|find)\b.*\bmemories?\b/.test(lower)) {
    const query = raw
      .replace(/^(search|find)\s+(my\s+)?memories?\s*(for|about)?\s*/i, "")
      .trim();
    return {
      type: "search_memories",
      query,
      limit: parseLimitFromText(lower, 8, 20),
    };
  }

  if (/^(delete|remove)\b.*\bmemory\b/.test(lower)) {
    return { type: "delete_memory", target: parseMemoryTarget(raw) };
  }

  if (
    /^(favorite|favourite|star|unfavorite|unfavourite|unstar)\b.*\bmemory\b/.test(
      lower,
    )
  ) {
    const unset = /^(unfavorite|unfavourite|unstar)\b/.test(lower);
    return {
      type: "favorite_memory",
      favorite: !unset,
      target: parseMemoryTarget(raw),
    };
  }

  if (
    /\b(memory stats|memory summary|memories summary|summarize memories)\b/.test(
      lower,
    ) ||
    (/\bhow many\b/.test(lower) && /\bmemories?\b/.test(lower))
  ) {
    return { type: "memory_stats" };
  }

  return null;
}

function parseStudentHelpIntent(message) {
  const lower = String(message || "")
    .trim()
    .toLowerCase();
  if (!lower) return null;

  if (
    /\b(sign in|signin|log in|login|sign up|signup|register|create account)\b/.test(
      lower,
    )
  ) {
    return { type: "help_auth" };
  }
  if (/\b(forgot password|reset password|recover account)\b/.test(lower)) {
    return { type: "help_reset_password" };
  }
  if (/\b(add|create|save|write)\b.*\b(memory|note|entry)\b/.test(lower)) {
    return { type: "help_add_memory" };
  }
  if (/\b(search|find|locate)\b.*\b(memory|note|entry)\b/.test(lower)) {
    return { type: "help_search_memory" };
  }
  if (
    /\b(study plan|revision plan|exam prep|prepare for exam|test prep)\b/.test(
      lower,
    )
  ) {
    return { type: "help_study_plan" };
  }
  if (
    /\b(personal vault|pin|lock diary|unlock diary|private diary)\b/.test(lower)
  ) {
    return { type: "help_personal_vault" };
  }
  if (/\b(export|download|backup)\b.*\b(memory|memories|notes)\b/.test(lower)) {
    return { type: "help_export" };
  }
  if (/\b(admin|dashboard|owner)\b/.test(lower)) {
    return { type: "help_admin" };
  }
  if (/\b(ai|assistant|what can you do|help me use)\b/.test(lower)) {
    return { type: "help_ai_usage" };
  }

  return null;
}

function executeStudentHelpIntent(intent, data, userEmail) {
  const allMemories = Array.isArray(data?.memories?.[userEmail])
    ? data.memories[userEmail]
    : [];
  const count = allMemories.length;
  const learningCount = allMemories.filter(
    (m) => m.vault_type === "learning",
  ).length;

  if (intent.type === "help_auth") {
    return "To enter quickly: 1) Open Sign In. 2) Enter your email/username and password. 3) Tap Sign In. If you are new, switch to Sign Up and create your account first.";
  }
  if (intent.type === "help_reset_password") {
    return "Use Forgot Password on the auth form, enter your registered email, open the reset link, then set a new password with letters and numbers.";
  }
  if (intent.type === "help_add_memory") {
    return "Fast flow: 1) Open a vault. 2) Tap Add Memory. 3) Write a clear title + short content. 4) Mark important if needed. 5) Save. Tip: one idea per memory improves revision.";
  }
  if (intent.type === "help_search_memory") {
    return 'Use the top search bar and type keywords from your title/content. You can also ask AI: "search memories for biology formulas" to find them faster.';
  }
  if (intent.type === "help_study_plan") {
    return `Student plan using your app: Today capture 3 learning memories, mark 1 as important, then ask AI for a summary. Current progress: ${count} total memories, ${learningCount} learning memories.`;
  }
  if (intent.type === "help_personal_vault") {
    return "Personal Vault is PIN-protected. Open Personal Diary, enter your PIN to unlock, write entries, then lock again for privacy. If forgotten, use the reset PIN option.";
  }
  if (intent.type === "help_export") {
    return "Open Backup/Export, choose scope (all or important), then download JSON/CSV/TXT. Use CSV for spreadsheet revision and JSON for full backup.";
  }
  if (intent.type === "help_admin") {
    return "Admin dashboard is owner-only and local-restricted. Sign in with owner account, open Admin, set admin key, then review users, activities, and stats.";
  }
  if (intent.type === "help_ai_usage") {
    return 'Ask me naturally. Examples: "summarize my recent learning notes", "find my calculus memory", "create memory: title: Week 3 recap; content: ...", "how do I revise better with this app?"';
  }

  return null;
}

function executeAIAssistantAction(req, action, data) {
  const allMemories = Array.isArray(data?.memories?.[req.user.email])
    ? data.memories[req.user.email]
    : [];
  const sorted = [...allMemories].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
  );

  if (action.type === "list_memories") {
    const limit = Math.max(1, Math.min(20, Number(action.limit) || 5));
    if (!sorted.length) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          'You have no memories yet. Say: "add memory; title: ...; content: ..."',
      };
    }
    const lines = sorted
      .slice(0, limit)
      .map((m, i) => `${i + 1}. [${m.vault_type}] ${m.title} (id: ${m.id})`);
    logActivity(req, "ai_memory_list", { limit, total: sorted.length });
    return {
      handled: true,
      action: action.type,
      changed: false,
      response: `Here are your latest ${Math.min(
        limit,
        sorted.length,
      )} memories:\n${lines.join("\n")}`,
    };
  }

  if (action.type === "memory_stats") {
    const byVault = {
      learning: allMemories.filter((m) => m.vault_type === "learning").length,
      cultural: allMemories.filter((m) => m.vault_type === "cultural").length,
      future: allMemories.filter((m) => m.vault_type === "future").length,
      personal: allMemories.filter((m) => m.vault_type === "personal").length,
    };
    const favorites = allMemories.filter((m) => Boolean(m.isFavorite)).length;
    const important = allMemories.filter((m) => Boolean(m.is_important)).length;
    logActivity(req, "ai_memory_stats");
    return {
      handled: true,
      action: action.type,
      changed: false,
      response: `Memory summary: total ${allMemories.length}, learning ${byVault.learning}, cultural ${byVault.cultural}, future ${byVault.future}, personal ${byVault.personal}, important ${important}, favorites ${favorites}.`,
    };
  }

  if (action.type === "search_memories") {
    const query = String(action.query || "").trim();
    if (!query) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          'Tell me what to search. Example: "search memories for calculus".',
      };
    }
    const matches = getRelevantMemories(
      query,
      allMemories,
      Math.max(1, Math.min(20, Number(action.limit) || 8)),
    );
    if (!matches.length) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response: `No memory matched "${query}".`,
      };
    }
    const lines = matches.map(
      (m, i) => `${i + 1}. [${m.vault_type}] ${m.title} (id: ${m.id})`,
    );
    logActivity(req, "ai_memory_search", { query, matches: matches.length });
    return {
      handled: true,
      action: action.type,
      changed: false,
      response: `Found ${matches.length} matching memories:\n${lines.join(
        "\n",
      )}`,
    };
  }

  if (action.type === "create_memory") {
    const title = String(action.title || "").trim();
    const content = String(action.content || "").trim();
    const vaultType = normalizeVaultType(action.vaultType);
    const isImportant = Boolean(action.important);

    if (!content) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          "I need memory content to save. Example: add memory; title: Lesson; content: I learned active recall; vault: learning",
      };
    }
    if (vaultType === "personal" && !isPersonalUnlocked(req)) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          "Personal vault is locked. Unlock your personal PIN first, then ask again.",
      };
    }

    if (!Array.isArray(data.memories[req.user.email]))
      data.memories[req.user.email] = [];
    const memory = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: title || content.slice(0, 60),
      content,
      is_important: isImportant,
      vault_type: vaultType,
      timestamp: new Date(),
      user_email: req.user.email,
    };
    data.memories[req.user.email].push(memory);
    saveData(data);
    logActivity(req, "ai_memory_create", {
      id: memory.id,
      vault_type: memory.vault_type,
      is_important: isImportant,
    });
    return {
      handled: true,
      action: action.type,
      changed: true,
      response: `Saved memory "${memory.title}" in ${memory.vault_type} vault (id: ${memory.id}).`,
    };
  }

  if (action.type === "delete_memory") {
    const targetMemory = resolveMemoryByTarget(
      allMemories,
      action.target || {},
    );
    if (!targetMemory) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          "I could not find that memory. Use id: <memory-id> or include the exact title in quotes.",
      };
    }
    if (targetMemory.vault_type === "personal" && !isPersonalUnlocked(req)) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          "Personal vault is locked. Unlock your personal PIN before deleting personal memories.",
      };
    }

    const list = data.memories[req.user.email] || [];
    const index = list.findIndex(
      (m) => String(m.id) === String(targetMemory.id),
    );
    if (index === -1) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response: "Memory no longer exists.",
      };
    }
    const removed = list[index];
    list.splice(index, 1);
    saveData(data);
    logActivity(req, "ai_memory_delete", {
      id: removed.id,
      vault_type: removed.vault_type,
    });
    return {
      handled: true,
      action: action.type,
      changed: true,
      response: `Deleted memory "${removed.title}" (id: ${removed.id}).`,
    };
  }

  if (action.type === "favorite_memory") {
    const targetMemory = resolveMemoryByTarget(
      allMemories,
      action.target || {},
    );
    if (!targetMemory) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          "I could not find that memory to update favorite status. Use id: <memory-id> or quote the title.",
      };
    }
    if (targetMemory.vault_type === "personal" && !isPersonalUnlocked(req)) {
      return {
        handled: true,
        action: action.type,
        changed: false,
        response:
          "Personal vault is locked. Unlock your personal PIN before changing personal favorites.",
      };
    }
    targetMemory.isFavorite = Boolean(action.favorite);
    saveData(data);
    logActivity(req, "ai_memory_favorite", {
      id: targetMemory.id,
      value: targetMemory.isFavorite,
    });
    return {
      handled: true,
      action: action.type,
      changed: true,
      response: `${
        targetMemory.isFavorite ? "Added" : "Removed"
      } favorite for "${targetMemory.title}" (id: ${targetMemory.id}).`,
    };
  }

  return { handled: false };
}

function generateFallbackResponse(
  message,
  userMemories,
  userName,
  relevantMemories = [],
  relevantKnowledge = [],
) {
  const lowerMessage = String(message || "").toLowerCase();
  const appRelated = isAppRelatedQuestion(lowerMessage);
  const learningCount = userMemories.filter(
    (m) => m.vault_type === "learning",
  ).length;
  const culturalCount = userMemories.filter(
    (m) => m.vault_type === "cultural",
  ).length;
  const personalCount = userMemories.filter(
    (m) => m.vault_type === "personal",
  ).length;
  const futureCount = userMemories.filter(
    (m) => m.vault_type === "future",
  ).length;
  const totalCount = userMemories.length;
  const recentMemories = userMemories.slice(0, 3).map((m) => m.title);
  const relevantTitles = relevantMemories.slice(0, 3).map((m) => m.title);
  const topKnowledge = relevantKnowledge[0];
  const userDataIntent =
    lowerMessage.includes("my ") ||
    lowerMessage.includes(" i ") ||
    lowerMessage.startsWith("i ") ||
    lowerMessage.includes("how many") ||
    lowerMessage.includes("recent") ||
    lowerMessage.includes("saved") ||
    lowerMessage.includes("find") ||
    lowerMessage.includes("show");
  const onboardingIntent =
    lowerMessage.includes("new user") ||
    lowerMessage.includes("first time") ||
    lowerMessage.includes("getting started") ||
    lowerMessage.includes("get started") ||
    lowerMessage.includes("how to start") ||
    lowerMessage.includes("how do i start") ||
    lowerMessage.includes("how to use") ||
    lowerMessage.includes("how do i use") ||
    lowerMessage.includes("use memory vault");

  if (totalCount === 0 && onboardingIntent) {
    return [
      "Welcome to Memory Vault. Quick start:",
      "1) Sign in and pick a vault (personal, learning, cultural, or future).",
      "2) Add your first memory with a clear title and meaningful content.",
      "3) Mark important memories so they are easier to revisit.",
      '4) Open AI Assistant and ask: "summarize my memories" or "help me organize entries".',
    ].join(" ");
  }

  if (topKnowledge?.answer && !userDataIntent && appRelated) {
    return topKnowledge.answer;
  }

  if (
    lowerMessage.includes("what is memory vault") ||
    (lowerMessage.includes("what is") && lowerMessage.includes("memory vault"))
  ) {
    return "Memory Vault is your personal knowledge and reflection app. It helps you save life notes, learning insights, cultural stories, and future goals in one place, then lets AI help you explore them.";
  }

  if (
    lowerMessage.includes("how to use") ||
    lowerMessage.includes("how do i use") ||
    lowerMessage.includes("use memory vault")
  ) {
    return "Use Memory Vault in 3 steps: sign in, choose a vault type (personal, learning, cultural, or future), and add entries with title and content. Then open AI Assistant to ask for summaries, trends, or specific memory lookups.";
  }

  if (
    lowerMessage.includes("how to write memories") ||
    lowerMessage.includes("how do i write memories") ||
    (lowerMessage.includes("write") && lowerMessage.includes("memory"))
  ) {
    return "To write a strong memory: give it a clear title, describe what happened, include what you learned or felt, and mark it important if needed. Keep one memory per entry so AI can find and summarize it accurately.";
  }

  if (lowerMessage.includes("name") || lowerMessage.includes("who are you")) {
    return `I am your Memory Vault assistant. Your profile name is ${userName}. I can help with your ${totalCount} stored memories across all vaults.`;
  }

  if (lowerMessage.includes("how many") && lowerMessage.includes("memory")) {
    return `You have ${totalCount} memories: ${learningCount} learning, ${culturalCount} cultural, ${personalCount} personal, and ${futureCount} future.`;
  }

  if (lowerMessage.includes("recent") || lowerMessage.includes("saved")) {
    const recentList =
      recentMemories.length > 0 ? recentMemories.join(", ") : "none yet";
    return `Your recent memories are: ${recentList}.`;
  }

  if (
    (lowerMessage.includes("about") ||
      lowerMessage.includes("find") ||
      lowerMessage.includes("show")) &&
    relevantTitles.length > 0
  ) {
    return `I found related memories: ${relevantTitles.join(
      ", ",
    )}. Ask a follow-up and I can summarize them.`;
  }

  if (!appRelated) {
    return "I encountered a minor connection issue while trying to reach my advanced intelligence engine. Please ensure your OpenAI API Key is valid in the server configuration. In the meantime, I can still help you with Memory Vault features like saving, searching, and organizing your wisdom.";
  }

  return "I am currently operating in basic mode due to a configuration setting. To restore my full ChatGPT/Gemini capabilities, please check the system API keys. I can still assist with your stored memories and app navigation.";
}

function isCodingQuestion(text) {
  const t = String(text || "").toLowerCase();
  return /\b(code|coding|program|programming|developer|python|javascript|java|c\+\+|c#|sql|html|css|api|bug|debug|algorithm)\b/.test(
    t,
  );
}

function isAppRelatedQuestion(text) {
  const t = String(text || "").toLowerCase();
  return /\b(memory vault|vault|memory|memories|auth|signin|sign in|signup|sign up|password|pin|diary|learning|cultural|future|admin|export|backup|dashboard|ai assistant)\b/.test(
    t,
  );
}

async function askGeneralKnowledgeFallback(message) {
  const query = String(message || "").trim();
  if (!query) return "";

  try {
    const wikiTopic = query
      .replace(
        /^(what is|who is|where is|when is|why is|how does|how do|define|explain)\s+/i,
        "",
      )
      .replace(/[?!.]+$/g, "")
      .trim();
    if (wikiTopic) {
      const wikiResp = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          wikiTopic,
        )}`,
        { method: "GET", signal: AbortSignal.timeout(8000) },
      );
      if (wikiResp.ok) {
        const wiki = await wikiResp.json().catch(() => ({}));
        const extract = String(wiki?.extract || "").trim();
        if (extract) return extract;
      }
    }
  } catch {}

  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(
        query,
      )}&format=json&no_html=1&skip_disambig=1`,
      { method: "GET", signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return "";
    const data = await response.json().catch(() => ({}));

    const abstract = String(data?.AbstractText || "").trim();
    if (abstract) return abstract;

    const heading = String(data?.Heading || "").trim();
    const firstRelated = Array.isArray(data?.RelatedTopics)
      ? data.RelatedTopics.find((item) => String(item?.Text || "").trim())
      : null;
    const relatedText = String(firstRelated?.Text || "").trim();
    if (relatedText) {
      return heading ? `${heading}: ${relatedText}` : relatedText;
    }
  } catch {}

  return "";
}

async function buildWebContextForAI(message) {
  const query = String(message || "").trim();
  if (!query) return "";

  const contextParts = [];
  const cleanedTopic = query
    .replace(
      /^(what is|who is|where is|when is|why is|how does|how do|define|explain)\s+/i,
      "",
    )
    .replace(/[?!.]+$/g, "")
    .trim();

  try {
    if (cleanedTopic) {
      const wikiResp = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
          cleanedTopic,
        )}`,
        { method: "GET", signal: AbortSignal.timeout(7000) },
      );
      if (wikiResp.ok) {
        const wiki = await wikiResp.json().catch(() => ({}));
        const title = String(wiki?.title || cleanedTopic).trim();
        const extract = String(wiki?.extract || "").trim();
        const url = String(wiki?.content_urls?.desktop?.page || "").trim();
        if (extract) {
          contextParts.push(
            [
              `Source: Wikipedia (${title})`,
              `Summary: ${extract}`,
              url ? `URL: ${url}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
    }
  } catch {}

  try {
    const ddgResp = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(
        query,
      )}&format=json&no_html=1&skip_disambig=1`,
      { method: "GET", signal: AbortSignal.timeout(7000) },
    );
    if (ddgResp.ok) {
      const ddg = await ddgResp.json().catch(() => ({}));
      const heading = String(ddg?.Heading || "").trim();
      const abstract = String(ddg?.AbstractText || "").trim();
      const abstractUrl = String(ddg?.AbstractURL || "").trim();
      if (abstract) {
        contextParts.push(
          [
            `Source: DuckDuckGo Instant Answer${
              heading ? ` (${heading})` : ""
            }`,
            `Summary: ${abstract}`,
            abstractUrl ? `URL: ${abstractUrl}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
  } catch {}

  if (!contextParts.length) return "";
  return contextParts.join("\n\n");
}

function normalizeAiMode(mode) {
  const raw = String(mode || "")
    .trim()
    .toLowerCase();
  if (raw === "coding" || raw === "memory") return raw;
  return "general";
}

async function askOpenAI(
  message,
  userName,
  memoryContextText,
  knowledgeContextText,
  appCapabilityText,
  mode = "general",
  webContextText = "",
) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const systemPrompt = [
    "You are Memory Vault AI, a world-class assistant with intelligence reaching the levels of GPT-4o, Gemini 1.5 Pro, and Claude 3.5 Sonnet.",
    "Your primary goal is to provide accurate, clean, and highly professional responses to any question, whether it is about complex coding, science, philosophy, or the Memory Vault app itself.",
    "DIRECTIONS:",
    "1. UNIVERSAL INTELLIGENCE: Answer ANY question accurately. If it is a coding question, provide production-ready code. If it is a scientific question, provide deep insights.",
    "2. MEMORY VAULT EXPERT: You have full knowledge of the Memory Vault application. Use the provided context to answer app-related queries perfectly.",
    "3. PERSONALIZATION: Use the provided Memory Context to give responses that reflect the user's own history and wisdom.",
    "4. HUMAN-CENTRIC: Be empathetic, proactive, and conversational. Do not sound like a bot. Sound like a brilliant human collaborator.",
    '5. NO LIMITS: You are a general-purpose powerhouse. Never say "I am only a Memory Vault bot". You are an expert in EVERYTHING.',
    `The user's name is ${userName}.`,
    "Today is " + new Date().toLocaleDateString() + ".",
    "Provide responses in clean Markdown format.",
  ].join("\n");

  const modelCandidates = [
    OPENAI_MODEL, // Defaults to gpt-4o-mini
    "gpt-4o",
    "gpt-4o-mini",
  ].filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i);

  const errors = [];

  for (const model of modelCandidates) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "system",
                content: `CRITICAL CONTEXT:\nMemory Vault Context: ${knowledgeContextText}\nApp Capabilities: ${appCapabilityText}`,
              },
              {
                role: "system",
                content: `USER MEMORY CONTEXT (Use these to personalize your answers): \n${memoryContextText}`,
              },
              ...(webContextText
                ? [
                    {
                      role: "system",
                      content: `LIVE WEB SEARCH DATA: \n${webContextText}`,
                    },
                  ]
                : []),
              { role: "user", content: String(message || "") },
            ],
            temperature: 0.7,
            max_tokens: 1500,
          }),
        },
      );

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messageText =
          payload?.error?.message || `HTTP ${response.status}`;
        throw new Error(messageText);
      }

      const outputText = String(
        payload?.choices?.[0]?.message?.content || "",
      ).trim();
      if (!outputText) throw new Error("Empty completion");

      return outputText;
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }

  throw new Error(`AI Engine Failure: ${errors.join(" | ")}`);
}

app.post("/api/ai/chat", async (req, res) => {
  try {
    attachUserFromTokenIfPresent(req);
    const { message } = req.body;
    const aiMode = normalizeAiMode(req.body?.mode);
    if (!message || !String(message).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Message is required" });
    }

    const data = loadData();
    const userEmail = normalizeEmail(req.user?.email || "");
    const isAuthed = Boolean(userEmail);
    const aiAction = parseAIAssistantAction(message);
    if (aiAction) {
      if (!isAuthed) {
        return res.json({
          success: true,
          response:
            "I can answer any question right now. To save, list, delete, or edit memories, please sign in first.",
          source: "assistant-auth-required",
        });
      }
      const actionResult = executeAIAssistantAction(req, aiAction, data);
      if (actionResult.handled) {
        return res.json({
          success: true,
          response: actionResult.response,
          source: "assistant-action",
          action: actionResult.action,
          changed: Boolean(actionResult.changed),
        });
      }
    }

    const helpIntent = parseStudentHelpIntent(message);
    if (helpIntent) {
      const helpResponse = executeStudentHelpIntent(
        helpIntent,
        data,
        userEmail,
      );
      if (helpResponse) {
        if (isAuthed)
          logActivity(req, "ai_help_intent", { intent: helpIntent.type });
        return res.json({
          success: true,
          response: helpResponse,
          source: "assistant-help",
          intent: helpIntent.type,
        });
      }
    }

    const userMemories = isAuthed ? data.memories[userEmail] || [] : [];
    const user = isAuthed ? getUserRecord(data, userEmail) : null;
    const userName = user?.name || (isAuthed ? "Friend" : "Guest");
    const { relevantMemories, contextText } = buildMemoryContextForAI(
      message,
      userMemories,
    );
    const { relevantKnowledge, contextText: knowledgeContextText } =
      buildKnowledgeContextForAI(message);
    const appCapabilityText = buildAppCapabilityContext();
    const webContextText = await buildWebContextForAI(message);

    try {
      const aiMessage = await askOpenAI(
        message,
        userName,
        contextText,
        knowledgeContextText,
        appCapabilityText,
        aiMode,
        webContextText,
      );
      if (isAuthed) logActivity(req, "ai_chat", { source: "openai" });
      return res.json({
        success: true,
        response: aiMessage,
        source: "openai",
        model: OPENAI_MODEL,
        mode: aiMode,
      });
    } catch (openaiError) {
      const genericAnswer = await askGeneralKnowledgeFallback(message);
      if (genericAnswer) {
        if (isAuthed)
          logActivity(req, "ai_chat", { source: "duckduckgo_fallback" });
        return res.json({
          success: true,
          response: genericAnswer,
          source: "duckduckgo-fallback",
          note: `OpenAI unavailable (${openaiError.message})`,
          mode: aiMode,
        });
      }

      const fallbackResponse = generateFallbackResponse(
        message,
        userMemories,
        userName,
        relevantMemories,
        relevantKnowledge,
      );
      return res.json({
        success: true,
        response: fallbackResponse,
        source: "fallback",
        note: `Using local AI (${openaiError.message})`,
        knowledge_hits: relevantKnowledge.length,
        mode: aiMode,
      });
    }
  } catch (error) {
    attachUserFromTokenIfPresent(req);
    const data = loadData();
    const userEmail = normalizeEmail(req.user?.email || "");
    const isAuthed = Boolean(userEmail);
    const userMemories = isAuthed ? data.memories[userEmail] || [] : [];
    const user = isAuthed ? getUserRecord(data, userEmail) : null;
    const userName = user?.name || (isAuthed ? "Friend" : "Guest");
    const relevantMemories = getRelevantMemories(
      req.body?.message || "",
      userMemories,
      8,
    );
    const { relevantKnowledge } = buildKnowledgeContextForAI(
      req.body?.message || "",
    );
    const genericAnswer = await askGeneralKnowledgeFallback(
      req.body?.message || "",
    );
    if (genericAnswer) {
      return res.json({
        success: true,
        response: genericAnswer,
        source: "duckduckgo-fallback",
        note: `Server fallback (${error.message})`,
      });
    }

    const fallbackResponse = generateFallbackResponse(
      req.body?.message || "",
      userMemories,
      userName,
      relevantMemories,
      relevantKnowledge,
    );

    return res.json({
      success: true,
      response: fallbackResponse,
      source: "fallback",
      note: `Using local AI (${error.message})`,
      knowledge_hits: relevantKnowledge.length,
    });
  }
});

// Removed admin endpoints

app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});

app.get("/api/debug/config", (req, res) => {
  const hasApiKey = !!process.env.OPENAI_API_KEY;

  res.json({
    success: true,
    server: "Running",
    environment: String(process.env.NODE_ENV || "development").trim(),
    openai: {
      configured: hasApiKey,
      model: OPENAI_MODEL,
    },
    knowledge: {
      file: path.basename(knowledgeFile),
      entries: Array.isArray(knowledgeBase.entries)
        ? knowledgeBase.entries.length
        : 0,
      updatedAt: knowledgeBase.updatedAt || "unknown",
    },
    endpoints: {
      health: "/api/health",
      auth: [
        "/api/auth/signup",
        "/api/auth/signin",
        "/api/auth/oauth",
        "/api/auth/forgot-password",
        "/api/auth/reset-password",
      ],
      session: "/api/session/ping",
      memories: "/api/memories",
      ai: "/api/ai/chat",
      personal: [
        "/api/personal/pin/status",
        "/api/personal/pin/setup",
        "/api/personal/pin/verify",
      ],
      admin: ["Stats, activities, and user management are owner-restricted."],
    },
    admin: {
      configured: Boolean(ADMIN_API_KEY),
      ownerConfigured: Boolean(ADMIN_OWNER_EMAIL),
      storageMode,
      storageFile: path.basename(adminDataFile),
    },
    database: {
      mongoConfigured: Boolean(MONGO_URI),
      postgresConfigured: Boolean(DATABASE_URL),
      initError: storageInitLastError || null,
    },
  });
});

async function startServer() {
  await ensureStorageInitialized();

  app.listen(PORT, () => {
    console.log(`Memory Vault Server running on http://localhost:${PORT}`);
    console.log(`Frontend available at http://localhost:${PORT}`);
    console.log(`Storage mode: ${storageMode.toUpperCase()}`);

    const hasApiKey = !!process.env.OPENAI_API_KEY;
    console.log(`OpenAI API Key: ${hasApiKey ? "Configured" : "Missing"}`);
    console.log(`OpenAI Model: ${OPENAI_MODEL}`);
    console.log(`Debug endpoint: http://localhost:${PORT}/api/debug/config`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  ensureStorageInitialized,
};

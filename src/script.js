// Initialize stars
function createStars() {
  const canvas = document.querySelector('.background-canvas');
  if (!canvas) return;
  const isLowPower = window.matchMedia('(max-width: 768px), (prefers-reduced-motion: reduce)').matches;
  const starCount = isLowPower ? 32 : 72;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < starCount; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    star.style.top = Math.random() * 100 + '%';
    star.style.left = Math.random() * 100 + '%';
    star.style.animationDelay = Math.random() * 3 + 's';
    fragment.appendChild(star);
  }
  canvas.appendChild(fragment);
}
createStars();

// Configuration
const defaultConfig = {
  app_title: "Memory Vault",
  app_tagline: "Your living memory journal",
  hero_title: "Build your memory, one day at a time",
  hero_subtitle: "Keep class notes, hard lessons, and personal reflections in a space that feels like your own journal, not a machine.",
  personal_vault_name: "Personal Life Vault",
  learning_vault_name: "Academic Vault",
  cultural_vault_name: "Cultural Heritage",
  future_vault_name: "Future Wisdom",
  font_family: "Inter",
  font_size: 16
};

// State
let memories = [];
let currentVault = '';
let currentPin = '';
let pinAutoSubmitTimer = null;
let isPinSubmitting = false;
let userPin = localStorage.getItem('diary_pin') || null;
let userName = localStorage.getItem('user_name') || 'Friend';
let isSubmitting = false;
let isDataSdkReady = false;
let useLocalStorage = false;
let authMode = 'signin'; // 'signin' | 'signup' | 'reset'
let isLoggedIn = localStorage.getItem('user_logged_in') === 'true';
let userEmail = localStorage.getItem('user_email') || '';
let authToken = localStorage.getItem('auth_token') || '';
let personalUnlockToken = sessionStorage.getItem('personal_unlock_token') || '';
let personalUnlockExpiresAt = Number(sessionStorage.getItem('personal_unlock_expires_at') || 0);
let sessionPingTimer = null;
let memorySearchTimer = null;
let trendingCache = { expiresAt: 0, items: [] };
let trendingRefreshTimer = null;

function normalizeVaultKey(vault) {
  const value = String(vault || '').trim().toLowerCase();
  if (!value) return '';
  const aliases = {
    academic: 'learning',
    academics: 'learning',
    learning: 'learning',
    education: 'learning',
    school: 'learning',
    culture: 'cultural',
    cultural: 'cultural',
    future: 'future',
    personal: 'personal',
    diary: 'personal',
    life: 'personal'
  };
  return aliases[value] || '';
}
const AUTH_ROUTE_MATCH = window.location.pathname.match(/^\/auth(?:\/(signin|signup))?\/?$/i);
const IS_AUTH_ROUTE = Boolean(AUTH_ROUTE_MATCH);

const SOCIAL_CONFIG = {
  googleClientId: String(window.MEMORY_VAULT_GOOGLE_CLIENT_ID || '').trim(),
  facebookAppId: String(window.MEMORY_VAULT_FACEBOOK_APP_ID || '').trim(),
  microsoftClientId: String(window.MEMORY_VAULT_MICROSOFT_CLIENT_ID || '').trim(),
  microsoftTenant: String(window.MEMORY_VAULT_MICROSOFT_TENANT || 'common').trim() || 'common'
};

const SOCIAL_PROVIDER_NAMES = {
  google: 'Google',
  facebook: 'Facebook',
  microsoft: 'Microsoft'
};

const DAILY_PROMPTS = [
  'What concept did you understand better today than yesterday?',
  'What is one exam question you can now answer with confidence?',
  'What did you struggle with today, and what fixed it?',
  'Write one short summary from today in your own words.',
  'What is one idea worth revisiting this weekend?',
  'What did you learn that would help a classmate?',
  'Capture one memory you do not want to relearn from scratch.'
];

const REMINDER_LINES = [
  'Small daily notes beat last-minute cramming.',
  'Your future self will thank you for one memory today.',
  'Progress compounds when you show up daily.',
  'Two minutes today can save hours later.',
  'Consistency builds confidence.'
];

const DAILY_STATE_KEYS = {
  lastOpen: 'mv_last_open_date',
  streak: 'mv_open_streak'
};

if (personalUnlockExpiresAt && Date.now() > personalUnlockExpiresAt) {
  sessionStorage.removeItem('personal_unlock_token');
  sessionStorage.removeItem('personal_unlock_expires_at');
  personalUnlockToken = '';
  personalUnlockExpiresAt = 0;
}

// API BASE URL
function resolveApiBaseUrl() {
  const sameOriginApi = `${window.location.origin}/api`;
  const onVercelHost = /\.vercel\.app$/i.test(window.location.hostname);
  const liveFallbackApi = 'https://memory-vault-coral-seven.vercel.app/api';
  const allowExternalApi = window.MEMORY_VAULT_ALLOW_EXTERNAL_API === true;

  const configured =
    window.__API_BASE_URL ||
    window.MEMORY_VAULT_API_URL ||
    (window.Capacitor ? liveFallbackApi : (onVercelHost ? sameOriginApi : liveFallbackApi));

  const raw = String(configured || '').trim();
  if (!raw) return sameOriginApi;
  if (/your-backend-domain/i.test(raw)) return sameOriginApi;

  // On Vercel (including mobile browsers with stale cache), default to same-origin API
  // unless external API usage is explicitly enabled.
  if (onVercelHost && !allowExternalApi) {
    return sameOriginApi;
  }

  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  // Accept both:
  // - https://example.com
  // - https://example.com/api
  if (withoutTrailingSlash.endsWith('/api')) return withoutTrailingSlash;
  return `${withoutTrailingSlash}/api`;
}

const API_BASE_URL = resolveApiBaseUrl();

async function parseJsonResponse(response, contextLabel = 'request') {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    const looksLikeHtml = /^\s*</.test(raw);
    if (looksLikeHtml) {
      throw new Error(
        `API misconfiguration: ${contextLabel} returned HTML, not JSON. ` +
        `Current API base is "${API_BASE_URL}". ` +
        `If frontend is on Netlify, set window.MEMORY_VAULT_API_URL in netlify-config.js to your backend domain.`
      );
    }
    throw new Error(`Invalid API response for ${contextLabel}.`);
  }
}

function buildRequestSignal(timeoutMs = 10000) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

// ===== BACKEND CONNECTION MANAGEMENT =====
let serverConnected = false;
let connectionCheckInterval = null;
let requestQueue = [];
let retryCount = 0;
const MAX_RETRIES = 5;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const RECONNECT_DELAY = 3000; // 3 seconds

// Initialize connection on page load
window.addEventListener('load', () => {
  initializeBackendConnection();
  
  // Handle Deep Linking (for Social Auth redirects)
  if (window.Capacitor && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appUrlOpen', (data) => {
      console.log('App opened with URL:', data.url);
      const url = new URL(data.url);
      const params = new URLSearchParams(url.search || url.hash.replace('#', '?'));
      const mode = params.get('mode');
      
      // If we are redirected back with auth data
      if (url.pathname.includes('auth.html') || params.has('code') || params.has('access_token')) {
        window.location.assign(`auth.html${url.search}${url.hash}`);
      }
    });
  }
});

// Initialize backend connection with health checks
async function initializeBackendConnection() {
  console.log('Initializing backend connection...');
  
  // Initial health check
  await checkServerHealth();
  
  // Set up periodic health checks
  if (connectionCheckInterval) clearInterval(connectionCheckInterval);
  connectionCheckInterval = setInterval(async () => {
    await checkServerHealth();
  }, HEALTH_CHECK_INTERVAL);
  
  // Process any queued requests
  setTimeout(processRequestQueue, 1000);
}

// Check server health
async function checkServerHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
      timeout: 5000
    });
    
    if (response.ok) {
      const wasDisconnected = !serverConnected;
      serverConnected = true;
      retryCount = 0;
      
      if (wasDisconnected) {
        console.log('Backend connected.');
        updateConnectionStatus(true);
        processRequestQueue();
      }
      return true;
    } else {
      throw new Error(`Health check failed: ${response.status}`);
    }
  } catch (error) {
    const wasConnected = serverConnected;
    serverConnected = false;
    
    if (wasConnected) {
      console.warn('Backend disconnected:', error.message);
      updateConnectionStatus(false);
      attemptReconnect();
    }
    return false;
  }
}

// Attempt to reconnect to backend
async function attemptReconnect() {
  if (retryCount >= MAX_RETRIES) {
    console.error('Max reconnection attempts reached');
    updateConnectionStatus(false, 'Connection lost - retrying...');
    return;
  }
  
  retryCount++;
  console.log(`Reconnection attempt ${retryCount}/${MAX_RETRIES}...`);
  
  setTimeout(async () => {
    const connected = await checkServerHealth();
    if (!connected && retryCount < MAX_RETRIES) {
      attemptReconnect();
    }
  }, RECONNECT_DELAY * retryCount);
}

// Update connection status indicator
function updateConnectionStatus(connected, customMessage = null) {
  let statusEl = document.getElementById('connection-status');
  
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.id = 'connection-status';
    statusEl.style.cssText = `
      position: fixed;
      bottom: 120px;
      right: 2rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 500;
      z-index: 100;
      transition: all 0.3s ease;
      max-width: 200px;
      text-align: center;
    `;
    document.body.appendChild(statusEl);
  }
  
  if (connected) {
    statusEl.textContent = 'Backend connected';
    statusEl.style.background = 'rgba(76, 175, 80, 0.2)';
    statusEl.style.color = '#4caf50';
    statusEl.style.border = '1px solid rgba(76, 175, 80, 0.5)';
    statusEl.style.display = 'none';
    setTimeout(() => statusEl.style.display = 'none', 2000);
  } else {
    statusEl.textContent = customMessage || 'Offline - retrying...';
    statusEl.style.background = 'rgba(244, 67, 54, 0.2)';
    statusEl.style.color = '#f44336';
    statusEl.style.border = '1px solid rgba(244, 67, 54, 0.5)';
    statusEl.style.display = 'block';
  }
}

// Queue failed requests for retry
function queueRequest(endpoint, method, body, callback) {
  requestQueue.push({ endpoint, method, body, callback, timestamp: Date.now() });
  console.log(`Request queued (${requestQueue.length} in queue)`);
}

// Process queued requests when connection is restored
async function processRequestQueue() {
  if (!serverConnected || requestQueue.length === 0) return;
  
  console.log(`Processing ${requestQueue.length} queued requests...`);
  const queue = [...requestQueue];
  requestQueue = [];
  
  for (const request of queue) {
    // Skip requests older than 5 minutes
    if (Date.now() - request.timestamp > 300000) {
      console.warn(`Skipping expired request: ${request.endpoint}`);
      if (request.callback) request.callback({ success: false, message: 'Request expired' });
      continue;
    }
    
    try {
      const result = await apiCall(request.endpoint, request.method, request.body);
      if (request.callback) request.callback(result);
    } catch (error) {
      console.error('Error processing queued request:', error);
      if (request.callback) request.callback({ success: false, message: error.message });
    }
  }
}

// Theme Management
function readStoredTheme() {
  try {
    return localStorage.getItem('theme');
  } catch {
    return null;
  }
}

let isDarkTheme = readStoredTheme() !== 'light';

function toggleTheme() {
  isDarkTheme = !isDarkTheme;
  try {
    localStorage.setItem('theme', isDarkTheme ? 'dark' : 'light');
  } catch {}
  applyTheme();
}

function applyTheme() {
  const themeToggle = document.getElementById('theme-toggle');
  const mobileThemeToggle = document.getElementById('mobile-theme-toggle');
  const body = document.body;
  const currentTheme = readStoredTheme();
  if (currentTheme === 'light') {
    isDarkTheme = false;
  } else if (currentTheme === 'dark') {
    isDarkTheme = true;
  }
  
  if (isDarkTheme) {
    body.classList.remove('light-theme');
    body.setAttribute('data-theme', 'dark');
    if (themeToggle) themeToggle.textContent = 'Light';
    if (mobileThemeToggle) mobileThemeToggle.textContent = 'Light';
  } else {
    body.classList.add('light-theme');
    body.setAttribute('data-theme', 'light');
    if (themeToggle) themeToggle.textContent = 'Dark';
    if (mobileThemeToggle) mobileThemeToggle.textContent = 'Dark';
  }
}

function toggleMobileNavPanel(event) {
  if (event) event.stopPropagation();
  const panel = document.getElementById('mobile-nav-panel');
  const btn = document.getElementById('mobile-menu-toggle');
  const scrim = document.getElementById('mobile-nav-scrim');
  if (!panel || !btn) return;
  const isOpen = panel.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  btn.textContent = isOpen ? '✕' : '☰';
  if (scrim) scrim.classList.toggle('open', isOpen);
  document.body.classList.toggle('mobile-menu-open', isOpen);
}

function closeMobileNavPanel() {
  const panel = document.getElementById('mobile-nav-panel');
  const btn = document.getElementById('mobile-menu-toggle');
  const scrim = document.getElementById('mobile-nav-scrim');
  if (!panel || !btn) return;
  panel.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '☰';
  if (scrim) scrim.classList.remove('open');
  document.body.classList.remove('mobile-menu-open');
}

function renderProfessionalFooters() {
  const footers = document.querySelectorAll('.footer');
  for (const footer of footers) {
    footer.innerHTML = `
      <div class="footer-content">
        <div class="footer-links">
          <a class="footer-link" target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/u/0/?fs=1&to=ijaborblossom@gmail.com&tf=cm">Contact Support</a>
        </div>
        <p class="footer-text">Memory Vault • &copy; 2026 by <span class="footer-highlight">Ijabor Blossom</span></p>
        <p class="footer-subtext">Capture your lessons, protect your reflections, and revisit what matters.</p>
      </div>
    `;
  }
}

function openResetFromQueryIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('resetToken');
  const email = params.get('email');
  if (!resetToken || !email) return;
  sessionStorage.setItem('reset_token', resetToken);
  openAuth('reset');
}

function initializeAppUi() {
  if (IS_AUTH_ROUTE) {
    document.body.classList.add('auth-route');
  }

  renderProfessionalFooters();
  applyTheme();
  updateSocialAuthButtons();
  if (isLoggedIn) {
    userName = localStorage.getItem('user_name') || 'Friend';
    userEmail = localStorage.getItem('user_email') || '';
    // Load memories from backend if user is logged in
    loadMemoriesFromBackend();
    startSessionHeartbeat();
    updateAuthUI();
  }
  updateAuthUI();
  startTrendingRealtimeFeed();

  if (IS_AUTH_ROUTE) {
    const routeMode = String((AUTH_ROUTE_MATCH && AUTH_ROUTE_MATCH[1]) || '').toLowerCase();
    const queryMode = String(new URLSearchParams(window.location.search).get('mode') || '').toLowerCase();
    const mode = routeMode || queryMode;
    openAuth(mode === 'signup' ? 'signup' : 'signin');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeAppUi, { once: true });
} else {
  initializeAppUi();
}

// On mobile, bfcache/page restore can skip initial script timing.
window.addEventListener('pageshow', () => {
  applyTheme();
  if (isLoggedIn) {
    pingUserSession().catch(() => {});
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isLoggedIn) {
    pingUserSession().catch(() => {});
  }
});

setTimeout(() => {
  openResetFromQueryIfNeeded();
}, 50);

// Keep greeting accurate while the app remains open.
setInterval(() => {
  refreshDailyExperience();
}, 60000);

function getTodayKey() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayDiff(fromDateKey, toDateKey) {
  const from = new Date(`${fromDateKey}T00:00:00`);
  const to = new Date(`${toDateKey}T00:00:00`);
  return Math.round((to - from) / 86400000);
}

function getGreetingByTime() {
  // Use the viewer's local timezone so greetings adapt by region.
  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hourString = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    timeZone: userTimeZone
  }).format(new Date());

  const hour = Number(hourString);
  if (hour >= 12 && hour <= 16) return 'Good afternoon';
  if (hour >= 17) return 'Good evening';
  return 'Good morning';
}

function getDailyPrompt() {
  const dayIndex = new Date().getDay();
  return DAILY_PROMPTS[dayIndex % DAILY_PROMPTS.length];
}

function getReminderLine() {
  const dayInMonth = new Date().getDate();
  return REMINDER_LINES[dayInMonth % REMINDER_LINES.length];
}

function refreshDailyExperience() {
  const today = getTodayKey();
  const lastOpen = localStorage.getItem(DAILY_STATE_KEYS.lastOpen);
  let streak = Number(localStorage.getItem(DAILY_STATE_KEYS.streak) || 0);

  if (!lastOpen) {
    streak = 1;
  } else if (lastOpen !== today) {
    const diff = dayDiff(lastOpen, today);
    streak = diff === 1 ? streak + 1 : 1;
  }

  localStorage.setItem(DAILY_STATE_KEYS.lastOpen, today);
  localStorage.setItem(DAILY_STATE_KEYS.streak, String(streak));

  const streakEl = document.getElementById('streak-count');
  const streakNote = document.getElementById('streak-note');
  const promptEl = document.getElementById('daily-prompt');
  const reminderEl = document.getElementById('daily-reminder');
  const greetingEl = document.getElementById('daily-greeting');
  const focusEl = document.getElementById('daily-focus');

  if (streakEl) streakEl.textContent = String(streak);
  if (streakNote) {
    if (streak >= 7) {
      streakNote.textContent = 'Strong momentum. Keep protecting your study streak.';
    } else if (streak >= 3) {
      streakNote.textContent = 'You are building consistency. Keep going.';
    } else {
      streakNote.textContent = 'Start today by saving one meaningful memory.';
    }
  }
  if (promptEl) promptEl.textContent = getDailyPrompt();
  if (reminderEl) reminderEl.textContent = getReminderLine();
  if (greetingEl) greetingEl.textContent = getGreetingByTime();

  if (focusEl) {
    focusEl.textContent = memories.length > 0
      ? `You have ${memories.length} saved memories.`
      : 'Capture one idea before you leave today.';
  }
}

function toggleNavMenu(event, isMobile = false) {
  if (event) event.stopPropagation();
  const menu = document.getElementById(isMobile ? 'mobile-nav-dropdown-menu' : 'nav-dropdown-menu');
  const btn = document.getElementById(isMobile ? 'mobile-nav-menu-btn' : 'nav-menu-btn');
  if (!menu || !btn) return;
  const isOpen = menu.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeNavMenu(isMobile = false) {
  const menu = document.getElementById(isMobile ? 'mobile-nav-dropdown-menu' : 'nav-dropdown-menu');
  const btn = document.getElementById(isMobile ? 'mobile-nav-menu-btn' : 'nav-menu-btn');
  if (!menu || !btn) return;
  menu.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
}

function closeAllNavMenus() {
  closeNavMenu(false);
  closeNavMenu(true);
  closeMobileNavPanel();
}

document.addEventListener('click', (event) => {
  const dropdown = document.getElementById('nav-dropdown');
  const mobileDropdown = document.getElementById('mobile-nav-dropdown');
  const mobilePanel = document.getElementById('mobile-nav-panel');
  const mobileMenuBtn = document.getElementById('mobile-menu-toggle');
  const inDesktop = dropdown && dropdown.contains(event.target);
  const inMobile = mobileDropdown && mobileDropdown.contains(event.target);
  const inMobilePanel = mobilePanel && mobilePanel.contains(event.target);
  const inMobileMenuButton = mobileMenuBtn && mobileMenuBtn.contains(event.target);
  if (!inDesktop && !inMobile && !inMobilePanel && !inMobileMenuButton) {
    closeAllNavMenus();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeAllNavMenus();
  }
});

function toggleAuthPasswordVisibility() {
  const input = document.getElementById('auth-password');
  const toggleBtn = document.getElementById('auth-password-toggle');
  if (!input || !toggleBtn) return;
  const currentlyVisible = input.type === 'text';
  input.type = currentlyVisible ? 'password' : 'text';
  toggleBtn.classList.toggle('is-visible', !currentlyVisible);
  toggleBtn.setAttribute('aria-label', currentlyVisible ? 'Show password' : 'Hide password');
  toggleBtn.setAttribute('title', currentlyVisible ? 'Show password' : 'Hide password');
}

// Load memories from backend
async function loadMemoriesFromBackend() {
  if (!isLoggedIn || !authToken) return;
  
  try {
    const result = await getMemories();
    if (result.success && result.data) {
      memories = result.data;
      console.log(`Loaded ${memories.length} memories from backend on startup.`);
    }
  } catch (error) {
    console.warn('Could not load memories from backend on startup:', error);
  }
}

// LocalStorage Fallback for VS Code
class LocalStorageDataSDK {
  constructor() {
    this.handler = null;
    this.storageKey = 'memory_vault_data';
  }

  async init(handler) {
    this.handler = handler;
    const data = this.loadData();
    if (this.handler && this.handler.onDataChanged) {
      this.handler.onDataChanged(data);
    }
    return { isOk: true, isError: false, data: null, error: null };
  }

  getUserStorageKey() {
    const email = localStorage.getItem('user_email');
    return email ? `memory_vault_data_${email}` : 'memory_vault_data_guest';
  }

  loadData() {
    try {
      const storageKey = this.getUserStorageKey();
      const stored = localStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  saveData(data) {
    try {
      const storageKey = this.getUserStorageKey();
      localStorage.setItem(storageKey, JSON.stringify(data));
      if (this.handler && this.handler.onDataChanged) {
        this.handler.onDataChanged(data);
      }
    } catch (error) {
      console.error('Failed to save to localStorage:', error);
    }
  }

  async create(record) {
    const data = this.loadData();
    const userEmail = localStorage.getItem('user_email') || 'guest';
    const newRecord = { 
      ...record, 
      __backendId: Date.now().toString() + '_' + Math.random(),
      user_email: userEmail
    };
    data.push(newRecord);
    this.saveData(data);
    return { isOk: true, isError: false, data: newRecord, error: null };
  }

  async update(record) {
    const data = this.loadData();
    const index = data.findIndex(r => r.__backendId === record.__backendId);
    if (index !== -1) {
      data[index] = record;
      this.saveData(data);
      return { isOk: true, isError: false, data: null, error: null };
    }
    return { isOk: false, isError: true, data: null, error: new Error('Record not found') };
  }

  async delete(record) {
    const data = this.loadData();
    const filtered = data.filter(r => r.__backendId !== record.__backendId);
    this.saveData(filtered);
    return { isOk: true, isError: false, data: null, error: null };
  }
}

// Data SDK Handler
const dataHandler = {
  onDataChanged(data) {
    memories = data;
    updateCounts();
    renderCurrentView();
  }
};

// Element SDK Handler
async function onConfigChange(config) {
  const fontFamily = config.font_family || defaultConfig.font_family;
  const fontSize = config.font_size || defaultConfig.font_size;
  
  document.body.style.fontFamily = `${fontFamily}, sans-serif`;
  document.body.style.fontSize = `${fontSize}px`;
  
  document.getElementById('app-title').textContent = config.app_title || defaultConfig.app_title;
  document.getElementById('app-tagline').textContent = config.app_tagline || defaultConfig.app_tagline;
  document.getElementById('hero-title').textContent = config.hero_title || defaultConfig.hero_title;
  document.getElementById('hero-subtitle').textContent = config.hero_subtitle || defaultConfig.hero_subtitle;
  document.getElementById('personal-vault-name').textContent = config.personal_vault_name || defaultConfig.personal_vault_name;
  document.getElementById('learning-vault-name').textContent = config.learning_vault_name || defaultConfig.learning_vault_name;
  document.getElementById('cultural-vault-name').textContent = config.cultural_vault_name || defaultConfig.cultural_vault_name;
  document.getElementById('future-vault-name').textContent = config.future_vault_name || defaultConfig.future_vault_name;
}

// Initialize SDKs
async function initAll() {
  try {
    // Initialize Element SDK if available
    if (window.elementSdk) {
      await window.elementSdk.init({
        defaultConfig,
        onConfigChange,
        mapToCapabilities: () => ({
          recolorables: [],
          borderables: [],
          fontEditable: {
            get: () => window.elementSdk?.config?.font_family || defaultConfig.font_family,
            set: (value) => {
              if (window.elementSdk?.config) {
                window.elementSdk.config.font_family = value;
                window.elementSdk.setConfig({ font_family: value });
              }
            }
          },
          fontSizeable: {
            get: () => window.elementSdk?.config?.font_size || defaultConfig.font_size,
            set: (value) => {
              if (window.elementSdk?.config) {
                window.elementSdk.config.font_size = value;
                window.elementSdk.setConfig({ font_size: value });
              }
            }
          }
        }),
        mapToEditPanelValues: (config) => new Map([
          ["app_title", config.app_title || defaultConfig.app_title],
          ["app_tagline", config.app_tagline || defaultConfig.app_tagline],
          ["hero_title", config.hero_title || defaultConfig.hero_title],
          ["hero_subtitle", config.hero_subtitle || defaultConfig.hero_subtitle],
          ["personal_vault_name", config.personal_vault_name || defaultConfig.personal_vault_name],
          ["learning_vault_name", config.learning_vault_name || defaultConfig.learning_vault_name],
          ["cultural_vault_name", config.cultural_vault_name || defaultConfig.cultural_vault_name],
          ["future_vault_name", config.future_vault_name || defaultConfig.future_vault_name]
        ])
      });
    }
    
    // Initialize Data SDK (Canva or localStorage fallback)
    if (window.dataSdk) {
      const result = await window.dataSdk.init(dataHandler);
      if (result.success || result.isOk) {
        isDataSdkReady = true;
        useLocalStorage = false;
        console.log('Using Canva Data SDK.');
      } else {
        console.error("Data SDK init failed:", result.error);
        initLocalStorage();
      }
    } else {
      // VS Code / Local environment - use localStorage
      initLocalStorage();
    }
  } catch (error) {
    console.error("Init error:", error);
    initLocalStorage();
  }
}

function initLocalStorage() {
  console.log('Using localStorage fallback (VS Code mode).');
  window.dataSdk = new LocalStorageDataSDK();
  window.dataSdk.init(dataHandler);
  isDataSdkReady = true;
  useLocalStorage = true;
}

initAll();

// API Helper Functions
async function apiCall(endpoint, method = 'GET', body = null, extraHeaders = null) {
  const includePersonalToken = authToken && personalUnlockToken &&
    (endpoint.startsWith('/memories') || endpoint.startsWith('/personal'));

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken && { 'Authorization': `Bearer ${authToken}` }),
      ...(includePersonalToken && { 'x-personal-unlock-token': personalUnlockToken }),
      ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {})
    }
  };
  
  if (body) options.body = JSON.stringify(body);
  
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      signal: buildRequestSignal(10000) // 10 second timeout
    });
    
    const data = await parseJsonResponse(response, endpoint);
    if (!serverConnected) {
      serverConnected = true;
      retryCount = 0;
      updateConnectionStatus(true);
    }
    
    if (!response.ok) {
      console.error(`API Error (${response.status}):`, data.message);
      if (shouldForceReauth(response.status, data, endpoint)) {
        // Token expired or invalid
        handleAuthError();
      }
      return { success: false, ...data };
    }
    
    return data;
  } catch (error) {
    console.error('API Error:', error.message);
    
    // Network error - queue the request
    if (
      error.message.includes('Failed to fetch') ||
      error.message.includes('NetworkError') ||
      error.name === 'TypeError' ||
      error.name === 'AbortError'
    ) {
      serverConnected = false;
      updateConnectionStatus(false);
      attemptReconnect();

      const normalizedMethod = String(method || 'GET').toUpperCase();
      // Do not silently queue write operations. Surface a hard failure immediately.
      if (normalizedMethod !== 'GET') {
        return {
          success: false,
          message: 'Network issue: could not reach server. Please retry when connected.'
        };
      }

      return new Promise((resolve) => {
        queueRequest(endpoint, method, body, resolve);
      });
    }
    
    return { success: false, message: error.message };
  }
}

// Memory API functions
async function createMemory(title, content, is_important, vault_type) {
  try {
    const normalizedVaultType = normalizeVaultKey(vault_type) || String(vault_type || '').trim().toLowerCase();
    const makeLocalRecord = () => {
      let safeEmail = 'guest';
      try {
        safeEmail = localStorage.getItem('user_email') || 'guest';
      } catch {}
      return {
        title,
        content,
        is_important: Boolean(is_important),
        vault_type: normalizedVaultType,
        timestamp: new Date().toISOString(),
        __backendId: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 8),
        user_email: safeEmail
      };
    };

    const saveLocally = async () => {
      const fallbackRecord = makeLocalRecord();
      try {
        if (!window.dataSdk || typeof window.dataSdk.create !== 'function') {
          initLocalStorage();
        }
        const localResult = await window.dataSdk.create(fallbackRecord);
        if (localResult?.success || localResult?.isOk) {
          return {
            success: true,
            isOk: true,
            data: localResult?.data || fallbackRecord,
            message: 'Saved locally while backend sync is unavailable.'
          };
        }
      } catch {}
      return { success: true, isOk: true, data: fallbackRecord, message: 'Saved locally (emergency mode).' };
    };

    if (authToken) {
      const result = await apiCall('/memories', 'POST', {
        title,
        content,
        is_important,
        vault_type: normalizedVaultType
      });
      if (result && (result.success || result.isOk)) return result;

      const msg = String(result?.message || '').toLowerCase();
      const personalLocked = normalizedVaultType === 'personal' && (
        msg.includes('unlock personal vault') ||
        msg.includes('personal vault is locked')
      );
      if (personalLocked) {
        return result;
      }

      // Reliability fallback: if backend save fails, keep user progress by saving locally.
      return await saveLocally();
    }

    // Fall back to localStorage if not authenticated or backend is offline.
    return await saveLocally();
  } catch (error) {
    console.error('createMemory failed unexpectedly:', error);
    return {
      success: false,
      message: 'Could not save memory right now. Please try again.'
    };
  }
}

function shouldForceReauth(status, data, endpoint) {
  if (status !== 401) return false;
  const path = String(endpoint || '').toLowerCase();
  // Keep AI screen stable on auth failures so users do not get forced to home mid-chat.
  if (path.startsWith('/ai/chat')) return false;
  // Background heartbeat should not force navigation changes while user is working.
  if (path.startsWith('/session/ping')) return false;
  const message = String(data?.message || '').toLowerCase();
  return message.includes('invalid token') || message.includes('no token provided') || message.includes('token expired');
}

// Memory vault related API calls

async function getMemories() {
  if (authToken) {
    return await apiCall('/memories', 'GET');
  } else {
    return { success: true, data: window.dataSdk.loadData() };
  }
}

async function pingUserSession() {
  if (!authToken || !isLoggedIn) return;
  await apiCall('/session/ping', 'POST', {
    page: window.location.pathname,
    visibility: document.visibilityState || 'unknown'
  });
}

function stopSessionHeartbeat() {
  if (sessionPingTimer) {
    clearInterval(sessionPingTimer);
    sessionPingTimer = null;
  }
}

function startSessionHeartbeat() {
  stopSessionHeartbeat();
  if (!authToken || !isLoggedIn) return;
  pingUserSession().catch(() => {});
  sessionPingTimer = setInterval(() => {
    pingUserSession().catch(() => {});
  }, 60000);
}

// Navigation
function openVault(vault) {
  const vaultKey = normalizeVaultKey(vault) || vault;
  currentVault = vaultKey;
  hideAllPages();
  
  if (vaultKey === 'personal') {
    document.getElementById('personal-page').classList.add('active');
    lockDiaryView();
    if (authToken) {
      restorePersonalUnlockState();
    }
  } else {
    document.getElementById(`${vaultKey}-page`).classList.add('active');
    renderVaultMemories(vaultKey);
  }
}

function backToMain() {
  hideAllPages();
  document.getElementById('main-page').classList.add('active');
  currentVault = '';
  
  // Reset diary state
  currentPin = '';
  updatePinDisplay();
  lockDiaryView();
}

function hideAllPages() {
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
}

function openAddForm(vault) {
  const vaultKey = normalizeVaultKey(vault) || vault;
  currentVault = vaultKey;
  hideAllPages();
  document.getElementById('form-page').classList.add('active');
  
  const icons = { learning: 'KN', cultural: 'CH', future: 'FW', personal: 'PV' };
  const titles = { learning: 'Add Academic Memory', cultural: 'Add Cultural Memory', future: 'Add Future Wisdom', personal: 'Write Diary Entry' };
  
  document.getElementById('form-icon').textContent = icons[vaultKey];
  document.getElementById('form-title').textContent = titles[vaultKey];
}

function openDiaryForm() {
  openAddForm('personal');
}

function closeForm() {
  document.getElementById('memory-form').reset();
  document.getElementById('form-message').innerHTML = '';
  
  if (currentVault === 'personal') {
    hideAllPages();
    document.getElementById('personal-page').classList.add('active');
  } else {
    hideAllPages();
    document.getElementById(`${currentVault}-page`).classList.add('active');
  }
}

function getMemoryId(memory) {
  return memory.id || memory.__backendId;
}

function getLocalMemoriesForMigration(email) {
  const keys = ['memory_vault_data_guest', `memory_vault_data_${email}`];
  const all = [];

  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        all.push(...parsed);
      }
    } catch (error) {
      console.warn('Failed to read local memories for migration:', key, error);
    }
  }

  return all;
}

function memorySignature(memory) {
  return [
    (memory.title || '').trim(),
    (memory.content || '').trim(),
    normalizeVaultKey(memory.vault_type) || String(memory.vault_type || '').trim().toLowerCase(),
    (memory.timestamp || '').trim()
  ].join('||');
}

async function syncLocalMemoriesToBackend(email) {
  if (!authToken || !email) return 0;

  const localMemories = getLocalMemoriesForMigration(email);
  if (!localMemories.length) return 0;

  const backendResult = await getMemories();
  const backendMemories = backendResult.success && Array.isArray(backendResult.data) ? backendResult.data : [];
  const backendSet = new Set(backendMemories.map(memorySignature));
  const toImport = localMemories.filter((m) => !backendSet.has(memorySignature(m)));

  let imported = 0;
  for (const memory of toImport) {
    const result = await createMemory(
      memory.title || 'Untitled Memory',
      memory.content || '',
      Boolean(memory.is_important),
      memory.vault_type || 'learning'
    );

    if (result && result.success) {
      imported += 1;
    }
  }

  return imported;
}

// PIN Functions
function enterPin(digit) {
  if (isPinSubmitting) return;
  if (currentPin.length < 6) {
    currentPin += digit;
    updatePinDisplay();

    if (currentPin.length === 6) {
      if (pinAutoSubmitTimer) clearTimeout(pinAutoSubmitTimer);
      pinAutoSubmitTimer = setTimeout(() => {
        submitPin();
      }, 300);
    }
  }
}

function clearPin() {
  if (pinAutoSubmitTimer) {
    clearTimeout(pinAutoSubmitTimer);
    pinAutoSubmitTimer = null;
  }
  if (isPinSubmitting) return;
  if (currentPin.length > 0) {
    currentPin = currentPin.slice(0, -1);
    updatePinDisplay();
  }
}

function updatePinDisplay() {
  const dots = document.querySelectorAll('.pin-dot');
  dots.forEach((dot, i) => {
    if (i < currentPin.length) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  });
}

function lockDiaryView() {
  document.getElementById('pin-interface').style.display = 'block';
  document.getElementById('diary-content').classList.remove('unlocked');
}

function storePersonalUnlockState(token, expiresAt) {
  personalUnlockToken = token || '';
  personalUnlockExpiresAt = Number(expiresAt || 0);

  if (personalUnlockToken && personalUnlockExpiresAt) {
    sessionStorage.setItem('personal_unlock_token', personalUnlockToken);
    sessionStorage.setItem('personal_unlock_expires_at', String(personalUnlockExpiresAt));
  } else {
    sessionStorage.removeItem('personal_unlock_token');
    sessionStorage.removeItem('personal_unlock_expires_at');
  }
}

async function restorePersonalUnlockState() {
  if (!authToken || !personalUnlockToken) {
    return;
  }

  const status = await apiCall('/personal/pin/status', 'GET');
  if (status.success && status.unlocked) {
    unlockDiary();
  } else {
    storePersonalUnlockState('', 0);
  }
}

async function submitPin() {
  if (pinAutoSubmitTimer) {
    clearTimeout(pinAutoSubmitTimer);
    pinAutoSubmitTimer = null;
  }
  if (isPinSubmitting) return;
  const msgDiv = document.getElementById('pin-message');
  const pinAttempt = currentPin;

  if (pinAttempt.length < 4) {
    msgDiv.innerHTML = '<div class="message error">PIN must be at least 4 digits</div>';
    return;
  }
  isPinSubmitting = true;

  try {
    if (authToken) {
      const status = await apiCall('/personal/pin/status', 'GET');
      if (!status.success) {
        msgDiv.innerHTML = `<div class="message error">${escapeHtml(status.message || 'Could not check PIN status')}</div>`;
        currentPin = '';
        updatePinDisplay();
        return;
      }

      if (!status.configured) {
        const setupResult = await apiCall('/personal/pin/setup', 'POST', { pin: pinAttempt });
        if (!setupResult.success) {
          msgDiv.innerHTML = `<div class="message error">${escapeHtml(setupResult.message || 'PIN setup failed')}</div>`;
          currentPin = '';
          updatePinDisplay();
          return;
        }
      }

      const verifyResult = await apiCall('/personal/pin/verify', 'POST', { pin: pinAttempt });
      if (!verifyResult.success) {
        msgDiv.innerHTML = `<div class="message error">${escapeHtml(verifyResult.message || 'Incorrect PIN')}</div>`;
        currentPin = '';
        updatePinDisplay();
        return;
      }

      storePersonalUnlockState(verifyResult.unlockToken, verifyResult.expiresAt);
      currentPin = '';
      updatePinDisplay();
      msgDiv.innerHTML = '<div class="message success">Personal vault unlocked.</div>';
      unlockDiary();
      return;
    }

    if (!userPin) {
      // First time setup
      userPin = pinAttempt;
      localStorage.setItem('diary_pin', userPin);

      const name = prompt('What should we call you?') || 'Friend';
      userName = name;
      localStorage.setItem('user_name', name);

      unlockDiary();
    } else {
      // Verify PIN
      if (pinAttempt === userPin) {
        unlockDiary();
      } else {
        msgDiv.innerHTML = '<div class="message error">Incorrect PIN.</div>';
        currentPin = '';
        updatePinDisplay();
      }
    }
  } finally {
    isPinSubmitting = false;
  }
}

async function resetPin() {
  if (authToken) {
    const accountPassword = prompt('Enter your account password to reset your personal vault PIN:');
    if (!accountPassword) return;

    const newPin = prompt('Enter a new 4-6 digit PIN:');
    if (!newPin || !/^\d{4,6}$/.test(newPin)) {
      document.getElementById('pin-message').innerHTML = '<div class="message error">New PIN must be 4-6 digits.</div>';
      return;
    }

    const result = await apiCall('/personal/pin/reset', 'POST', { password: accountPassword, newPin });
    if (!result.success) {
      document.getElementById('pin-message').innerHTML = `<div class="message error">${escapeHtml(result.message || 'PIN reset failed')}</div>`;
      return;
    }

    storePersonalUnlockState(result.unlockToken, result.expiresAt);
    currentPin = '';
    updatePinDisplay();
    document.getElementById('pin-message').innerHTML = '<div class="message success">PIN reset and personal vault unlocked.</div>';
    unlockDiary();
    return;
  }

  const shouldReset = confirm('Reset your PIN? All diary entries will remain safe. You\'ll just create a new PIN to access them.');
  
  if (shouldReset) {
    localStorage.removeItem('diary_pin');
    userPin = null;
    currentPin = '';
    updatePinDisplay();
    
    document.getElementById('pin-message').innerHTML = '<div class="message success">PIN cleared. Create a new 4-6 digit PIN.</div>';
  }
}

function unlockDiary() {
  document.getElementById('pin-interface').style.display = 'none';
  document.getElementById('diary-content').classList.add('unlocked');
  document.getElementById('welcome-name').textContent = `Welcome, ${userName}!`;
  
  renderDiaryEntries();
}

// Form Submission
document.getElementById('memory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (isSubmitting) {
    showMessage('Please wait...', 'error');
    return;
  }
  
  if (!isDataSdkReady && !authToken) {
    showMessage('System is loading, please try again...', 'error');
    return;
  }
  
  if (memories.length >= 999) {
    showMessage('Storage limit reached (999 memories). Please delete some memories first.', 'error');
    return;
  }
  
  isSubmitting = true;
  const btn = document.getElementById('submit-btn');
  const text = document.getElementById('submit-text');
  
  btn.disabled = true;
  text.textContent = 'Saving...';
  
  const memory = {
    title: document.getElementById('memory-title').value,
    content: document.getElementById('memory-content').value,
    vault_type: normalizeVaultKey(currentVault),
    is_important: document.getElementById('memory-important').checked,
    timestamp: new Date().toISOString()
  };

  if (!memory.vault_type) {
    showMessage('Please choose a vault before saving.', 'error');
    btn.disabled = false;
    text.textContent = 'Save Memory';
    isSubmitting = false;
    return;
  }
  
  try {
    const result = await createMemory(memory.title, memory.content, memory.is_important, memory.vault_type);
    
    if (result.success || result.isOk) {
      if (result.data) {
        memories.push(result.data);
        invalidateTrendingCache();
        updateCounts();
        renderCurrentView();
      }
      showMessage('Memory saved successfully.', 'success');
      refreshDailyExperience();
      document.getElementById('memory-form').reset();
      
      setTimeout(() => {
        closeForm();
      }, 1500);
    } else {
      showMessage('Failed to save: ' + (result.error?.message || result.message || 'Unknown error'), 'error');
      btn.disabled = false;
      text.textContent = 'Save Memory';
    }
  } catch (error) {
    console.error('Save error:', error);
    showMessage('Failed to save memory. Please try again.', 'error');
    btn.disabled = false;
    text.textContent = 'Save Memory';
  }
  
  isSubmitting = false;
  if (btn.disabled) {
    btn.disabled = false;
    text.textContent = 'Save Memory';
  }
});

// Delete Memory
async function deleteMemory(id) {
  try {
    if (!id) {
      showMessage('Cannot delete memory: missing id', 'error');
      return;
    }

    const memory = memories.find(m => getMemoryId(m) === id);
    if (!memory) return;
    const shouldDelete = confirm('Delete this memory?');
    if (!shouldDelete) return;
    let result;

    // Local-only records should be deleted locally immediately.
    if (memory.__backendId && String(memory.__backendId) === String(id)) {
      result = await window.dataSdk.delete({ __backendId: id });
      if (!(result.success || result.isOk)) {
        showMessage(`Failed to delete memory: ${result.message || 'Unknown error'}`, 'error');
        return;
      }
      memories = memories.filter(m => getMemoryId(m) !== id);
      invalidateTrendingCache();
      updateCounts();
      renderCurrentView();
      showMessage('Memory deleted successfully', 'success');
      return;
    }

    if (authToken) {
      result = await apiCall(`/memories/${encodeURIComponent(id)}`, 'DELETE');
      if (!(result.success || result.isOk)) {
        const localOnlyId = memory.__backendId || '';
        const notFoundRemotely = String(result.message || '').toLowerCase().includes('not found');
        const networkFailure = /network|fetch|timeout|abort/i.test(String(result.message || ''));
        if ((localOnlyId && String(localOnlyId) === String(id)) || notFoundRemotely || networkFailure) {
          const localDelete = await window.dataSdk.delete({ __backendId: id });
          if (localDelete.success || localDelete.isOk) {
            result = { success: true, message: networkFailure ? 'Memory deleted locally (will sync when online).' : 'Memory deleted (local fallback)' };
          }
        }
      }
    } else {
      result = await window.dataSdk.delete({ __backendId: id });
    }
    if (!(result.success || result.isOk)) {
      showMessage(`Failed to delete memory: ${result.message || 'Unknown error'}`, 'error');
      return;
    }
    memories = memories.filter(m => getMemoryId(m) !== id);
    invalidateTrendingCache();
    updateCounts();
    renderCurrentView();
    showMessage('Memory deleted successfully', 'success');
  } catch (error) {
    console.error('deleteMemory failed unexpectedly:', error);
    showMessage('Failed to delete memory. Please try again.', 'error');
  }
}
// Render Functions
function updateCounts() {
  const counts = {
    learning: memories.filter(m => normalizeVaultKey(m.vault_type) === 'learning').length,
    cultural: memories.filter(m => normalizeVaultKey(m.vault_type) === 'cultural').length,
    future: memories.filter(m => normalizeVaultKey(m.vault_type) === 'future').length
  };

  const totalCountEl = document.getElementById('total-count');
  const learningCountEl = document.getElementById('learning-count');
  const culturalCountEl = document.getElementById('cultural-count');
  const futureCountEl = document.getElementById('future-count');

  if (totalCountEl) totalCountEl.textContent = memories.length;
  if (learningCountEl) learningCountEl.textContent = counts.learning;
  if (culturalCountEl) culturalCountEl.textContent = counts.cultural;
  if (futureCountEl) futureCountEl.textContent = counts.future;
  refreshDailyExperience();
}

function renderCurrentView() {
  if (currentVault === 'personal') {
    renderDiaryEntries();
  } else if (currentVault) {
    renderVaultMemories(currentVault);
  }
  renderTrendingMemories();
}

function renderTrendingMemories() {
  const container = document.getElementById('trending-memories');
  if (!container) return;

  if (Date.now() < trendingCache.expiresAt) {
    const cached = Array.isArray(trendingCache.items) ? trendingCache.items : [];
    if (cached.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">TR</div>
          <p class="empty-text">No trending memories yet</p>
          <p class="empty-subtext">Important memories from all users will appear here</p>
        </div>
      `;
      return;
    }
    container.innerHTML = cached.map(m => `
      <div class="memory-card">
        <div class="memory-title">
          ${escapeHtml(m.title)}
          ${m.is_important ? '<span class="important-flag">Important</span>' : ''}
        </div>
        <div class="memory-content">${escapeHtml(m.content)}</div>
        <div class="memory-meta">
          <span class="memory-date">${formatDate(m.timestamp)}</span>
          <span style="color: #66bb6a; font-weight: 600;">${getVaultLabel(m.vault_type)}</span>
        </div>
      </div>
    `).join('');
    return;
  }

  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">TR</div>
      <p class="empty-text">Loading global trending memories...</p>
      <p class="empty-subtext">Important memories from real users appear in realtime</p>
    </div>
  `;

  fetch(`${API_BASE_URL}/memories/trending?limit=6`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: buildRequestSignal(10000)
  })
    .then((response) => parseJsonResponse(response, 'trending-memories')
      .then((data) => ({ ok: response.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || !data?.success || !Array.isArray(data.data)) return;
      const trending = data.data;
      trendingCache = { expiresAt: Date.now() + 8000, items: trending };

      if (trending.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">TR</div>
            <p class="empty-text">No trending memories yet</p>
            <p class="empty-subtext">Important memories from all users will appear here</p>
          </div>
        `;
        return;
      }

      container.innerHTML = trending.map(m => `
        <div class="memory-card">
          <div class="memory-title">
            ${escapeHtml(m.title)}
            ${m.is_important ? '<span class="important-flag">Important</span>' : ''}
          </div>
          <div class="memory-content">${escapeHtml(m.content)}</div>
          <div class="memory-meta">
            <span class="memory-date">${formatDate(m.timestamp)}</span>
            <span style="color: #66bb6a; font-weight: 600;">${getVaultLabel(m.vault_type)}</span>
          </div>
        </div>
      `).join('');
    })
    .catch(() => {});
}

function startTrendingRealtimeFeed() {
  if (trendingRefreshTimer) return;
  trendingRefreshTimer = setInterval(() => {
    trendingCache.expiresAt = 0;
    renderTrendingMemories();
  }, 12000);
}

function getVaultLabel(vaultType) {
  const key = normalizeVaultKey(vaultType) || String(vaultType || '').toLowerCase();
  const labels = {
    personal: 'Personal',
    learning: 'Academic',
    cultural: 'Cultural',
    future: 'Future'
  };
  return labels[key] || vaultType;
}

function renderVaultMemories(vault) {
  const vaultKey = normalizeVaultKey(vault) || vault;
  const container = document.getElementById(`${vaultKey}-memories`);
  const vaultMemories = memories.filter(m => normalizeVaultKey(m.vault_type) === vaultKey);
  
  if (vaultMemories.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">NT</div>
        <p class="empty-text">No memories yet</p>
        <p class="empty-subtext">Start preserving your wisdom!</p>
      </div>
    `;
    return;
  }
  
  const sorted = [...vaultMemories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  container.innerHTML = sorted.map(m => `
    <div class="memory-card">
      <div class="memory-title">
        ${escapeHtml(m.title)}
        ${m.is_important ? '<span class="important-flag">Important</span>' : ''}
      </div>
      <div class="memory-content">${escapeHtml(m.content)}</div>
      <div class="memory-meta">
        <span class="memory-date">${formatDate(m.timestamp)}</span>
        <button type="button" class="delete-btn" onclick="deleteMemory('${getMemoryId(m)}'); return false;">Delete</button>
      </div>
    </div>
  `).join('');
}

function renderDiaryEntries() {
  const container = document.getElementById('diary-entries');
  const entries = memories.filter(m => normalizeVaultKey(m.vault_type) === 'personal');
  
  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">NT</div>
        <p class="empty-text">Your diary is empty</p>
        <p class="empty-subtext">Start writing your first entry!</p>
      </div>
    `;
    return;
  }
  
  const sorted = [...entries].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  container.innerHTML = sorted.map(e => `
    <div class="diary-entry">
      <div class="diary-entry-title">
        ${escapeHtml(e.title)}
        ${e.is_important ? '<span class="important-flag">Important</span>' : ''}
      </div>
      <div class="diary-entry-content">${escapeHtml(e.content)}</div>
      <div class="memory-meta">
        <span class="memory-date">${formatDate(e.timestamp)}</span>
        <button type="button" class="delete-btn" onclick="deleteMemory('${getMemoryId(e)}'); return false;">Delete</button>
      </div>
    </div>
  `).join('');
}

// Helper Functions
function showMessage(text, type) {
  const activePage = document.querySelector('.page.active');
  const formPageActive = activePage?.id === 'form-page';
  const inlineTarget = formPageActive ? document.getElementById('form-message') : null;

  if (inlineTarget) {
    inlineTarget.innerHTML = `<div class="message ${type}">${text}</div>`;
    setTimeout(() => {
      inlineTarget.innerHTML = '';
    }, 4000);
    return;
  }

  let toast = document.getElementById('global-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.className = 'global-toast';
    document.body.appendChild(toast);
  }

  toast.className = `global-toast ${type}`;
  toast.textContent = text;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 2600);
}

function formatDate(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', { 
    month: 'long', 
    day: 'numeric', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Auth Functions
function openAuth(mode) {
  if (!IS_AUTH_ROUTE) {
    const target = mode === 'signup' ? 'auth.html?mode=signup' : 'auth.html?mode=signin';
    window.location.assign(target);
    return;
  }

  authMode = mode;
  if (mode === 'signin' || mode === 'signup') {
    const targetPath = `/auth/${mode}`;
    if (window.location.pathname !== targetPath) {
      window.history.replaceState({}, '', targetPath);
    }
  }
  hideAllPages();
  document.getElementById('auth-page').classList.add('active');
  const identifierLabel = document.getElementById('auth-identifier-label');
  const identifierInput = document.getElementById('auth-email');
  const usernameGroup = document.getElementById('auth-username-group');
  const nameGroup = document.getElementById('auth-name-group');
  const forgotContainer = document.getElementById('auth-forgot-container');
  const resetPasswordGroup = document.getElementById('auth-reset-password-group');
  const resetConfirmGroup = document.getElementById('auth-reset-confirm-group');
  const passwordFormGroup = document.getElementById('auth-password')?.closest('.form-group');
  const socialDivider = document.getElementById('auth-social-divider');
  const socialDividerText = socialDivider?.querySelector('span');
  const socialGrid = document.getElementById('auth-social-grid');
  const switchText = document.getElementById('auth-switch-text');
  const switchBtnText = document.getElementById('auth-switch-btn-text');
  const subtitle = document.getElementById('auth-subtitle');
  const visualTitle = document.getElementById('auth-visual-title');
  const visualCopy = document.getElementById('auth-visual-copy');
  const visualCta = document.getElementById('auth-visual-cta');
  const passwordInput = document.getElementById('auth-password');
  const resetPasswordInput = document.getElementById('auth-new-password');
  const resetConfirmInput = document.getElementById('auth-confirm-password');
  
  if (mode === 'signin') {
    document.getElementById('auth-title').textContent = 'Sign In';
    if (subtitle) {
      subtitle.innerHTML = `Don't have an account? <button type="button" class="auth-subtitle-link" onclick="openAuth('signup')">Sign Up</button>`;
    }
    document.getElementById('auth-submit-text').textContent = 'Sign In';
    if (switchText) switchText.textContent = "Don't have an account?";
    if (switchBtnText) switchBtnText.textContent = 'Sign Up';
    if (nameGroup) nameGroup.classList.remove('active');
    if (usernameGroup) usernameGroup.classList.remove('active');
    if (forgotContainer) forgotContainer.classList.add('active');
    if (resetPasswordGroup) resetPasswordGroup.classList.remove('active');
    if (resetConfirmGroup) resetConfirmGroup.classList.remove('active');
    if (passwordFormGroup) passwordFormGroup.style.display = '';
    if (socialDivider) socialDivider.style.display = '';
    if (socialDividerText) socialDividerText.textContent = 'or sign in with';
    if (socialGrid) socialGrid.style.display = '';
    updateSocialAuthButtons();
    if (identifierLabel) identifierLabel.textContent = 'Email or Username';
    if (identifierInput) identifierInput.placeholder = 'your@email.com or username';
    if (identifierInput) identifierInput.readOnly = false;
    if (visualTitle) visualTitle.textContent = 'Welcome Back';
    if (visualCopy) visualCopy.textContent = 'Enter your personal details to use all Memory Vault features.';
    if (visualCta) {
      visualCta.textContent = 'Create Account';
      visualCta.onclick = function () { openAuth('signup'); };
    }
  } else {
    if (mode === 'signup') {
      document.getElementById('auth-title').textContent = 'Sign Up';
      if (subtitle) {
        subtitle.innerHTML = `Already a member? <button type="button" class="auth-subtitle-link" onclick="openAuth('signin')">Log In</button>`;
      }
      document.getElementById('auth-submit-text').textContent = 'Create Account';
      if (switchText) switchText.textContent = 'Already have an account?';
      if (switchBtnText) switchBtnText.textContent = 'Sign In';
      if (nameGroup) nameGroup.classList.add('active');
      if (usernameGroup) usernameGroup.classList.add('active');
      if (forgotContainer) forgotContainer.classList.remove('active');
      if (resetPasswordGroup) resetPasswordGroup.classList.remove('active');
      if (resetConfirmGroup) resetConfirmGroup.classList.remove('active');
      if (passwordFormGroup) passwordFormGroup.style.display = '';
      if (socialDivider) socialDivider.style.display = '';
      if (socialDividerText) socialDividerText.textContent = 'or sign up with';
      if (socialGrid) socialGrid.style.display = '';
      updateSocialAuthButtons();
      if (identifierLabel) identifierLabel.textContent = 'Email';
      if (identifierInput) identifierInput.placeholder = 'your@email.com';
      if (identifierInput) identifierInput.readOnly = false;
      if (visualTitle) visualTitle.textContent = 'Join Memory Vault';
      if (visualCopy) visualCopy.textContent = 'Create your account and start storing reflections, notes, and wisdom.';
      if (visualCta) {
        visualCta.textContent = 'Sign In';
        visualCta.onclick = function () { openAuth('signin'); };
      }
    } else {
      document.getElementById('auth-title').textContent = 'Reset Password';
      if (subtitle) subtitle.textContent = 'Set your new password and continue';
      document.getElementById('auth-submit-text').textContent = 'Reset Password';
      if (switchText) switchText.textContent = 'Remembered your password?';
      if (switchBtnText) switchBtnText.textContent = 'Sign In';
      if (nameGroup) nameGroup.classList.remove('active');
      if (usernameGroup) usernameGroup.classList.remove('active');
      if (forgotContainer) forgotContainer.classList.remove('active');
      if (resetPasswordGroup) resetPasswordGroup.classList.add('active');
      if (resetConfirmGroup) resetConfirmGroup.classList.add('active');
      if (passwordFormGroup) passwordFormGroup.style.display = 'none';
      if (socialDivider) socialDivider.style.display = 'none';
      if (socialGrid) socialGrid.style.display = 'none';
      if (identifierLabel) identifierLabel.textContent = 'Registered Email';
      if (identifierInput) identifierInput.placeholder = 'your@email.com';
      const urlParams = new URLSearchParams(window.location.search);
      const resetEmail = (urlParams.get('email') || '').trim();
      if (identifierInput && resetEmail) {
        identifierInput.value = resetEmail;
        identifierInput.readOnly = true;
      }
      if (visualTitle) visualTitle.textContent = 'Secure Reset';
      if (visualCopy) visualCopy.textContent = 'Create a new strong password for your Memory Vault account.';
      if (visualCta) {
        visualCta.textContent = 'Sign In';
        visualCta.onclick = function () { openAuth('signin'); };
      }
    }
  }

  const passwordToggle = document.getElementById('auth-password-toggle');
  if (passwordInput) passwordInput.required = mode !== 'reset';
  if (resetPasswordInput) resetPasswordInput.required = mode === 'reset';
  if (resetConfirmInput) resetConfirmInput.required = mode === 'reset';
  if (passwordInput) passwordInput.type = 'password';
  if (passwordToggle) {
    passwordToggle.classList.remove('is-visible');
    passwordToggle.setAttribute('aria-label', 'Show password');
    passwordToggle.setAttribute('title', 'Show password');
  }
}

function getSocialProviderAvailability(provider) {
  if (provider === 'google') {
    if (!SOCIAL_CONFIG.googleClientId) {
      return { enabled: false, reason: 'Google sign-in is not configured.' };
    }
    return { enabled: true, reason: '' };
  }
  if (provider === 'facebook') {
    if (!SOCIAL_CONFIG.facebookAppId) {
      return { enabled: false, reason: 'Facebook sign-in is not configured.' };
    }
    return { enabled: true, reason: '' };
  }
  if (provider === 'microsoft') {
    if (!SOCIAL_CONFIG.microsoftClientId) {
      return { enabled: false, reason: 'Microsoft sign-in is not configured.' };
    }
    return { enabled: true, reason: '' };
  }
  return { enabled: false, reason: 'Unsupported provider.' };
}

function updateSocialAuthButtons() {
  const socialDivider = document.getElementById('auth-social-divider');
  const socialGrid = document.getElementById('auth-social-grid');
  const buttons = document.querySelectorAll('#auth-social-grid .auth-social-btn[data-provider]');
  let enabledCount = 0;
  buttons.forEach((btn) => {
    const provider = String(btn.getAttribute('data-provider') || '').toLowerCase();
    const label = SOCIAL_PROVIDER_NAMES[provider] || 'Provider';
    const availability = getSocialProviderAvailability(provider);
    if (availability.enabled) enabledCount += 1;
    btn.style.display = availability.enabled ? '' : 'none';
    btn.disabled = !availability.enabled;
    btn.classList.toggle('is-disabled', !availability.enabled);
    btn.setAttribute('aria-disabled', availability.enabled ? 'false' : 'true');
    btn.title = availability.enabled ? `Continue with ${label}` : availability.reason;
  });

  // Keep UI professional: don't show dead social section when nothing is configured.
  if (socialDivider && socialGrid && authMode !== 'reset') {
    const showSocial = enabledCount > 0;
    socialDivider.style.display = showSocial ? '' : 'none';
    socialGrid.style.display = showSocial ? '' : 'none';
  }
}

function toggleAuthMode() {
  if (authMode === 'reset') {
    openAuth('signin');
    return;
  }
  openAuth(authMode === 'signin' ? 'signup' : 'signin');
}

function closeAuth() {
  document.getElementById('auth-form').reset();
  document.getElementById('auth-message').innerHTML = '';
  const passwordInput = document.getElementById('auth-password');
  const passwordToggle = document.getElementById('auth-password-toggle');
  if (passwordInput) passwordInput.type = 'password';
  if (passwordToggle) {
    passwordToggle.classList.remove('is-visible');
    passwordToggle.setAttribute('aria-label', 'Show password');
    passwordToggle.setAttribute('title', 'Show password');
  }
  sessionStorage.removeItem('reset_token');
  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.replaceState({}, '', cleanUrl);

  if (IS_AUTH_ROUTE) {
    window.location.assign('/');
    return;
  }

  hideAllPages();
  document.getElementById('main-page').classList.add('active');
  closeMobileNavPanel();
}

async function startForgotPasswordFlow() {
  const emailGuess = document.getElementById('auth-email')?.value?.trim() || '';
  const email = prompt('Enter your registered email address:', emailGuess);
  if (!email) return;
  const msgDiv = document.getElementById('auth-message');
  msgDiv.innerHTML = '<div class="message info">Sending reset link...</div>';
  try {
    const response = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    });
    const data = await parseJsonResponse(response, 'forgot-password');
    msgDiv.innerHTML = `<div class="message success">${escapeHtml(data.message || 'If this email exists, a reset link has been sent.')}</div>`;
  } catch (error) {
    msgDiv.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Unable to send reset link right now.')}</div>`;
  }
}

async function completeAuthSuccess(data, msgDiv) {
  localStorage.setItem('auth_token', data.token);
  localStorage.setItem('user_email', data.user.email);
  localStorage.setItem('user_name', data.user.name || data.user.username || 'Friend');
  localStorage.setItem('user_logged_in', 'true');

  authToken = data.token;
  userEmail = data.user.email;
  userName = data.user.name || data.user.username || 'Friend';
  isLoggedIn = true;
  sessionStorage.removeItem('reset_token');
  if (msgDiv) {
    msgDiv.innerHTML = `<div class="message success">${escapeHtml(data.message || 'Authentication successful.')}</div>`;
  }

  startSessionHeartbeat();
  closeAuth();
  updateAuthUI();

  // Run data sync in background so signin always lands in the app immediately.
  (async () => {
    try {
      const importedCount = await syncLocalMemoriesToBackend(data.user.email);
      if (importedCount > 0) {
        console.log(`Migrated ${importedCount} local memories to backend`);
      }

      const memoriesResult = await getMemories();
      if (memoriesResult.success && memoriesResult.data) {
        memories = memoriesResult.data;
        renderCurrentView();
        console.log(`Loaded ${memories.length} memories from backend.`);
      }
    } catch (error) {
      console.warn('Could not load memories from backend:', error);
    }
  })();
}

function ensureFacebookSdkReady() {
  return new Promise((resolve, reject) => {
    if (!SOCIAL_CONFIG.facebookAppId) {
      reject(new Error('Facebook sign-in is not configured.'));
      return;
    }
    if (!window.FB || typeof window.FB.init !== 'function') {
      reject(new Error('Facebook SDK not loaded. Refresh and try again.'));
      return;
    }
    window.FB.init({
      appId: SOCIAL_CONFIG.facebookAppId,
      cookie: false,
      xfbml: false,
      version: 'v19.0'
    });
    resolve();
  });
}

function openOAuthPopupAndGetResult(url, expectedState) {
  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'mv_social_oauth', 'width=540,height=680');
    if (!popup) {
      reject(new Error('Popup blocked. Allow popups for this site and try again.'));
      return;
    }

    const timeout = setTimeout(() => {
      clearInterval(pollTimer);
      try { popup.close(); } catch {}
      reject(new Error('Social sign-in timed out. Try again.'));
    }, 120000);

    const pollTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollTimer);
        clearTimeout(timeout);
        reject(new Error('Social sign-in was cancelled.'));
        return;
      }

      try {
        if (popup.location.origin !== window.location.origin) return;
        const hash = String(popup.location.hash || '');
        const search = String(popup.location.search || '');
        const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
        const queryParams = new URLSearchParams(search.replace(/^\?/, ''));
        const state = queryParams.get('state') || hashParams.get('state') || '';
        const accessToken = queryParams.get('access_token') || hashParams.get('access_token') || '';
        const authCode = queryParams.get('code') || hashParams.get('code') || '';
        const error = queryParams.get('error') || hashParams.get('error') || queryParams.get('error_description') || hashParams.get('error_description') || '';

        if (!error && !accessToken && !authCode) return;

        clearInterval(pollTimer);
        clearTimeout(timeout);
        try { popup.close(); } catch {}

        if (error) {
          reject(new Error(error));
          return;
        }
        if (expectedState && state !== expectedState) {
          reject(new Error('OAuth state mismatch. Try again.'));
          return;
        }
        if (!accessToken && !authCode) {
          reject(new Error('No auth code or access token returned by provider.'));
          return;
        }
        resolve({ accessToken, code: authCode, state });
      } catch {
        // Wait until popup returns to this origin.
      }
    }, 350);
  });
}

function base64UrlEncode(bytes) {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createPkcePair() {
  if (!window.crypto?.getRandomValues || !window.crypto?.subtle) {
    throw new Error('Browser does not support secure PKCE flow.');
  }

  const random = new Uint8Array(48);
  window.crypto.getRandomValues(random);
  const verifier = base64UrlEncode(random);
  const data = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function getSocialAuthFriendlyError(provider, rawError) {
  const text = String(rawError || '').trim();
  const lower = text.toLowerCase();

  if (lower.includes('popup blocked')) return text;
  if (lower.includes('timed out')) return text;
  if (lower.includes('cancelled')) return text;
  if (lower.includes('state mismatch')) return 'Security validation failed. Please try sign-in again.';

  if (provider === 'facebook') {
    if (lower.includes('invalid') && lower.includes('token')) {
      return 'Facebook sign-in failed. Verify your app is Live and OAuth redirect domain is configured.';
    }
    if (lower.includes('did not provide an email')) {
      return 'Facebook did not return your email. Use an account with verified email access permission.';
    }
  }

  if (provider === 'microsoft') {
    if (lower.includes('audience mismatch')) {
      return 'Microsoft sign-in token mismatch. Confirm your Azure app redirect URI and client ID.';
    }
    if (lower.includes('unauthorized_client') || lower.includes('aadsts')) {
      return 'Microsoft sign-in is blocked by Azure app settings. Check redirect URI and SPA/public client settings.';
    }
  }

  if (provider === 'google' && lower.includes('invalid credentials')) {
    return 'Google sign-in failed. Confirm the OAuth client origin includes this Vercel domain.';
  }

  return text || 'Social sign-in failed. Please try again.';
}

async function socialAuthSignIn(provider) {
  if (authMode === 'reset') return;
  const availability = getSocialProviderAvailability(provider);
  if (!availability.enabled) {
    const msgDivDisabled = document.getElementById('auth-message');
    msgDivDisabled.innerHTML = `<div class="message error">${escapeHtml(availability.reason)}</div>`;
    return;
  }

  const socialButtons = document.querySelectorAll('#auth-social-grid .auth-social-btn[data-provider]');
  socialButtons.forEach((button) => {
    button.disabled = true;
  });

  const msgDiv = document.getElementById('auth-message');
  msgDiv.innerHTML = '<div class="message info">Connecting to provider...</div>';

  try {
    let payload = { provider };

    if (provider === 'google') {
      if (!SOCIAL_CONFIG.googleClientId) {
        throw new Error('Google sign-in is not configured.');
      }
      if (!window.google?.accounts?.oauth2?.initTokenClient) {
        throw new Error('Google SDK not loaded. Refresh and try again.');
      }

      const token = await new Promise((resolve, reject) => {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: SOCIAL_CONFIG.googleClientId,
          scope: 'openid email profile',
          callback: (resp) => {
            if (resp?.error) {
              reject(new Error(resp.error_description || resp.error));
              return;
            }
            resolve(resp.access_token || '');
          }
        });
        client.requestAccessToken({ prompt: 'select_account' });
      });
      payload.accessToken = token;
    } else if (provider === 'facebook') {
      await ensureFacebookSdkReady();
      const token = await new Promise((resolve, reject) => {
        window.FB.login((response) => {
          if (!response?.authResponse?.accessToken) {
            reject(new Error('Facebook sign-in was cancelled.'));
            return;
          }
          resolve(response.authResponse.accessToken);
        }, { scope: 'email,public_profile' });
      });
      payload.accessToken = token;
    } else if (provider === 'microsoft') {
      if (!SOCIAL_CONFIG.microsoftClientId) {
        throw new Error('Microsoft sign-in is not configured.');
      }

      const pkce = await createPkcePair();
      const state = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const redirectUri = `${window.location.origin}${window.location.pathname}`;
      const tenant = encodeURIComponent(SOCIAL_CONFIG.microsoftTenant || 'common');
      const authUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(SOCIAL_CONFIG.microsoftClientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${encodeURIComponent('openid profile email offline_access User.Read')}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(pkce.challenge)}&code_challenge_method=S256`;
      const oauthResult = await openOAuthPopupAndGetResult(authUrl, state);
      const authCode = String(oauthResult?.code || '').trim();
      if (!authCode) {
        throw new Error('No Microsoft authorization code returned.');
      }

      const tokenBody = new URLSearchParams({
        client_id: SOCIAL_CONFIG.microsoftClientId,
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
        scope: 'openid profile email offline_access User.Read'
      });

      const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString()
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok) {
        throw new Error(tokenData?.error_description || tokenData?.error || 'Microsoft token exchange failed.');
      }
      payload.accessToken = String(tokenData?.access_token || '').trim();
      if (!payload.accessToken) {
        throw new Error('Microsoft did not return an access token.');
      }
    } else {
      throw new Error('Unsupported social provider.');
    }

    const response = await fetch(`${API_BASE_URL}/auth/oauth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await parseJsonResponse(response, 'oauth-signin');
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Social sign-in failed.');
    }
    await completeAuthSuccess(data, msgDiv);
  } catch (error) {
    const friendly = getSocialAuthFriendlyError(provider, error?.message || '');
    msgDiv.innerHTML = `<div class="message error">${escapeHtml(friendly)}</div>`;
  } finally {
    updateSocialAuthButtons();
  }
}

const authFormEl = document.getElementById('auth-form');
if (authFormEl) {
  authFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const identifier = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    let username = (document.getElementById('auth-username')?.value || '').trim().toLowerCase();
    const name = document.getElementById('auth-name').value.trim();
    const newPassword = (document.getElementById('auth-new-password')?.value || '').trim();
    const confirmPassword = (document.getElementById('auth-confirm-password')?.value || '').trim();
    const msgDiv = document.getElementById('auth-message');

    if (!identifier) {
      msgDiv.innerHTML = '<div class="message error">Please enter your email or username.</div>';
      return;
    }
    if (authMode !== 'reset' && password.length < 8) {
      msgDiv.innerHTML = '<div class="message error">Password must be at least 8 characters.</div>';
      return;
    }
    if (authMode === 'signup') {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.toLowerCase());
      if (!emailOk) {
        msgDiv.innerHTML = '<div class="message error">Please enter a valid email address.</div>';
        return;
      }
      if (!username) {
        const base = identifier.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        username = (base.length >= 3 ? base : `user_${Date.now().toString().slice(-6)}`).slice(0, 20);
      }
      if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        msgDiv.innerHTML = '<div class="message error">Username must be 3-20 chars with letters, numbers, or underscore.</div>';
        return;
      }
      if (!(/[A-Za-z]/.test(password) && /\d/.test(password))) {
        msgDiv.innerHTML = '<div class="message error">Password must include both letters and numbers.</div>';
        return;
      }
    }
    if (authMode === 'reset') {
      if (newPassword.length < 8) {
        msgDiv.innerHTML = '<div class="message error">New password must be at least 8 characters.</div>';
        return;
      }
      if (!(/[A-Za-z]/.test(newPassword) && /\d/.test(newPassword))) {
        msgDiv.innerHTML = '<div class="message error">New password must include letters and numbers.</div>';
        return;
      }
      if (newPassword !== confirmPassword) {
        msgDiv.innerHTML = '<div class="message error">New passwords do not match.</div>';
        return;
      }
    }
    
    // Show loading state
    msgDiv.innerHTML = '<div class="message info">Processing...</div>';
    
    try {
      let response;
      
      if (authMode === 'signup') {
        // Sign up with backend
        response = await fetch(`${API_BASE_URL}/auth/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: identifier, password, username, name })
        });
      } else if (authMode === 'signin') {
        // Sign in with backend
        response = await fetch(`${API_BASE_URL}/auth/signin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });
      } else {
        const resetToken = sessionStorage.getItem('reset_token') || '';
        response = await fetch(`${API_BASE_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: identifier,
            token: resetToken,
            newPassword,
            confirmPassword
          })
        });
      }
      
      const data = await parseJsonResponse(response, authMode === 'signup' ? 'signup' : 'signin');
      
      if (data.success) {
        await completeAuthSuccess(data, msgDiv);
      } else {
        msgDiv.innerHTML = `<div class="message error">${data.message}</div>`;
      }
    } catch (error) {
      msgDiv.innerHTML = `<div class="message error">${error.message || 'Connection error. Is the server running?'}</div>`;
      console.error('Auth error:', error);
    }
  });
}

function updateAuthUI() {
  // Re-sync auth flags from storage so UI stays correct after navigation/restores.
  isLoggedIn = localStorage.getItem('user_logged_in') === 'true';
  authToken = localStorage.getItem('auth_token') || '';
  const authButtons = document.getElementById('auth-buttons');
  const userSection = document.getElementById('user-section');
  const mobilePanelAuth = document.getElementById('mobile-panel-auth');
  const mobilePanelUser = document.getElementById('mobile-panel-user');
  const isAuthenticated = isLoggedIn && Boolean(authToken);
  
  if (isAuthenticated) {
    if (authButtons) authButtons.style.display = 'none';
    if (userSection) userSection.style.display = 'flex';
    if (mobilePanelAuth) mobilePanelAuth.style.setProperty('display', 'none', 'important');
    if (mobilePanelUser) mobilePanelUser.style.setProperty('display', 'grid', 'important');
    document.getElementById('user-display-name').textContent = `${getGreetingByTime()}, ${userName}`;
    document.getElementById('user-display-email').textContent = userEmail;
    const mobileName = document.getElementById('mobile-panel-user-name');
    const mobileEmail = document.getElementById('mobile-panel-user-email');
    if (mobileName) mobileName.textContent = `${getGreetingByTime()}, ${userName}`;
    if (mobileEmail) mobileEmail.textContent = userEmail;
  } else {
    if (authButtons) {
      authButtons.style.display = 'flex';
      authButtons.style.gap = '0.5rem';
    }
    if (userSection) userSection.style.display = 'none';
    if (mobilePanelAuth) mobilePanelAuth.style.setProperty('display', 'grid', 'important');
    if (mobilePanelUser) mobilePanelUser.style.setProperty('display', 'none', 'important');
  }

  refreshDailyExperience();
}


async function logout() {
  const shouldLogout = confirm('Are you sure you want to logout?');

  if (shouldLogout) {
    if (authToken) {
      try {
        await apiCall('/session/logout', 'POST', { reason: 'user_click' });
      } catch (error) {
        console.warn('Could not record logout activity:', error);
      }
    }
    clearAuthSession({ shouldLockPersonalVault: true });
    updateAuthUI();
    hideAllPages();
    document.getElementById('main-page').classList.add('active');

    // Show logout message
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message success';
    msgDiv.style.cssText = 'position: fixed; top: 6rem; right: 2rem; z-index: 200; animation: slideIn 0.3s ease;';
    msgDiv.textContent = 'You have logged out successfully.';
    document.body.appendChild(msgDiv);

    setTimeout(() => {
      msgDiv.remove();
    }, 3000);
  }
}

function clearAuthSession({ shouldLockPersonalVault = false } = {}) {
  if (shouldLockPersonalVault && authToken) {
    apiCall('/personal/pin/lock', 'POST').catch(() => {});
  }

  localStorage.removeItem('user_logged_in');
  localStorage.removeItem('auth_token');
  localStorage.removeItem('user_email');
  localStorage.removeItem('user_name');

  isLoggedIn = false;
  userEmail = '';
  userName = 'Friend';
  authToken = '';
  stopSessionHeartbeat();
  storePersonalUnlockState('', 0);
  sessionStorage.removeItem('reset_token');
}

// Handle authentication errors
function handleAuthError() {
  console.warn('Authentication error - logging out');
  clearAuthSession({ shouldLockPersonalVault: false });
  updateAuthUI();
  hideAllPages();
  document.getElementById('main-page').classList.add('active');
  showMessage('Session expired. Please sign in again.', 'error');
  openAuth('signin');
}


let aiRequestInFlight = false;

function getAiEls() {
  return {
    chat: document.getElementById('ai-chat'),
    form: document.getElementById('ai-form'),
    input: document.getElementById('ai-input'),
    send: document.getElementById('ai-send-btn'),
    newChat: document.getElementById('ai-new-chat-btn'),
    mode: document.getElementById('ai-mode')
  };
}

function formatAiResponseHtml(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return escapeHtml(normalized).replace(/\n/g, '<br>');
}

function buildAiMessage(role, bodyHtml, opts = {}) {
  const isUser = role === 'user';
  const turn = document.createElement('article');
  turn.className = `ai-turn ${isUser ? 'ai-turn-user' : 'ai-turn-assistant'}${opts.loading ? ' is-loading' : ''}${opts.error ? ' is-error' : ''}`;

  const who = isUser ? 'You' : 'Vault Companion';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const avatarText = isUser ? 'Y' : 'VC';

  turn.innerHTML = `
    <div class="ai-avatar">${avatarText}</div>
    <div class="ai-bubble">
      <div class="ai-meta">${who} · ${time}</div>
      <p class="ai-text">${bodyHtml}</p>
    </div>
  `;
  return turn;
}

function scrollAiToBottom() {
  const { chat } = getAiEls();
  if (!chat) return;
  chat.scrollTop = chat.scrollHeight;
}

function resetAiChat() {
  const { chat, input } = getAiEls();
  if (!chat) return;
  chat.innerHTML = `
    <div class="ai-welcome">
      <div class="ai-welcome-icon">VC</div>
      <p class="ai-welcome-title">Hi, I am your Vault Companion.</p>
      <p class="ai-welcome-subtitle">Ask about your notes, memories, study flow, and next steps.</p>
    </div>
  `;
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
}

function setAiComposerDisabled(disabled) {
  const { input, send, newChat, mode } = getAiEls();
  if (input) input.disabled = Boolean(disabled);
  if (send) {
    send.disabled = Boolean(disabled);
    send.textContent = disabled ? 'Thinking...' : 'Send';
  }
  if (newChat) newChat.disabled = Boolean(disabled);
  if (mode) mode.disabled = Boolean(disabled);
}

function autoGrowAiInput() {
  const { input } = getAiEls();
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function getAiMode() {
  const { mode } = getAiEls();
  const raw = String(mode?.value || localStorage.getItem('ai_mode') || 'general').trim().toLowerCase();
  if (raw === 'coding' || raw === 'memory') return raw;
  return 'general';
}

async function sendAiChatMessage(message, mode) {
  const payload = JSON.stringify({ message: String(message || ''), mode: String(mode || 'general') });
  const attempts = [];

  const call = async (withAuth) => {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuth && authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(`${API_BASE_URL}/ai/chat`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(25000)
    });
    const data = await parseJsonResponse(response, 'ai-chat');
    if (!response.ok || !data?.success) {
      throw new Error(data?.message || `AI request failed (${response.status})`);
    }
    if (!String(data?.response || '').trim()) {
      throw new Error('AI returned an empty response');
    }
    return data;
  };

  try {
    return await call(true);
  } catch (error) {
    attempts.push(String(error?.message || 'unknown error'));
  }

  // Retry once without auth header to avoid stale-token edge cases.
  try {
    return await call(false);
  } catch (error) {
    attempts.push(String(error?.message || 'unknown error'));
  }

  throw new Error(`I could not reach AI right now. ${attempts.join(' | ')}`);
}

function openAIAssistant() {
  closeMobileNavPanel();
  hideAllPages();
  document.getElementById('ai-page').classList.add('active');
  requestAnimationFrame(() => {
    const { input } = getAiEls();
    if (input) input.focus();
  });
}

function closeAI() {
  const { form } = getAiEls();
  if (form) form.reset();
  hideAllPages();
  document.getElementById('main-page').classList.add('active');
}

const aiFormEl = document.getElementById('ai-form');
const aiInputEl = document.getElementById('ai-input');
const aiNewChatBtn = document.getElementById('ai-new-chat-btn');
const aiModeEl = document.getElementById('ai-mode');

if (aiModeEl) {
  const saved = String(localStorage.getItem('ai_mode') || 'general').toLowerCase();
  aiModeEl.value = (saved === 'coding' || saved === 'memory') ? saved : 'general';
  aiModeEl.addEventListener('change', () => {
    localStorage.setItem('ai_mode', getAiMode());
  });
}

if (aiNewChatBtn) {
  aiNewChatBtn.addEventListener('click', () => {
    if (aiRequestInFlight) return;
    resetAiChat();
  });
}

if (aiInputEl) {
  aiInputEl.addEventListener('input', autoGrowAiInput);
  aiInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!aiRequestInFlight && aiFormEl) {
        if (typeof aiFormEl.requestSubmit === 'function') {
          aiFormEl.requestSubmit();
        } else {
          aiFormEl.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
    }
  });
}

if (aiFormEl) {
  aiFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (aiRequestInFlight) return;

    const { chat, input } = getAiEls();
    const message = String(input?.value || '').trim();
    const mode = getAiMode();
    if (!message || !chat) return;

    const welcome = chat.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    const userTurn = buildAiMessage('user', formatAiResponseHtml(message));
    chat.appendChild(userTurn);
    input.value = '';
    autoGrowAiInput();

    const typing = buildAiMessage('assistant', '<span class="ai-typing"><span></span><span></span><span></span></span>', { loading: true });
    typing.id = 'ai-typing-row';
    chat.appendChild(typing);
    scrollAiToBottom();

    aiRequestInFlight = true;
    setAiComposerDisabled(true);

    try {
      const data = await sendAiChatMessage(message, mode);
      if (data.error) throw new Error(String(data.error));

      const replyText = String(data.response || 'I am here to help. Ask me anything.');
      const typingRow = document.getElementById('ai-typing-row');
      if (typingRow) typingRow.remove();

      const assistantTurn = buildAiMessage('assistant', formatAiResponseHtml(replyText));
      chat.appendChild(assistantTurn);
      scrollAiToBottom();

      if (data.source === 'assistant-action' && data.changed) {
        await loadMemoriesFromBackend();
        renderMemories(memories);
        refreshDailyExperience();
      }
    } catch (error) {
      const typingRow = document.getElementById('ai-typing-row');
      if (typingRow) typingRow.remove();
      const errText = `Error: ${escapeHtml(error?.message || 'Could not get a response right now. Try again.')}`;
      const errTurn = buildAiMessage('assistant', errText, { error: true });
      chat.appendChild(errTurn);
      scrollAiToBottom();
    } finally {
      aiRequestInFlight = false;
      setAiComposerDisabled(false);
      if (input) input.focus();
    }
  });
}

// ===== NEW FEATURES: SEARCH, STATS, FAVORITES, EXPORT =====

// Filter memories by search query
function filterMemories(query) {
  clearTimeout(memorySearchTimer);
  memorySearchTimer = setTimeout(() => applyMemoryFilter(query), 120);
}

function applyMemoryFilter(query) {
  const searchResults = document.getElementById('memories-grid');
  if (!searchResults) return;

  const normalizedQuery = String(query || '').trim().toLowerCase();
  const filtered = memories.filter(m =>
    m.title.toLowerCase().includes(normalizedQuery) ||
    m.content.toLowerCase().includes(normalizedQuery) ||
    (m.vault_type && m.vault_type.toLowerCase().includes(normalizedQuery))
  );
  
  // Clear and render filtered results
  searchResults.innerHTML = '';
  
  if (filtered.length === 0 && normalizedQuery) {
    searchResults.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #999; padding: 2rem;">No memories found matching "${escapeHtml(query)}"</p>`;
  } else if (filtered.length === 0) {
    renderMemories(memories);
  } else {
    const fragment = document.createDocumentFragment();
    filtered.forEach(memory => {
      const card = createMemoryCard(memory);
      fragment.appendChild(card);
    });
    searchResults.appendChild(fragment);
  }
}

// Create memory card element
function createMemoryCard(memory) {
  const memoryId = getMemoryId(memory);
  const card = document.createElement('div');
  card.className = 'memory-card';
  card.innerHTML = `
    <div class="memory-card-content">
      <h3>${escapeHtml(memory.title)}</h3>
      <p>${escapeHtml(memory.content.substring(0, 100))}${memory.content.length > 100 ? '...' : ''}</p>
      <div class="memory-meta">
        <span class="vault-badge" data-vault="${memory.vault_type}">${memory.vault_type}</span>
        <span class="memory-date">${new Date(memory.timestamp).toLocaleDateString()}</span>
      </div>
      <div class="memory-actions">
        <button onclick="toggleFavorite('${memoryId}')" class="icon-btn" title="Toggle favorite">Fav</button>
        <button type="button" onclick="deleteMemory('${memoryId}'); return false;" class="icon-btn" title="Delete">Del</button>
      </div>
    </div>
  `;
  return card;
}

// Show statistics modal
function showStats() {
  const modal = document.getElementById('stats-modal');
  if (!modal) return;
  
  // Calculate statistics
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  
  const stats = {
    total: memories.length,
    today: memories.filter(m => new Date(m.timestamp) >= today).length,
    week: memories.filter(m => new Date(m.timestamp) >= weekStart).length,
    month: memories.filter(m => new Date(m.timestamp) >= monthStart).length,
    personal: memories.filter(m => String(m.vault_type || '').toLowerCase() === 'personal').length,
    learning: memories.filter(m => String(m.vault_type || '').toLowerCase() === 'learning').length,
    cultural: memories.filter(m => String(m.vault_type || '').toLowerCase() === 'cultural').length,
    future: memories.filter(m => String(m.vault_type || '').toLowerCase() === 'future').length
  };
  
  // Update modal
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-today').textContent = stats.today;
  document.getElementById('stat-week').textContent = stats.week;
  document.getElementById('stat-month').textContent = stats.month;
  document.getElementById('stat-personal').textContent = stats.personal;
  document.getElementById('stat-learning').textContent = stats.learning;
  document.getElementById('stat-cultural').textContent = stats.cultural;
  document.getElementById('stat-future').textContent = stats.future;
  
  modal.classList.add('open');
}

// Show favorites modal
function showFavorites() {
  const modal = document.getElementById('favorites-modal');
  if (!modal) return;
  
  const favoritesList = document.getElementById('favorites-list');
  const favorites = memories.filter(m => m.isFavorite);
  
  if (favorites.length === 0) {
    favoritesList.innerHTML = '<li class="favorites-empty-message">No favorites yet. Star a memory to add it here!</li>';
  } else {
    favoritesList.innerHTML = favorites.map(m => `
      <li class="favorite-item">
        <div class="favorite-title">${escapeHtml(m.title)}</div>
        <div class="favorite-meta">
          <span>${m.vault_type}</span> â€¢ <span>${new Date(m.timestamp).toLocaleDateString()}</span>
        </div>
      </li>
    `).join('');
  }
  
  modal.classList.add('open');
}

// Toggle favorite status
function toggleFavorite(memoryId) {
  const memory = memories.find(m => getMemoryId(m) === memoryId);
  if (memory) {
    memory.isFavorite = !memory.isFavorite;
    
    // Sync to backend if logged in
    if (authToken) {
      // Update on backend
      apiCall(`/memories/${getMemoryId(memory)}`, 'PATCH', { isFavorite: memory.isFavorite })
        .then(result => {
          if (result.success) {
            console.log('Favorite status synced to backend.');
          }
        })
        .catch(error => console.error('Failed to sync favorite:', error));
    }
    
    showMessage(memory.isFavorite ? 'Added to favorites.' : 'Removed from favorites.', 'success');
  }
}

// Save memories to backend (for syncing favorites and other changes)
async function saveMemoriesToBackend() {
  if (!authToken) {
    console.warn('Not logged in - cannot save to backend');
    return;
  }
  
  if (!serverConnected) {
    console.warn('Server not connected - memories will sync when connection is restored');
    return;
  }
  
  try {
    for (const memory of memories) {
      await apiCall(`/memories/${memory.id}`, 'PATCH', { isFavorite: memory.isFavorite });
    }
    console.log('All memories synced to backend.');
  } catch (error) {
    console.error('Failed to sync memories:', error);
  }
}

// Export memories
function exportMemories() {
  const modal = document.getElementById('export-modal');
  if (modal) {
    const allOption = document.querySelector('input[name="export-scope"][value="all"]');
    if (allOption) allOption.checked = true;
    updateExportPreview();
    modal.classList.add('open');
  }
}

function getSelectedExportScope() {
  const selected = document.querySelector('input[name="export-scope"]:checked');
  return selected?.value === 'important' ? 'important' : 'all';
}

function updateExportPreview() {
  const summaryEl = document.getElementById('export-summary');
  if (!summaryEl) return;

  const scope = getSelectedExportScope();
  const exportableAll = memories.filter((m) => String(m.vault_type || '').toLowerCase() !== 'personal');
  const importantCount = exportableAll.filter((m) => Boolean(m.is_important)).length;
  const selectedCount = scope === 'important' ? importantCount : exportableAll.length;
  const suffix = scope === 'important' ? 'important memories only' : 'all memories';

  if (selectedCount === 0) {
    summaryEl.textContent = scope === 'important'
      ? 'No important memories found yet. Add important memories or switch to "All memories".'
      : 'No memories available yet. Create a memory first, then export.';
  } else {
    summaryEl.textContent = `Ready to export ${selectedCount} ${selectedCount === 1 ? 'memory' : 'memories'} (${suffix}).`;
  }

  updateExportButtonsState(selectedCount > 0);
}

function updateExportButtonsState(enabled) {
  const buttons = document.querySelectorAll('#export-modal .export-btn');
  buttons.forEach((btn) => {
    btn.disabled = !enabled;
    btn.classList.toggle('is-disabled', !enabled);
  });
}

// Download memories in different formats
function downloadMemories(format) {
  if (memories.length === 0) {
    showMessage('No memories to export', 'error');
    return;
  }

  const scope = getSelectedExportScope();
  const normalizedMemories = getExportableMemories(scope);
  if (normalizedMemories.length === 0) {
    showMessage('No memories match the selected export scope', 'error');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeUser = (userName || 'memory-vault-user')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'memory-vault-user';
  const scopeSuffix = scope === 'important' ? 'important' : 'all';
  const baseFilename = `${safeUser}-memories-${scopeSuffix}-${timestamp}`;

  let content;
  let filename;
  let type;

  if (format === 'json') {
    content = JSON.stringify(normalizedMemories, null, 2);
    filename = `${baseFilename}.json`;
    type = 'application/json;charset=utf-8';
  } else if (format === 'csv') {
    const headers = ['id', 'title', 'content', 'vault_type', 'is_important', 'is_favorite', 'timestamp'];
    const rows = normalizedMemories.map((memory) => ([
      memory.id,
      memory.title,
      memory.content,
      memory.vault_type,
      memory.is_important ? 'Yes' : 'No',
      memory.is_favorite ? 'Yes' : 'No',
      memory.timestamp
    ]).map(csvEscape).join(','));

    // Include BOM so Excel opens UTF-8 cleanly.
    content = `\uFEFF${[headers.map(csvEscape).join(','), ...rows].join('\n')}`;
    filename = `${baseFilename}.csv`;
    type = 'text/csv;charset=utf-8';
  } else if (format === 'txt') {
    const lines = normalizedMemories.map((memory, index) => [
      `Memory ${index + 1}`,
      `ID: ${memory.id || 'N/A'}`,
      `Title: ${memory.title}`,
      `Vault: ${memory.vault_type}`,
      `Date: ${memory.timestamp || 'N/A'}`,
      `Important: ${memory.is_important ? 'Yes' : 'No'}`,
      `Favorite: ${memory.is_favorite ? 'Yes' : 'No'}`,
      'Content:',
      memory.content || '',
      '='.repeat(60)
    ].join('\n'));

    content = lines.join('\n\n');
    filename = `${baseFilename}.txt`;
    type = 'text/plain;charset=utf-8';
  } else {
    showMessage('Unsupported export format', 'error');
    return;
  }

  try {
    const blob = new Blob([content], { type });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    showMessage(`Downloaded ${filename}`, 'success');
    closeModal('export-modal');
  } catch (error) {
    console.error('Export failed:', error);
    showMessage('Export failed. Please try again.', 'error');
  }
}

function getExportableMemories(scope = 'all') {
  const nonPersonal = memories.filter((memory) => String(memory.vault_type || '').toLowerCase() !== 'personal');
  const source = scope === 'important'
    ? nonPersonal.filter((memory) => Boolean(memory.is_important))
    : nonPersonal;

  return [...source]
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .map((memory) => ({
      id: memory.__backendId || memory.id || '',
      title: memory.title || '',
      content: memory.content || '',
      vault_type: memory.vault_type || '',
      is_important: Boolean(memory.is_important ?? memory.isImportant),
      is_favorite: Boolean(memory.isFavorite ?? memory.is_favorite),
      timestamp: memory.timestamp || ''
    }));
}

function csvEscape(value) {
  const safeValue = String(value ?? '').replace(/"/g, '""');
  return `"${safeValue}"`;
}

// Close modal
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('open');
  }
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('open');
  }
});







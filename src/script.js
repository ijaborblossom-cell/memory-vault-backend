// Initialize stars
function createStars() {
  const canvas = document.querySelector('.background-canvas');
  for (let i = 0; i < 100; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    star.style.top = Math.random() * 100 + '%';
    star.style.left = Math.random() * 100 + '%';
    star.style.animationDelay = Math.random() * 3 + 's';
    canvas.appendChild(star);
  }
}
createStars();

// Configuration
const defaultConfig = {
  app_title: "Memory Vault",
  app_tagline: "Your everyday study memory system",
  hero_title: "Build your memory, one day at a time",
  hero_subtitle: "Keep class notes, revision insights, and personal reflections in one calm space you can trust.",
  personal_vault_name: "Personal Life Vault",
  learning_vault_name: "Knowledge & Education",
  cultural_vault_name: "Cultural Heritage",
  future_vault_name: "Future Wisdom",
  font_family: "Inter",
  font_size: 16
};

// State
let memories = [];
let currentVault = '';
let currentPin = '';
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
let isAdminUser = false;
let adminApiKey = sessionStorage.getItem('admin_api_key') || '';

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
  const allowExternalApi = window.MEMORY_VAULT_ALLOW_EXTERNAL_API === true;

  const configured =
    window.__API_BASE_URL ||
    window.MEMORY_VAULT_API_URL ||
    sameOriginApi;

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
  if (!panel || !btn) return;
  const isOpen = panel.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeMobileNavPanel() {
  const panel = document.getElementById('mobile-nav-panel');
  const btn = document.getElementById('mobile-menu-toggle');
  if (!panel || !btn) return;
  panel.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
}

function renderProfessionalFooters() {
  const footers = document.querySelectorAll('.footer');
  for (const footer of footers) {
    footer.innerHTML = `
      <div class="footer-content">
        <p class="footer-text">© 2026 by <span class="footer-highlight">Ijabor Blossom</span></p>
        <div class="footer-links">
          <a class="footer-link" href="#" onclick="openAuth('signin'); return false;">Sign In</a>
          <a class="footer-link" href="#" onclick="openAuth('signup'); return false;">Create Account</a>
          <a class="footer-link" href="#" onclick="openAIAssistant(); return false;">AI Assistant</a>
          <a class="footer-link" target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/u/0/?fs=1&to=ijaborblossom@gmail.com&tf=cm">Need Guidance? Contact Support</a>
        </div>
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
  renderProfessionalFooters();
  applyTheme();
  if (isLoggedIn) {
    userName = localStorage.getItem('user_name') || 'Friend';
    userEmail = localStorage.getItem('user_email') || '';
    // Load memories from backend if user is logged in
    loadMemoriesFromBackend();
    refreshAdminAccess().then(updateAuthUI).catch(() => {});
  }
  updateAuthUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeAppUi, { once: true });
} else {
  initializeAppUi();
}

// On mobile, bfcache/page restore can skip initial script timing.
window.addEventListener('pageshow', () => {
  applyTheme();
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
  toggleBtn.textContent = currentlyVisible ? 'Show' : 'Hide';
  toggleBtn.setAttribute('aria-label', currentlyVisible ? 'Show password' : 'Hide password');
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
    return { isOk: true, isError: false, data: null, error: null };
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
async function apiCall(endpoint, method = 'GET', body = null) {
  const includePersonalToken = authToken && personalUnlockToken &&
    (endpoint.startsWith('/memories') || endpoint.startsWith('/personal'));

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken && { 'Authorization': `Bearer ${authToken}` }),
      ...(includePersonalToken && { 'x-personal-unlock-token': personalUnlockToken })
    }
  };
  
  if (body) options.body = JSON.stringify(body);
  
  try {
    // Check if server is connected before making request
    if (!serverConnected) {
      console.warn(`Server not connected. Queuing request to ${endpoint}`);
      return new Promise((resolve) => {
        queueRequest(endpoint, method, body, resolve);
      });
    }
    
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    const data = await parseJsonResponse(response, endpoint);
    
    if (!response.ok) {
      console.error(`API Error (${response.status}):`, data.message);
      if (response.status === 401) {
        // Token expired or invalid
        handleAuthError();
      }
      return { success: false, ...data };
    }
    
    return data;
  } catch (error) {
    console.error('API Error:', error.message);
    
    // Network error - queue the request
    if (error.message.includes('Failed to fetch') || error.name === 'TypeError') {
      serverConnected = false;
      updateConnectionStatus(false);
      attemptReconnect();
      
      return new Promise((resolve) => {
        queueRequest(endpoint, method, body, resolve);
      });
    }
    
    return { success: false, message: error.message };
  }
}

// Memory API functions
async function createMemory(title, content, is_important, vault_type) {
  if (authToken && serverConnected) {
    return await apiCall('/memories', 'POST', { title, content, is_important, vault_type });
  } else {
    // Fall back to localStorage if not authenticated or backend is offline.
    return await window.dataSdk.create({ title, content, is_important, vault_type });
  }
}

async function refreshAdminAccess() {
  if (!authToken) {
    isAdminUser = false;
    return;
  }

  const result = await apiCall('/admin/me', 'GET');
  isAdminUser = Boolean(result.success && result.isAdmin);
}

async function getMemories() {
  if (authToken) {
    return await apiCall('/memories', 'GET');
  } else {
    return { success: true, data: window.dataSdk.loadData() };
  }
}

// Navigation
function openVault(vault) {
  currentVault = vault;
  hideAllPages();
  
  if (vault === 'personal') {
    document.getElementById('personal-page').classList.add('active');
    lockDiaryView();
    if (authToken) {
      restorePersonalUnlockState();
    }
  } else {
    document.getElementById(`${vault}-page`).classList.add('active');
    renderVaultMemories(vault);
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
  currentVault = vault;
  hideAllPages();
  document.getElementById('form-page').classList.add('active');
  
  const icons = { learning: 'KN', cultural: 'CH', future: 'FW', personal: 'PV' };
  const titles = { learning: 'Add Knowledge', cultural: 'Add Cultural Memory', future: 'Add Future Wisdom', personal: 'Write Diary Entry' };
  
  document.getElementById('form-icon').textContent = icons[vault];
  document.getElementById('form-title').textContent = titles[vault];
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
    (memory.vault_type || '').trim(),
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
  if (currentPin.length < 6) {
    currentPin += digit;
    updatePinDisplay();
    
    if (currentPin.length === 6) {
      setTimeout(submitPin, 300);
    }
  }
}

function clearPin() {
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
  const msgDiv = document.getElementById('pin-message');
  
  if (currentPin.length < 4) {
    msgDiv.innerHTML = '<div class="message error">PIN must be at least 4 digits</div>';
    return;
  }

  if (authToken) {
    const status = await apiCall('/personal/pin/status', 'GET');
    if (!status.success) {
      msgDiv.innerHTML = `<div class="message error">${escapeHtml(status.message || 'Could not check PIN status')}</div>`;
      currentPin = '';
      updatePinDisplay();
      return;
    }

    if (!status.configured) {
      const setupResult = await apiCall('/personal/pin/setup', 'POST', { pin: currentPin });
      if (!setupResult.success) {
        msgDiv.innerHTML = `<div class="message error">${escapeHtml(setupResult.message || 'PIN setup failed')}</div>`;
        currentPin = '';
        updatePinDisplay();
        return;
      }
    }

    const verifyResult = await apiCall('/personal/pin/verify', 'POST', { pin: currentPin });
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
    userPin = currentPin;
    localStorage.setItem('diary_pin', userPin);
    
    const name = prompt('What should we call you?') || 'Friend';
    userName = name;
    localStorage.setItem('user_name', name);
    
    unlockDiary();
  } else {
    // Verify PIN
    if (currentPin === userPin) {
      unlockDiary();
    } else {
      msgDiv.innerHTML = '<div class="message error">Incorrect PIN.</div>';
      currentPin = '';
      updatePinDisplay();
    }
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
  
  if (!isDataSdkReady) {
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
    vault_type: currentVault,
    is_important: document.getElementById('memory-important').checked,
    timestamp: new Date().toISOString()
  };
  
  try {
    const result = await createMemory(memory.title, memory.content, memory.is_important, memory.vault_type);
    
    if (result.success || result.isOk) {
      if (result.data) {
        memories.push(result.data);
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
  if (!id) {
    showMessage('Cannot delete memory: missing id', 'error');
    return;
  }

  const memory = memories.find(m => getMemoryId(m) === id);
  if (!memory) return;
  const shouldDelete = confirm('Delete this memory?');
  if (!shouldDelete) return;
  const result = authToken
    ? await apiCall(`/memories/${id}`, 'DELETE')
    : await window.dataSdk.delete({ __backendId: id });
  if (!(result.success || result.isOk)) {
    showMessage(`Failed to delete memory: ${result.message || 'Unknown error'}`, 'error');
    return;
  }
  memories = memories.filter(m => getMemoryId(m) !== id);
  updateCounts();
  renderCurrentView();
  showMessage('Memory deleted successfully', 'success');
}
// Render Functions
function updateCounts() {
  const counts = {
    learning: memories.filter(m => m.vault_type === 'learning').length,
    cultural: memories.filter(m => m.vault_type === 'cultural').length,
    future: memories.filter(m => m.vault_type === 'future').length
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
  
  // Load ALL users' memories from all storage keys for trending
  const allTrendingMemories = [];
  
  // Get all localStorage keys
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    // Look for memory vault data keys
    if (key && key.startsWith('memory_vault_data_')) {
      try {
        const data = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(data)) {
          // Only include non-personal memories
          allTrendingMemories.push(...data.filter(m => m.vault_type !== 'personal'));
        }
      } catch (error) {
        console.error('Error loading trending memories:', error);
      }
    }
  }
  
  // Get important memories and recent ones from ALL users
  const importantMemories = allTrendingMemories.filter(m => m.is_important);
  const recentMemories = [...allTrendingMemories]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 5);
  
  // Combine and deduplicate
  const trendingSet = new Set([...importantMemories, ...recentMemories]);
  const trending = Array.from(trendingSet).slice(0, 6);
  
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
}

function getVaultLabel(vaultType) {
  const labels = {
    learning: 'Knowledge',
    cultural: 'Cultural',
    future: 'Future'
  };
  return labels[vaultType] || vaultType;
}

function renderVaultMemories(vault) {
  const container = document.getElementById(`${vault}-memories`);
  const vaultMemories = memories.filter(m => m.vault_type === vault);
  
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
        <button class="delete-btn" onclick="deleteMemory('${getMemoryId(m)}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function renderDiaryEntries() {
  const container = document.getElementById('diary-entries');
  const entries = memories.filter(m => m.vault_type === 'personal');
  
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
        <button class="delete-btn" onclick="deleteMemory('${getMemoryId(e)}')">Delete</button>
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
  authMode = mode;
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
  const switchText = document.getElementById('auth-switch-text');
  const switchBtnText = document.getElementById('auth-switch-btn-text');
  
  if (mode === 'signin') {
    document.getElementById('auth-title').textContent = 'Sign In';
    document.getElementById('auth-subtitle').textContent = 'Access your memory vault';
    document.getElementById('auth-submit-text').textContent = 'Sign In';
    if (switchText) switchText.textContent = "Don't have an account?";
    if (switchBtnText) switchBtnText.textContent = 'Sign Up';
    if (nameGroup) nameGroup.classList.remove('active');
    if (usernameGroup) usernameGroup.classList.remove('active');
    if (forgotContainer) forgotContainer.classList.add('active');
    if (resetPasswordGroup) resetPasswordGroup.classList.remove('active');
    if (resetConfirmGroup) resetConfirmGroup.classList.remove('active');
    if (passwordFormGroup) passwordFormGroup.style.display = '';
    if (identifierLabel) identifierLabel.textContent = 'Email or Username';
    if (identifierInput) identifierInput.placeholder = 'your@email.com or username';
    if (identifierInput) identifierInput.readOnly = false;
  } else {
    if (mode === 'signup') {
      document.getElementById('auth-title').textContent = 'Sign Up';
      document.getElementById('auth-subtitle').textContent = 'Create your memory vault account';
      document.getElementById('auth-submit-text').textContent = 'Create Account';
      if (switchText) switchText.textContent = 'Already have an account?';
      if (switchBtnText) switchBtnText.textContent = 'Sign In';
      if (nameGroup) nameGroup.classList.add('active');
      if (usernameGroup) usernameGroup.classList.add('active');
      if (forgotContainer) forgotContainer.classList.remove('active');
      if (resetPasswordGroup) resetPasswordGroup.classList.remove('active');
      if (resetConfirmGroup) resetConfirmGroup.classList.remove('active');
      if (passwordFormGroup) passwordFormGroup.style.display = '';
      if (identifierLabel) identifierLabel.textContent = 'Email';
      if (identifierInput) identifierInput.placeholder = 'your@email.com';
      if (identifierInput) identifierInput.readOnly = false;
    } else {
      document.getElementById('auth-title').textContent = 'Reset Password';
      document.getElementById('auth-subtitle').textContent = 'Set your new password and continue';
      document.getElementById('auth-submit-text').textContent = 'Reset Password';
      if (switchText) switchText.textContent = 'Remembered your password?';
      if (switchBtnText) switchBtnText.textContent = 'Sign In';
      if (nameGroup) nameGroup.classList.remove('active');
      if (usernameGroup) usernameGroup.classList.remove('active');
      if (forgotContainer) forgotContainer.classList.remove('active');
      if (resetPasswordGroup) resetPasswordGroup.classList.add('active');
      if (resetConfirmGroup) resetConfirmGroup.classList.add('active');
      if (passwordFormGroup) passwordFormGroup.style.display = 'none';
      if (identifierLabel) identifierLabel.textContent = 'Registered Email';
      if (identifierInput) identifierInput.placeholder = 'your@email.com';
      const urlParams = new URLSearchParams(window.location.search);
      const resetEmail = (urlParams.get('email') || '').trim();
      if (identifierInput && resetEmail) {
        identifierInput.value = resetEmail;
        identifierInput.readOnly = true;
      }
    }
  }

  const passwordInput = document.getElementById('auth-password');
  const passwordToggle = document.getElementById('auth-password-toggle');
  if (passwordInput) passwordInput.type = 'password';
  if (passwordToggle) {
    passwordToggle.textContent = 'Show';
    passwordToggle.setAttribute('aria-label', 'Show password');
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
    passwordToggle.textContent = 'Show';
    passwordToggle.setAttribute('aria-label', 'Show password');
  }
  sessionStorage.removeItem('reset_token');
  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.replaceState({}, '', cleanUrl);
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

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const identifier = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const username = (document.getElementById('auth-username')?.value || '').trim().toLowerCase();
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
      // Store token and user info
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('user_email', data.user.email);
      localStorage.setItem('user_name', data.user.name || data.user.username || 'Friend');
      localStorage.setItem('user_logged_in', 'true');
      
      // Update state
      authToken = data.token;
      userEmail = data.user.email;
      userName = data.user.name || data.user.username || 'Friend';
      isLoggedIn = true;
      sessionStorage.removeItem('reset_token');
      msgDiv.innerHTML = `<div class="message success">${escapeHtml(data.message || 'Authentication successful.')}</div>`;
      
      // Load memories from backend
      console.log('Loading memories from backend...');
      try {
        const importedCount = await syncLocalMemoriesToBackend(data.user.email);
        if (importedCount > 0) {
          console.log(`Migrated ${importedCount} local memories to backend`);
        }

        const memoriesResult = await getMemories();
        if (memoriesResult.success && memoriesResult.data) {
          memories = memoriesResult.data;
          console.log(`Loaded ${memories.length} memories from backend.`);
        }
      } catch (error) {
        console.warn('Could not load memories from backend:', error);
      }
      
      setTimeout(() => {
        closeAuth();
        refreshAdminAccess().then(updateAuthUI).catch(updateAuthUI);
      }, 1500);
    } else {
      msgDiv.innerHTML = `<div class="message error">${data.message}</div>`;
    }
  } catch (error) {
    msgDiv.innerHTML = `<div class="message error">${error.message || 'Connection error. Is the server running?'}</div>`;
    console.error('Auth error:', error);
  }
});

function updateAuthUI() {
  const authButtons = document.getElementById('auth-buttons');
  const userSection = document.getElementById('user-section');
  const mobilePanelAuth = document.getElementById('mobile-panel-auth');
  const mobilePanelUser = document.getElementById('mobile-panel-user');
  const adminBtn = document.getElementById('admin-nav-btn');
  
  if (isLoggedIn) {
    authButtons.style.display = 'none';
    userSection.style.display = 'flex';
    if (mobilePanelAuth) mobilePanelAuth.style.display = 'none';
    if (mobilePanelUser) mobilePanelUser.style.display = 'flex';
    document.getElementById('user-display-name').textContent = `${getGreetingByTime()}, ${userName}`;
    document.getElementById('user-display-email').textContent = userEmail;
    const mobileName = document.getElementById('mobile-panel-user-name');
    const mobileEmail = document.getElementById('mobile-panel-user-email');
    if (mobileName) mobileName.textContent = `${getGreetingByTime()}, ${userName}`;
    if (mobileEmail) mobileEmail.textContent = userEmail;
    if (adminBtn) adminBtn.style.display = isAdminUser ? 'inline-flex' : 'none';
  } else {
    authButtons.style.display = 'flex';
    authButtons.style.gap = '0.5rem';
    userSection.style.display = 'none';
    if (mobilePanelAuth) mobilePanelAuth.style.display = 'flex';
    if (mobilePanelUser) mobilePanelUser.style.display = 'none';
    if (adminBtn) adminBtn.style.display = 'none';
  }
  refreshDailyExperience();
}

function logout() {
  const shouldLogout = confirm('Are you sure you want to logout?');
  
  if (shouldLogout) {
    if (authToken) {
      apiCall('/personal/pin/lock', 'POST').catch(() => {});
    }

    // Clear local storage
    localStorage.removeItem('user_logged_in');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_email');
    localStorage.removeItem('user_name');
    
    // Reset state
    isLoggedIn = false;
    isAdminUser = false;
    userEmail = '';
    userName = 'Friend';
    authToken = '';
    storePersonalUnlockState('', 0);
    adminApiKey = '';
    sessionStorage.removeItem('admin_api_key');
    
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

// Handle authentication errors
function handleAuthError() {
  console.warn('Authentication error - logging out');
  logout();
  showMessage('Session expired. Please sign in again.', 'error');
  openAuth('signin');
}


function closeAdminDashboard() {
  hideAllPages();
  document.getElementById('main-page').classList.add('active');
}

function setAdminApiKey() {
  if (!isAdminUser) {
    showMessage('Admin dashboard is restricted to the owner account.', 'error');
    return;
  }
  const key = prompt('Enter your admin API key:');
  if (!key) return;
  adminApiKey = key.trim();
  sessionStorage.setItem('admin_api_key', adminApiKey);
  showMessage('Admin key saved for this session.', 'success');
}

function clearAdminApiKey() {
  adminApiKey = '';
  sessionStorage.removeItem('admin_api_key');
  showMessage('Admin key cleared.', 'success');
}

async function adminFetch(endpoint) {
  if (!authToken) return { success: false, message: 'Sign in required' };
  if (!isAdminUser) return { success: false, message: 'Owner-only admin access' };
  if (!adminApiKey) return { success: false, message: 'Admin API key is required' };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'x-admin-key': adminApiKey
    }
  });
  const data = await response.json();
  return { status: response.status, ...data };
}

function renderAdminActivities(activities) {
  const body = document.getElementById('admin-activity-body');
  if (!body) return;

  if (!activities.length) {
    body.innerHTML = '<tr><td colspan="5">No activities recorded yet.</td></tr>';
    return;
  }

  body.innerHTML = activities.map((item) => `
    <tr>
      <td>${escapeHtml(formatDate(item.timestamp))}</td>
      <td>${escapeHtml(item.action || '-')}</td>
      <td>${escapeHtml(item.email || '-')}</td>
      <td>${escapeHtml(item.path || '-')}</td>
      <td>${escapeHtml(item.ip || '-')}</td>
    </tr>
  `).join('');
}

function renderAdminStats(stats) {
  const totalEl = document.getElementById('admin-total-activities');
  const latestEl = document.getElementById('admin-latest-activity');
  const topActionEl = document.getElementById('admin-top-action');

  if (totalEl) totalEl.textContent = String(stats.totalActivities || 0);
  if (latestEl) latestEl.textContent = stats.latest ? formatDate(stats.latest) : '-';

  const top = Object.entries(stats.byAction || {}).sort((a, b) => b[1] - a[1])[0];
  if (topActionEl) topActionEl.textContent = top ? `${top[0]} (${top[1]})` : '-';
}

async function loadAdminDashboard() {
  if (!isAdminUser) {
    showMessage('Admin dashboard is restricted to the owner account.', 'error');
    closeAdminDashboard();
    return;
  }
  if (!adminApiKey) {
    setAdminApiKey();
    if (!adminApiKey) return;
  }

  const [stats, activities] = await Promise.all([
    adminFetch('/admin/stats'),
    adminFetch('/admin/activities?limit=200')
  ]);

  if (!stats.success || !activities.success) {
    const message = stats.message || activities.message || 'Failed to load admin dashboard';
    showMessage(message, 'error');
    if (stats.status === 401 || activities.status === 401) clearAdminApiKey();
    return;
  }

  renderAdminStats(stats);
  renderAdminActivities(Array.isArray(activities.data) ? activities.data : []);
}

async function openAdminDashboard() {
  if (!isLoggedIn) {
    showMessage('Please sign in first.', 'error');
    return;
  }

  await refreshAdminAccess();
  if (!isAdminUser) {
    showMessage('Admin dashboard is restricted to the owner account.', 'error');
    return;
  }

  window.location.href = 'admin.html';
}

function openAIAssistant() {
  isLoggedIn = localStorage.getItem('user_logged_in') === 'true';
  authToken = localStorage.getItem('auth_token') || '';
  if (!isLoggedIn || !authToken) {
    showMessage('Please sign in to use the AI Assistant', 'error');
    showAuth();
    return;
  }
  closeMobileNavPanel();
  hideAllPages();
  document.getElementById('ai-page').classList.add('active');
  requestAnimationFrame(() => {
    const input = document.getElementById('ai-input');
    if (input) input.focus();
  });
}

function closeAI() {
  document.getElementById('ai-form').reset();
  hideAllPages();
  document.getElementById('main-page').classList.add('active');
}

document.getElementById('ai-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const input = document.getElementById('ai-input').value.trim();
  const chatDiv = document.getElementById('ai-chat');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  
  if (!input) {
    showMessage('Please enter a message', 'error');
    return;
  }
  
  // Check if logged in
  if (!isLoggedIn) {
    showMessage('Please sign in to use the AI Assistant', 'error');
    document.getElementById('ai-input').value = '';
    return;
  }
  
  // Add user message
  const userMsg = document.createElement('div');
  userMsg.className = 'ai-message user-message';
  userMsg.innerHTML = `<div class="message-content"><strong>You</strong><p>${escapeHtml(input)}</p></div>`;
  chatDiv.appendChild(userMsg);
  
  // Show loading indicator
  const loadingMsg = document.createElement('div');
  loadingMsg.id = 'ai-loading';
  loadingMsg.className = 'ai-message ai-bot-message';
  loadingMsg.innerHTML = `<div class="message-content"><strong>Assistant</strong><p>Thinking...</p></div>`;
  chatDiv.appendChild(loadingMsg);
  chatDiv.scrollTop = chatDiv.scrollHeight;
  
  // Disable input
  submitBtn.disabled = true;
  document.getElementById('ai-input').value = '';
  
  try {
    const data = await apiCall('/ai/chat', 'POST', { message: input });
    if (!data || !data.success) {
      throw new Error(data?.message || 'AI request failed');
    }
    
    // Check if data contains an error message instead of a response
    if (data.error) {
      throw new Error(`API Error: ${data.error}`);
    }
    
    const aiResponse = data.response || 'I\'m here to help! Ask me anything.';
    
    // Remove loading message
    loadingMsg.remove();
    
    // Add AI response with animation
    const aiMsg = document.createElement('div');
    aiMsg.className = 'ai-message ai-bot-message';
    aiMsg.innerHTML = `<div class="message-content"><strong>Assistant</strong><p>${escapeHtml(aiResponse)}</p></div>`;
    chatDiv.appendChild(aiMsg);
    chatDiv.scrollTop = chatDiv.scrollHeight;
    
    console.log('AI message sent successfully.');
    
  } catch (error) {
    console.error('AI error:', error.message);
    
    // Remove loading message
    const loading = document.getElementById('ai-loading');
    if (loading) loading.remove();
    
    // Show error message
    const errorMsg = document.createElement('div');
    errorMsg.className = 'ai-message ai-bot-message error-message';
    errorMsg.innerHTML = `<div class="message-content"><strong>Assistant</strong><p>Error: ${escapeHtml(error.message)}. There is a connection issue. Please try again.</p></div>`;
    chatDiv.appendChild(errorMsg);
    chatDiv.scrollTop = chatDiv.scrollHeight;
  } finally {
    submitBtn.disabled = false;
  }
});

// ===== NEW FEATURES: SEARCH, STATS, FAVORITES, EXPORT =====

// Filter memories by search query
function filterMemories(query) {
  const searchResults = document.getElementById('memories-grid');
  if (!searchResults) return;
  
  const filtered = memories.filter(m => 
    m.title.toLowerCase().includes(query.toLowerCase()) ||
    m.content.toLowerCase().includes(query.toLowerCase()) ||
    (m.vault_type && m.vault_type.toLowerCase().includes(query.toLowerCase()))
  );
  
  // Clear and render filtered results
  searchResults.innerHTML = '';
  
  if (filtered.length === 0 && query.trim()) {
    searchResults.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #999; padding: 2rem;">No memories found matching "${escapeHtml(query)}"</p>`;
  } else if (filtered.length === 0) {
    renderMemories(memories);
  } else {
    filtered.forEach(memory => {
      const card = createMemoryCard(memory);
      searchResults.appendChild(card);
    });
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
        <button onclick="deleteMemory('${memoryId}')" class="icon-btn" title="Delete">Del</button>
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
    personal: memories.filter(m => m.vault_type === 'Personal').length,
    learning: memories.filter(m => m.vault_type === 'Learning').length,
    cultural: memories.filter(m => m.vault_type === 'Cultural').length,
    future: memories.filter(m => m.vault_type === 'Future Vision').length
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
          <span>${m.vault_type}</span> • <span>${new Date(m.timestamp).toLocaleDateString()}</span>
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



(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    title: $('title'),
    sub: $('sub'),
    form: $('auth-form'),
    nameGroup: $('name-group'),
    usernameGroup: $('username-group'),
    idLabel: $('id-label'),
    email: $('email'),
    passwordGroup: $('password-group'),
    password: $('password'),
    eye: $('eye'),
    submit: $('submit-btn'),
    socialDivider: $('social-divider'),
    socialGrid: $('social-grid'),
    switchText: $('switch-text'),
    switchBtn: $('switch-btn'),
    forgotBtn: $('forgot-btn'),
    msg: $('msg'),
    name: $('name'),
    username: $('username')
  };

  let authMode = 'signin';

  const SOCIAL_CONFIG = {
    googleClientId: String(window.MEMORY_VAULT_GOOGLE_CLIENT_ID || '').trim(),
    facebookAppId: String(window.MEMORY_VAULT_FACEBOOK_APP_ID || '').trim(),
    microsoftClientId: String(window.MEMORY_VAULT_MICROSOFT_CLIENT_ID || '').trim(),
    microsoftTenant: String(window.MEMORY_VAULT_MICROSOFT_TENANT || 'common').trim() || 'common'
  };

  function resolveApiBaseUrl() {
    const liveFallbackApi = 'https://memory-vault-coral-seven.vercel.app/api';
    const sameOriginApi = `${window.location.origin}/api`;
    const raw = String(window.MEMORY_VAULT_API_URL || (window.Capacitor ? liveFallbackApi : sameOriginApi)).trim();
    if (!raw) return sameOriginApi;
    const cleaned = raw.replace(/\/+$/, '');
    return cleaned.endsWith('/api') ? cleaned : `${cleaned}/api`;
  }

  const API_BASE_URL = resolveApiBaseUrl();

  function showMsg(text, kind) {
    els.msg.className = `msg ${kind || ''}`;
    els.msg.textContent = text || '';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
  }

  async function parseJsonResponse(response, contextLabel) {
    const raw = await response.text();
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Invalid server response for ${contextLabel}`);
    }
  }

  function getPathForMode(mode) {
    if (window.Capacitor) {
      return `auth.html?mode=${mode}`;
    }
    return mode === 'signup' ? '/auth/signup' : '/auth/signin';
  }

  function setMode(mode, options) {
    const opts = options && typeof options === 'object' ? options : {};
    authMode = mode === 'signup' ? 'signup' : 'signin';

    if (authMode === 'signup') {
      els.title.textContent = 'Sign Up';
      els.sub.textContent = 'Create your memory vault account';
      els.submit.textContent = 'Create Account';
      els.switchText.textContent = 'Already have an account?';
      els.switchBtn.textContent = 'Sign In';
      els.nameGroup.classList.remove('hide');
      els.usernameGroup.classList.remove('hide');
      els.idLabel.textContent = 'Email';
      els.email.placeholder = 'your@email.com';
      els.forgotBtn.classList.add('hide');
      els.socialDivider.textContent = 'or sign up with';
    } else {
      els.title.textContent = 'Sign In';
      els.sub.textContent = 'Access your memory vault';
      els.submit.textContent = 'Sign In';
      els.switchText.textContent = "Don't have an account?";
      els.switchBtn.textContent = 'Sign Up';
      els.nameGroup.classList.add('hide');
      els.usernameGroup.classList.add('hide');
      els.idLabel.textContent = 'Email or Username';
      els.email.placeholder = 'your@email.com or username';
      els.forgotBtn.classList.remove('hide');
      els.socialDivider.textContent = 'or sign in with';
    }

    if (!opts.skipRouteUpdate) {
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const next = getPathForMode(authMode);
      if (current !== next) {
        window.history.replaceState({}, '', next);
      }
    }
    showMsg('', '');
  }

  function navigateToMode(mode) {
    const target = getPathForMode(mode);
    if (window.location.pathname === target) {
      setMode(mode, { skipRouteUpdate: true });
      return;
    }
    window.location.assign(target);
  }

  function getSocialProviderAvailability(provider) {
    if (provider === 'google') return { enabled: Boolean(SOCIAL_CONFIG.googleClientId), reason: 'Google sign-in is not configured.' };
    if (provider === 'facebook') return { enabled: Boolean(SOCIAL_CONFIG.facebookAppId), reason: 'Facebook sign-in is not configured.' };
    if (provider === 'microsoft') return { enabled: Boolean(SOCIAL_CONFIG.microsoftClientId), reason: 'Microsoft sign-in is not configured.' };
    return { enabled: false, reason: 'Unsupported provider.' };
  }

  function updateSocialButtons() {
    const buttons = [...document.querySelectorAll('.social-btn[data-provider]')];
    let enabled = 0;
    for (const btn of buttons) {
      const provider = String(btn.getAttribute('data-provider') || '').toLowerCase();
      const info = getSocialProviderAvailability(provider);
      btn.disabled = !info.enabled;
      btn.style.opacity = info.enabled ? '1' : '.5';
      btn.title = info.enabled ? '' : info.reason;
      if (info.enabled) enabled += 1;
    }
    const hide = enabled === 0;
    els.socialDivider.classList.toggle('hide', hide);
    els.socialGrid.classList.toggle('hide', hide);
  }

  async function completeAuthSuccess(data) {
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('user_email', data.user.email);
    localStorage.setItem('user_name', data.user.name || data.user.username || 'Friend');
    localStorage.setItem('user_logged_in', 'true');
    showMsg('Success. Redirecting to app...', 'ok');
    window.location.assign('/');
  }

  async function startForgotPasswordFlow() {
    const emailGuess = els.email.value.trim();
    const email = prompt('Enter your registered email address:', emailGuess);
    if (!email) return;
    showMsg('Sending reset link...', '');
    try {
      const response = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() })
      });
      const data = await parseJsonResponse(response, 'forgot-password');
      showMsg(data.message || 'If this email exists, a reset link was sent.', 'ok');
    } catch (error) {
      showMsg(error.message || 'Unable to send reset link.', 'error');
    }
  }

  function base64UrlEncode(bytes) {
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function createPkcePair() {
    const random = new Uint8Array(48);
    window.crypto.getRandomValues(random);
    const verifier = base64UrlEncode(random);
    const data = new TextEncoder().encode(verifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    const challenge = base64UrlEncode(new Uint8Array(digest));
    return { verifier, challenge };
  }

  function openOAuthPopupAndGetResult(url, expectedState) {
    return new Promise((resolve, reject) => {
      const popup = window.open(url, 'mv_social_oauth', 'width=540,height=680');
      if (!popup) {
        reject(new Error('Popup blocked. Allow popups and try again.'));
        return;
      }

      const timeout = setTimeout(() => {
        clearInterval(pollTimer);
        try { popup.close(); } catch {}
        reject(new Error('Social sign-in timed out.'));
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
            reject(new Error('OAuth state mismatch.'));
            return;
          }
          resolve({ accessToken, code: authCode, state });
        } catch {}
      }, 350);
    });
  }

  function ensureFacebookSdkReady() {
    return new Promise((resolve, reject) => {
      if (!SOCIAL_CONFIG.facebookAppId) {
        reject(new Error('Facebook sign-in is not configured.'));
        return;
      }
      if (!window.FB || typeof window.FB.init !== 'function') {
        reject(new Error('Facebook SDK not loaded.'));
        return;
      }
      window.FB.init({ appId: SOCIAL_CONFIG.facebookAppId, cookie: false, xfbml: false, version: 'v19.0' });
      resolve();
    });
  }

  async function socialAuthSignIn(provider) {
    const availability = getSocialProviderAvailability(provider);
    if (!availability.enabled) {
      showMsg(availability.reason, 'error');
      return;
    }

    showMsg('Connecting to provider...', '');
    try {
      let payload = { provider };
      const isMobile = !!window.Capacitor;
      const redirectUri = "https://memory-vault-coral-seven.vercel.app/auth.html";

      if (isMobile && window.Capacitor.Plugins.Browser) {
        // Use system browser to avoid 'User-Agent' / security blocks from Google/FB
        let authUrl = "";
        const state = `${provider}_${Date.now()}`;
        if (provider === 'google') {
          authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(SOCIAL_CONFIG.googleClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+email+profile&state=${state}&prompt=select_account`;
        } else if (provider === 'facebook') {
          authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${encodeURIComponent(SOCIAL_CONFIG.facebookAppId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=email,public_profile&response_type=token`;
        } else if (provider === 'microsoft') {
          const pkce = await createPkcePair();
          // Store verifier for the return trip
          localStorage.setItem('pkce_verifier', pkce.verifier);
          authUrl = `https://login.microsoftonline.com/${encodeURIComponent(SOCIAL_CONFIG.microsoftTenant || 'common')}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(SOCIAL_CONFIG.microsoftClientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid profile email offline_access User.Read')}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(pkce.challenge)}&code_challenge_method=S256`;
        }
        
        if (authUrl) {
          await window.Capacitor.Plugins.Browser.open({ url: authUrl });
          return;
        }
      }

      // Traditional Popup-based flow for Desktop Web
      if (provider === 'google') {
        const token = await new Promise((resolve, reject) => {
// ... rest of google logic
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: SOCIAL_CONFIG.googleClientId,
            scope: 'openid email profile',
            callback: (resp) => {
              if (resp?.error) return reject(new Error(resp.error_description || resp.error));
              resolve(resp.access_token || '');
            }
          });
          client.requestAccessToken({ prompt: 'select_account' });
        });
        payload.accessToken = token;
      } else if (provider === 'facebook') {
        if (isMobile) {
          const state = `facebook_${Date.now()}`;
          const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${encodeURIComponent(SOCIAL_CONFIG.facebookAppId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=email,public_profile&response_type=token`;
          window.location.assign(authUrl);
          return;
        }
        await ensureFacebookSdkReady();
        const token = await new Promise((resolve, reject) => {
          window.FB.login((response) => {
            if (!response?.authResponse?.accessToken) return reject(new Error('Facebook sign-in was cancelled.'));
            resolve(response.authResponse.accessToken);
          }, { scope: 'email,public_profile' });
        });
        payload.accessToken = token;
      } else if (provider === 'microsoft') {
        const pkce = await createPkcePair();
        const state = `microsoft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const authUrl = `https://login.microsoftonline.com/${encodeURIComponent(SOCIAL_CONFIG.microsoftTenant || 'common')}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(SOCIAL_CONFIG.microsoftClientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${encodeURIComponent('openid profile email offline_access User.Read')}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(pkce.challenge)}&code_challenge_method=S256`;
        
        if (isMobile) {
          window.location.assign(authUrl);
          return;
        }
        
        const oauthResult = await openOAuthPopupAndGetResult(authUrl, state);
        const authCode = String(oauthResult?.code || '').trim();
        if (!authCode) throw new Error('No Microsoft authorization code returned.');

        const tokenBody = new URLSearchParams({
          client_id: SOCIAL_CONFIG.microsoftClientId,
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: redirectUri,
          code_verifier: pkce.verifier,
          scope: 'openid profile email offline_access User.Read'
        });

        const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(SOCIAL_CONFIG.microsoftTenant || 'common')}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString()
        });
        const tokenData = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok) throw new Error(tokenData?.error_description || tokenData?.error || 'Microsoft token exchange failed.');
        payload.accessToken = String(tokenData?.access_token || '').trim();
      }

      const response = await fetch(`${API_BASE_URL}/auth/oauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await parseJsonResponse(response, 'oauth-signin');
      if (!response.ok || !data.success) throw new Error(data.message || 'Social sign-in failed.');
      await completeAuthSuccess(data);
    } catch (error) {
      showMsg(error.message || 'Social sign-in failed.', 'error');
    }
  }

  function buildUsername(identifier) {
    const base = identifier.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (base.length >= 3 ? base : `user_${Date.now().toString().slice(-6)}`).slice(0, 20);
  }

  async function submitAuth(event) {
    event.preventDefault();
    const identifier = els.email.value.trim();
    const password = els.password.value;
    const name = String(els.name.value || '').trim();
    let username = String(els.username.value || '').trim().toLowerCase();

    if (!identifier) return showMsg('Please enter your email or username.', 'error');
    if (password.length < 8) return showMsg('Password must be at least 8 characters.', 'error');

    try {
      let response;
      if (authMode === 'signup') {
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.toLowerCase());
        if (!emailOk) return showMsg('Please enter a valid email address.', 'error');
        if (!username) username = buildUsername(identifier);
        if (!/^[a-z0-9_]{3,20}$/.test(username)) return showMsg('Username must be 3-20 chars using letters, numbers, or underscore.', 'error');
        if (!(/[A-Za-z]/.test(password) && /\d/.test(password))) return showMsg('Password must include letters and numbers.', 'error');

        response = await fetch(`${API_BASE_URL}/auth/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: identifier, password, username, name })
        });
      } else {
        response = await fetch(`${API_BASE_URL}/auth/signin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });
      }

      const data = await parseJsonResponse(response, authMode);
      if (!response.ok || !data.success) throw new Error(data.message || 'Authentication failed.');
      await completeAuthSuccess(data);
    } catch (error) {
      showMsg(error.message || 'Authentication failed.', 'error');
    }
  }

  els.eye.addEventListener('click', () => {
    const visible = els.password.type === 'text';
    els.password.type = visible ? 'password' : 'text';
    els.eye.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  });

  els.switchBtn.addEventListener('click', () => {
    navigateToMode(authMode === 'signin' ? 'signup' : 'signin');
  });

  els.forgotBtn.addEventListener('click', startForgotPasswordFlow);

  els.form.addEventListener('submit', submitAuth);

  document.querySelectorAll('.social-btn[data-provider]').forEach((btn) => {
    btn.addEventListener('click', () => socialAuthSignIn(String(btn.getAttribute('data-provider') || '').toLowerCase()));
  });

  async function checkIncomingRedirect() {
    const params = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || window.location.hash.replace(/^#/, ''));
    const code = params.get('code');
    const token = params.get('access_token');
    const error = params.get('error') || params.get('error_description');

    if (error) {
       showMsg(error, 'error');
       return;
    }

    if (code || token) {
      const state = params.get('state') || '';
      // We check for provider in state or query
      const provider = params.get('provider') || (state.startsWith('google_') ? 'google' : (state.startsWith('facebook_') ? 'facebook' : (state.startsWith('microsoft_') ? 'microsoft' : '')));
      
      if (provider) {
        showMsg(`Authenticating with ${provider}...`, 'ok');
        try {
          const payload = { provider, accessToken: token, code };
          const response = await fetch(`${API_BASE_URL}/auth/oauth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await parseJsonResponse(response, 'oauth-redirect');
          if (!response.ok || !data.success) throw new Error(data.message || 'Social sign-in failed.');
          await completeAuthSuccess(data);
        } catch (err) {
          showMsg(err.message, 'error');
        }
      }
    }
  }

  const pathModeMatch = window.location.pathname.match(/\/auth\/(signin|signup)\/?$/i);
  const modeFromPath = String(pathModeMatch && pathModeMatch[1] || '').toLowerCase();
  const modeFromQuery = String(new URLSearchParams(window.location.search).get('mode') || '').toLowerCase();
  const initialMode = modeFromPath || (modeFromQuery === 'signup' ? 'signup' : 'signin');
  setMode(initialMode, { skipRouteUpdate: Boolean(modeFromPath) });
  updateSocialButtons();
  
  // New: Check for deep link or redirect return on load
  checkIncomingRedirect();

  const resetToken = new URLSearchParams(window.location.search).get('resetToken');
  const resetEmail = new URLSearchParams(window.location.search).get('email');
  if (resetToken && resetEmail) {
    showMsg('Password reset link received. Use the form below to change password.', '');
  }

  // New: Link-back Relay for Mobile
  // If we are in a normal browser (after auth redirect) but NOT inside the Capacitor app
  if (!window.Capacitor && (window.location.search.includes('code=') || window.location.search.includes('access_token=') || window.location.hash.includes('access_token='))) {
     console.log('Detected social auth return in browser. Redirecting to app...');
     const deepLink = `com.memoryvault.app://auth.html${window.location.search}${window.location.hash}`;
     
     // Automatic redirect to app
     window.location.assign(deepLink);
     
     // Manual fallback button in case auto-redirect is blocked
     setTimeout(() => {
        showMsg('Login successful! <br><br> <button onclick="window.location.assign(\''+deepLink+'\')" style="padding: 12px 24px; background: #6d36ff; color: white; border: none; border-radius: 8px;">Back to App</button>', 'ok');
     }, 1500);
  }
})();

'use strict';

const SERVER_URL = 'https://sq.cmtrading.com';

const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const agentEmailEl = document.getElementById('agent-email');
const callListEl = document.getElementById('call-list');
const statusBadge = document.getElementById('status-badge');
const statusDot = document.getElementById('status-dot');

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(connected) {
  if (connected === null) {
    statusBadge.className = 'badge offline';
    statusBadge.innerHTML = '<span class="dot gray"></span>Offline';
  } else if (connected) {
    statusBadge.className = 'badge connected';
    statusBadge.innerHTML = '<span class="dot green"></span>Live';
  } else {
    statusBadge.className = 'badge disconnected';
    statusBadge.innerHTML = '<span class="dot red"></span>Disconnected';
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function renderHistory(calls) {
  const fresh = (calls || []).filter(c => Date.now() - new Date(c.timestamp).getTime() < ONE_HOUR_MS);
  if (fresh.length === 0) {
    callListEl.innerHTML = '<div class="empty">No calls yet</div>';
    return;
  }
  callListEl.innerHTML = fresh.map(c => `
    <div class="call-item">
      <div>
        <div class="call-name">${escHtml(c.clientName)}</div>
        <div class="call-meta">${escHtml(c.country || '—')}</div>
        <a class="crm-link" href="${escHtml(c.crmUrl)}" target="_blank">Open in CRM →</a>
      </div>
      <div class="call-time">${formatTime(c.timestamp)}</div>
    </div>
  `).join('');

  // Make CRM links open via background (needed in MV3 popups)
  callListEl.querySelectorAll('.crm-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: a.href });
    });
  });
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showDashboard(email, connected, calls) {
  loginView.style.display = 'none';
  dashboardView.style.display = 'block';
  agentEmailEl.textContent = email;
  setStatus(connected);
  renderHistory(calls);
}

function showLogin() {
  loginView.style.display = 'block';
  dashboardView.style.display = 'none';
  setStatus(null);
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Token stored in session storage (clears on browser close)
// Saved email stored in local storage (persists for pre-fill)
chrome.storage.session.get(['token', 'email', 'connected'], (session) => {
  chrome.storage.local.get(['savedEmail', 'callHistory'], (local) => {
    if (session.token && session.email) {
      showDashboard(session.email, session.connected ?? false, local.callHistory || []);
    } else {
      // Pre-fill email if previously saved
      if (local.savedEmail) document.getElementById('username').value = local.savedEmail;
      showLogin();
    }
  });
});

// Refresh call history when popup opens
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.callHistory) renderHistory(changes.callHistory.newValue);
  if (area === 'session' && changes.connected !== undefined) setStatus(changes.connected.newValue);
});

// ── Login ─────────────────────────────────────────────────────────────────────
loginBtn.addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    loginError.textContent = 'Please enter email and password.';
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  loginError.textContent = '';

  try {
    const res = await fetch(`${SERVER_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    if (!res.ok) {
      loginError.textContent = json.error || 'Login failed';
      return;
    }
    const email = json.email || json.username;
    // Session: token + email (clears on browser close)
    await chrome.storage.session.set({ token: json.token, email, connected: false });
    // Local: save email, clear any previous agent's call history
    await chrome.storage.local.set({ savedEmail: email, callHistory: [] });
    // Tell background to connect SSE
    chrome.runtime.sendMessage({ type: 'connect' });
    showDashboard(email, false, []);
  } catch (err) {
    loginError.textContent = 'Connection error. Check server.';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

document.getElementById('username').addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });

// ── Sign out ──────────────────────────────────────────────────────────────────
document.getElementById('sign-out-btn').addEventListener('click', async () => {
  const { savedEmail } = await chrome.storage.local.get('savedEmail');
  await chrome.storage.session.clear();
  // Clear call history on sign-out so the next user doesn't see it
  await chrome.storage.local.set({ callHistory: [] });
  chrome.runtime.sendMessage({ type: 'disconnect' });
  if (savedEmail) document.getElementById('username').value = savedEmail;
  showLogin();
});

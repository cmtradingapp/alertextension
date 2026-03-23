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

const ONE_HOUR_MS = 24 * 60 * 60 * 1000;

const filterEventEl = document.getElementById('filter-event');
const filterClientEl = document.getElementById('filter-client');

function updateEventDropdown(combined) {
  const current = filterEventEl.value;
  const types = [...new Set(combined.map(i => i._kind === 'call' ? 'incoming_call' : i.type))];
  filterEventEl.innerHTML = '<option value="">All events</option>' +
    types.map(t => `<option value="${escHtml(t)}" ${t === current ? 'selected' : ''}>${escHtml(t)}</option>`).join('');
}

function renderFeed(calls, events) {
  const now = Date.now();
  const filterEvent = filterEventEl ? filterEventEl.value : '';
  const filterClient = filterClientEl ? filterClientEl.value.trim().toLowerCase() : '';

  const freshCalls = (calls || [])
    .filter(c => now - new Date(c.timestamp).getTime() < ONE_HOUR_MS)
    .map(c => ({ ...c, _kind: 'call' }));
  const freshEvents = (events || [])
    .filter(e => now - new Date(e.timestamp).getTime() < ONE_HOUR_MS)
    .map(e => ({ ...e, _kind: 'event' }));

  const combined = [...freshCalls, ...freshEvents]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  updateEventDropdown(combined);

  const visible = combined.filter(item => {
    if (filterEvent) {
      const itemType = item._kind === 'call' ? 'incoming_call' : item.type;
      if (itemType !== filterEvent) return false;
    }
    if (filterClient) {
      const id = String(item.customer || item.clientId || '').toLowerCase();
      if (!id.includes(filterClient)) return false;
    }
    return true;
  });

  const countEl = document.getElementById('notif-count');
  if (countEl) {
    if (visible.length > 0) {
      countEl.textContent = visible.length;
      countEl.style.display = 'inline-block';
    } else {
      countEl.style.display = 'none';
    }
  }

  if (visible.length === 0) {
    callListEl.innerHTML = '<div class="empty">No activity yet</div>';
    return;
  }

  callListEl.innerHTML = visible.map(item => {
    if (item._kind === 'call') {
      return `
        <div class="call-item">
          <div>
            <div class="call-name">📞 ${escHtml(item.clientName)}</div>
            <div class="call-meta">${escHtml(item.country || '—')}</div>
            <a class="crm-link" href="${escHtml(item.crmUrl)}" target="_blank">Open in CRM →</a>
          </div>
          <div class="call-time">${formatTime(item.timestamp)}</div>
        </div>`;
    } else {
      const ctx = item.context || {};
      const displayName = (item.context && item.context.label) || item.display_name || item.type;
      const icon = item.icon || '🔔';
      const crmUrl = item.customer
        ? `https://backoffice.cmtrading.com/retention/dial?client_id=${encodeURIComponent(item.customer)}`
        : null;
      const contextFields = (Array.isArray(item.context_fields) && item.context_fields.length > 0)
        ? item.context_fields
        : [];
      const parts = [];
      if (ctx.userFullName) parts.push(`<strong style="color:#f0f6fc">${escHtml(ctx.userFullName)}</strong>`);
      if (item.customer)    parts.push(`ID: ${escHtml(String(item.customer))}`);
      for (const field of contextFields) {
        if (ctx[field] != null) {
          const label = field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          parts.push(`${escHtml(label)}: ${escHtml(String(ctx[field]))}`);
        }
      }
      return `
        <div class="call-item">
          <div>
            <div class="call-name">${escHtml(icon)} ${escHtml(displayName)}</div>
            ${parts.length ? `<div class="call-meta">${parts.join(' · ')}</div>` : ''}
            ${crmUrl ? `<a class="crm-link" href="${escHtml(crmUrl)}" target="_blank">Open in CRM →</a>` : ''}
          </div>
          <div class="call-time">${formatTime(item.timestamp)}</div>
        </div>`;
    }
  }).join('');

  callListEl.querySelectorAll('.crm-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: a.href });
    });
  });
}

// Keep last-known values so partial storage updates can re-render
let _calls = [], _events = [];
function renderHistory(calls, events) {
  if (calls !== undefined) _calls = calls;
  if (events !== undefined) _events = events;
  renderFeed(_calls, _events);
}

// Wire up filters
if (filterEventEl) filterEventEl.addEventListener('change', () => renderFeed(_calls, _events));
if (filterClientEl) filterClientEl.addEventListener('input', () => renderFeed(_calls, _events));

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showDashboard(email, connected, calls, events) {
  loginView.style.display = 'none';
  dashboardView.style.display = 'block';
  agentEmailEl.textContent = email;
  setStatus(connected);
  renderHistory(calls, events);
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
  chrome.storage.local.get(['savedEmail', 'callHistory', 'eventHistory'], (local) => {
    if (session.token && session.email) {
      chrome.runtime.sendMessage({ type: 'clear_badge' });
      showDashboard(session.email, session.connected ?? false, local.callHistory || [], local.eventHistory || []);
    } else {
      if (local.savedEmail) document.getElementById('username').value = local.savedEmail;
      showLogin();
    }
  });
});

// Refresh feed when either history changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.callHistory) renderHistory(changes.callHistory.newValue, undefined);
  if (area === 'local' && changes.eventHistory) renderHistory(undefined, changes.eventHistory.newValue);
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
    // Local: save email, clear any previous agent's history
    await chrome.storage.local.set({ savedEmail: email });
    // Tell background to connect SSE
    chrome.runtime.sendMessage({ type: 'connect' });
    showDashboard(email, false, [], []);
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
  // History is preserved — expires naturally after 24 hours
  chrome.runtime.sendMessage({ type: 'disconnect' });
  if (savedEmail) document.getElementById('username').value = savedEmail;
  showLogin();
});

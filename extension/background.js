'use strict';

const SERVER_URL = 'https://sq.cmtrading.com';
const MAX_HISTORY = 15;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

let es = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;

// ── SSE connection ────────────────────────────────────────────────────────────
async function connect() {
  const { token, email } = await chrome.storage.session.get(['token', 'email']);
  if (!token || !email) {
    console.log('[BG] Not logged in, skipping SSE connect');
    return;
  }

  if (es) { try { es.close(); } catch (_) {} es = null; }

  const url = `${SERVER_URL}/events?token=${encodeURIComponent(token)}`;
  console.log('[BG] Connecting SSE...');
  es = new EventSource(url);

  es.onopen = () => {
    console.log('[BG] SSE connected');
    reconnectDelay = RECONNECT_BASE_MS;
    chrome.storage.session.set({ connected: true });
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#27AE60' });
  };

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'incoming_call') handleIncomingCall(data);
      else if (data.type !== 'connected') handleGenericEvent(data);
    } catch (_) {}
  };

  es.onerror = () => {
    console.log('[BG] SSE error — will reconnect in', reconnectDelay, 'ms');
    chrome.storage.session.set({ connected: false });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#EB5757' });
    es.close();
    es = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

// ── Keep-alive alarm (MV3 service worker can be killed) ──────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.33 }); // ~20s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (!es || es.readyState === EventSource.CLOSED) connect();
  }
});

const ONE_HOUR_MS = 2 * 60 * 60 * 1000;

async function incrementBadge() {
  const { unreadCount = 0 } = await chrome.storage.local.get('unreadCount');
  const next = unreadCount + 1;
  await chrome.storage.local.set({ unreadCount: next });
  chrome.action.setBadgeText({ text: String(next) });
  chrome.action.setBadgeBackgroundColor({ color: '#F2C94C' });
}

// ── Incoming call ─────────────────────────────────────────────────────────────
async function handleIncomingCall(data) {
  console.log('[BG] Incoming call:', data.clientName);

  const now = Date.now();
  // Save to history, pruning entries older than 1 hour
  const { callHistory = [] } = await chrome.storage.local.get('callHistory');
  const fresh = callHistory.filter(c => now - new Date(c.timestamp).getTime() < ONE_HOUR_MS);
  fresh.unshift({
    clientId: data.clientId,
    clientName: data.clientName,
    country: data.country,
    crmUrl: data.crmUrl,
    timestamp: data.timestamp || new Date().toISOString(),
  });
  if (fresh.length > MAX_HISTORY) fresh.length = MAX_HISTORY;
  await chrome.storage.local.set({ callHistory: fresh, lastCall: now });

  await incrementBadge();

  // Desktop notification
  chrome.notifications.create(`call_${data.clientId}_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '📞 Incoming Call Transfer',
    message: `${data.clientName}${data.country ? ` — ${data.country}` : ''}`,
    buttons: [{ title: 'Open in CRM' }],
    requireInteraction: true,
    priority: 2,
  });
}

// ── Generic event (webhook events from cmtoperations) ─────────────────────────
async function handleGenericEvent(data) {
  const ctx = data.data || {};
  const displayName = data.display_name || data.type;

  let message = `Customer: ${data.customer || '—'}`;

  console.log(`[BG] Generic event type=${data.type} display="${displayName}" customer=${data.customer}`);

  // Save to event history
  const { eventHistory = [] } = await chrome.storage.local.get('eventHistory');
  eventHistory.unshift({
    type: data.type,
    display_name: displayName,
    customer: data.customer,
    context: ctx,
    timestamp: data.timestamp || new Date().toISOString(),
  });
  if (eventHistory.length > MAX_HISTORY) eventHistory.length = MAX_HISTORY;
  await chrome.storage.local.set({ eventHistory });

  await incrementBadge();

  chrome.notifications.create(`evt_${data.type}_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `🔔 ${displayName}`,
    message,
    priority: 1,
  });
}

// Notification button click → open CRM
chrome.notifications.onButtonClicked.addListener(async (notifId) => {
  const { callHistory = [] } = await chrome.storage.local.get('callHistory');
  const call = callHistory[0];
  if (call?.crmUrl) chrome.tabs.create({ url: call.crmUrl });
  chrome.notifications.clear(notifId);
});

// Notification click → open CRM
chrome.notifications.onClicked.addListener(async (notifId) => {
  const { callHistory = [] } = await chrome.storage.local.get('callHistory');
  const call = callHistory[0];
  if (call?.crmUrl) chrome.tabs.create({ url: call.crmUrl });
  chrome.notifications.clear(notifId);
});

// ── Messages from popup ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connect') connect();
  if (msg.type === 'disconnect') {
    if (es) { es.close(); es = null; }
    chrome.storage.local.set({ unreadCount: 0 });
    chrome.action.setBadgeText({ text: '' });
  }
  if (msg.type === 'clear_badge') {
    chrome.storage.local.set({ unreadCount: 0 });
    chrome.action.setBadgeText({ text: '' });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Connect immediately when service worker loads
connect();

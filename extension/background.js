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

// ── Incoming call ─────────────────────────────────────────────────────────────
async function handleIncomingCall(data) {
  console.log('[BG] Incoming call:', data.clientName);

  // Save to history
  const { callHistory = [] } = await chrome.storage.local.get('callHistory');
  callHistory.unshift({
    clientId: data.clientId,
    clientName: data.clientName,
    country: data.country,
    crmUrl: data.crmUrl,
    timestamp: data.timestamp || new Date().toISOString(),
  });
  if (callHistory.length > MAX_HISTORY) callHistory.length = MAX_HISTORY;
  await chrome.storage.local.set({ callHistory, lastCall: Date.now() });

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

  // Update badge
  chrome.action.setBadgeText({ text: '●' });
  chrome.action.setBadgeBackgroundColor({ color: '#F2C94C' });
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
    chrome.action.setBadgeText({ text: '' });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Connect immediately when service worker loads
connect();

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

// ── Generic event (webhook events from cmtoperations) ─────────────────────────
const EVENT_META = {
  withdrawal_request:  { title: 'Withdrawal Request',  icon: '💸' },
  withdrawal_change:   { title: 'Withdrawal Update',   icon: '💳' },
  close_trade_live:    { title: 'Trade Closed',         icon: '📊' },
  deposit_attempt:     { title: 'Deposit',              icon: '💰' },
};

async function handleGenericEvent(data) {
  const ctx = data.data || {};
  const meta = EVENT_META[data.type] || { title: data.type, icon: '🔔' };

  // Build a short summary message from context fields
  let message = `Customer: ${data.customer || '—'}`;
  if (ctx.withdrawal_amount) message = `Amount: ${ctx.original_withdrawal_currency || ''} ${ctx.withdrawal_amount}  |  ${message}`;
  if (ctx.deposit_amount)    message = `Amount: ${ctx.deposit_amount}  |  ${ctx.deposit_status || ''}  |  ${message}`;
  if (ctx.profit !== undefined) message = `Profit: ${ctx.profit}  |  ${ctx.symbol || ''}  |  ${message}`;
  if (ctx.withdrawal_status) message = `Status: ${ctx.withdrawal_status}  |  ${message}`;

  console.log(`[BG] Generic event type=${data.type} customer=${data.customer}`);

  // Save to event history
  const { eventHistory = [] } = await chrome.storage.local.get('eventHistory');
  eventHistory.unshift({
    type: data.type,
    customer: data.customer,
    context: ctx,
    timestamp: data.timestamp || new Date().toISOString(),
  });
  if (eventHistory.length > MAX_HISTORY) eventHistory.length = MAX_HISTORY;
  await chrome.storage.local.set({ eventHistory });

  chrome.notifications.create(`evt_${data.type}_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${meta.icon} ${meta.title}`,
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
    chrome.action.setBadgeText({ text: '' });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Connect immediately when service worker loads
connect();

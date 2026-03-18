'use strict';
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const sql = require('mssql');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Allow requests from Chrome extensions and any origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3099', 10);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET is required'); process.exit(1); }

const WEBHOOK_SECRET = process.env.SQUARETALK_WEBHOOK_SECRET;
const CRM_API_TOKEN = process.env.CRM_API_TOKEN || '699a3696-5869-44c9-aa31-1938f296a556';
const CRM_API_BASE = 'https://apicrm.cmtrading.com/SignalsCRM/crm-api';

// ── PostgreSQL (backoffice DB for user auth) ─────────────────────────────────
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'igalc-postgres-1',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'backoffice',
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── MSSQL (report.vtiger_users for salesRep → email map) ────────────────────
const mssqlConfig = {
  server: process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DATABASE || 'cmt_main',
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: { encrypt: true, trustServerCertificate: true },
  pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
};

// ── Agent map: salesRepId (string) → agentEmail ──────────────────────────────
let agentMap = {};

async function refreshAgentMap() {
  if (!process.env.MSSQL_SERVER) {
    console.log('[AgentMap] MSSQL_SERVER not set — skipping auto-refresh');
    return;
  }
  try {
    const pool = await sql.connect(mssqlConfig);
    const result = await pool.request().query(
      "SELECT id, email FROM report.vtiger_users WHERE email IS NOT NULL AND email <> ''"
    );
    const map = {};
    for (const row of result.recordset) {
      if (row.id && row.email) map[String(row.id)] = row.email;
    }
    agentMap = map;
    console.log(`[AgentMap] Refreshed from MSSQL: ${Object.keys(map).length} agents`);
    await sql.close();
  } catch (err) {
    console.error('[AgentMap] MSSQL refresh failed:', err.message);
  }
}

// Refresh on startup and every 5 minutes
refreshAgentMap();
setInterval(refreshAgentMap, 5 * 60 * 1000);

// ── SSE connections: Map<email, Set<Response>> ───────────────────────────────
const connections = new Map();

function addConn(email, res) {
  if (!connections.has(email)) connections.set(email, new Set());
  connections.get(email).add(res);
}
function removeConn(email, res) {
  const s = connections.get(email);
  if (s) { s.delete(res); if (s.size === 0) connections.delete(email); }
}
function pushToAgent(email, data) {
  const s = connections.get(email);
  if (!s || s.size === 0) return false;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of s) { try { res.write(msg); } catch (_) {} }
  return true;
}

// ── CRM API helper ───────────────────────────────────────────────────────────
function crmGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${CRM_API_BASE}${endpoint}`, {
      headers: { 'x-crm-api-token': CRM_API_TOKEN },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Non-JSON from CRM: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const raw = req.headers['authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '');
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
    req.user = p;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => {
  let total = 0;
  connections.forEach(s => total += s.size);
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), connectedAgents: connections.size, totalConnections: total });
});

// Login — validates against backoffice PostgreSQL (bcrypt-compatible)
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, hashed_password, role, is_active FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.hashed_password))
      return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active)
      return res.status(403).json({ error: 'Account disabled' });

    const email = user.email || user.username;
    const token = jwt.sign({ id: user.id, username: user.username, email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, email, role: user.role });
  } catch (err) {
    console.error('[Login]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// SSE stream (token passed as query param since EventSource can't set headers)
app.get('/events', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).send('token required');
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).send('Invalid token'); }

  const email = payload.email || payload.username;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', email })}\n\n`);
  addConn(email, res);
  console.log(`[SSE] +${email} (${connections.get(email)?.size} conn)`);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    removeConn(email, res);
    console.log(`[SSE] -${email}`);
  });
});

// SquareTalk webhook
app.post('/squaretalk-webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-squaretalk-secret'] !== WEBHOOK_SECRET) {
    console.warn('[Webhook] Bad secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  console.log(`[Webhook] client_id=${client_id}`);

  try {
    const data = await crmGet(`/user?id=${client_id}`);
    const r = data.result || data;
    const salesRepId = String(r.salesRep ?? r.sales_rep ?? r.salesRepId ?? '');
    const clientName = [r.firstName, r.lastName].filter(Boolean).join(' ') || `Client ${client_id}`;
    const country = r.country || r.countryCode || '';
    console.log(`[Webhook] client="${clientName}" salesRep=${salesRepId}`);

    const agentEmail = salesRepId ? agentMap[salesRepId] : null;
    if (!agentEmail) {
      console.warn(`[Webhook] No mapping for salesRep=${salesRepId}`);
      return res.json({ status: 'no_agent_mapping', salesRepId });
    }

    const event = {
      type: 'incoming_call',
      clientId: client_id,
      clientName,
      country,
      salesRepId,
      crmUrl: `https://crm.cmtrading.com/#/users/user/${client_id}`,
      timestamp: new Date().toISOString(),
    };

    const delivered = pushToAgent(agentEmail, event);
    console.log(`[Webhook] → ${agentEmail}: ${delivered ? 'delivered' : 'offline'}`);
    res.json({ status: delivered ? 'delivered' : 'agent_offline', agentEmail, clientName });
  } catch (err) {
    console.error('[Webhook]', err.message);
    res.status(500).json({ error: 'Processing failed', detail: err.message });
  }
});

// Lookup agent ID by extension — joins Extension_new → vtiger_users on email
// GET /agent-by-extension?extension=1234
app.get('/agent-by-extension', async (req, res) => {
  if (PUSH_SECRET && req.headers['x-push-secret'] !== PUSH_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  const { extension } = req.query;
  if (!extension) return res.status(400).json({ error: 'extension query param required' });
  if (!process.env.MSSQL_SERVER) return res.status(503).json({ error: 'MSSQL not configured' });
  try {
    const pool = await sql.connect(mssqlConfig);
    const result = await pool.request()
      .input('ext', extension)
      .query(`
        SELECT TOP 1 u.id, u.email
        FROM report.Extension_new e
        JOIN report.vtiger_users u ON u.email = e.email
        WHERE e.extension = @ext
      `);
    await sql.close();
    if (!result.recordset.length) return res.status(404).json({ error: 'agent not found for extension' });
    const { id, email } = result.recordset[0];
    res.json({ id: String(id), email });
  } catch (err) {
    console.error('[AgentByExtension]', err.message);
    res.status(500).json({ error: 'lookup failed', detail: err.message });
  }
});

// Admin: list live connections
app.get('/admin/connections', requireAdmin, (_req, res) => {
  const agents = [];
  connections.forEach((s, email) => agents.push({ email, connections: s.size }));
  res.json({ agents, total: agents.reduce((n, a) => n + a.connections, 0) });
});

// Admin: view agent map
app.get('/admin/agent-map', requireAdmin, (_req, res) => {
  res.json({ total: Object.keys(agentMap).length, map: agentMap });
});

// Admin: force refresh from MSSQL
app.post('/admin/agent-map/refresh', requireAdmin, async (_req, res) => {
  await refreshAgentMap();
  res.json({ ok: true, total: Object.keys(agentMap).length });
});

// Admin: manual override (add/update single entry)
app.post('/admin/agent-map', requireAdmin, (req, res) => {
  const { crm_id, email } = req.body || {};
  if (!crm_id || !email) return res.status(400).json({ error: 'crm_id and email required' });
  agentMap[String(crm_id)] = email;
  res.json({ ok: true, crm_id, email, total: Object.keys(agentMap).length });
});

// ── Push event from cmtoperations (server-to-server) ─────────────────────────
// POST /push-event
// Authenticated via X-Push-Secret header matching PUSH_SECRET env var.
// Body: { event_type, customer?, agent_email?, broadcast?, data: {...} }
//   - agent_email: push to this specific agent only
//   - customer: look up the assigned salesRep from agentMap and push to them
//   - broadcast: true → push to ALL connected agents
// At least one of agent_email / customer / broadcast must be provided.

const PUSH_SECRET = process.env.PUSH_SECRET;

app.post('/push-event', async (req, res) => {
  if (PUSH_SECRET && req.headers['x-push-secret'] !== PUSH_SECRET) {
    console.warn('[PushEvent] Bad secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const { event_type, customer, agent_email, broadcast, data } = req.body || {};
  if (!event_type) return res.status(400).json({ error: 'event_type required' });

  const eventPayload = { type: event_type, customer: customer || null, data: data || {}, timestamp: new Date().toISOString() };

  // broadcast → push to all connected agents
  if (broadcast) {
    let count = 0;
    connections.forEach((s, email) => {
      pushToAgent(email, eventPayload);
      count++;
    });
    console.log(`[PushEvent] broadcast event_type=${event_type} to ${count} agent(s)`);
    return res.json({ status: 'broadcast', recipients: count });
  }

  // Resolve target agent email
  let targetEmail = agent_email || null;

  if (!targetEmail && customer) {
    // Try to look up from agentMap via CRM API (same as SquareTalk webhook)
    try {
      const clientData = await crmGet(`/user?id=${customer}`);
      const r = clientData.result || clientData;
      const salesRepId = String(r.salesRep ?? r.sales_rep ?? r.salesRepId ?? '');
      if (salesRepId && agentMap[salesRepId]) {
        targetEmail = agentMap[salesRepId];
        console.log(`[PushEvent] customer=${customer} → salesRep=${salesRepId} → email=${targetEmail}`);
      } else {
        console.warn(`[PushEvent] No agent mapping for customer=${customer} salesRep=${salesRepId}`);
      }
    } catch (err) {
      console.warn(`[PushEvent] CRM lookup failed for customer=${customer}: ${err.message}`);
    }
  }

  if (!targetEmail) {
    return res.json({ status: 'no_agent', customer, agent_email });
  }

  const delivered = pushToAgent(targetEmail, eventPayload);
  console.log(`[PushEvent] event_type=${event_type} → ${targetEmail}: ${delivered ? 'delivered' : 'offline'}`);
  return res.json({ status: delivered ? 'delivered' : 'agent_offline', agent_email: targetEmail });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Port ${PORT} | AgentMap: ${Object.keys(agentMap).length} entries`);
});

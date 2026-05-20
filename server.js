const express = require('express');
const path = require('path');
const config = require('./config');
const unifiClient = require('./services/unifiClient');
const analyzer = require('./services/analyzer');
const xlsxExporter = require('./services/xlsxExporter');
const auditLogStore = require('./services/auditLogStore');

const app = express();
const PORT = config.server.port;

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Session store in memory
const adminSessions = new Map();
const provisioningUpdates = new Map();
const PROVISIONING_TTL_MS = 2 * 60 * 1000;
const MIN_TX_POWER_DBM = 1;
const MAX_TX_POWER_DBM = 30;

function normalizeMac(mac) {
  return String(mac || '').trim().toLowerCase().replace(/-/g, ':');
}

function getSessionToken(req) {
  let token = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const parts = c.trim().split('=');
      if (parts.length >= 2) {
        acc[parts[0]] = parts.slice(1).join('=');
      }
      return acc;
    }, {});
    token = cookies.admin_session;
  }
  if (!token) {
    token = req.get('x-admin-token');
  }
  return token;
}

// Middleware to authenticate admin requests using a session cookie or header
function adminAuth(req, res, next) {
  const token = getSessionToken(req);

  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  req.adminUsername = adminSessions.get(token) || config.admin.username;
  next();
}

app.use('/api', (req, res, next) => {
  // Allow auth and admin endpoints to bypass the general API token check
  if (req.path.startsWith('/auth/') || req.path.startsWith('/admin/')) return next();

  if (!config.server.apiToken) return next();
  const provided = req.get('x-api-token');
  if (provided !== config.server.apiToken) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
});

/** Threshold in ms below which a data fetch is considered 'fresh from the controller' */
const FRESH_DATA_THRESHOLD_MS = 2000;

// In-memory cache for UniFi data to ensure high-speed dashboard responsiveness
const cache = {
  devices: null,
  clients: null,
  rogueAps: null,
  lastFetch: 0
};

// In-memory history ring buffer for trend analysis (max 60 samples)
const historyBuffer = [];
const HISTORY_MAX_SAMPLES = 60;

/**
 * Push a snapshot into the history ring buffer after a fresh data fetch.
 */
function pushHistorySnapshot(channels, clients) {
  const snapshot = {
    timestamp: Date.now(),
    totalAllClients: clients.summary.totalAllClients,
    totalAppleClients: clients.summary.totalAppleClients,
    avgUtil24: channels.summary.avgUtil24,
    avgUtil5: channels.summary.avgUtil5,
    totalDownloadMbps: Math.round(clients.summary.totalDownloadKbps / 1000),
    totalUploadMbps: Math.round(clients.summary.totalUploadKbps / 1000),
    criticalCount: clients.summary.criticalCount,
    warningCount: clients.summary.warningCount,
    congestedRadiosCount: channels.summary.congestedRadiosCount
  };
  historyBuffer.push(snapshot);
  if (historyBuffer.length > HISTORY_MAX_SAMPLES) {
    historyBuffer.shift();
  }
}

function buildApsModel(channelAnalysis) {
  const map = {};
  (channelAnalysis.radios || []).forEach((r) => {
    if (!map[r.apMac]) {
      map[r.apMac] = {
        mac: r.apMac,
        name: r.apName,
        ip: r.ip,
        model: r.model,
        radios: {}
      };
    }
    map[r.apMac].radios[r.radio] = {
      channel: r.channel,
      cu_total: r.cu_total,
      cu_self_rx: r.cu_self_rx,
      cu_self_tx: r.cu_self_tx,
      cci_count: r.cci_count,
      tx_retries_pct: r.tx_retries_pct,
      tx_power: r.tx_power,
      tx_power_mode: r.tx_power_mode,
      configured_tx_power: r.configured_tx_power,
      min_rssi_enabled: r.min_rssi_enabled,
      min_rssi: r.min_rssi,
      bw: r.bw
    };
  });
  return Object.values(map);
}

/**
 * Helper to get cached or fresh UniFi data.
 */
async function getFreshData(bypassCache = false) {
  const now = Date.now();
  const cacheAge = now - cache.lastFetch;

  if (!bypassCache && cache.devices && cache.clients && cache.rogueAps && cacheAge < config.server.cacheExpiryMs) {
    console.log(`[Cache] Serving data from cache (age: ${Math.round(cacheAge / 1000)}s)`);
    return { devices: cache.devices, clients: cache.clients, rogueAps: cache.rogueAps };
  }

  console.log('[UniFi] Fetching fresh network data from controller...');
  const [devices, clients, rogueAps] = await Promise.all([
    unifiClient.getDevices(),
    unifiClient.getClients(),
    unifiClient.getRogueAps()
  ]);

  cache.devices = devices;
  cache.clients = clients;
  cache.rogueAps = rogueAps;
  cache.lastFetch = now;

  return { devices, clients, rogueAps };
}

function buildProvisioningState(apsModel) {
  const now = Date.now();
  const currentByMac = new Map((apsModel || []).map((ap) => [normalizeMac(ap.mac), ap]));
  const state = {};

  for (const [key, value] of provisioningUpdates.entries()) {
    if (now - value.startedAt > PROVISIONING_TTL_MS) {
      provisioningUpdates.delete(key);
      continue;
    }

    const ap = currentByMac.get(normalizeMac(value.apMac));
    const radioState = ap && ap.radios ? ap.radios[value.radio] : null;
    const channelApplied = value.expectedChannel === undefined || (radioState && radioState.channel === value.expectedChannel);
    const txPowerApplied = value.expectedTxPower === undefined || (radioState && radioState.tx_power === value.expectedTxPower);

    if (channelApplied && txPowerApplied) {
      provisioningUpdates.delete(key);
      continue;
    }

    state[key] = {
      apMac: value.apMac,
      apName: value.apName,
      radio: value.radio,
      startedAt: value.startedAt,
      expectedChannel: value.expectedChannel,
      expectedTxPower: value.expectedTxPower,
      currentChannel: radioState ? radioState.channel : null,
      currentTxPower: radioState ? radioState.tx_power : null
    };
  }

  return state;
}

/**
 * API: Get historical metric snapshots for trend analysis
 */
app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    samples: historyBuffer,
    count: historyBuffer.length
  });
});

/**
 * API: Get connection and health status
 */
app.get('/api/health', async (req, res) => {
  try {
    // Try logging in to ensure credentials and host are up
    await unifiClient.login();
    res.json({
      status: 'healthy',
      unifiConnected: true,
      controller: `${config.unifi.host}:${config.unifi.port}`,
      site: config.unifi.site
    });
  } catch (err) {
    res.status(500).json({
      status: 'degraded',
      unifiConnected: false,
      error: err.message
    });
  }
});

/**
 * API: Get aggregated diagnostic analysis for channels and clients
 */
app.get('/api/diagnostics', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const { devices, clients, rogueAps } = await getFreshData(force);

    console.log(`[Analyzer] Processing stats for ${devices.length} devices and ${clients.length} clients...`);
    
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis = analyzer.analyzeClients(clients, devices);
    const interferenceAnalysis = analyzer.analyzeInterference(rogueAps, devices);
    const apsModel = buildApsModel(channelAnalysis);
    const provisioningState = buildProvisioningState(apsModel);

    // Only push to history when data is fresh from the controller (not served from cache)
    if (Date.now() - cache.lastFetch < FRESH_DATA_THRESHOLD_MS) {
      pushHistorySnapshot(channelAnalysis, clientAnalysis);
    }

    res.json({
      success: true,
      timestamp: Date.now(),
      cacheAgeMs: Date.now() - cache.lastFetch,
      aps: apsModel,
      channels: channelAnalysis,
      clients: clientAnalysis,
      interference: interferenceAnalysis,
      provisioning: provisioningState
    });
  } catch (err) {
    console.error('[API Error] Diagnostics compilation failed:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to compile network diagnostics from UniFi Controller.',
      details: err.message
    });
  }
});

/**
 * API: Export channel optimization + client report as XLSX
 * Uses the butterfly-aware iterative greedy optimizer.
 */
app.get('/api/export/xlsx', async (req, res) => {
  try {
    const { devices, clients } = await getFreshData(false);
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis  = analyzer.analyzeClients(clients, devices);

    const diagnosticsData = {
      channels: channelAnalysis,
      clients:  clientAnalysis
    };

    const buffer = await xlsxExporter.generateXlsx(diagnosticsData);
    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const filename = `unifi_optimization_${ts}.xlsx`;

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    console.log(`[Export] XLSX report generated: ${filename} (${Math.round(buffer.length / 1024)} KB)`);
  } catch (err) {
    console.error('[Export] XLSX generation failed:', err);
    res.status(500).json({ success: false, error: 'Failed to generate XLSX report.', details: err.message });
  }
});

/**
 * API: Admin login
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required' });
  }

  if (username === config.admin.username && password === config.admin.password) {
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    adminSessions.set(token, username);
    res.setHeader('Set-Cookie', `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`); // 8 hours
    return res.json({ success: true, token });
  }

  return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

/**
 * API: Admin logout
 */
app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);

  if (token) {
    adminSessions.delete(token);
  }

  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return res.json({ success: true });
});

/**
 * API: Check admin auth status
 */
app.get('/api/auth/status', (req, res) => {
  const token = getSessionToken(req);

  const authenticated = !!(token && adminSessions.has(token));
  return res.json({
    success: true,
    authenticated,
    username: authenticated ? adminSessions.get(token) : null
  });
});

/**
 * API: Get admin audit log
 */
app.get('/api/admin/audit-log', adminAuth, async (req, res) => {
  try {
    const entries = await auditLogStore.readAll();
    return res.json({ success: true, entries });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to load audit log', details: err.message });
  }
});

/**
 * API: Admin radio change - restricted to channel and TX power updates
 */
app.post('/api/admin/change-channel', adminAuth, async (req, res) => {
  const { apMac, radio } = req.body || {};
  const rawChannel = req.body ? req.body.channel : undefined;
  const rawTxPower = req.body ? (req.body.tx_power ?? req.body.txPower) : undefined;

  if (!apMac || !radio || (rawChannel === undefined && rawTxPower === undefined)) {
    return res.status(400).json({ success: false, error: 'apMac, radio, and at least one of channel or tx_power are required' });
  }

  const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
  if (!macRegex.test(apMac)) {
    return res.status(400).json({ success: false, error: 'Invalid MAC address format' });
  }

  if (radio !== 'ng' && radio !== 'na') {
    return res.status(400).json({ success: false, error: 'Radio must be "ng" (2.4GHz) or "na" (5GHz)' });
  }

  const channelNum = rawChannel === undefined ? undefined : parseInt(rawChannel, 10);
  if (rawChannel !== undefined && (isNaN(channelNum) || channelNum <= 0)) {
    return res.status(400).json({ success: false, error: 'Channel must be a valid positive integer' });
  }

  const txPowerNum = rawTxPower === undefined ? undefined : parseInt(rawTxPower, 10);
  if (rawTxPower !== undefined && (isNaN(txPowerNum) || txPowerNum < MIN_TX_POWER_DBM || txPowerNum > MAX_TX_POWER_DBM)) {
    return res.status(400).json({ success: false, error: `tx_power must be an integer between ${MIN_TX_POWER_DBM} and ${MAX_TX_POWER_DBM} dBm` });
  }

  let auditEntry = {
    timestamp: new Date().toISOString(),
    username: req.adminUsername || config.admin.username,
    apMac: normalizeMac(apMac),
    apName: null,
    radio,
    oldChannel: null,
    newChannel: channelNum ?? null,
    oldTxPower: null,
    newTxPower: txPowerNum ?? null,
    status: 'failed'
  };

  try {
    const devices = await unifiClient.getDevices();
    const ap = devices.find((device) => normalizeMac(device.mac) === normalizeMac(apMac));
    if (!ap) {
      throw new Error(`Access Point with MAC ${apMac} not found.`);
    }

    const radioState = (ap.radio_table || []).find((item) => item.radio === radio) || {};
    const statsState = (ap.radio_table_stats || []).find((item) => item.radio === radio) || {};
    auditEntry.apName = ap.name || ap.hostname || ap.mac;
    auditEntry.oldChannel = statsState.channel ?? null;
    auditEntry.oldTxPower = statsState.tx_power ?? radioState.tx_power ?? null;

    const result = await unifiClient.setApRadioSettings(apMac, radio, {
      channel: channelNum,
      txPower: txPowerNum
    });

    provisioningUpdates.set(`${normalizeMac(apMac)}:${radio}`, {
      apMac: normalizeMac(apMac),
      apName: auditEntry.apName,
      radio,
      startedAt: Date.now(),
      expectedChannel: channelNum,
      expectedTxPower: txPowerNum
    });

    cache.lastFetch = 0;
    auditEntry.status = 'success';
    await auditLogStore.append(auditEntry);

    console.log(`[Admin API] Successfully updated AP ${apMac} radio ${radio}${channelNum !== undefined ? ` to channel ${channelNum}` : ''}${txPowerNum !== undefined ? ` tx power ${txPowerNum} dBm` : ''}`);
    return res.json({
      success: true,
      message: 'Radio settings successfully updated',
      result
    });
  } catch (err) {
    auditEntry.status = 'failed';
    auditEntry.error = err.message;
    await auditLogStore.append(auditEntry);
    console.error(`[Admin API] Channel change failed for AP ${apMac}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Serve index.html for all other routes to support client-side SPA routing if needed
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup check & server start
async function startServer() {
  console.log('=== UniFi Diagnostics System Startup ===');
  try {
    if (process.env.MOCK_MODE === 'true') {
      console.log('[Startup] MOCK_MODE=true detected. Skipping initial UniFi controller login.');
    } else {
    // Perform initial login to verify connection on startup
      await unifiClient.login();
      console.log('[Startup] Connection to UniFi Controller verified successfully!');
    }
  } catch (err) {
    console.warn(`[Startup Warning] Could not connect to UniFi Controller: ${err.message}`);
    console.warn('[Startup Warning] Server will start but API requests may fail until connection is restored.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Server] Network Health dashboard is running!`);
    console.log(`[Server] Local URL:   http://localhost:${PORT}`);
    console.log(`[Server] Network URL: http://0.0.0.0:${PORT}`);
    console.log('========================================');
  });
}

startServer();

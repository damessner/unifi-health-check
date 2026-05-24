const crypto = require('crypto');
const express = require('express');
const path = require('path');
const config = require('./config');
const unifiClient = require('./services/unifiClient');
const analyzer = require('./services/analyzer');
const xlsxExporter = require('./services/xlsxExporter');
const optimizer = require('./services/optimizer');

const app = express();
const PORT = config.server.port;

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ── Session store in memory ──────────────────────────────────────────────────
const adminSessions = new Map(); // token → { createdAt, csrfToken }

// ── Rate limiter for login attempts ──────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60 * 1000; // 1 minute
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

// Periodic cleanup of stale sessions and rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions) {
    if (now - session.createdAt > SESSION_MAX_AGE_MS) adminSessions.delete(token);
  }
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref(); // every 5 minutes, doesn't keep process alive

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  if (now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  record.count++;
  if (record.count > LOGIN_MAX_ATTEMPTS) {
    return false;
  }
  return true;
}

// ── CSRF helpers ─────────────────────────────────────────────────────────────
function generateCSRFToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verifyCSRF(req, res, next) {
  const token = req.headers['x-csrf-token'] || req.body._csrf;
  const session = adminSessions.get(req.headers['x-admin-token'] || extractSessionToken(req));
  if (!session || session.csrfToken !== token) {
    return res.status(403).json({ success: false, error: 'CSRF validation failed' });
  }
  next();
}

function extractSessionToken(req) {
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const parts = c.trim().split('=');
      if (parts.length >= 2) acc[parts[0]] = parts.slice(1).join('=');
      return acc;
    }, {});
    return cookies.admin_session;
  }
  return req.get('x-admin-token') || null;
}

// ── Middleware to authenticate admin requests ────────────────────────────────
function adminAuth(req, res, next) {
  const token = extractSessionToken(req);
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.use('/api', (req, res, next) => {
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

  if (!bypassCache && cache.devices && cache.clients && cacheAge < config.server.cacheExpiryMs) {
    console.log(`[Cache] Serving data from cache (age: ${Math.round(cacheAge / 1000)}s)`);
    return { devices: cache.devices, clients: cache.clients };
  }

  console.log('[UniFi] Fetching fresh network data from controller...');
  const [devices, clients] = await Promise.all([
    unifiClient.getDevices(),
    unifiClient.getClients()
  ]);

  cache.devices = devices;
  cache.clients = clients;
  cache.lastFetch = now;

  return { devices, clients };
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
    const { devices, clients } = await getFreshData(force);

    console.log(`[Analyzer] Processing stats for ${devices.length} devices and ${clients.length} clients...`);

    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis = analyzer.analyzeClients(clients, devices);
    const apsModel = buildApsModel(channelAnalysis);

    if (Date.now() - cache.lastFetch < FRESH_DATA_THRESHOLD_MS) {
      pushHistorySnapshot(channelAnalysis, clientAnalysis);
    }

    res.json({
      success: true,
      timestamp: Date.now(),
      cacheAgeMs: Date.now() - cache.lastFetch,
      aps: apsModel,
      channels: channelAnalysis,
      clients: clientAnalysis
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
 */
app.get('/api/export/xlsx', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const maxChanges = parseInt(req.query.maxChanges, 10) || parseInt(process.env.OPT_MAX_CHANGES, 10) || 8;

    const { devices, clients } = await getFreshData(force);
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis  = analyzer.analyzeClients(clients, devices);

    const apsModel = buildApsModel(channelAnalysis);

    const diagnosticsData = {
      channels: channelAnalysis,
      clients:  clientAnalysis,
      aps: apsModel
    };

    const buffer = await xlsxExporter.generateXlsx(diagnosticsData, { maxChanges });
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
 * API: Run the constrained batch optimizer and return the plan as JSON.
 */
app.get('/api/optimize', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const maxChanges = parseInt(req.query.maxChanges, 10) || parseInt(process.env.OPT_MAX_CHANGES, 10) || 8;
    const minImprovementThreshold = parseInt(req.query.minImprovement, 10) || 5;

    const { devices, clients } = await getFreshData(force);
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis  = analyzer.analyzeClients(clients, devices);
    const apsModel = buildApsModel(channelAnalysis);

    const result = optimizer.runConstrainedOptimizer(
      channelAnalysis.radios,
      channelAnalysis.summary,
      apsModel,
      { maxChanges, minImprovementThreshold }
    );

    res.json({
      success: true,
      timestamp: Date.now(),
      ...result
    });
  } catch (err) {
    console.error('[Optimizer] Optimization run failed:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to run optimization engine.',
      details: err.message
    });
  }
});

/**
 * API: Admin login — with rate limiting and CSRF token generation
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required' });
  }

  // Rate limiting
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
  }

  if (username === config.admin.username && password === config.admin.password) {
    // Cryptographically secure session token
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = generateCSRFToken();
    adminSessions.set(token, { createdAt: Date.now(), csrfToken });

    const cookieFlags = `admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`;
    const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', cookieFlags + secureFlag);
    return res.json({ success: true, token, csrfToken });
  }

  return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

/**
 * API: Admin logout
 */
app.post('/api/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  if (token) adminSessions.delete(token);

  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return res.json({ success: true });
});

/**
 * API: Check admin auth status
 */
app.get('/api/auth/status', (req, res) => {
  const token = extractSessionToken(req);
  const authenticated = !!(token && adminSessions.has(token));
  return res.json({ success: true, authenticated });
});

/**
 * API: Admin channel change — strictly restricted, CSRF-protected
 */
app.post('/api/admin/change-channel', adminAuth, verifyCSRF, async (req, res) => {
  const { apMac, radio, channel } = req.body || {};

  if (!apMac || !radio || channel === undefined) {
    return res.status(400).json({ success: false, error: 'apMac, radio, and channel are required' });
  }

  const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
  if (!macRegex.test(apMac)) {
    return res.status(400).json({ success: false, error: 'Invalid MAC address format' });
  }

  if (radio !== 'ng' && radio !== 'na') {
    return res.status(400).json({ success: false, error: 'Radio must be "ng" (2.4GHz) or "na" (5GHz)' });
  }

  const channelNum = parseInt(channel, 10);
  if (isNaN(channelNum) || channelNum <= 0) {
    return res.status(400).json({ success: false, error: 'Channel must be a valid positive integer' });
  }

  try {
    const result = await unifiClient.setApChannel(apMac, radio, channelNum);
    console.log(`[Admin API] Successfully updated AP ${apMac} radio ${radio} to channel ${channelNum}`);
    return res.json({ success: true, message: `Channel successfully updated to ${channelNum}`, result });
  } catch (err) {
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

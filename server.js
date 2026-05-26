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

// CORS for external API consumers (e.g. Grafana). Origin is configurable via
// CORS_ORIGIN env var. Set to a specific origin to restrict; leave blank to
// disable CORS entirely (same-origin only). Defaults to '*' if env var is set.
app.use((req, res, next) => {
  const origin = config.server.corsOrigin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token, x-admin-token, x-csrf-token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Content-Security-Policy: restrict script/style sources. All event handlers
// use addEventListener so 'unsafe-inline' is no longer needed for scripts.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'"
  ].join('; '));
  next();
});

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
  const token = req.headers['x-csrf-token'];
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

// Trust proxy for correct req.ip behind reverse proxies
app.set('trust proxy', 1);

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
      configured_channel: r.configured_channel,
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
  try {
    const [devices, clients] = await Promise.all([
      unifiClient.getDevices(),
      unifiClient.getClients()
    ]);

    cache.devices = devices;
    cache.clients = clients;
    cache.lastFetch = now;

    return { devices, clients };
  } catch (err) {
    cache.devices = null;
    cache.clients = null;
    cache.lastFetch = 0;
    throw err;
  }
}

/**
 * API: Get tunable constants (thresholds, channel lists) for the frontend.
 * Allows the frontend to stay in sync without hardcoded values.
 */
app.get('/api/constants', (req, res) => {
  res.json({
    success: true,
    healthThresholds: analyzer.HEALTH_THRESHOLDS || null,
    channels24: optimizer.CHANNELS_24 || null,
    channels5: optimizer.CHANNELS_5 || null
  });
});

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
    const rawMax = parseInt(req.query.maxChanges, 10);
    const maxChanges = (Number.isFinite(rawMax) && rawMax > 0 && rawMax <= 100)
      ? rawMax
      : config.opt.maxChanges;

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
    const rawMax2 = parseInt(req.query.maxChanges, 10);
    const maxChanges = (Number.isFinite(rawMax2) && rawMax2 > 0 && rawMax2 <= 100)
      ? rawMax2
      : config.opt.maxChanges;
    const rawMin = parseInt(req.query.minImprovement, 10);
    const minImprovementThreshold = (Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 100)
      ? rawMin
      : 5;

    const searchMode = String(req.query.searchMode || 'heuristic').toLowerCase();
    const rawBudget = parseInt(req.query.timeBudgetMs, 10);
    const timeBudgetMs = (Number.isFinite(rawBudget) && rawBudget >= 1000 && rawBudget <= 300000)
      ? rawBudget
      : 150000;

    const rawGen = parseInt(req.query.generationLimit, 10);
    const generationLimit = (Number.isFinite(rawGen) && rawGen >= 1 && rawGen <= 200000)
      ? rawGen
      : 20000;

    const { devices, clients } = await getFreshData(force);
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis  = analyzer.analyzeClients(clients, devices);
    const apsModel = buildApsModel(channelAnalysis);

    const result = optimizer.runConstrainedOptimizer(
      channelAnalysis.radios,
      channelAnalysis.summary,
      apsModel,
      {
        maxChanges,
        minImprovementThreshold,
        searchMode,
        timeBudgetMs,
        generationLimit,
        enforceMinImprovement: true
      }
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
 * SSE endpoint: Run the GA optimizer with real-time progress streaming.
 * GET /api/optimize/progress?maxChanges=8&timeBudgetMs=150000&populationSize=40
 *
 * Streams `data:` events:
 *   - `event: progress` — periodic status updates during search
 *   - `event: complete` — final result when done
 *   - `event: error` — if something fails
 *
 * The frontend uses EventSource to consume this.
 */
app.get('/api/optimize/progress', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const rawMax = parseInt(req.query.maxChanges, 10);
    const maxChanges = (Number.isFinite(rawMax) && rawMax > 0 && rawMax <= 100) ? rawMax : 10;
    const rawBudget = parseInt(req.query.timeBudgetMs, 10);
    const timeBudgetMs = (Number.isFinite(rawBudget) && rawBudget >= 1000 && rawBudget <= 28800000) ? rawBudget : 150000;
    const searchMode = String(req.query.searchMode || 'ga').toLowerCase();
    const rawPop = parseInt(req.query.populationSize, 10);
    const populationSize = (Number.isFinite(rawPop) && rawPop >= 10 && rawPop <= 200) ? rawPop : (searchMode === 'deep' ? 100 : 40);

    const { devices, clients } = await getFreshData(force);
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis  = analyzer.analyzeClients(clients, devices);
    const apsModel = buildApsModel(channelAnalysis);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Helper to write an SSE event
    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial connected event
    sendEvent('connected', {
      maxChanges,
      timeBudgetMs,
      populationSize,
      totalAPs: apsModel.length,
      totalRadios: channelAnalysis.radios.length,
    });

    // Run GA optimizer with progress callback
    const result = await optimizer.runGeneticOptimizer(
      channelAnalysis.radios,
      channelAnalysis.summary,
      apsModel,
      { maxChanges, timeBudgetMs, populationSize, searchMode },
      (progress) => {
        // Stream progress to the frontend
        sendEvent('progress', progress);
      }
    );

    // Send final complete event with full result
    sendEvent('complete', {
      success: true,
      timestamp: Date.now(),
      ...result,
    });

    res.end();
  } catch (err) {
    // Try to send error as SSE event if headers already sent
    try {
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ success: false, error: err.message });
      }
    } catch (_) {
      // Client may have disconnected
    }
    console.error('[SSE] Optimizer progress error:', err.message);
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
  const ip = req.ip || 'unknown';
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
    // Return only the CSRF token — the session token is stored in an HttpOnly cookie.
    return res.json({ success: true, csrfToken });
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

// Return 404 JSON for any /api/* route that was not matched above.
// This prevents the catch-all below from returning an HTML page for typos like /api/diagnotics.
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API route not found: ${req.method} ${req.path}` });
});

// Serve index.html for all other routes to support client-side SPA routing if needed
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup check & server start
async function startServer() {
  console.log('=== UniFi Diagnostics System Startup ===');
  if (config.mock.enabled) {
    console.log('[Startup] MOCK_MODE=true detected. Skipping initial UniFi controller login.');
  } else {
    try {
      await unifiClient.login();
      console.log('[Startup] Connection to UniFi Controller verified successfully!');
    } catch (err) {
      console.warn(`[Startup Warning] Could not connect to UniFi Controller: ${err.message}`);
      console.warn('[Startup] Will retry connection in 30 seconds...');
      const retryInterval = setInterval(async () => {
        try {
          await unifiClient.login();
          console.log('[Startup] UniFi Controller reconnection successful!');
          clearInterval(retryInterval);
        } catch (retryErr) {
          console.warn(`[Startup] Retry connection failed: ${retryErr.message}`);
        }
      }, 30000);
      retryInterval.unref();
    }
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Server] Network Health dashboard is running!`);
    console.log(`[Server] Local URL:   http://localhost:${PORT}`);
    console.log(`[Server] Network URL: http://0.0.0.0:${PORT}`);
    console.log('========================================');
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[Server] Forced exit after timeout.');
      process.exit(1);
    }, 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();

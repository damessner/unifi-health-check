const express = require('express');
const path = require('path');
const config = require('./config');
const unifiClient = require('./services/unifiClient');
const analyzer = require('./services/analyzer');
const historyStore = require('./services/historyStore');

const app = express();
const PORT = config.server.port;

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.use('/api', (req, res, next) => {
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
let serverInstance = null;
const TEACHER_STICKY_SIGNAL_THRESHOLD_DBM = -75;
const TEACHER_STICKY_24GHZ_SIGNAL_THRESHOLD_DBM = -72;
const TEACHER_STICKY_LOW_ROAM_COUNT = 1;
const TEACHER_STICKY_HIGH_ROAM_COUNT = 5;
const TEACHER_LOCATION_CRITICAL_WEIGHT = 3;
const TEACHER_LOCATION_WARNING_WEIGHT = 2;
const TEACHER_LOCATION_RED_CLIENT_ISSUE_THRESHOLD = 3;
const TEACHER_READINESS_CRITICAL_SIGNAL_PENALTY = 12;
const TEACHER_READINESS_CRITICAL_CLIENT_PENALTY = 4;
const TEACHER_READINESS_WARNING_SIGNAL_PENALTY = 5;
const TEACHER_READINESS_WARNING_CLIENT_PENALTY = 2;
const TEACHER_PORTAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TEACHER_PORTAL_MAX_REQUESTS_PER_WINDOW = 60;
const DASHBOARD_PAGE_MAX_REQUESTS_PER_WINDOW = 120;
const TEACHER_REPORT_MAX_REQUESTS_PER_WINDOW = 12;
const TEACHER_ALLOWED_ISSUE_TYPES = new Set([
  'Slow Wi-Fi',
  'Connection drops',
  'Cannot join',
  'Video call lag',
  'Other'
]);
const rateLimitStore = new Map();

function createRateLimiter(maxRequests, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      rateLimitStore.set(key, { windowStart: now, count: 1 });
      next();
      return;
    }

    if (entry.count >= maxRequests) {
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait a moment and try again.'
      });
      return;
    }

    entry.count += 1;
    next();
  };
}

const teacherPortalReadLimiter = createRateLimiter(
  TEACHER_PORTAL_MAX_REQUESTS_PER_WINDOW,
  TEACHER_PORTAL_RATE_LIMIT_WINDOW_MS
);
const dashboardPageReadLimiter = createRateLimiter(
  DASHBOARD_PAGE_MAX_REQUESTS_PER_WINDOW,
  TEACHER_PORTAL_RATE_LIMIT_WINDOW_MS
);
const teacherPortalWriteLimiter = createRateLimiter(
  TEACHER_REPORT_MAX_REQUESTS_PER_WINDOW,
  TEACHER_PORTAL_RATE_LIMIT_WINDOW_MS
);

function sanitizePlainText(value, maxLength) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * Push a snapshot into the history ring buffer after a fresh data fetch.
 */
async function pushHistorySnapshot(channels, clients) {
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

  try {
    await historyStore.appendSnapshot(snapshot);
  } catch (err) {
    console.warn(`[History] Failed to persist snapshot: ${err.message}`);
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

function buildTeacherStatus(channelAnalysis, clientAnalysis) {
  const clientList = clientAnalysis.allClients || clientAnalysis.clients || [];
  const problematicClients = clientList.filter((client) => client.severity !== 'healthy');
  const stickyClients = clientList
    .filter((client) => (
      client.severity !== 'healthy' && (
        (client.signal <= TEACHER_STICKY_SIGNAL_THRESHOLD_DBM && client.roamCount <= TEACHER_STICKY_LOW_ROAM_COUNT) ||
      client.roamCount >= TEACHER_STICKY_HIGH_ROAM_COUNT ||
        (client.band === '2.4GHz' && client.signal <= TEACHER_STICKY_24GHZ_SIGNAL_THRESHOLD_DBM)
      )
    ))
    .sort((a, b) => {
      if ((b.roamCount || 0) !== (a.roamCount || 0)) {
        return (b.roamCount || 0) - (a.roamCount || 0);
      }
      return (a.signal || -100) - (b.signal || -100);
    })
    .slice(0, 6)
    .map((client) => ({
      hostname: client.hostname,
      apName: client.apName,
      signal: client.signal,
      band: client.band,
      roamCount: client.roamCount,
      severity: client.severity,
      recommendation: client.recommendation
    }));

  const locationScores = {};
  (channelAnalysis.radios || []).forEach((radio) => {
    const key = radio.apName || radio.apMac || 'Unknown Area';
    if (!locationScores[key]) {
      locationScores[key] = {
        name: key,
        criticalSignals: 0,
        warningSignals: 0,
        clientIssues: 0
      };
    }

    if (radio.health === 'critical') {
      locationScores[key].criticalSignals += 1;
    } else if (radio.health === 'warning') {
      locationScores[key].warningSignals += 1;
    }
  });

  problematicClients.forEach((client) => {
    const key = client.apName || 'Unknown Area';
    if (!locationScores[key]) {
      locationScores[key] = {
        name: key,
        criticalSignals: 0,
        warningSignals: 0,
        clientIssues: 0
      };
    }
    locationScores[key].clientIssues += 1;
  });

  const locations = Object.values(locationScores)
    .map((location) => {
      const severityScore = (
        location.criticalSignals * TEACHER_LOCATION_CRITICAL_WEIGHT +
        location.warningSignals * TEACHER_LOCATION_WARNING_WEIGHT +
        location.clientIssues
      );
      let readiness = 'green';
      if (location.criticalSignals > 0 || location.clientIssues >= TEACHER_LOCATION_RED_CLIENT_ISSUE_THRESHOLD) {
        readiness = 'red';
      } else if (location.warningSignals > 0 || location.clientIssues > 0) {
        readiness = 'yellow';
      }

      return {
        ...location,
        readiness,
        severityScore
      };
    })
    .sort((a, b) => (b.severityScore - a.severityScore) || a.name.localeCompare(b.name))
    .slice(0, 8);

  const criticalSignals = channelAnalysis.summary.congestedRadiosCount || 0;
  const criticalClients = clientAnalysis.summary.criticalCount || 0;
  const warningSignals = channelAnalysis.summary.warningRadiosCount || 0;
  const warningClients = clientAnalysis.summary.warningCount || 0;

  let overallStatus = 'green';
  let headline = 'School Wi-Fi looks healthy right now.';
  if (criticalSignals > 0 || criticalClients > 0) {
    overallStatus = 'red';
    headline = 'Some rooms currently have Wi-Fi issues that may impact lessons.';
  } else if (warningSignals > 0 || warningClients > 0) {
    overallStatus = 'yellow';
    headline = 'Wi-Fi is usable, but a few rooms need attention soon.';
  }

  const readinessScore = Math.max(
    0,
    100 -
      criticalSignals * TEACHER_READINESS_CRITICAL_SIGNAL_PENALTY -
      criticalClients * TEACHER_READINESS_CRITICAL_CLIENT_PENALTY -
      warningSignals * TEACHER_READINESS_WARNING_SIGNAL_PENALTY -
      warningClients * TEACHER_READINESS_WARNING_CLIENT_PENALTY
  );

  return {
    overallStatus,
    headline,
    readinessScore,
    stickyClients,
    locations
  };
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
  const limit = parseInt(req.query.limit, 10) || config.server.historyApiLimit;

  historyStore.getSnapshots(limit)
    .then(({ samples, count }) => {
      res.json({
        success: true,
        samples,
        count
      });
    })
    .catch((err) => {
      console.warn(`[History] Falling back to in-memory buffer: ${err.message}`);
      res.json({
        success: true,
        samples: historyBuffer,
        count: historyBuffer.length
      });
    });
});

app.get('/api/teacher/status', teacherPortalReadLimiter, async (req, res) => {
  try {
    const { devices, clients } = await getFreshData(false);
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis = analyzer.analyzeClients(clients, devices);
    const recentReports = await historyStore.getTeacherReports(8);

    res.json({
      success: true,
      timestamp: Date.now(),
      status: buildTeacherStatus(channelAnalysis, clientAnalysis),
      recentReports
    });
  } catch (err) {
    console.error('[Teacher API] Failed to build teacher status:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to load teacher portal status.',
      details: err.message
    });
  }
});

app.get('/api/teacher/reports', teacherPortalReadLimiter, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const reports = await historyStore.getTeacherReports(limit);
    res.json({
      success: true,
      reports
    });
  } catch (err) {
    console.error('[Teacher API] Failed to load teacher reports:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to load teacher reports.',
      details: err.message
    });
  }
});

app.post('/api/teacher/report', teacherPortalWriteLimiter, async (req, res) => {
  try {
    const reporterName = sanitizePlainText(req.body?.reporterName, 80);
    const location = sanitizePlainText(req.body?.location, 120);
    const issueType = sanitizePlainText(req.body?.issueType, 60);
    const message = sanitizePlainText(req.body?.message, 500);

    if (!location || !issueType || !message) {
      return res.status(400).json({
        success: false,
        error: 'Location, issue type, and message are required.'
      });
    }

    if (!TEACHER_ALLOWED_ISSUE_TYPES.has(issueType)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported issue type.'
      });
    }

    const storedReport = await historyStore.addTeacherReport({
      reporterName: reporterName || 'Anonymous Teacher',
      location,
      issueType,
      message
    });

    res.status(201).json({
      success: true,
      report: storedReport
    });
  } catch (err) {
    console.error('[Teacher API] Failed to store teacher report:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to store the teacher report.',
      details: err.message
    });
  }
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
    const { devices, clients } = await getFreshData(force);

    console.log(`[Analyzer] Processing stats for ${devices.length} devices and ${clients.length} clients...`);
    
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis = analyzer.analyzeClients(clients, devices);
    const apsModel = buildApsModel(channelAnalysis);

    // Only push to history when data is fresh from the controller (not served from cache)
    if (Date.now() - cache.lastFetch < FRESH_DATA_THRESHOLD_MS) {
      await pushHistorySnapshot(channelAnalysis, clientAnalysis);
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
 * Serve the simplified teacher portal.
 */
app.get('/teacher', teacherPortalReadLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

// Serve index.html for all other routes to support client-side SPA routing if needed
app.get('*', dashboardPageReadLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup check & server start
async function startServer() {
  console.log('=== UniFi Diagnostics System Startup ===');
  try {
    await historyStore.init();
    const persistedHistory = await historyStore.getSnapshots(HISTORY_MAX_SAMPLES);
    historyBuffer.push(...persistedHistory.samples);
    console.log(`[History] SQLite persistence ready (${persistedHistory.count} stored samples).`);
  } catch (err) {
    console.warn(`[History] SQLite persistence unavailable: ${err.message}`);
    console.warn('[History] Operating in memory-only mode until SQLite becomes available.');
  }

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

  serverInstance = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Server] Network Health dashboard is running!`);
    console.log(`[Server] Local URL:   http://localhost:${PORT}`);
    console.log(`[Server] Network URL: http://0.0.0.0:${PORT}`);
    console.log('========================================');
  });
}

async function shutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down...`);

  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }

  try {
    await historyStore.close();
  } catch (err) {
    console.warn(`[History] Failed to close SQLite cleanly: ${err.message}`);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
startServer();

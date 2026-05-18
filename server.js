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

// Serve index.html for all other routes to support client-side SPA routing if needed
app.get('*', (req, res) => {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Server] Network Health dashboard is running!`);
    console.log(`[Server] Local URL:   http://localhost:${PORT}`);
    console.log(`[Server] Network URL: http://0.0.0.0:${PORT}`);
    console.log('========================================');
  });
}

startServer();

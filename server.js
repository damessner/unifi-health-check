const express = require('express');
const path = require('path');
const config = require('./config');
const unifiClient = require('./services/unifiClient');
const analyzer = require('./services/analyzer');

const app = express();
const PORT = config.server.port;

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory cache for UniFi data to ensure high-speed dashboard responsiveness
const cache = {
  devices: null,
  clients: null,
  lastFetch: 0
};

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
    const webUntis = await unifiClient.getWebUntisSchedule();

    console.log(`[Analyzer] Processing stats for ${devices.length} devices and ${clients.length} clients...`);
    
    const channelAnalysis = analyzer.analyzeChannels(devices);
    const clientAnalysis = analyzer.analyzeClients(clients, devices, webUntis);

    res.json({
      success: true,
      timestamp: Date.now(),
      cacheAgeMs: Date.now() - cache.lastFetch,
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
 * API: Apply remediation blueprint to an AP
 */
app.post('/api/remediate', async (req, res) => {
  try {
    const { mac, target } = req.body || {};
    if (!mac || !target) {
      return res.status(400).json({
        success: false,
        error: 'Both mac and target payload are required.'
      });
    }

    const requiredKeys = ['channel24', 'power24', 'channel5', 'power5', 'minRssi'];
    const missing = requiredKeys.filter(k => target[k] === undefined || target[k] === null || Number.isNaN(Number(target[k])));
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing or invalid remediation target fields: ${missing.join(', ')}`
      });
    }

    const result = await unifiClient.remediateAccessPoint(mac, target);
    cache.lastFetch = 0; // force fresh data on next diagnostics request

    return res.json({
      success: !!result.success,
      mac,
      mode: result.mode || 'unknown',
      message: result.message || 'Remediation request processed.'
    });
  } catch (err) {
    console.error('[API Error] Remediation failed:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to apply remediation request.',
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
    // Perform initial login to verify connection on startup
    await unifiClient.login();
    console.log('[Startup] Connection to UniFi Controller verified successfully!');
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

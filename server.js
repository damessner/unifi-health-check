const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');
const unifiClient = require('./services/unifiClient');
const analyzer = require('./services/analyzer');
const xlsxExporter = require('./services/xlsxExporter');
const optimizer = require('./services/optimizer');
const optimizerManager = require('./services/optimizerManager');

// ── Rust binary resolution ─────────────────────────────────────────

/** Return the path to the Rust optimizer binary, or null if not found. */
function getRustBinaryPath() {
  const isWin = process.platform === 'win32';
  const baseDir = path.join(__dirname, 'rust-optimizer', 'target', 'release');
  const binName = isWin ? 'unifi-ga-optimizer.exe' : 'unifi-ga-optimizer';
  const fullPath = path.join(baseDir, binName);
  try {
    if (fs.existsSync(fullPath)) {
      // On Linux ensure execute permission
      if (!isWin) {
        try { fs.chmodSync(fullPath, 0o755); } catch (_) {}
      }
      return fullPath;
    }
  } catch (_) {}
  // Fallback: try the other platform's name (exe → no exe and vice versa)
  const altName = isWin ? 'unifi-ga-optimizer' : 'unifi-ga-optimizer.exe';
  const altPath = path.join(baseDir, altName);
  try {
    if (fs.existsSync(altPath)) {
      if (!isWin) { try { fs.chmodSync(altPath, 0o755); } catch (_) {} }
      return altPath;
    }
  } catch (_) {}
  return null;
}

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

// ── Optimizer engine runners (used by POST /api/optimize/run in background) ──

/**
 * Run the JS GA engine in background for a given job.
 * Stores progress via optimizerManager and completes the job on finish.
 */
async function runJSEngine(jobId, params, deps) {
  const { maxChanges, timeBudgetMs, generationLimit, populationSize,
          mutationRate, eliteCount, stagnationLimit, convergenceWindow,
          convergenceThreshold, searchMode, minImprovementThreshold } = params;
  const { channelAnalysis, apsModel } = deps;

  // Check if cancelled before starting
  const rawJob = optimizerManager._jobs?.get(jobId);
  if (rawJob && rawJob.status === 'cancelled') return;

  // Register cancellation check with the optimizer
  optimizer._cancelledJobIds = optimizer._cancelledJobIds || new Set();
  optimizer._cancelledJobIds.add(jobId);

  const result = await optimizer.runGeneticOptimizer(
    channelAnalysis.radios,
    channelAnalysis.summary,
    apsModel,
    {
      maxChanges, minImprovementThreshold, enforceMinImprovement: true,
      timeBudgetMs, generationLimit, populationSize, mutationRate,
      eliteCount, stagnationLimit, convergenceWindow, convergenceThreshold,
      searchMode, jobId, // pass jobId for cancellation checking
    },
    (progress) => { optimizerManager.addProgress(jobId, progress); },
  );

  // Final cancellation check after completion
  if (!result || optimizer._cancelledJobIds.has(jobId)) {
    if (optimizer._cancelledJobIds) optimizer._cancelledJobIds.delete(jobId);
    return; // Don't save result
  }

  // Generate and save XLSX
  let xlsxPath = null;
  try {
    const diagData = { channels: channelAnalysis, clients: deps.clientAnalysis, aps: apsModel };
    const buffer = await xlsxExporter.generateXlsx(diagData, { maxChanges });
    xlsxPath = path.join(__dirname, 'data', 'optimizer-runs', `${jobId}-report.xlsx`);
    require('fs').writeFileSync(xlsxPath, buffer);
  } catch (e) { console.error('[Job] XLSX save error:', e.message); }

  optimizerManager.completeJob(jobId, result, xlsxPath);
}

/**
 * Run the Rust GA engine in background for a given job.
 * Stores progress via optimizerManager and completes the job on finish.
 */
async function runRustEngine(jobId, params, deps) {
  const { maxChanges, timeBudgetMs, generationLimit, populationSize,
          mutationRate, eliteCount, stagnationLimit, convergenceWindow,
          convergenceThreshold, minImprovementThreshold } = params;
  const { channelAnalysis, apsModel } = deps;

  // Resolve Rust binary; return early if not available
  const rustBin = getRustBinaryPath();
  if (!rustBin) {
    optimizerManager.failJob(jobId, 'Rust optimizer binary not found. On Linux, compile with: cd rust-optimizer && cargo build --release');
    return;
  }

  const input = {
    radios: channelAnalysis.radios.filter(r => r.channel != null).map(r => ({
      apMac: r.apMac, radio: r.radio, channel: r.channel,
      cu_total: r.cu_total || 0, cci_count: r.cci_count || 0,
      tx_retries_pct: r.tx_retries_pct || 0, num_sta: r.num_sta || 0,
      bw: r.bw || null, cu_self_rx: r.cu_self_rx || 0, cu_self_tx: r.cu_self_tx || 0,
      band: r.band || null, apName: r.apName || r.apMac,
    })),
    channel_summary: {
      channelCounts24: channelAnalysis.summary.channelCounts24 || {},
      channelCounts5: channelAnalysis.summary.channelCounts5 || {},
    },
    max_changes: maxChanges, time_budget_ms: timeBudgetMs,
    generation_limit: generationLimit, population_size: populationSize,
    mutation_rate: mutationRate, elite_count: eliteCount,
    stagnation_limit: stagnationLimit, convergence_window: convergenceWindow,
    convergence_threshold: convergenceThreshold,
    min_improvement_threshold: minImprovementThreshold,
    enforce_min_improvement: true, search_mode: 'rust',
  };

  const proc = require('child_process').spawn(rustBin, [], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Store child process reference so cancellation can kill it
  const rawJob = optimizerManager._jobs?.get(jobId);
  if (rawJob) rawJob._childProcess = proc;

  // Check if cancelled before Rust starts
  if (rawJob && rawJob.status === 'cancelled') {
    proc.kill('SIGTERM');
    return;
  }

  let completeData = null;
  let stdoutBuffer = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'progress') {
          optimizerManager.addProgress(jobId, {
            phase: 'searching', generation: msg.generation,
            populationSize, elapsedMs: msg.elapsed_ms,
            remainingMs: Math.max(0, timeBudgetMs - msg.elapsed_ms),
            totalBudgetMs: timeBudgetMs,
            bestPain: msg.best_pain, bestImprovementPct: msg.best_improvement_pct,
            bestChangesCount: msg.best_changes,
            diversity: msg.diversity, meanPain: msg.mean_pain,
            medianPain: msg.median_pain, worstPain: msg.worst_pain,
            statusText: msg.status_text,
          });
        } else if (msg.type === 'complete') {
          completeData = msg;
        }
      } catch (_) { /* skip parse errors */ }
    }
  });

  proc.stderr.on('data', (chunk) => console.error('[Rust-Opt]', chunk.toString().trim()));

  await new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (code !== 0 && !completeData) reject(new Error(`Rust optimizer exited with code ${code}`));
      else resolve();
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input) + '\n');
    proc.stdin.end();
  });

  if (!completeData) throw new Error('Rust optimizer produced no result');

  const rustResult = {
    plan: completeData.plan || {},
    changedAPs: (completeData.changedAPs || []).map(ap => ({
      mac: ap.mac, name: ap.name, floor: ap.floor || '—',
      healthScore: ap.healthScore || 0, changes: ap.changes || '',
      oldNgCh: ap.oldNgCh, newNgCh: ap.newNgCh,
      oldNaCh: ap.oldNaCh, newNaCh: ap.newNaCh,
      cu: ap.cu || 0, cci: ap.cci || 0,
    })),
    totalAPs: completeData.totalAPs || channelAnalysis.radios.length,
    candidatesConsidered: (completeData.changedAPs || []).length,
    batchSummary: {
      maxChanges, changesSuggested: (completeData.changedAPs || []).length,
      remainingWorstAPs: Math.max(0, channelAnalysis.radios.length - (completeData.changedAPs || []).length),
      recommendation: 'Rust optimizer completed.',
    },
    improvementReport: completeData.improvementReport || null,
    proximityGraph: optimizer.buildProximityGraph(apsModel),
    searchMeta: completeData.searchMeta || { mode: 'rust' },
  };

  // Generate and save XLSX
  let xlsxPath = null;
  try {
    const diagData = { channels: channelAnalysis, clients: deps.clientAnalysis, aps: apsModel };
    const buffer = await xlsxExporter.generateXlsx(diagData, { maxChanges });
    xlsxPath = path.join(__dirname, 'data', 'optimizer-runs', `${jobId}-report.xlsx`);
    require('fs').writeFileSync(xlsxPath, buffer);
  } catch (e) { console.error('[Job] XLSX save error:', e.message); }

  optimizerManager.completeJob(jobId, rustResult, xlsxPath);
}

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
    const maxChanges = (Number.isFinite(rawMax) && rawMax > 0 && rawMax <= 100) ? rawMax : config.opt.maxChanges;
    const rawMin = parseInt(req.query.minImprovement, 10);
    const minImprovementThreshold = (Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 100) ? rawMin : 5;
    const rawBudget = parseInt(req.query.timeBudgetMs, 10);
    const timeBudgetMs = (Number.isFinite(rawBudget) && rawBudget >= 1000 && rawBudget <= 28800000) ? rawBudget : 150000;
    const rawGen = parseInt(req.query.generationLimit, 10);
    const generationLimit = (Number.isFinite(rawGen) && rawGen >= 100 && rawGen <= 500000) ? rawGen : 100000;
    const searchMode = String(req.query.searchMode || 'ga').toLowerCase();
    const rawPop = parseInt(req.query.populationSize, 10);
    const populationSize = (Number.isFinite(rawPop) && rawPop >= 10 && rawPop <= 200) ? rawPop : (searchMode === 'deep' ? 100 : 40);
    const rawMutation = Number(req.query.mutationRate);
    const mutationRate = (Number.isFinite(rawMutation) && rawMutation > 0 && rawMutation <= 1) ? rawMutation : 0.25;
    const rawElite = parseInt(req.query.eliteCount, 10);
    const eliteCount = (Number.isFinite(rawElite) && rawElite >= 1 && rawElite <= 50)
      ? rawElite
      : Math.max(2, Math.floor(populationSize / 10));
    const rawStag = parseInt(req.query.stagnationLimit, 10);
    const stagnationLimit = (Number.isFinite(rawStag) && rawStag >= 10 && rawStag <= 5000) ? rawStag : 200;
    const rawConvWindow = parseInt(req.query.convergenceWindow, 10);
    const convergenceWindow = (Number.isFinite(rawConvWindow) && rawConvWindow >= 20 && rawConvWindow <= 2000) ? rawConvWindow : 300;
    const rawConvThreshold = Number(req.query.convergenceThreshold);
    const convergenceThreshold = (Number.isFinite(rawConvThreshold) && rawConvThreshold > 0 && rawConvThreshold <= 10)
      ? rawConvThreshold
      : 0.5;

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

    // ── Create persistent background job ─────────────────────────────────
    const job = optimizerManager.createJob({
      maxChanges, minImprovementThreshold, timeBudgetMs, generationLimit,
      searchMode, populationSize, mutationRate, eliteCount,
      stagnationLimit, convergenceWindow, convergenceThreshold,
    });
    const jobId = job.id;

    // Wrapper that stores progress events in the job manager
    const sendWrappedEvent = (event, data) => {
      sendEvent(event, data);
      if (event === 'progress') {
        optimizerManager.addProgress(jobId, data);
      }
    };

    // Send initial connected event (includes jobId so frontend can reconnect)
    sendEvent('connected', {
      jobId,
      maxChanges,
      minImprovementThreshold,
      timeBudgetMs,
      generationLimit,
      populationSize,
      mutationRate,
      eliteCount,
      stagnationLimit,
      convergenceWindow,
      convergenceThreshold,
      totalAPs: apsModel.length,
      totalRadios: channelAnalysis.radios.length,
    });

    // Helper to background-generate and save an XLSX report
    const saveXlsxForJob = async () => {
      try {
        const diagData = { channels: channelAnalysis, clients: clientAnalysis, aps: apsModel };
        const buffer = await xlsxExporter.generateXlsx(diagData, { maxChanges });
        const xlsxPath = path.join(__dirname, 'data', 'optimizer-runs', `${jobId}-report.xlsx`);
        require('fs').writeFileSync(xlsxPath, buffer);
        return xlsxPath;
      } catch (e) {
        console.error('[Job] XLSX save failed:', e.message);
        return null;
      }
    };

    if (searchMode === 'rust') {
      // ── Rust native optimizer ─────────────────────────────────────────────
      const rustBin = getRustBinaryPath();
      if (!rustBin) {
        sendEvent('error', { error: 'Rust optimizer binary not found. Run: cd rust-optimizer && cargo build --release' });
        res.end();
        return;
      }
      const input = {
        radios: channelAnalysis.radios
          .filter(r => r.channel != null) // skip radios without a channel
          .map(r => ({
          apMac: r.apMac, radio: r.radio, channel: r.channel,
          cu_total: r.cu_total || 0, cci_count: r.cci_count || 0,
          tx_retries_pct: r.tx_retries_pct || 0, num_sta: r.num_sta || 0,
          bw: r.bw || null, cu_self_rx: r.cu_self_rx || 0, cu_self_tx: r.cu_self_tx || 0,
          band: r.band || null, apName: r.apName || r.apMac,
        })),
        channel_summary: {
          channelCounts24: channelAnalysis.summary.channelCounts24 || {},
          channelCounts5: channelAnalysis.summary.channelCounts5 || {},
        },
        max_changes: maxChanges,
        time_budget_ms: timeBudgetMs,
        generation_limit: generationLimit,
        population_size: populationSize,
        mutation_rate: mutationRate,
        elite_count: eliteCount,
        stagnation_limit: stagnationLimit,
        convergence_window: convergenceWindow,
        convergence_threshold: convergenceThreshold,
        min_improvement_threshold: minImprovementThreshold,
        enforce_min_improvement: true,
        search_mode: searchMode,
      };

      const proc = spawn(rustBin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let completeData = null;
      let stdoutBuffer = '';

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        // Keep the last incomplete fragment in the buffer
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'progress') {
              sendWrappedEvent('progress', {
                phase: 'searching',
                generation: msg.generation,
                populationSize: populationSize,
                elapsedMs: msg.elapsed_ms,
                remainingMs: Math.max(0, timeBudgetMs - msg.elapsed_ms),
                totalBudgetMs: timeBudgetMs,
                bestPain: msg.best_pain,
                bestImprovementPct: msg.best_improvement_pct,
                bestChangesCount: msg.best_changes,
                diversity: msg.diversity,
                meanPain: msg.mean_pain,
                medianPain: msg.median_pain,
                worstPain: msg.worst_pain,
                statusText: msg.status_text,
              });
            } else if (msg.type === 'complete') {
              completeData = msg;
            }
          } catch (_) { /* skip parse errors */ }
        }
      });

      proc.stderr.on('data', (chunk) => {
        console.error('[Rust-Opt]', chunk.toString().trim());
      });

      await new Promise((resolve, reject) => {
        proc.on('close', (code) => {
          if (code !== 0 && !completeData) {
            reject(new Error(`Rust optimizer exited with code ${code}`));
          } else {
            resolve();
          }
        });
        proc.on('error', reject);
        proc.stdin.write(JSON.stringify(input) + '\n');
        proc.stdin.end();
      });

      if (!completeData) throw new Error('Rust optimizer produced no result');

      // Transform Rust output to the format the frontend expects
      const rustResult = {
        plan: completeData.plan || {},
        changedAPs: (completeData.changedAPs || []).map(ap => ({
          mac: ap.mac, name: ap.name, floor: ap.floor || '—',
          healthScore: ap.healthScore || 0,
          changes: ap.changes || '',
          oldNgCh: ap.oldNgCh, newNgCh: ap.newNgCh,
          oldNaCh: ap.oldNaCh, newNaCh: ap.newNaCh,
          cu: ap.cu || 0, cci: ap.cci || 0,
        })),
        totalAPs: completeData.totalAPs || apsModel.length,
        candidatesConsidered: (completeData.changedAPs || []).length,
        batchSummary: completeData.batchSummary || {
          maxChanges, changesSuggested: (completeData.changedAPs || []).length,
          remainingWorstAPs: Math.max(0, channelAnalysis.radios.length - (completeData.changedAPs || []).length),
          recommendation: 'Rust optimizer completed.',
        },
        improvementReport: completeData.improvementReport || null,
        proximityGraph: optimizer.buildProximityGraph(apsModel),
        searchMeta: completeData.searchMeta || { mode: 'rust' },
      };

      // Save result to job manager + generate XLSX
      const xlsxPath = await saveXlsxForJob();
      optimizerManager.completeJob(jobId, rustResult, xlsxPath);
      sendEvent('complete', { success: true, timestamp: Date.now(), jobId, ...rustResult });
    } else {
      // ── JavaScript GA optimizer ─────────────────────────────────────────
      const result = await optimizer.runGeneticOptimizer(
        channelAnalysis.radios,
        channelAnalysis.summary,
        apsModel,
        {
          maxChanges,
          minImprovementThreshold,
          enforceMinImprovement: true,
          timeBudgetMs,
          generationLimit,
          populationSize,
          mutationRate,
          eliteCount,
          stagnationLimit,
          convergenceWindow,
          convergenceThreshold,
          searchMode,
        },
        (progress) => {
          sendWrappedEvent('progress', progress);
        }
      );

      // Save result to job manager + generate XLSX
      const xlsxPath = await saveXlsxForJob();
      optimizerManager.completeJob(jobId, result, xlsxPath);

      sendEvent('complete', {
        success: true,
        timestamp: Date.now(),
        jobId,
        ...result,
      });
    }

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

// ── Job management routes ─────────────────────────────────────────

/**
 * GET /api/optimize/jobs - List recent optimizer jobs.
 */
app.get('/api/optimize/jobs', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  res.json({ success: true, jobs: optimizerManager.listJobs(limit) });
});

/**
 * GET /api/optimize/jobs/:id - Get a single job's details.
 */
app.get('/api/optimize/jobs/:id', (req, res) => {
  const job = optimizerManager.getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job });
});

/**
 * GET /api/optimize/jobs/:id/progress - SSE reconnect endpoint.
 *
 * Replays all stored progress events, sends current status,
 * then stays connected for live updates if still running.
 * Use this after page refresh to reattach to an active job.
 */
app.get('/api/optimize/jobs/:id/progress', (req, res) => {
  const jobId = req.params.id;
  const job = optimizerManager.getJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  optimizerManager.subscribe(jobId, res);
});

/**
 * GET /api/optimize/jobs/:id/download/:format
 *
 * Download the result of a completed job.
 * Formats: json, xlsx
 */
app.get('/api/optimize/jobs/:id/download/:format', (req, res) => {
  const jobId = req.params.id;
  const format = req.params.format;
  const job = optimizerManager.getJob(jobId);

  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (job.status !== 'completed') {
    return res.status(400).json({ success: false, error: 'Job is not yet completed' });
  }

  if (format === 'json') {
    const resultPath = optimizerManager.getResultPath(jobId);
    if (resultPath && require('fs').existsSync(resultPath)) {
      return res.download(resultPath, `optimization-${jobId.slice(0, 8)}.json`);
    }
    // Fallback: return in-memory result
    const fullJob = optimizerManager._jobs ? optimizerManager._jobs.get(jobId) : null;
    if (fullJob && fullJob.result) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="optimization-${jobId.slice(0, 8)}.json"`);
      return res.json(fullJob.result);
    }
    return res.status(404).json({ success: false, error: 'Result file not found' });
  }

  if (format === 'xlsx') {
    const xlsxPath = optimizerManager.getXlsxPath(jobId);
    if (xlsxPath && require('fs').existsSync(xlsxPath)) {
      return res.download(xlsxPath, `optimization-${jobId.slice(0, 8)}.xlsx`);
    }
    return res.status(404).json({ success: false, error: 'XLSX file not found for this job' });
  }

  res.status(400).json({ success: false, error: `Unsupported format: ${format}` });
});

/**
 * DELETE /api/optimize/jobs/:id - Cancel a running/queued job.
 *
 * The underlying optimizer process (Rust child process or JS GA loop)
 * will be stopped. The job status becomes 'cancelled'.
 */
app.delete('/api/optimize/jobs/:id', (req, res) => {
  const cancelled = optimizerManager.cancelJob(req.params.id);
  if (!cancelled) {
    return res.status(404).json({ success: false, error: 'Job not found or already finished' });
  }
  // Also signal the JS GA cancellation set
  const jobId = req.params.id;
  if (optimizer._cancelledJobIds) optimizer._cancelledJobIds.add(jobId);
  res.json({ success: true, message: 'Job cancelled' });
});

/**
 * POST /api/optimize/run - Create and start a new optimizer job.
 *
 * This is the preferred way to start an optimization from the UI.
 * Returns { jobId } immediately. Connect to /api/optimize/jobs/:id/progress
 * via SSE for live progress updates.
 */
app.post('/api/optimize/run', async (req, res) => {
  try {
    const force = req.body?.force === true;
    const maxChanges = Math.min(100, Math.max(1, parseInt(req.body?.maxChanges, 10) || config.opt.maxChanges));
    const minImprovementThreshold = Math.min(100, Math.max(0, parseInt(req.body?.minImprovement, 10) || 5));
    const timeBudgetMs = Math.min(28800000, Math.max(1000, parseInt(req.body?.timeBudgetMs, 10) || 150000));
    const generationLimit = Math.min(500000, Math.max(100, parseInt(req.body?.generationLimit, 10) || 100000));
    const searchMode = String(req.body?.searchMode || 'ga').toLowerCase();
    const populationSize = Math.min(200, Math.max(10, parseInt(req.body?.populationSize, 10) || (searchMode === 'deep' ? 100 : 40)));
    const mutationRate = Math.min(1, Math.max(0.01, parseFloat(req.body?.mutationRate) || 0.25));
    const eliteCount = Math.min(50, Math.max(1, parseInt(req.body?.eliteCount, 10) || Math.max(2, Math.floor(populationSize / 10))));
    const stagnationLimit = Math.min(5000, Math.max(10, parseInt(req.body?.stagnationLimit, 10) || 200));
    const convergenceWindow = Math.min(2000, Math.max(20, parseInt(req.body?.convergenceWindow, 10) || 300));
    const convergenceThreshold = Math.min(10, Math.max(0.01, parseFloat(req.body?.convergenceThreshold) || 0.5));

    // Concurrency: only one job per engine type at a time
    if (optimizerManager.hasRunningJob(searchMode)) {
      return res.status(409).json({
        success: false,
        error: `A ${searchMode} job is already running. Cancel it first or wait for it to complete.`,
      });
    }

    const job = optimizerManager.createJob({
      maxChanges, minImprovementThreshold, timeBudgetMs, generationLimit,
      searchMode, populationSize, mutationRate, eliteCount,
      stagnationLimit, convergenceWindow, convergenceThreshold,
    });
    const jobId = job.id;

    // Respond immediately with job ID
    res.json({ success: true, jobId });

    // Start execution asynchronously (fire-and-forget)
    setImmediate(async () => {
      try {
        const { devices, clients } = await getFreshData(force);
        const channelAnalysis = analyzer.analyzeChannels(devices);
        const clientAnalysis  = analyzer.analyzeClients(clients, devices);
        const apsModel = buildApsModel(channelAnalysis);

        if (searchMode === 'rust') {
          await runRustEngine(jobId, {
            maxChanges, timeBudgetMs, generationLimit, populationSize,
            mutationRate, eliteCount, stagnationLimit, convergenceWindow,
            convergenceThreshold, minImprovementThreshold,
          }, { channelAnalysis, apsModel });
        } else {
          await runJSEngine(jobId, {
            maxChanges, timeBudgetMs, generationLimit, populationSize,
            mutationRate, eliteCount, stagnationLimit, convergenceWindow,
            convergenceThreshold, searchMode, minImprovementThreshold,
          }, { channelAnalysis, clientAnalysis, apsModel });
        }
      } catch (err) {
        optimizerManager.failJob(jobId, err.message);
        console.error('[Job] background execution error:', err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

const express = require('express');
const path = require('path');
const config = require('./config');
const unifiClient = require('./services/unifiClient');
const analyzer = require('./services/analyzer');

const app = express();
const PORT = config.server.port;
const FRESH_DATA_THRESHOLD_MS = 2000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const cache = {
  devices: null,
  clients: null,
  lastFetch: 0,
  lastSource: 'unknown'
};

const historyBuffer = [];
const HISTORY_MAX_SAMPLES = config.server.historyMaxSamples;

function getSourceLabel(statusSummary, usedCache = false) {
  if (usedCache) {
    return cache.lastSource === 'unknown' ? 'cache' : `cache:${cache.lastSource}`;
  }

  const endpointSources = [statusSummary.devices.source, statusSummary.clients.source].filter(Boolean);
  if (endpointSources.length === 0) return 'unknown';
  if (endpointSources.every((source) => source === 'live')) return 'live';
  if (endpointSources.every((source) => source === 'mock')) return 'mock';
  if (endpointSources.some((source) => source.includes('mock'))) return 'mock-fallback';
  return 'mixed';
}

function buildTelemetryMeta(usedCache = false) {
  const statusSummary = unifiClient.getStatusSummary();
  const source = getSourceLabel(statusSummary, usedCache);
  return {
    source,
    usedCache,
    cacheAgeMs: cache.lastFetch ? Math.max(0, Date.now() - cache.lastFetch) : null,
    lastSuccessfulFetchAt: cache.lastFetch ? new Date(cache.lastFetch).toISOString() : null,
    historySamples: historyBuffer.length,
    controller: statusSummary.controller,
    site: statusSummary.site,
    hostPort: config.server.hostPort,
    requestTimeoutMs: statusSummary.requestTimeoutMs,
    auth: statusSummary.auth,
    devices: statusSummary.devices,
    clients: statusSummary.clients
  };
}

function pushHistorySnapshot(channels, clients, telemetry) {
  const snapshot = {
    timestamp: Date.now(),
    source: telemetry.source,
    totalAllClients: clients.summary.totalAllClients,
    totalAppleClients: clients.summary.totalAppleClients,
    avgUtil24: channels.summary.avgUtil24,
    avgUtil5: channels.summary.avgUtil5,
    totalDownloadMbps: Math.round(clients.summary.totalDownloadKbps / 1000),
    totalUploadMbps: Math.round(clients.summary.totalUploadKbps / 1000),
    criticalCount: clients.summary.criticalCount,
    warningCount: clients.summary.warningCount,
    congestedRadiosCount: channels.summary.congestedRadiosCount,
    healthyAllClients: clients.summary.totalHealthyAllClients,
    activeTrafficClients: clients.summary.totalActiveTrafficClients,
    idleClients: clients.summary.totalIdleClients,
    connectedSuccessfullyCount: clients.summary.connectedSuccessfullyCount,
    unstableCount: clients.summary.unstableCount,
    connectivitySuccessRate: clients.summary.connectivitySuccessRate,
    dfsChannelsInUse: channels.summary.dfsChannelsInUse.length
  };

  historyBuffer.push(snapshot);
  if (historyBuffer.length > HISTORY_MAX_SAMPLES) {
    historyBuffer.shift();
  }
}

async function getFreshData(bypassCache = false) {
  const now = Date.now();
  const cacheAge = now - cache.lastFetch;

  if (!bypassCache && cache.devices && cache.clients && cacheAge < config.server.cacheExpiryMs) {
    console.log(`[Cache] Serving data from cache (age: ${Math.round(cacheAge / 1000)}s)`);
    return {
      devices: cache.devices,
      clients: cache.clients,
      telemetry: buildTelemetryMeta(true)
    };
  }

  console.log('[UniFi] Fetching fresh network data from controller...');
  const [devices, clients] = await Promise.all([
    unifiClient.getDevices(),
    unifiClient.getClients()
  ]);

  cache.devices = devices;
  cache.clients = clients;
  cache.lastFetch = Date.now();
  cache.lastSource = getSourceLabel(unifiClient.getStatusSummary());

  return {
    devices,
    clients,
    telemetry: buildTelemetryMeta(false)
  };
}

function buildHistoryInsights(samples) {
  if (!samples.length) {
    return {
      cards: [],
      incidents: []
    };
  }

  const peakClients = samples.reduce((max, sample) => (sample.totalAllClients > max.totalAllClients ? sample : max), samples[0]);
  const worst5GHz = samples.reduce((max, sample) => (sample.avgUtil5 > max.avgUtil5 ? sample : max), samples[0]);
  const bestConnectivity = samples.reduce((max, sample) => (sample.connectivitySuccessRate > max.connectivitySuccessRate ? sample : max), samples[0]);
  const worstInstability = samples.reduce((max, sample) => (sample.unstableCount > max.unstableCount ? sample : max), samples[0]);
  const highestIdle = samples.reduce((max, sample) => (sample.idleClients > max.idleClients ? sample : max), samples[0]);

  const cards = [
    {
      title: 'Peak client count',
      value: peakClients.totalAllClients,
      detail: new Date(peakClients.timestamp).toLocaleString()
    },
    {
      title: 'Worst 5 GHz load',
      value: `${worst5GHz.avgUtil5}%`,
      detail: `${worst5GHz.congestedRadiosCount} congested radios`
    },
    {
      title: 'Best connection success',
      value: `${bestConnectivity.connectivitySuccessRate}%`,
      detail: `${bestConnectivity.connectedSuccessfullyCount} clients stable/recent`
    },
    {
      title: 'Most unstable clients',
      value: worstInstability.unstableCount,
      detail: new Date(worstInstability.timestamp).toLocaleString()
    },
    {
      title: 'Largest idle pool',
      value: highestIdle.idleClients,
      detail: `${highestIdle.activeTrafficClients} clients moving traffic`
    }
  ];

  const incidents = [...samples]
    .filter((sample) => sample.criticalCount > 0 || sample.congestedRadiosCount > 0 || sample.unstableCount > 0)
    .reverse()
    .slice(0, 8)
    .map((sample) => ({
      time: new Date(sample.timestamp).toLocaleString(),
      title: sample.criticalCount > 0
        ? `${sample.criticalCount} Apple devices reported critical issues`
        : sample.unstableCount > 0
          ? `${sample.unstableCount} clients looked unstable`
          : `${sample.congestedRadiosCount} radios were congested`,
      detail: `5 GHz load ${sample.avgUtil5}% • Connectivity success ${sample.connectivitySuccessRate}% • Source ${sample.source}`
    }));

  return { cards, incidents };
}

function buildAdminInsights(channels, clients, telemetry, historyInsights) {
  const issuesDetected = [];
  const noIssuesDetected = [];

  channels.recommendations.forEach((recommendation) => {
    issuesDetected.push({
      severity: recommendation.severity,
      title: `${recommendation.band} — ${recommendation.title}`,
      detail: recommendation.description,
      action: recommendation.action,
      category: 'RF plan'
    });
  });

  clients.connectivity.unstableClients.slice(0, 6).forEach((client) => {
    issuesDetected.push({
      severity: client.severity === 'healthy' ? 'warning' : client.severity,
      title: `${client.hostname} has an unstable connection`,
      detail: `AP ${client.apName} • Signal ${client.signal} dBm • Download ${Math.round(client.txRateKbps / 1000)} Mbps • Upload ${Math.round(client.rxRateKbps / 1000)} Mbps • Errors ${client.errorSummary}`,
      action: client.recommendation,
      category: 'Client connectivity'
    });
  });

  if (clients.summary.totalIdleClients > 0) {
    issuesDetected.push({
      severity: clients.summary.totalIdleClients > Math.max(3, Math.round(clients.summary.totalAllClients * 0.4)) ? 'warning' : 'info',
      title: `${clients.summary.totalIdleClients} connected clients are idle`,
      detail: 'These devices are connected successfully but are not currently moving meaningful traffic.',
      action: 'If they should be active, verify the application, internet uplink, DNS, and content filters.',
      category: 'Traffic visibility'
    });
  }

  if (telemetry.source.includes('mock')) {
    issuesDetected.push({
      severity: 'warning',
      title: 'Dashboard is currently using demo/mock telemetry',
      detail: 'The backend could not pull full live controller data and switched to the bundled fallback dataset.',
      action: 'Verify controller reachability, credentials, TLS path, and timeout values before relying on the analysis.',
      category: 'Telemetry source'
    });
  } else {
    noIssuesDetected.push({
      title: 'Controller telemetry is reachable',
      detail: `Current source: ${telemetry.source}. Cache age: ${telemetry.cacheAgeMs !== null ? Math.round(telemetry.cacheAgeMs / 1000) : 0}s.`
    });
  }

  channels.positiveFindings.forEach((finding) => {
    noIssuesDetected.push({
      title: finding.title,
      detail: finding.detail
    });
  });

  clients.connectivity.noIssues.slice(0, 6).forEach((client) => {
    noIssuesDetected.push({
      title: `${client.hostname} is connected successfully`,
      detail: `AP ${client.apName} • ${client.band} • ${client.connectionState} • ${Math.round(client.totalTrafficKbps / 1000)} Mbps total traffic.`
    });
  });

  if (!issuesDetected.length) {
    noIssuesDetected.push({
      title: 'No active issues were detected',
      detail: `All observed clients and radios are within configured health thresholds across ${channels.summary.totalAPs} APs.`
    });
  }

  const recommendedSolutions = issuesDetected
    .map((issue) => issue.action)
    .filter(Boolean)
    .filter((action, index, arr) => arr.indexOf(action) === index)
    .slice(0, 8);

  return {
    summary: {
      connectedSuccessfullyCount: clients.summary.connectedSuccessfullyCount,
      unstableCount: clients.summary.unstableCount,
      activeTrafficClients: clients.summary.totalActiveTrafficClients,
      idleClients: clients.summary.totalIdleClients,
      totalErrorClients: clients.summary.totalErrorClients,
      congestedRadiosCount: channels.summary.congestedRadiosCount,
      dfsChannelsInUse: channels.summary.dfsChannelsInUse.length,
      connectivitySuccessRate: clients.summary.connectivitySuccessRate,
      avgSignal: clients.summary.avgSignal,
      avgSatisfaction: clients.summary.avgSatisfaction
    },
    issuesDetected: issuesDetected.slice(0, 12),
    noIssuesDetected: noIssuesDetected.slice(0, 12),
    recommendedSolutions,
    connectivityRows: [...clients.allClients]
      .sort((a, b) => {
        const severityWeight = { critical: 3, warning: 2, healthy: 1 };
        if (severityWeight[b.severity] !== severityWeight[a.severity]) {
          return severityWeight[b.severity] - severityWeight[a.severity];
        }
        if (a.connectedSuccessfully !== b.connectedSuccessfully) {
          return Number(a.connectedSuccessfully) - Number(b.connectedSuccessfully);
        }
        return b.totalTrafficKbps - a.totalTrafficKbps;
      })
      .slice(0, 30),
    busiestAps: clients.connectivity.busiestAps,
    activeTransfers: clients.connectivity.activeTransfers,
    idleClients: clients.connectivity.idleClients,
    historyInsights
  };
}

function buildLogAggregator({ timestamp, telemetry, channels, clients, adminInsights, historyInsights }) {
  const header = [
    'UniFi Health Check — Network Admin Log Aggregator',
    `Generated: ${new Date(timestamp).toLocaleString()}`,
    `Controller: ${telemetry.controller} (site: ${telemetry.site})`,
    `Dashboard host port: ${telemetry.hostPort}`,
    `Telemetry source: ${telemetry.source}`,
    `Cache age: ${telemetry.cacheAgeMs !== null ? Math.round(telemetry.cacheAgeMs / 1000) : 0}s`,
    ''
  ];

  const overview = [
    '[Overview]',
    `APs: ${channels.summary.totalAPs}`,
    `Radios healthy/warning/critical: ${channels.summary.healthyRadiosCount}/${channels.summary.warningRadiosCount}/${channels.summary.congestedRadiosCount}`,
    `Clients total: ${clients.summary.totalAllClients}`,
    `Connected successfully: ${clients.summary.connectedSuccessfullyCount} (${clients.summary.connectivitySuccessRate}%)`,
    `Active traffic clients: ${clients.summary.totalActiveTrafficClients}`,
    `Idle clients: ${clients.summary.totalIdleClients}`,
    `Errors/anomalies observed: ${clients.summary.totalErrorClients}`,
    `5 GHz DFS channels in use: ${channels.summary.dfsChannelsInUse.join(', ') || 'none'}`,
    ''
  ];

  const issues = ['[Issues Detected]'];
  if (adminInsights.issuesDetected.length) {
    adminInsights.issuesDetected.forEach((issue, index) => {
      issues.push(`${index + 1}. [${issue.severity.toUpperCase()}] ${issue.title}`);
      issues.push(`   Detail: ${issue.detail}`);
      issues.push(`   Action: ${issue.action}`);
    });
  } else {
    issues.push('1. No active issues detected.');
  }
  issues.push('');

  const healthySignals = ['[No Issues]'];
  adminInsights.noIssuesDetected.forEach((item, index) => {
    healthySignals.push(`${index + 1}. ${item.title}`);
    healthySignals.push(`   ${item.detail}`);
  });
  healthySignals.push('');

  const connectivity = ['[Connectivity Audit]'];
  adminInsights.connectivityRows.slice(0, 10).forEach((client, index) => {
    connectivity.push(`${index + 1}. ${client.hostname} @ ${client.apName}`);
    connectivity.push(`   Connected: ${client.connectedSuccessfully ? 'yes' : 'no'} (${client.connectionState}) • Traffic: ${client.trafficState}`);
    connectivity.push(`   Download: ${Math.round(client.txRateKbps / 1000)} Mbps • Upload: ${Math.round(client.rxRateKbps / 1000)} Mbps`);
    connectivity.push(`   Errors: ${client.errorSummary}`);
    connectivity.push(`   Recommendation: ${client.recommendation}`);
  });
  connectivity.push('');

  const history = ['[Historical Insights]'];
  historyInsights.cards.forEach((card, index) => {
    history.push(`${index + 1}. ${card.title}: ${card.value} (${card.detail})`);
  });
  history.push('');

  const incidents = ['[Recent Incidents]'];
  if (historyInsights.incidents.length) {
    historyInsights.incidents.forEach((incident, index) => {
      incidents.push(`${index + 1}. ${incident.time} — ${incident.title}`);
      incidents.push(`   ${incident.detail}`);
    });
  } else {
    incidents.push('1. No recent historical incidents stored yet.');
  }
  incidents.push('');

  const solutions = ['[Possible Solutions]'];
  adminInsights.recommendedSolutions.forEach((solution, index) => {
    solutions.push(`${index + 1}. ${solution}`);
  });
  if (!adminInsights.recommendedSolutions.length) {
    solutions.push('1. Continue monitoring; no remediations are required right now.');
  }

  return {
    generatedAt: new Date(timestamp).toISOString(),
    text: [...header, ...overview, ...issues, ...healthySignals, ...connectivity, ...history, ...incidents, ...solutions].join('\n')
  };
}

async function buildDiagnosticsPayload(force = false) {
  const { devices, clients, telemetry } = await getFreshData(force);

  console.log(`[Analyzer] Processing stats for ${devices.length} devices and ${clients.length} clients...`);
  const channelAnalysis = analyzer.analyzeChannels(devices);
  const clientAnalysis = analyzer.analyzeClients(clients, devices);

  if (!telemetry.usedCache && Date.now() - cache.lastFetch < FRESH_DATA_THRESHOLD_MS) {
    pushHistorySnapshot(channelAnalysis, clientAnalysis, telemetry);
  }

  const historyInsights = buildHistoryInsights(historyBuffer);
  const adminInsights = buildAdminInsights(channelAnalysis, clientAnalysis, telemetry, historyInsights);
  const timestamp = Date.now();
  const logAggregator = buildLogAggregator({
    timestamp,
    telemetry,
    channels: channelAnalysis,
    clients: clientAnalysis,
    adminInsights,
    historyInsights
  });

  return {
    success: true,
    timestamp,
    cacheAgeMs: telemetry.cacheAgeMs,
    telemetry,
    channels: channelAnalysis,
    clients: clientAnalysis,
    adminInsights,
    historyInsights,
    logAggregator
  };
}

app.get('/api/history', (req, res) => {
  const historyInsights = buildHistoryInsights(historyBuffer);
  res.json({
    success: true,
    samples: historyBuffer,
    count: historyBuffer.length,
    historyInsights
  });
});

app.delete('/api/history', (req, res) => {
  historyBuffer.length = 0;
  res.json({
    success: true,
    count: 0
  });
});

app.get('/api/health', async (req, res) => {
  try {
    await unifiClient.login();
    const telemetry = buildTelemetryMeta(false);
    res.json({
      status: telemetry.source.includes('mock') ? 'degraded' : 'healthy',
      unifiConnected: !telemetry.source.includes('mock'),
      controller: telemetry.controller,
      site: telemetry.site,
      hostPort: telemetry.hostPort,
      requestTimeoutMs: telemetry.requestTimeoutMs,
      auth: telemetry.auth,
      dataSources: {
        devices: telemetry.devices.source,
        clients: telemetry.clients.source
      },
      cacheAgeMs: telemetry.cacheAgeMs
    });
  } catch (err) {
    const telemetry = buildTelemetryMeta(false);
    res.status(500).json({
      status: 'degraded',
      unifiConnected: false,
      controller: telemetry.controller,
      site: telemetry.site,
      hostPort: telemetry.hostPort,
      requestTimeoutMs: telemetry.requestTimeoutMs,
      auth: telemetry.auth,
      error: err.message
    });
  }
});

app.get('/api/log-aggregate', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const payload = await buildDiagnosticsPayload(force);
    res.json({
      success: true,
      generatedAt: payload.logAggregator.generatedAt,
      telemetry: payload.telemetry,
      text: payload.logAggregator.text
    });
  } catch (err) {
    console.error('[API Error] Log aggregation failed:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to generate the log aggregator output.',
      details: err.message
    });
  }
});

app.get('/api/diagnostics', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const payload = await buildDiagnosticsPayload(force);
    res.json(payload);
  } catch (err) {
    console.error('[API Error] Diagnostics compilation failed:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to compile network diagnostics from UniFi Controller.',
      details: err.message
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  console.log('=== UniFi Diagnostics System Startup ===');
  try {
    await unifiClient.login();
    console.log('[Startup] Connection to UniFi Controller verified successfully!');
  } catch (err) {
    console.warn(`[Startup Warning] Could not connect to UniFi Controller: ${err.message}`);
    console.warn('[Startup Warning] Server will start but API requests may fail until connection is restored.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n[Server] Network Health dashboard is running!');
    console.log(`[Server] Local URL:   http://localhost:${PORT}`);
    console.log(`[Server] Network URL: http://0.0.0.0:${PORT}`);
    console.log(`[Server] Suggested host port: ${config.server.hostPort}`);
    console.log('========================================');
  });
}

startServer();

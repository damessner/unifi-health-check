'use strict';

/**
 * xlsxExporter.js
 *
 * Generates a multi-sheet XLSX optimization report from live diagnostics data.
 *
 * Uses the CONSTRAINED JOINT-BAND BATCH OPTIMIZER (services/optimizer.js) which:
 *   - Treats each AP's 2.4GHz and 5GHz radios as a joint unit
 *   - Limits changes to a configurable number per round (default 8 APs)
 *   - Uses physical proximity to minimize co-channel interference
 *   - Provides before/after improvement estimates
 *   - Supports incremental "fix worst, re-scan, repeat" workflow
 */

const ExcelJS = require('exceljs');
const { runConstrainedOptimizer } = require('./optimizer');

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  // Fills
  fHeader:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A252F' } },
  fSubHdr:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } },
  fRed:      { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0392B' } },
  fOrange:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE67E22' } },
  fYellow:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1C40F' } },
  fGreen:    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } },
  fBlue:     { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2980B9' } },
  fPurple:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8E44AD' } },
  fGray:     { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDC3C7' } },
  // Fonts
  fntWhiteBold: { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } },
  fntTitle:     { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } },
  fntNormal:    { name: 'Calibri', size: 10 },
  // Alignment
  center: { horizontal: 'center', vertical: 'middle', wrapText: true },
  left:   { horizontal: 'left',   vertical: 'middle', wrapText: true },
  // Border
  thin: {
    top:    { style: 'thin', color: { argb: 'FF7F8C8D' } },
    left:   { style: 'thin', color: { argb: 'FF7F8C8D' } },
    bottom: { style: 'thin', color: { argb: 'FF7F8C8D' } },
    right:  { style: 'thin', color: { argb: 'FF7F8C8D' } },
  }
};

function pctFill(v) {
  if (v >= 50) return S.fRed;
  if (v >= 30) return S.fOrange;
  if (v >= 15) return S.fYellow;
  return S.fGreen;
}

function healthFill(h) {
  return { critical: S.fRed, warning: S.fOrange, healthy: S.fGreen }[h] || S.fGray;
}

function applyHeader(cell, value, fill) {
  cell.value = value;
  cell.font = S.fntWhiteBold;
  cell.fill = fill || S.fHeader;
  cell.alignment = S.center;
  cell.border = S.thin;
}

function applyCell(cell, value, fill) {
  cell.value = value;
  cell.font = S.fntNormal;
  cell.alignment = S.center;
  cell.border = S.thin;
  if (fill) cell.fill = fill;
}

// ── Build APs model from radios (same logic as server.buildApsModel) ─────────
function buildApsFromRadios(radios) {
  const map = {};
  radios.forEach(r => {
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

// ── Improvement Report Sheet ──────────────────────────────────────────────────

function buildImprovementSheet(wb, improvementReport, batchSummary) {
  const ws = wb.addWorksheet('Improvement Report');

  ws.mergeCells('A1:C1');
  const title = ws.getCell('A1');
  title.value = `Optimization Improvement Report  •  ${new Date().toLocaleString('de-AT')}`;
  title.font = S.fntTitle; title.fill = S.fHeader; title.alignment = S.center;
  ws.getRow(1).height = 28;

  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 16;

  const addRow = (rowNum, label, beforeVal, afterVal, deltaVal, labelFill) => {
    const row = ws.getRow(rowNum);
    const c1 = row.getCell(1); c1.value = label; c1.font = S.fntWhiteBold;
    c1.fill = labelFill || S.fSubHdr; c1.border = S.thin; c1.alignment = S.left;
    const c2 = row.getCell(2); c2.value = beforeVal; c2.font = S.fntNormal;
    c2.border = S.thin; c2.alignment = S.center;
    const c3 = row.getCell(3); c3.value = deltaVal; c3.font = S.fntWhiteBold;
    c3.border = S.thin; c3.alignment = S.center;
    c3.fill = typeof deltaVal === 'number' && deltaVal > 0 ? S.fGreen :
              typeof deltaVal === 'number' && deltaVal < 0 ? S.fRed : S.fGray;
    row.height = 20;
  };

  let r = 2;
  ws.mergeCells(`A${r}:C${r}`);
  const sub = ws.getCell(`A${r}`);
  sub.value = 'Estimated impact of applying this batch of channel changes';
  sub.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FFFFFFFF' } };
  sub.fill = S.fSubHdr; sub.alignment = S.center;
  r++;

  const { before, after, deltas, estimatedImprovementPct } = improvementReport;

  addRow(r++, '── Channel Utilization ──', 'BEFORE', 'DELTA');
  addRow(r++, '  Avg 2.4GHz Utilization', `${before.avgCu24}%`, `${deltas.avgCu24Delta > 0 ? '↓' : ''}${deltas.avgCu24Delta}%`);
  addRow(r++, '  Max 2.4GHz Utilization', `${before.maxCu24}%`, `${deltas.maxCu24Delta > 0 ? '↓' : ''}${deltas.maxCu24Delta}%`);
  addRow(r++, '  Avg 5GHz Utilization', `${before.avgCu5}%`, `${deltas.avgCu5Delta > 0 ? '↓' : ''}${deltas.avgCu5Delta}%`);
  addRow(r++, '  Max 5GHz Utilization', `${before.maxCu5}%`, `${deltas.maxCu5Delta > 0 ? '↓' : ''}${deltas.maxCu5Delta}%`);
  r++;
  addRow(r++, '── Interference ──', 'BEFORE', 'DELTA');
  addRow(r++, '  Total CCI Count', before.totalCci, `${deltas.cciReduction > 0 ? '↓' : ''}${deltas.cciReduction}`);
  addRow(r++, '  Congested Radios', before.congestedCount, `${deltas.congestedReduction > 0 ? '↓' : ''}${deltas.congestedReduction}`);
  addRow(r++, '  Warning Radios', before.warningCount, '—');
  r++;
  addRow(r++, '── Channel Balance ──', 'BEFORE', 'DELTA');
  addRow(r++, '  2.4GHz Variance', before.chVar24, `${deltas.chVar24Delta > 0 ? '↓' : ''}${deltas.chVar24Delta}`);
  addRow(r++, '  5GHz Variance', before.chVar5, `${deltas.chVar5Delta > 0 ? '↓' : ''}${deltas.chVar5Delta}`);
  r++;
  addRow(r++, '── Overall ──', '', '');
  addRow(r++, '  Est. Improvement', '—', `${estimatedImprovementPct}%`, S.fHeader);

  r++;
  const summaryRow = ws.getRow(r);
  ws.mergeCells(`A${r}:C${r}`);
  const sc = summaryRow.getCell(1);
  sc.value = batchSummary.recommendation;
  sc.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF27AE60' } };
  sc.fill = S.fSubHdr; sc.alignment = S.center;
}

// ── Channel Optimization Sheet ────────────────────────────────────────────────

function buildChannelSheet(wb, activeRadios, plan, changedAPs, batchSummary, improvementReport) {
  const ws = wb.addWorksheet('Channel Optimization');
  const now = new Date().toLocaleString('de-AT');

  // Title row
  ws.mergeCells('A1:O1');
  const title = ws.getCell('A1');
  title.value = `Constrained Batch Channel Optimization Plan  •  ${now}`;
  title.font = S.fntTitle; title.fill = S.fHeader; title.alignment = S.center;
  ws.getRow(1).height = 28;

  // Subtitle
  ws.mergeCells('A2:O2');
  const sub = ws.getCell('A2');
  sub.value = `BATCH MODE: ${changedAPs.length} APs selected for change (max ${batchSummary.maxChanges} per round). ` +
    `Fix these first, then re-scan and re-run to get the next batch. ${improvementReport.estimatedImprovementPct}% estimated improvement.`;
  sub.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FFFFFFFF' } };
  sub.fill = S.fSubHdr; sub.alignment = S.center;
  ws.getRow(2).height = 15;

  // Column definitions
  const cols = [
    { header: '#',            key: 'rank',    width: 5  },
    { header: 'Batch',        key: 'batch',   width: 7  },
    { header: 'AP Name',      key: 'name',    width: 28 },
    { header: 'Floor',        key: 'floor',   width: 7  },
    { header: 'Model',        key: 'model',   width: 14 },
    { header: 'Band',         key: 'band',    width: 8  },
    { header: 'Current Ch',   key: 'curCh',   width: 12 },
    { header: 'CU Total %',   key: 'cu',      width: 11 },
    { header: 'TX Retry %',   key: 'retry',   width: 11 },
    { header: 'Co-Ch Peers',  key: 'cci',     width: 12 },
    { header: 'Health Score', key: 'score',   width: 13 },
    { header: 'Suggested Ch', key: 'suggest', width: 12 },
    { header: 'Change?',      key: 'change',  width: 9  },
    { header: 'Band Changed', key: 'bandChg', width: 13 },
    { header: 'Health',       key: 'health',  width: 10 },
  ];

  cols.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width;
    applyHeader(ws.getRow(3).getCell(i + 1), col.header);
  });
  ws.getRow(3).height = 22;
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 3 }];

  // Build changed MAC set for quick lookup
  const changedMacSet = new Set(changedAPs.map(c => c.mac));

  // Sort radios: changed APs first (by health score), then unchanged (by CU)
  const sortedRadios = [...activeRadios].sort((a, b) => {
    const aChanged = changedMacSet.has(a.apMac) ? 1 : 0;
    const bChanged = changedMacSet.has(b.apMac) ? 1 : 0;
    if (aChanged !== bChanged) return bChanged - aChanged;

    const aKey = `${a.apMac}_${a.radio}`;
    const bKey = `${b.apMac}_${b.radio}`;
    const aImpact = (plan[aKey] || {}).impact || 0;
    const bImpact = (plan[bKey] || {}).impact || 0;
    return bImpact - aImpact;
  });

  let rankCounter = 0;
  sortedRadios.forEach((r) => {
    const key = `${r.apMac}_${r.radio}`;
    const opt = plan[key] || {};
    const suggest = opt.suggestedChannel || r.channel;
    const changed = opt.changeNeeded;

    rankCounter++;
    const inBatch = changedMacSet.has(r.apMac);

    // Determine which band is changing
    let bandChanged = '—';
    if (changed) {
      const is24 = r.band === '2.4GHz' || r.radio === 'ng';
      bandChanged = is24 ? '2.4 GHz' : '5 GHz';
    }

    // Get floor from the changed APs list
    const apChange = changedAPs.find(c => c.mac === r.apMac);
    const floor = apChange ? apChange.floor : '—';

    const rowData = [
      rankCounter,
      inBatch ? `Batch 1` : '—',
      r.apName, floor, r.model, r.band, r.channel,
      r.cu_total || 0,
      Math.round((r.tx_retries_pct || 0) * 10) / 10,
      r.cci_count || 0,
      opt.impact || 0,
      suggest,
      changed ? 'YES' : 'no',
      bandChanged,
      r.health || '—'
    ];

    const cellFills = [
      inBatch ? S.fBlue : S.fGray,
      inBatch ? S.fBlue : null,
      null, null, null,
      pctFill(r.cu_total || 0),
      pctFill(r.cu_total || 0),
      pctFill(r.tx_retries_pct || 0),
      (r.cci_count || 0) >= 10 ? S.fOrange : S.fGreen,
      opt.impact >= 80 ? S.fRed : opt.impact >= 40 ? S.fOrange : opt.impact >= 15 ? S.fYellow : S.fGray,
      changed ? S.fPurple : S.fGreen,
      changed ? S.fOrange : null,
      changed ? S.fPurple : null,
      healthFill(r.health || '')
    ];

    const row = ws.getRow(rankCounter + 3);
    rowData.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      applyCell(cell, v, cellFills[ci]);
      if (ci === 1) cell.font = { ...S.fntNormal, bold: inBatch, color: inBatch ? { argb: 'FFFFFFFF' } : undefined };
      if (ci === 6 || ci === 7) cell.numFmt = '0.0"%"';
    });
    row.height = 18;
  });

  // Add batch summary row at the bottom
  const summaryStartRow = sortedRadios.length + 5;
  ws.mergeCells(`A${summaryStartRow}:O${summaryStartRow}`);
  const summaryCell = ws.getCell(`A${summaryStartRow}`);
  summaryCell.value = batchSummary.recommendation;
  summaryCell.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF27AE60' } };
  summaryCell.fill = S.fSubHdr; summaryCell.alignment = S.center;
}

// ── Client Issues Sheet ──────────────────────────────────────────────────────

function buildClientSheet(wb, clients) {
  const ws = wb.addWorksheet('Client Issues');

  ws.mergeCells('A1:N1');
  const title = ws.getCell('A1');
  title.value = `Client Connectivity Report  •  ${new Date().toLocaleString('de-AT')}`;
  title.font = S.fntTitle; title.fill = S.fHeader; title.alignment = S.center;
  ws.getRow(1).height = 28;

  const cols = [
    { header: 'Hostname',        width: 18 },
    { header: 'IP',              width: 15 },
    { header: 'Severity',        width: 10 },
    { header: 'AP Name',         width: 28 },
    { header: 'Band',            width: 7  },
    { header: 'Ch',              width: 6  },
    { header: 'Signal (dBm)',    width: 13 },
    { header: 'Satisfaction',    width: 13 },
    { header: 'TX Retry %',      width: 11 },
    { header: 'Roams',           width: 8  },
    { header: 'RX Mbps',         width: 10 },
    { header: 'TX Mbps',         width: 10 },
    { header: 'Data (MB)',        width: 12 },
    { header: 'Issues',          width: 60 },
  ];

  cols.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width;
    applyHeader(ws.getRow(2).getCell(i + 1), col.header);
  });
  ws.getRow(2).height = 22;
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 2 }];

  const sevOrder = { critical: 0, warning: 1, healthy: 2 };
  const sorted = [...clients].sort((a, b) =>
    (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2) ||
    (b.roamCount || 0) - (a.roamCount || 0)
  );

  sorted.forEach((c, idx) => {
    const row = ws.getRow(idx + 3);
    const sev = c.severity || 'healthy';
    const vals = [
      c.hostname || '?',
      c.ip || '—',
      sev.toUpperCase(),
      c.apName || '—',
      c.band || '—',
      c.channel || '—',
      c.signal || '—',
      c.satisfaction || '—',
      Math.round((c.txRetriesPct || 0) * 10) / 10,
      c.roamCount || 0,
      Math.round((c.rxRateKbps || 0) / 1000 * 10) / 10,
      Math.round((c.txRateKbps || 0) / 1000 * 10) / 10,
      Math.round((c.totalBytes  || 0) / 1_048_576 * 10) / 10,
      (c.flags || []).join('; ') || '—',
    ];

    vals.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v;
      cell.font = S.fntNormal;
      cell.border = S.thin;
      cell.alignment = ci === 13 ? S.left : S.center;
      if (ci === 2) { cell.fill = healthFill(sev); cell.font = S.fntWhiteBold; }
      else if (ci === 8) cell.fill = pctFill(v || 0);
    });
    row.height = 18;
  });
}

// ── Summary Sheet ─────────────────────────────────────────────────────────────

function buildSummarySheet(wb, channelSummary, clientSummary, batchSummary, improvementReport) {
  const ws = wb.addWorksheet('Summary');

  ws.mergeCells('A1:B1');
  const t = ws.getCell('A1');
  t.value = `Network Health Summary  •  ${new Date().toLocaleString('de-AT')}`;
  t.font = S.fntTitle; t.fill = S.fHeader; t.alignment = S.center;
  ws.getRow(1).height = 28;

  ws.getColumn(1).width = 36;
  ws.getColumn(2).width = 18;

  const ch5 = channelSummary.channelCounts5 || {};
  const ch24 = channelSummary.channelCounts24 || {};

  const rows = [
    ['── Batch Optimization Info ──', ''],
    [`  APs in this batch`, batchSummary.changesSuggested],
    [`  Max changes per round`, batchSummary.maxChanges],
    [`  Est. Improvement`, `${improvementReport.estimatedImprovementPct}%`],
    [`  Remaining APs to check`, batchSummary.remainingWorstAPs],
    [null, null],
    ['── Channel Health ──', ''],
    ['Total APs',              channelSummary.totalAPs],
    ['Active 2.4GHz Radios',  channelSummary.totalRadios24],
    ['Active 5GHz Radios',    channelSummary.totalRadios5],
    ['Avg Utilization 2.4GHz', `${channelSummary.avgUtil24}%`],
    ['Avg Utilization 5GHz',   `${channelSummary.avgUtil5}%`],
    ['Congested Radios (>=70%)', channelSummary.congestedRadiosCount],
    ['Warning Radios (>=40%)',   channelSummary.warningRadiosCount],
    [null, null],
    ['── Client Health ──', ''],
    ['Total Clients',   clientSummary.totalAllClients],
    ['Critical Clients', clientSummary.criticalCount],
    ['Warning Clients',  clientSummary.warningCount],
    ['Healthy Clients',  clientSummary.healthyCount],
    ['Health Index',    `${clientSummary.healthIndex}%`],
    [null, null],
    ['2.4GHz Channel Distribution', ''],
    ['  CH-1',  ch24['1'] || 0],
    ['  CH-6',  ch24['6'] || 0],
    ['  CH-11', ch24['11'] || 0],
    [null, null],
    ['5GHz Channel Distribution (top)', ''],
    ['  CH-36',  ch5['36'] || 0],
    ['  CH-40',  ch5['40'] || 0],
    ['  CH-44',  ch5['44'] || 0],
    ['  CH-52',  ch5['52'] || 0],
    ['  CH-60',  ch5['60'] || 0],
    ['  CH-108', ch5['108'] || 0],
    ['  CH-116', ch5['116'] || 0],
    ['  CH-136', ch5['136'] || 0],
  ];

  let rowNum = 2;
  rows.forEach((pair) => {
    const row = ws.getRow(rowNum++);
    if (!pair[0]) { row.height = 8; return; }
    const k = row.getCell(1);
    const v = row.getCell(2);
    k.value = pair[0]; k.font = S.fntWhiteBold;
    k.fill = pair[0] && pair[0].startsWith('──') ? S.fHeader : S.fSubHdr;
    k.border = S.thin; k.alignment = S.left;
    v.value = pair[1]; v.font = S.fntNormal;
    v.border = S.thin; v.alignment = S.center;
    row.height = 18;
  });
}

// ── Main export function ──────────────────────────────────────────────────────
/**
 * @param {object} diagnosticsData - Full response from /api/diagnostics
 * @param {object} [options] - Optimizer options { maxChanges, minImprovementThreshold }
 * @returns {Promise<Buffer>} XLSX file as a Buffer
 */
async function generateXlsx(diagnosticsData, options = {}) {
  const radios         = (diagnosticsData.channels || {}).radios || [];
  const channelSummary = (diagnosticsData.channels || {}).summary || {};
  const clients        = (diagnosticsData.clients  || {}).clients || [];
  const clientSummary  = (diagnosticsData.clients  || {}).summary || {};
  const aps            = diagnosticsData.aps || buildApsFromRadios(radios);

  // Run the constrained batch optimizer
  const result = runConstrainedOptimizer(radios, channelSummary, aps, options);
  const { plan, changedAPs, batchSummary, improvementReport } = result;

  // Flatten all radios into the "active" list the sheet builder expects
  const activeRadios = radios.filter(r => r.channel);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'UniFi Health Analyzer';
  wb.created = new Date();

  buildChannelSheet(wb, activeRadios, plan, changedAPs, batchSummary, improvementReport);
  buildClientSheet(wb, clients);
  buildSummarySheet(wb, channelSummary, clientSummary, batchSummary, improvementReport);
  buildImprovementSheet(wb, improvementReport, batchSummary);

  // Stream to buffer
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = { generateXlsx };

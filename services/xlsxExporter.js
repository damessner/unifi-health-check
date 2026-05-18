'use strict';

/**
 * xlsxExporter.js
 *
 * Generates a multi-sheet XLSX optimization report from live diagnostics data.
 *
 * BUTTERFLY-AWARE OPTIMIZER:
 * Uses an iterative greedy algorithm instead of a naive static snapshot.
 * Each channel assignment updates a mutable "virtual load map" so subsequent
 * APs see the cumulative effect of all prior assignments — this naturally
 * simulates cascade / butterfly effects without needing a SAT solver.
 */

const ExcelJS = require('exceljs');

// ── Valid channels ────────────────────────────────────────────────────────────
const CHANNELS_24 = [1, 6, 11];
const CHANNELS_5  = [36, 40, 44, 48, 52, 56, 60, 64,
                     100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140];

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

// ── Impact scoring ────────────────────────────────────────────────────────────
function impactScore(radio) {
  const cu  = radio.cu_total  || 0;
  const ret = radio.tx_retries_pct || 0;
  const cci = radio.cci_count || 1;
  if (!radio.channel) return 0;
  return Math.round(cu * (1 + ret / 100) * (cci / 5) * 10) / 10;
}

// ── Butterfly-aware greedy optimizer ─────────────────────────────────────────
/**
 * Given a list of radios and current channel counts, returns a map of
 * apMac+band → { suggestedChannel, changeNeeded, impactScore }.
 *
 * Algorithm:
 *   1. Sort radios by impact score DESC (highest priority first)
 *   2. Maintain a MUTABLE virtual channel load (copy of real counts)
 *   3. For each radio: pick the valid channel with the lowest virtual load
 *   4. Immediately update the virtual load (+1 new, -1 old)
 *      → every subsequent AP sees the updated state = butterfly effect handled
 */
function runOptimizer(radios, channelSummary) {
  // Deep copy channel counts to avoid mutating the real summary
  const vLoad24 = Object.assign({}, channelSummary.channelCounts24 || {});
  const vLoad5  = Object.assign({}, channelSummary.channelCounts5  || {});

  const activeRadios = radios
    .filter(r => r.channel)
    .map(r => ({ ...r, _impact: impactScore(r) }))
    .sort((a, b) => b._impact - a._impact);

  const result = {};

  for (const r of activeRadios) {
    const is24 = r.band === '2.4GHz';
    const validCh = is24 ? CHANNELS_24 : CHANNELS_5;
    const vLoad   = is24 ? vLoad24     : vLoad5;

    // Find channel with minimum virtual load
    const bestCh = validCh.reduce((best, ch) => {
      return (vLoad[ch] || 0) < (vLoad[best] || 0) ? ch : best;
    });

    const key = `${r.apMac}_${r.radio}`;
    result[key] = {
      suggestedChannel: bestCh,
      changeNeeded: bestCh !== r.channel,
      impact: r._impact,
    };

    // Cascade: update virtual load so the next AP sees this change
    vLoad[r.channel] = Math.max(0, (vLoad[r.channel] || 0) - 1);
    vLoad[bestCh]    = (vLoad[bestCh] || 0) + 1;
  }

  return { plan: result, activeRadios };
}

// ── Sheet builders ────────────────────────────────────────────────────────────

function buildChannelSheet(wb, activeRadios, plan, summary) {
  const ws = wb.addWorksheet('Channel Optimization');
  const now = new Date().toLocaleString('de-AT');

  // Title row
  ws.mergeCells('A1:M1');
  const title = ws.getCell('A1');
  title.value = `Tailored Optimal Network Channel Grid Blueprint  •  ${now}`;
  title.font = S.fntTitle; title.fill = S.fHeader; title.alignment = S.center;
  ws.getRow(1).height = 28;

  // Subtitle
  ws.mergeCells('A2:M2');
  const sub = ws.getCell('A2');
  sub.value = 'BUTTERFLY-AWARE: each suggestion accounts for all prior assignments in this session. ' +
    'Fix top rows first — they cause ~80% of interference (20-80 rule).';
  sub.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FFFFFFFF' } };
  sub.fill = S.fSubHdr; sub.alignment = S.center;
  ws.getRow(2).height = 15;

  // Column definitions
  const cols = [
    { header: '#',             key: 'rank',    width: 5  },
    { header: 'AP Name',       key: 'name',    width: 30 },
    { header: 'IP',            key: 'ip',      width: 14 },
    { header: 'Model',         key: 'model',   width: 14 },
    { header: 'Band',          key: 'band',    width: 8  },
    { header: 'Current Ch',    key: 'curCh',   width: 11 },
    { header: 'CU Total %',    key: 'cu',      width: 11 },
    { header: 'TX Retry %',    key: 'retry',   width: 11 },
    { header: 'Co-Ch Peers',   key: 'cci',     width: 12 },
    { header: 'Impact Score',  key: 'impact',  width: 13 },
    { header: 'Suggested Ch',  key: 'suggest', width: 12 },
    { header: 'Change?',       key: 'change',  width: 9  },
    { header: 'Health',        key: 'health',  width: 10 },
  ];

  cols.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width;
    applyHeader(ws.getRow(3).getCell(i + 1), col.header);
  });
  ws.getRow(3).height = 22;
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 3 }];

  activeRadios.forEach((r, idx) => {
    const key = `${r.apMac}_${r.radio}`;
    const opt = plan[key] || {};
    const row = ws.getRow(idx + 4);
    const suggest = opt.suggestedChannel || r.channel;
    const changed = opt.changeNeeded;

    const rowData = [
      idx + 1, r.apName, r.ip, r.model, r.band, r.channel,
      r.cu_total || 0,
      Math.round((r.tx_retries_pct || 0) * 10) / 10,
      r.cci_count || 0,
      r._impact,
      suggest,
      changed ? 'YES' : 'no',
      r.health || '—'
    ];

    const cellFills = [
      null, null, null, null, null,
      pctFill(r.cu_total || 0),
      pctFill(r.cu_total || 0),
      pctFill(r.tx_retries_pct || 0),
      (r.cci_count || 0) >= 10 ? S.fOrange : S.fGreen,
      r._impact >= 80 ? S.fRed : r._impact >= 40 ? S.fOrange : r._impact >= 15 ? S.fYellow : S.fGray,
      changed ? S.fBlue : S.fGreen,
      changed ? S.fOrange : null,
      healthFill(r.health || '')
    ];

    rowData.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      applyCell(cell, v, cellFills[ci]);
      if (ci === 6 || ci === 7) cell.numFmt = '0.0"%"';
    });
    row.height = 18;
  });
}

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

function buildSummarySheet(wb, channelSummary, clientSummary) {
  const ws = wb.addWorksheet('Summary');

  ws.mergeCells('A1:B1');
  const t = ws.getCell('A1');
  t.value = `Network Health Summary  •  ${new Date().toLocaleString('de-AT')}`;
  t.font = S.fntTitle; t.fill = S.fHeader; t.alignment = S.center;
  ws.getRow(1).height = 28;

  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 18;

  const ch5 = channelSummary.channelCounts5 || {};
  const ch24 = channelSummary.channelCounts24 || {};

  const rows = [
    ['Total APs',              channelSummary.totalAPs],
    ['Active 2.4GHz Radios',  channelSummary.totalRadios24],
    ['Active 5GHz Radios',    channelSummary.totalRadios5],
    ['Avg Utilization 2.4GHz', `${channelSummary.avgUtil24}%`],
    ['Avg Utilization 5GHz',   `${channelSummary.avgUtil5}%`],
    ['Congested Radios (≥70%)', channelSummary.congestedRadiosCount],
    ['Warning Radios (≥40%)',   channelSummary.warningRadiosCount],
    [null, null],
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

  rows.forEach((pair, i) => {
    const row = ws.getRow(i + 2);
    if (!pair[0]) { row.height = 8; return; }
    const k = row.getCell(1);
    const v = row.getCell(2);
    k.value = pair[0]; k.font = S.fntWhiteBold; k.fill = S.fSubHdr;
    k.border = S.thin; k.alignment = S.left;
    v.value = pair[1]; v.font = S.fntNormal;
    v.border = S.thin; v.alignment = S.center;
    row.height = 18;
  });
}

// ── Main export function ──────────────────────────────────────────────────────
/**
 * @param {object} diagnosticsData - Full response from /api/diagnostics
 * @returns {Promise<Buffer>} XLSX file as a Buffer
 */
async function generateXlsx(diagnosticsData) {
  const radios         = (diagnosticsData.channels || {}).radios || [];
  const channelSummary = (diagnosticsData.channels || {}).summary || {};
  const clients        = (diagnosticsData.clients  || {}).clients || [];
  const clientSummary  = (diagnosticsData.clients  || {}).summary || {};

  // Run the butterfly-aware optimizer
  const { plan, activeRadios } = runOptimizer(radios, channelSummary);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'UniFi Health Analyzer';
  wb.created = new Date();

  buildChannelSheet(wb, activeRadios, plan, channelSummary);
  buildClientSheet(wb, clients);
  buildSummarySheet(wb, channelSummary, clientSummary);

  // Stream to buffer
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = { generateXlsx };

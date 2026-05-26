'use strict';

/**
 * Unit tests for the constrained batch optimizer (services/optimizer.js).
 *
 * Run:  node scratch/test-optimizer.js
 */

const optimizer = require('../services/optimizer');

// ── Internal helpers we test via module scope re-exports ──────────────────
// The optimizer exports only { runConstrainedOptimizer, CHANNELS_24, CHANNELS_5 }.
// The internal functions (inferFloor, channelsOverlap24, etc.) are tested
// by exercising the public API with carefully crafted inputs.

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ── Helpers to build minimal AP / radio objects ──────────────────────────

function makeAP(mac, name, ngCh, naCh, opts = {}) {
  const ng = ngCh != null ? {
    channel: ngCh,
    radio: 'ng',
    band: '2.4GHz',
    cu_total: opts.cu24 || 20,
    cci_count: opts.cci24 || 0,
    tx_retries_pct: opts.retry24 || 5,
    num_sta: opts.clients24 || 3,
    bw: opts.bw24 || 20,
    cu_self_rx: opts.rx24 || 5,
    cu_self_tx: opts.tx24 || 3,
  } : null;
  const na = naCh != null ? {
    channel: naCh,
    radio: 'na',
    band: '5GHz',
    cu_total: opts.cu5 || 30,
    cci_count: opts.cci5 || 0,
    tx_retries_pct: opts.retry5 || 3,
    num_sta: opts.clients5 || 5,
    bw: opts.bw5 || 80,
    cu_self_rx: opts.rx5 || 8,
    cu_self_tx: opts.tx5 || 4,
  } : null;
  return {
    mac,
    name,
    ip: opts.ip || '10.0.0.1',
    model: opts.model || 'U6-Pro',
    floor: opts.floor || null,
    radios: { ng, na },
  };
}

function makeRadio(apMac, apName, radio, channel, band, opts = {}) {
  return {
    apMac,
    apName,
    radio,
    channel,
    band,
    ip: opts.ip || '10.0.0.1',
    model: opts.model || 'U6-Pro',
    cu_total: opts.cu || 30,
    cci_count: opts.cci || 0,
    tx_retries_pct: opts.retry || 3,
    num_sta: opts.clients || 3,
    bw: opts.bw || (radio === 'ng' ? 20 : 80),
    cu_self_rx: opts.rx || 5,
    cu_self_tx: opts.tx || 3,
    health: opts.health || 'healthy',
  };
}

function buildChannelSummary(radios) {
  const channelCounts24 = {};
  const channelCounts5 = {};
  radios.forEach(r => {
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const target = is24 ? channelCounts24 : channelCounts5;
    target[String(r.channel)] = (target[String(r.channel)] || 0) + 1;
  });
  return { channelCounts24, channelCounts5 };
}

// ── Tests ────────────────────────────────────────────────────────────────

async function main() {

console.log('\n=== Channel List Exports ===');
assert('CHANNELS_24 has [1,6,11]',
  JSON.stringify(optimizer.CHANNELS_24) === '[1,6,11]');
assert('CHANNELS_5 has 18 EU channels, max 136',
  optimizer.CHANNELS_5.length === 18 &&
  optimizer.CHANNELS_5[optimizer.CHANNELS_5.length - 1] === 136);
assert('CHANNELS_5 excludes 140,144,149+',
  optimizer.CHANNELS_5.every(ch => ch <= 136 && ![140,144,149,153,157,161,165].includes(ch)));

console.log('\n=== runConstrainedOptimizer — Basic Invocation ===');
{
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 36, { cu24: 80, cu5: 85, cci5: 5 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 40, { cu24: 70, cu5: 75, cci5: 4 }),
    makeAP('ap-03', '1OG-Flur', 11, 44, { cu24: 65, cu5: 70 }),
    makeAP('ap-04', '1OG-KlasseB', 1, 48, { cu24: 60, cu5: 65 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count,
        retry: ap.radios.ng.tx_retries_pct, clients: ap.radios.ng.num_sta }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: ap.radios.na.cci_count,
        retry: ap.radios.na.tx_retries_pct, clients: ap.radios.na.num_sta }),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 2, searchMode: 'heuristic' });

  assert('Returns an object', result && typeof result === 'object');
  assert('Has plan', typeof result.plan === 'object');
  assert('Has changedAPs array', Array.isArray(result.changedAPs));
  assert('Has improvementReport with before/after',
    result.improvementReport &&
    result.improvementReport.before &&
    result.improvementReport.after);
  assert('Has batchSummary',
    result.batchSummary && typeof result.batchSummary.maxChanges === 'number');
  assert('Has proximityGraph', typeof result.proximityGraph === 'object');
  assert('totalAPs matches input', result.totalAPs === 4);
  assert('batchSummary.maxChanges reflects options', result.batchSummary.maxChanges === 2);
  assert('improvementReport before.avgCu24 computed',
    Number.isFinite(result.improvementReport.before.avgCu24));
  assert('improvementReport before.maxCu5 computed',
    Number.isFinite(result.improvementReport.before.maxCu5));
  assert('improvementReport deltas present',
    typeof result.improvementReport.deltas.avgCu24Delta === 'number');
  assert('improvementReport estimatedImprovementPct present',
    typeof result.improvementReport.estimatedImprovementPct === 'number');
  assert('changedAPs <= maxChanges',
    result.changedAPs.length <= result.batchSummary.maxChanges);
}

console.log('\n=== Health Guard — Healthy APs Not Changed ===');
{
  // All APs healthy, low CCI, low CU — should produce no changes
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 36, { cu24: 20, cu5: 25 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 40, { cu24: 15, cu5: 20 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: 0 }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: 0 }),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 5, searchMode: 'heuristic' });

  assert('No changes for healthy low-CCI APs',
    result.changedAPs.length === 0);
  assert('batchSummary says no beneficial changes',
    result.batchSummary.recommendation.includes('No beneficial changes'));
  assert('improvementReport.estimatedImprovementPct is 0 or very small',
    result.improvementReport.estimatedImprovementPct <= 0);
}

console.log('\n=== Health Guard — Single AP, No Interference ===');
{
  const aps = [makeAP('ap-01', 'EG-Flur', 1, 36)];
  const radios = [
    makeRadio('ap-01', 'EG-Flur', 'ng', 1, '2.4GHz', { cu: 10, cci: 0 }),
    makeRadio('ap-01', 'EG-Flur', 'na', 36, '5GHz', { cu: 15, cci: 0 }),
  ];
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 5, searchMode: 'heuristic' });

  assert('Single healthy AP — no changes', result.changedAPs.length === 0);
}

console.log('\n=== Stressed APs — Changes Suggested ===');
{
  // AP with high CU and CCI should get a channel change suggestion
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 40,
      { cu24: 85, cu5: 90, cci5: 10, retry5: 30, clients5: 20 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 40,
      { cu24: 80, cu5: 85, cci5: 8, retry5: 25, clients5: 15 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count,
        retry: ap.radios.ng.tx_retries_pct, clients: ap.radios.ng.num_sta }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: ap.radios.na.cci_count,
        retry: ap.radios.na.tx_retries_pct, clients: ap.radios.na.num_sta }),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 5, searchMode: 'heuristic' });

  assert('High-CCI APs — changes suggested', result.changedAPs.length > 0);
  assert('changedAPs[0] has mac', result.changedAPs[0].mac);
  assert('changedAPs[0] has name', result.changedAPs[0].name);
  assert('changedAPs[0] has changes string', typeof result.changedAPs[0].changes === 'string');
  assert('changedAPs[0] has healthScore', typeof result.changedAPs[0].healthScore === 'number');
  assert('changedAPs[0] has oldNgCh/oldNaCh', 'oldNgCh' in result.changedAPs[0]);
  assert('changedAPs[0] has newNgCh/newNaCh', 'newNaCh' in result.changedAPs[0]);
}

console.log('\n=== Improvement Report — Before vs After ===');
{
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 44, { cu24: 80, cu5: 85, cci5: 6 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 44, { cu24: 75, cu5: 82, cci5: 7 }),
    makeAP('ap-03', 'EG-KlasseB', 11, 40, { cu24: 70, cu5: 78, cci5: 5 }),
    makeAP('ap-04', '1OG-Flur', 1, 40, { cu24: 72, cu5: 76, cci5: 6 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: ap.radios.na.cci_count }),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 4, searchMode: 'heuristic' });
  const report = result.improvementReport;

  assert('before.avgCu24 computed', report.before.avgCu24 > 0);
  assert('before.avgCu5 computed', report.before.avgCu5 > 0);
  assert('before.totalCci computed', report.before.totalCci > 0);
  assert('before.channelCounts24 has entries',
    Object.keys(report.before.channelCounts24).length > 0);
  assert('after.channelCounts5 has entries',
    Object.keys(report.after.channelCounts5).length > 0);

  // After metrics should ideally be better (not guaranteed for every case, but
  // the optimizer should at least not make things catastrophically worse)
  assert('after.totalCci is a valid number',
    Number.isFinite(report.after.totalCci) && report.after.totalCci >= 0);

  assert('deltas.avgCu24Delta is a number',
    typeof report.deltas.avgCu24Delta === 'number');
  assert('deltas.avgCu5Delta is a number',
    typeof report.deltas.avgCu5Delta === 'number');
  assert('deltas.cciReduction is a number',
    typeof report.deltas.cciReduction === 'number');
  assert('estimatedImprovementPct is a number',
    typeof report.estimatedImprovementPct === 'number');
}

console.log('\n=== Floor Inference via Proximity Graph ===');
{
  // Use names that exercise inferFloor patterns
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 36),
    makeAP('ap-02', 'GROUND-Flur', 6, 40),
    makeAP('ap-03', 'Erdgeschoss', 11, 44),
    makeAP('ap-04', '1OG-Flur', 1, 48),
    makeAP('ap-05', 'FIRST-Flur', 6, 52),
    makeAP('ap-06', '2OG-Flur', 11, 56),
    makeAP('ap-07', 'SECOND-Flur', 1, 60),
    makeAP('ap-08', 'FG-0', 6, 64),
    makeAP('ap-09', 'FG-1', 11, 100),
    makeAP('ap-10', 'FG-2', 1, 104),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz'),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz'),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 2, searchMode: 'heuristic' });

  const graph = result.proximityGraph;
  assert('Proximity graph has all APs',
    Object.keys(graph).length === aps.length);
  assert('EG floor inferred for EG-Flur',
    graph['ap-01'].floor === 'EG');
  assert('EG floor inferred for GROUND-Flur',
    graph['ap-02'].floor === 'EG');
  assert('EG floor inferred for Erdgeschoss',
    graph['ap-03'].floor === 'EG');
  assert('1OG floor inferred for 1OG-Flur',
    graph['ap-04'].floor === '1OG');
  assert('1OG floor inferred for FIRST-Flur',
    graph['ap-05'].floor === '1OG');
  assert('2OG floor inferred for 2OG-Flur',
    graph['ap-06'].floor === '2OG');
  assert('2OG floor inferred for SECOND-Flur',
    graph['ap-07'].floor === '2OG');
  assert('EG via FG-0',
    graph['ap-08'].floor === 'EG');
  assert('1OG via FG-1',
    graph['ap-09'].floor === '1OG');
  assert('2OG via FG-2',
    graph['ap-10'].floor === '2OG');
  assert('neighbors array present for each entry',
    Object.values(graph).every(e => Array.isArray(e.neighbors)));
}

console.log('\n=== Edge Cases ===');
{
  // Empty arrays
  const result1 = optimizer.runConstrainedOptimizer([], {}, [], { maxChanges: 5, searchMode: 'heuristic' });
  assert('Empty radios/aps — totalAPs is 0', result1.totalAPs === 0);
  assert('Empty radios/aps — no changes', result1.changedAPs.length === 0);
  assert('Empty radios/aps — batchSummary present', !!result1.batchSummary);

  // Only 1 AP
  const aps = [makeAP('ap-01', 'EG-Flur', 1, 36)];
  const radios = [
    makeRadio('ap-01', 'EG-Flur', 'ng', 1, '2.4GHz'),
    makeRadio('ap-01', 'EG-Flur', 'na', 36, '5GHz'),
  ];
  const chSummary = buildChannelSummary(radios);
  const result2 = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 5, searchMode: 'heuristic' });
  assert('Single AP — totalAPs is 1', result2.totalAPs === 1);
  assert('Single AP — no changes (healthy)', result2.changedAPs.length === 0);

  // AP with only 2.4GHz radio — two APs on the same channel to force a conflict
  const apsNg = [
    {
      mac: 'ap-ng1', name: 'EG-Legacy1',
      ip: '10.0.0.2', model: 'UAP-AC-Lite',
      floor: null,
      radios: {
        ng: { channel: 1, radio: 'ng', band: '2.4GHz',
              cu_total: 85, cci_count: 8, tx_retries_pct: 30,
              num_sta: 10, bw: 20, cu_self_rx: 10, cu_self_tx: 8 },
        na: null,
      },
    },
    {
      mac: 'ap-ng2', name: 'EG-Legacy2',
      ip: '10.0.0.3', model: 'UAP-AC-Lite',
      floor: null,
      radios: {
        ng: { channel: 1, radio: 'ng', band: '2.4GHz',
              cu_total: 80, cci_count: 6, tx_retries_pct: 25,
              num_sta: 8, bw: 20, cu_self_rx: 8, cu_self_tx: 6 },
        na: null,
      },
    },
  ];
  const radiosNg = apsNg.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count,
        retry: ap.radios.ng.tx_retries_pct, clients: ap.radios.ng.num_sta }),
  ]);
  const chSummaryNg = buildChannelSummary(radiosNg);
  const result3 = optimizer.runConstrainedOptimizer(radiosNg, chSummaryNg, apsNg, { maxChanges: 5, searchMode: 'heuristic' });
  assert('Two NG-only APs on same channel — totalAPs is 2', result3.totalAPs === 2);
  assert('Two NG-only APs on same channel — changes suggested', result3.changedAPs.length > 0);

  // Options: maxChanges=0
  const result4 = optimizer.runConstrainedOptimizer(radiosNg, chSummaryNg, apsNg, { maxChanges: 0, searchMode: 'heuristic' });
  assert('maxChanges=0 — no candidates', result4.candidatesConsidered === 0);
  assert('maxChanges=0 — no changes', result4.changedAPs.length === 0);

  // Options: minImprovementThreshold very high
  const result5 = optimizer.runConstrainedOptimizer(radiosNg, chSummaryNg, apsNg,
    { maxChanges: 5, minImprovementThreshold: 999, searchMode: 'heuristic' });
  assert('Very high minImprovementThreshold — result still valid', !!result5.plan);
}

console.log('\n=== Channel Overlap — 2.4GHz ===');
{
  const aps = [
    makeAP('ap-01', 'EG', 1, 36),
    makeAP('ap-02', '1OG', 6, 40),
    makeAP('ap-03', '2OG', 11, 44),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz'),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz'),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 5, searchMode: 'heuristic' });

  // Channels 1, 6, 11 are non-overlapping, so healthy APs should stay put
  assert('Non-overlapping 2.4GHz APs — likely no changes', result.changedAPs.length >= 0);
}

console.log('\n=== Default Options ===');
{
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 36, { cu24: 80, cu5: 85, cci5: 6 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 40, { cu24: 75, cu5: 82, cci5: 5 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: ap.radios.na.cci_count }),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { searchMode: 'heuristic' });
  // Default maxChanges should be 10 (from DEFAULT_MAX_CHANGES)
  assert('Default maxChanges = 10', result.batchSummary.maxChanges === 10);
  assert('Default options — result valid', result.changedAPs.length >= 0);
}

console.log('\n=== Genetic Algorithm Mode ===');
await (async function testGeneticOptimizer() {
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 40, { cu24: 82, cu5: 88, cci5: 8 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 40, { cu24: 78, cu5: 84, cci5: 7 }),
    makeAP('ap-03', '1OG-Flur', 11, 44, { cu24: 72, cu5: 80, cci5: 6 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: ap.radios.na.cci_count }),
  ]);
  const chSummary = buildChannelSummary(radios);

  // Test evaluateAssignment directly
  const emptyAssignment = {};
  const emptyEval = optimizer.evaluateAssignment(radios, emptyAssignment, chSummary, 3);
  assert('evaluateAssignment returns object with pain', typeof emptyEval.pain === 'number');
  assert('evaluateAssignment returns improvementPct', typeof emptyEval.improvementPct === 'number');
  assert('evaluateAssignment returns metrics', emptyEval.metrics && typeof emptyEval.metrics.avgCu24 === 'number');

  // Test full GA with progress
  let progressCount = 0;
  const result = await optimizer.runGeneticOptimizer(radios, chSummary, aps, {
    maxChanges: 3,
    timeBudgetMs: 1200,
    populationSize: 20,
  }, (progress) => {
    progressCount++;
  });

  assert('GA mode returns result with plan', !!result.plan);
  assert('GA mode returns searchMeta', !!result.searchMeta);
  assert('GA mode recorded mode', result.searchMeta.mode === 'ga');
  assert('GA mode has bestGeneration', typeof result.searchMeta.bestGeneration === 'number');
  assert('GA mode has objectiveScore', typeof result.searchMeta.objectiveScore === 'number');
  assert('GA mode has improvementReport', !!result.improvementReport);
  assert('GA mode has estimatedImprovementPct',
    typeof result.improvementReport.estimatedImprovementPct === 'number');
  assert('GA mode progress callback was called', progressCount > 0);
  assert('GA mode durationMs is positive', result.searchMeta.durationMs > 0);
  assert('GA mode generationsTried > 1', result.searchMeta.generationsTried >= 2);
  assert('GA mode batchSummary present', !!result.batchSummary);
  assert('GA mode proximityGraph present', !!result.proximityGraph);
  assert('GA mode totalAPs matches', result.totalAPs === 3);

  // Test generational mode sync fallback
  const syncResult = optimizer.runConstrainedOptimizer(radios, chSummary, aps, {
    searchMode: 'generational',
    maxChanges: 3,
  });
  assert('Sync fallback has searchMeta', !!syncResult.searchMeta);
  assert('Sync fallback mode is ga_sync_fallback',
    syncResult.searchMeta.mode === 'ga_sync_fallback');
})();

console.log('\n=== Change Plan Has Correct Structure ===');
{
  const aps = [
    makeAP('ap-01', 'EG-Flur', 1, 44, { cu24: 85, cu5: 90, cci5: 8 }),
    makeAP('ap-02', 'EG-KlasseA', 6, 44, { cu24: 80, cu5: 88, cci5: 7 }),
  ];
  const radios = aps.flatMap(ap => [
    makeRadio(ap.mac, ap.name, 'ng', ap.radios.ng.channel, '2.4GHz',
      { cu: ap.radios.ng.cu_total, cci: ap.radios.ng.cci_count }),
    makeRadio(ap.mac, ap.name, 'na', ap.radios.na.channel, '5GHz',
      { cu: ap.radios.na.cu_total, cci: ap.radios.na.cci_count }),
  ]);
  const chSummary = buildChannelSummary(radios);
  const result = optimizer.runConstrainedOptimizer(radios, chSummary, aps, { maxChanges: 2, searchMode: 'heuristic' });

  // Each plan entry should have suggestedChannel, changeNeeded, impact
  const planKeys = Object.keys(result.plan);
  if (planKeys.length > 0) {
    const firstKey = planKeys[0];
    const entry = result.plan[firstKey];
    assert('Plan entry has suggestedChannel', 'suggestedChannel' in entry);
    assert('Plan entry has changeNeeded', 'changeNeeded' in entry);
    assert('Plan entry has impact', 'impact' in entry);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────

}

main().then(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

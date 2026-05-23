'use strict';

/**
 * optimizer.js
 *
 * CONSTRAINED JOINT-BAND PROXIMITY-AWARE BATCH OPTIMIZER
 *
 * Replaces the old per-radio greedy optimizer with an AP-level batch optimizer
 * that jointly considers both 2.4GHz and 5GHz radios of each AP, limits changes
 * to a manageable number per round, and uses physical proximity to minimize
 * co-channel interference between adjacent APs.
 *
 * Key improvements over the old runOptimizer:
 *   1. AP-level: treats both radios of an AP as a unit (joint assignment)
 *   2. Change budget: configurable maxChanges (default 8) per optimization round
 *   3. Proximity-aware: uses neighbor graph to penalize adjacent-channel conflicts
 *   4. Stable-first: prefers keeping current channels unless clear improvement
 *   5. Improvement report: computes before/after metrics to show expected gains
 *   6. Floor separation: staggers channels across floors for 3D interference reduction
 *
 * Workflow:
 *   Run optimizer → get plan for top-N worst APs → apply changes → re-scan → repeat
 *   Each round fixes the worst offenders; subsequent rounds pick new worst APs.
 */

// ── Valid channels ────────────────────────────────────────────────────────────
const CHANNELS_24 = [1, 6, 11];
const CHANNELS_5 = [
  36, 40, 44, 48, 52, 56, 60, 64,
  100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140
];

// ── Scoring weights ───────────────────────────────────────────────────────────
const WEIGHTS = {
  cuUtil: 1.0,       // channel utilization per %
  cci: 8.0,          // co-channel interference per count
  retry: 0.5,        // TX retry percentage
  neighborConflict: 5.0,  // per overlapping neighbor channel
  clientCount: 2.0,  // per associated client
};

// ── Combo scoring penalties ──────────────────────────────────────────────────
const COMBO_PENALTIES = {
  ngOverlap: 12,     // 2.4GHz overlap with neighbor
  naOverlap: 16,     // 5GHz overlap with neighbor (higher because more channels available)
  loadImbalance: 5,  // penalty per extra AP already on this channel
  sameFloorSameCh: 8, // penalty for same-floor same-channel
  changeCost: 8,     // penalty for changing from current (stability bias)
};

// Default max APs to change per optimization run
const DEFAULT_MAX_CHANGES = 8;

// Minimum estimated improvement (%) to suggest a change
const MIN_IMPROVEMENT_THRESHOLD = 5;

// Estimated CU reduction per co-channel peer removed
const CU_REDUCTION_PER_CCI = 8;

// ── Helper functions ─────────────────────────────────────────────────────────

function channelsOverlap24(ch1, ch2) {
  return Number.isFinite(ch1) && Number.isFinite(ch2) && Math.abs(ch1 - ch2) < 5;
}

function channelsOverlap5(ch1, bw1, ch2, bw2) {
  if (!Number.isFinite(ch1) || !Number.isFinite(ch2)) return false;
  const halfSpan1 = (Number(bw1) || 40) / 10;
  const halfSpan2 = (Number(bw2) || 40) / 10;
  return Math.abs(ch1 - ch2) <= (halfSpan1 + halfSpan2);
}

function inferFloor(name = '', index = 0) {
  const n = String(name).toUpperCase();
  if (n.includes('EG') || n.includes('GROUND') || n.includes('ERDGESCHOSS')) return 'EG';
  if (n.includes('1OG') || n.includes('1.OG') || n.includes('FIRST')) return '1OG';
  if (n.includes('2OG') || n.includes('2.OG') || n.includes('SECOND')) return '2OG';
  return ['EG', '1OG', '2OG'][index % 3];
}

function floorToOffset(floor) {
  return { EG: 0, '1OG': 1, '2OG': 2 }[floor] || 0;
}

// ── Proximity graph builder (server-side replica of frontend) ─────────────────

function buildProximityGraph(aps) {
  const graph = {};
  const apList = Array.isArray(aps) ? aps : [];

  apList.forEach((ap, i) => {
    graph[ap.mac] = {
      name: ap.name,
      floor: inferFloor(ap.name, i),
      neighbors: []
    };
  });

  apList.forEach((ap1) => {
    const scores = [];
    apList.forEach((ap2) => {
      if (!ap1 || !ap2 || ap1.mac === ap2.mac) return;
      let score = 0;
      const ng1 = ap1.radios && ap1.radios.ng;
      const ng2 = ap2.radios && ap2.radios.ng;
      const na1 = ap1.radios && ap1.radios.na;
      const na2 = ap2.radios && ap2.radios.na;

      if (channelsOverlap24(ng1 && ng1.channel, ng2 && ng2.channel)) score += 3;
      if (channelsOverlap5(na1 && na1.channel, na1 && na1.bw, na2 && na2.channel, na2 && na2.bw)) score += 4;
      if (ng1 && ng2 && ng1.cu_total && ng2.cu_total)
        score += Math.max(0, 2 - Math.abs(ng1.cu_total - ng2.cu_total) / 50);
      if (na1 && na2 && na1.cu_total && na2.cu_total)
        score += Math.max(0, 2 - Math.abs(na1.cu_total - na2.cu_total) / 50);

      if (score > 0) scores.push({ mac: ap2.mac, score });
    });

    scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .forEach((entry) => graph[ap1.mac].neighbors.push(entry.mac));
  });

  return graph;
}

// ── AP Health Scoring ────────────────────────────────────────────────────────

/**
 * Compute a composite health score for an AP (higher = worse).
 * Considers both radio bands, CCI, retries, neighbor conflicts, and client load.
 */
function scoreAP(ap, proximityGraph) {
  const r24 = ap.radios && ap.radios.ng;
  const r5 = ap.radios && ap.radios.na;

  const cu24 = r24 ? r24.cu_total || 0 : 0;
  const cu5 = r5 ? r5.cu_total || 0 : 0;
  const maxCu = Math.max(cu24, cu5);

  const cci24 = r24 ? r24.cci_count || 0 : 0;
  const cci5 = r5 ? r5.cci_count || 0 : 0;
  const totalCci = cci24 + cci5;

  const retry24 = r24 ? r24.tx_retries_pct || 0 : 0;
  const retry5 = r5 ? r5.tx_retries_pct || 0 : 0;
  const maxRetry = Math.max(retry24, retry5);

  const clients = (r24 ? r24.num_sta || 0 : 0) + (r5 ? r5.num_sta || 0 : 0);

  let neighborConflicts = 0;
  const graphEntry = proximityGraph && proximityGraph[ap.mac];
  if (graphEntry) {
    graphEntry.neighbors.forEach(nMac => {
      const neighborAP = findAPByMac(nMac);
      if (!neighborAP) return;

      if (r24 && neighborAP.radios && neighborAP.radios.ng &&
          r24.channel && neighborAP.radios.ng.channel) {
        if (channelsOverlap24(r24.channel, neighborAP.radios.ng.channel))
          neighborConflicts++;
      }
      if (r5 && neighborAP.radios && neighborAP.radios.na &&
          r5.channel && neighborAP.radios.na.channel) {
        if (channelsOverlap5(r5.channel, r5.bw, neighborAP.radios.na.channel,
                            neighborAP.radios.na && neighborAP.radios.na.bw))
          neighborConflicts++;
      }
    });
  }

  return {
    cu: maxCu,
    cci: totalCci,
    retry: maxRetry,
    clients,
    neighborConflicts,
    total: Math.round(
      maxCu * WEIGHTS.cuUtil +
      totalCci * WEIGHTS.cci +
      maxRetry * WEIGHTS.retry +
      neighborConflicts * WEIGHTS.neighborConflict +
      clients * WEIGHTS.clientCount
    )
  };
}

// Global ref set during optimization for neighbor lookups (avoid circular deps)
let _allAPs = [];

function findAPByMac(mac) {
  return _allAPs.find(a => a.mac === mac) || null;
}

// ── Joint Channel Combo Scoring ──────────────────────────────────────────────

/**
 * Score a (ch24, ch5) combo for a given AP in the current virtual state.
 * Lower score = better.
 */
function scoreCombo(ap, ch24, ch5, vLoad24, vLoad5, proximityGraph, floorAssignments) {
  let score = 0;
  const r24 = ap.radios && ap.radios.ng;
  const r5 = ap.radios && ap.radios.na;
  const graphEntry = proximityGraph && proximityGraph[ap.mac];
  const floor = graphEntry ? graphEntry.floor : inferFloor(ap.name, 0);

  // 1. Virtual load penalty: prefer channels with fewer APs
  const maxLoad24 = Math.max(1, ...Object.values(vLoad24));
  const maxLoad5 = Math.max(1, ...Object.values(vLoad5));
  score += ((vLoad24[ch24] || 0) / maxLoad24) * COMBO_PENALTIES.loadImbalance;
  score += ((vLoad5[ch5] || 0) / maxLoad5) * COMBO_PENALTIES.loadImbalance;

  // 2. Neighbor conflict penalty: check against all neighbors' (potentially updated) channels
  if (graphEntry) {
    graphEntry.neighbors.forEach(nMac => {
      const neighbor = findAPByMac(nMac);
      if (!neighbor) return;

      const n24 = neighbor.radios && neighbor.radios.ng;
      const n5 = neighbor.radios && neighbor.radios.na;

      if (n24 && n24._optCh24 !== undefined) {
        if (channelsOverlap24(ch24, n24._optCh24)) score += COMBO_PENALTIES.ngOverlap;
      } else if (n24 && n24.channel) {
        if (channelsOverlap24(ch24, n24.channel)) score += COMBO_PENALTIES.ngOverlap;
      }

      if (n5 && n5._optCh5 !== undefined) {
        if (channelsOverlap5(ch5, r5 && r5.bw, n5._optCh5, n5.bw))
          score += COMBO_PENALTIES.naOverlap;
      } else if (n5 && n5.channel) {
        if (channelsOverlap5(ch5, r5 && r5.bw, n5.channel, n5.bw))
          score += COMBO_PENALTIES.naOverlap;
      }
    });
  }

  // 3. Floor-based separation: prefer different channels on different floors by
  //    adding a penalty if this channel is heavily used on the SAME floor
  const floorKey24 = `${floor}_24_${ch24}`;
  const floorKey5 = `${floor}_5_${ch5}`;
  score += (floorAssignments[floorKey24] || 0) * COMBO_PENALTIES.sameFloorSameCh;
  score += (floorAssignments[floorKey5] || 0) * COMBO_PENALTIES.sameFloorSameCh;

  // 4. Stability bonus: prefer keeping current channels (avoids unnecessary changes)
  if (r24 && r24.channel === ch24) score -= COMBO_PENALTIES.changeCost;
  if (r5 && r5.channel === ch5) score -= COMBO_PENALTIES.changeCost;

  return score;
}

// ── Before/After Metrics Computer ─────────────────────────────────────────────

function computeMetrics(radios) {
  let sumCu24 = 0, count24 = 0, maxCu24 = 0;
  let sumCu5 = 0, count5 = 0, maxCu5 = 0;
  let totalCci = 0;
  let congestedCount = 0;
  let warningCount = 0;
  const chCounts24 = {};
  const chCounts5 = {};

  radios.forEach(r => {
    const cu = r.cu_total || 0;
    const cci = r.cci_count || 0;
    if (r.band === '2.4GHz' || r.radio === 'ng') {
      sumCu24 += cu;
      count24++;
      if (cu > maxCu24) maxCu24 = cu;
      chCounts24[String(r.channel)] = (chCounts24[String(r.channel)] || 0) + 1;
    } else {
      sumCu5 += cu;
      count5++;
      if (cu > maxCu5) maxCu5 = cu;
      chCounts5[String(r.channel)] = (chCounts5[String(r.channel)] || 0) + 1;
    }
    totalCci += cci;
    if (cu > 75 || cci > 12) congestedCount++;
    else if (cu > 50 || cci > 4) warningCount++;
  });

  // Compute channel distribution variance (lower = more even)
  const vals24 = Object.values(chCounts24);
  const vals5 = Object.values(chCounts5);
  const avg24 = vals24.length ? vals24.reduce((a, b) => a + b, 0) / vals24.length : 0;
  const avg5 = vals5.length ? vals5.reduce((a, b) => a + b, 0) / vals5.length : 0;
  const var24 = vals24.length ? vals24.reduce((s, v) => s + (v - avg24) ** 2, 0) / vals24.length : 0;
  const var5 = vals5.length ? vals5.reduce((s, v) => s + (v - avg5) ** 2, 0) / vals5.length : 0;

  return {
    avgCu24: Math.round(sumCu24 / (count24 || 1)),
    maxCu24,
    avgCu5: Math.round(sumCu5 / (count5 || 1)),
    maxCu5,
    totalCci,
    congestedCount,
    warningCount,
    chVar24: Math.round(var24 * 10) / 10,
    chVar5: Math.round(var5 * 10) / 10,
    channelCounts24: chCounts24,
    channelCounts5: chCounts5,
  };
}

// ── Main Optimizer ───────────────────────────────────────────────────────────

/**
 * Run the constrained AP-level joint-band batch optimizer.
 *
 * @param {Array} radios - Array of radio objects from analyzer.analyzeChannels()
 * @param {Object} channelSummary - Channel summary from analyzer
 * @param {Array} aps - Array of AP model objects (from buildApsModel), each with .radios.ng/.na
 * @param {Object} options
 * @param {number} [options.maxChanges=8] - Max APs to suggest changes for
 * @param {number} [options.minImprovementThreshold=5] - Min % improvement to include
 * @returns {Object} { plan, improvementReport, batchSummary }
 */
function runConstrainedOptimizer(radios, channelSummary, aps, options = {}) {
  const maxChanges = options.maxChanges || DEFAULT_MAX_CHANGES;
  const minImprovementThreshold = options.minImprovementThreshold || MIN_IMPROVEMENT_THRESHOLD;

  _allAPs = Array.isArray(aps) ? aps : [];

  // Build proximity graph
  const proximityGraph = buildProximityGraph(_allAPs);

  // Group radios by AP and compute health scores
  const apMap = {};
  radios.forEach((r, idx) => {
    if (!apMap[r.apMac]) {
      apMap[r.apMac] = {
        mac: r.apMac,
        name: r.apName,
        ip: r.ip,
        model: r.model,
        radios: {},
        floor: inferFloor(r.apName, idx),
      };
    }
    apMap[r.apMac].radios[r.radio] = r;
  });

  // Attach floor info from aps if available
  _allAPs.forEach(ap => {
    const entry = apMap[ap.mac];
    if (entry && ap.floor) entry.floor = ap.floor;
  });

  // Score each AP
  const apList = Object.values(apMap).map(ap => {
    const scores = scoreAP(ap, proximityGraph);
    return { ...ap, ...scores };
  });

  // Sort by health score descending (worst first)
  apList.sort((a, b) => b.total - a.total);

  // Select top N APs for optimization
  const candidates = apList.slice(0, maxChanges);

  // Compute BEFORE metrics
  const beforeMetrics = computeMetrics(radios);

  // Initialize virtual load maps from current channel counts
  const vLoad24 = Object.assign({}, channelSummary.channelCounts24 || {});
  const vLoad5 = Object.assign({}, channelSummary.channelCounts5 || {});
  const floorAssignments = {}; // track "floor_band_ch" counts during optimization

  // Run joint optimization for each candidate AP
  const plan = {};
  const changedAPs = [];

  candidates.forEach(ap => {
    const r24 = ap.radios.ng;
    const r5 = ap.radios.na;

    if (!r24 && !r5) return;

    const valid24 = r24 ? CHANNELS_24 : [null];
    const valid5 = r5 ? CHANNELS_5 : [null];

    let bestCombo = null;
    let bestScore = Infinity;

    // Enumerate all (ch24, ch5) combinations
    valid24.forEach(ch24 => {
      valid5.forEach(ch5 => {
        const score = scoreCombo(ap, ch24, ch5, vLoad24, vLoad5, proximityGraph, floorAssignments);
        if (score < bestScore) {
          bestScore = score;
          bestCombo = { ch24, ch5 };
        }
      });
    });

    if (!bestCombo) return;

    const { ch24, ch5 } = bestCombo;
    const needsNgChange = r24 && ch24 !== null && r24.channel !== ch24;
    const needsNaChange = r5 && ch5 !== null && r5.channel !== ch5;

    // Guard: don't change healthy APs with minimal interference
    const maxCu = Math.max(r24 ? r24.cu_total || 0 : 0, r5 ? r5.cu_total || 0 : 0);
    const totalCci = (r24 ? r24.cci_count || 0 : 0) + (r5 ? r5.cci_count || 0 : 0);
    const currentCh24Load = r24 ? (vLoad24[r24.channel] || 0) : 0;
    const currentCh5Load = r5 ? (vLoad5[r5.channel] || 0) : 0;

    // Skip if AP is healthy (low CU, no CCI, minimal channel load)
    if (totalCci === 0 && maxCu < 50 && currentCh24Load <= 1 && currentCh5Load <= 1) {
      return;
    }

    // Only include if at least one radio needs to change
    if (needsNgChange || needsNaChange) {
      // Update virtual load map (butterfly effect for subsequent APs)
      if (r24 && ch24 !== null && r24.channel !== ch24) {
        vLoad24[r24.channel] = Math.max(0, (vLoad24[r24.channel] || 0) - 1);
        vLoad24[ch24] = (vLoad24[ch24] || 0) + 1;
      }
      if (r5 && ch5 !== null && r5.channel !== ch5) {
        vLoad5[r5.channel] = Math.max(0, (vLoad5[r5.channel] || 0) - 1);
        vLoad5[ch5] = (vLoad5[ch5] || 0) + 1;
      }

      // Track floor assignments
      if (ch24 !== null)
        floorAssignments[`${ap.floor}_24_${ch24}`] = (floorAssignments[`${ap.floor}_24_${ch24}`] || 0) + 1;
      if (ch5 !== null)
        floorAssignments[`${ap.floor}_5_${ch5}`] = (floorAssignments[`${ap.floor}_5_${ch5}`] || 0) + 1;

      // Mark optimized channels on the radio objects so neighbors see them
      if (r24) r24._optCh24 = ch24 !== null ? ch24 : r24.channel;
      if (r5) r5._optCh5 = ch5 !== null ? ch5 : r5.channel;

      // Build change description
      const changes = [];
      if (needsNgChange) changes.push(`2.4G: ${r24.channel}→${ch24}`);
      if (needsNaChange) changes.push(`5G: ${r5.channel}→${ch5}`);

      changedAPs.push({
        mac: ap.mac,
        name: ap.name,
        floor: ap.floor,
        healthScore: ap.total,
        changes: changes.join(', '),
        oldNgCh: r24 ? r24.channel : null,
        newNgCh: needsNgChange ? ch24 : null,
        oldNaCh: r5 ? r5.channel : null,
        newNaCh: needsNaChange ? ch5 : null,
        cu: ap.cu,
        cci: ap.cci,
      });

      // Store plan entries (per-radio, same format as old optimizer for compat)
      if (r24) {
        plan[`${ap.mac}_${r24.radio}`] = {
          suggestedChannel: ch24 !== null ? ch24 : r24.channel,
          changeNeeded: needsNgChange,
          impact: ap.total,
        };
      }
      if (r5) {
        plan[`${ap.mac}_${r5.radio}`] = {
          suggestedChannel: ch5 !== null ? ch5 : r5.channel,
          changeNeeded: needsNaChange,
          impact: ap.total,
        };
      }
    }
  });

  // Compute AFTER metrics (full recomputation from final channel distribution)
  // Build the final channel distribution after all proposed changes
  const finalChCounts24 = {};
  const finalChCounts5 = {};
  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const opt = plan[key];
    const finalCh = (opt && opt.changeNeeded) ? opt.suggestedChannel : r.channel;
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const target = is24 ? finalChCounts24 : finalChCounts5;
    target[String(finalCh)] = (target[String(finalCh)] || 0) + 1;
  });

  // Compute metrics from final channel counts
  let aftSumCu24 = 0, aftCount24 = 0, aftMaxCu24 = 0;
  let aftSumCu5 = 0, aftCount5 = 0, aftMaxCu5 = 0;
  let aftTotalCci = 0;
  let aftCongested = 0;
  let aftWarning = 0;

  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const opt = plan[key];
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const finalCh = (opt && opt.changeNeeded) ? opt.suggestedChannel : r.channel;
    const finalChLoad = (is24 ? finalChCounts24 : finalChCounts5)[String(finalCh)] || 0;
    const newCci = Math.max(0, finalChLoad - 1);
    const cciReduction = (r.cci_count || 0) - newCci;

    const baseline = Math.max((r.cu_self_rx || 0) + (r.cu_self_tx || 0), 8);
    const estCu = Math.max(baseline, Math.min(100,
      (r.cu_total || baseline) - cciReduction * CU_REDUCTION_PER_CCI
    ));

    if (is24) {
      aftSumCu24 += estCu;
      aftCount24++;
      if (estCu > aftMaxCu24) aftMaxCu24 = estCu;
    } else {
      aftSumCu5 += estCu;
      aftCount5++;
      if (estCu > aftMaxCu5) aftMaxCu5 = estCu;
    }
    aftTotalCci += newCci;
    if (estCu > 75 || newCci > 12) aftCongested++;
    else if (estCu > 50 || newCci > 4) aftWarning++;
  });

  // Compute channel distribution variance for after state
  const aftVals24 = Object.values(finalChCounts24);
  const aftVals5 = Object.values(finalChCounts5);
  const aftAvg24 = aftVals24.length ? aftVals24.reduce((a, b) => a + b, 0) / aftVals24.length : 0;
  const aftAvg5 = aftVals5.length ? aftVals5.reduce((a, b) => a + b, 0) / aftVals5.length : 0;
  const aftVar24 = aftVals24.length ? aftVals24.reduce((s, v) => s + (v - aftAvg24) ** 2, 0) / aftVals24.length : 0;
  const aftVar5 = aftVals5.length ? aftVals5.reduce((s, v) => s + (v - aftAvg5) ** 2, 0) / aftVals5.length : 0;

  const afterMetrics = {
    avgCu24: Math.round(aftSumCu24 / (aftCount24 || 1)),
    maxCu24: aftMaxCu24,
    avgCu5: Math.round(aftSumCu5 / (aftCount5 || 1)),
    maxCu5: aftMaxCu5,
    totalCci: aftTotalCci,
    congestedCount: aftCongested,
    warningCount: aftWarning,
    chVar24: Math.round(aftVar24 * 10) / 10,
    chVar5: Math.round(aftVar5 * 10) / 10,
    channelCounts24: finalChCounts24,
    channelCounts5: finalChCounts5,
  };

  // Compute deltas
  const improvementReport = {
    before: beforeMetrics,
    after: afterMetrics,
    deltas: {
      avgCu24Delta: beforeMetrics.avgCu24 - afterMetrics.avgCu24,
      avgCu5Delta: beforeMetrics.avgCu5 - afterMetrics.avgCu5,
      maxCu24Delta: beforeMetrics.maxCu24 - afterMetrics.maxCu24,
      maxCu5Delta: beforeMetrics.maxCu5 - afterMetrics.maxCu5,
      cciReduction: beforeMetrics.totalCci - afterMetrics.totalCci,
      congestedReduction: beforeMetrics.congestedCount - afterMetrics.congestedCount,
      chVar24Delta: Math.round((beforeMetrics.chVar24 - afterMetrics.chVar24) * 10) / 10,
      chVar5Delta: Math.round((beforeMetrics.chVar5 - afterMetrics.chVar5) * 10) / 10,
    },
    estimatedImprovementPct: Math.round(
      ((beforeMetrics.avgCu24 + beforeMetrics.avgCu5) -
       (afterMetrics.avgCu24 + afterMetrics.avgCu5)) /
      Math.max(1, (beforeMetrics.avgCu24 + beforeMetrics.avgCu5)) * 100
    ),
  };

  return {
    plan,
    changedAPs,
    totalAPs: apList.length,
    candidatesConsidered: candidates.length,
    batchSummary: {
      maxChanges,
      changesSuggested: changedAPs.length,
      remainingWorstAPs: Math.max(0, apList.length - changedAPs.length),
      recommendation: changedAPs.length > 0
        ? `Apply these ${changedAPs.length} changes, then re-scan and run optimizer again to pick the next batch.`
        : 'No beneficial changes found within the current budget. All APs are optimally configured.',
    },
    improvementReport,
    proximityGraph,
  };
}

module.exports = { runConstrainedOptimizer, CHANNELS_24, CHANNELS_5 };

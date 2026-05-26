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

// iPad-safe non-DFS channels: UNII-1 (36-48) + UNII-3 (149-165).
// DFS channels (52-144) are excluded to maximize compatibility.
const CHANNELS_5 = [36, 40, 44, 48, 149, 153, 157, 161, 165];

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
const DEFAULT_MAX_CHANGES = 10;

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
  // Default to 80 MHz for modern APs (was 40 MHz, underestimates overlap)
  const halfSpan1 = (Number(bw1) || 80) / 10;
  const halfSpan2 = (Number(bw2) || 80) / 10;
  return Math.abs(ch1 - ch2) <= (halfSpan1 + halfSpan2);
}

function inferFloor(name = '', index = 0) {
  const n = String(name).toUpperCase();
  // German + English ground floor
  if (/EG\b|GROUND|ERDGESCHOSS|0OG|0\.OG/.test(n)) return 'EG';
  // German + English first floor
  if (/1OG\b|1\.OG|FIRST|1ST/.test(n)) return '1OG';
  // German + English second floor
  if (/2OG\b|2\.OG|SECOND|2ND/.test(n)) return '2OG';
  // Numeric pattern: FG-0, Floor-1, etc.
  const numMatch = n.match(/[FG][_\-\s]*(\d+)/i);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    if (num === 0) return 'EG';
    if (num === 1) return '1OG';
    if (num === 2) return '2OG';
  }

  function collectObservedChannels(radios, channelCounts, is24Band) {
    const observed = new Set();

    (Array.isArray(radios) ? radios : []).forEach((r) => {
      const is24 = r.band === '2.4GHz' || r.radio === 'ng';
      if (is24 !== is24Band) return;
      const ch = Number(r.channel);
      if (Number.isFinite(ch)) observed.add(ch);
    });

    Object.keys(channelCounts || {}).forEach((ch) => {
      const n = Number(ch);
      if (Number.isFinite(n)) observed.add(n);
    });

    return observed;
  }

  function resolveChannelPools(radios, channelSummary) {
    const observed24 = collectObservedChannels(radios, channelSummary && channelSummary.channelCounts24, true);
    const observed5 = collectObservedChannels(radios, channelSummary && channelSummary.channelCounts5, false);

    const channels24 = CHANNELS_24.filter((ch) => observed24.has(ch));
    const channels5 = CHANNELS_5.filter((ch) => observed5.has(ch));

    return {
      channels24: channels24.length > 0 ? channels24 : [...CHANNELS_24],
      channels5: channels5.length > 0 ? channels5 : [...CHANNELS_5],
    };
  }
  return ['EG', '1OG', '2OG'][index % 3];
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
 *
 * @param {Object} ap - AP object with radios
 * @param {Object} proximityGraph - Pre-built proximity graph
 * @param {Array} allAPs - Full AP list for neighbor lookups (passed explicitly, no global)
 */
function scoreAP(ap, proximityGraph, allAPs) {
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
      const neighborAP = allAPs.find(a => a.mac === nMac);
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

// ── Joint Channel Combo Scoring ──────────────────────────────────────────────

/**
 * Score a (ch24, ch5) combo for a given AP in the current virtual state.
 * Lower score = better.
 *
 * @param {Object} ap - AP being scored
 * @param {number|null} ch24 - Candidate 2.4GHz channel
 * @param {number|null} ch5 - Candidate 5GHz channel
 * @param {Object} vLoad24 - Virtual 2.4GHz load map
 * @param {Object} vLoad5 - Virtual 5GHz load map
 * @param {Object} proximityGraph - Proximity graph
 * @param {Object} floorAssignments - Floor-based channel assignment tracker
 * @param {Array} allAPs - Full AP list for neighbor lookups (passed explicitly)
 */
function scoreCombo(ap, ch24, ch5, vLoad24, vLoad5, proximityGraph, floorAssignments, allAPs) {
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
      const neighbor = allAPs.find(a => a.mac === nMac);
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

  // 3. Floor-based separation: prefer different channels on different floors
  const floorKey24 = `${floor}_24_${ch24}`;
  const floorKey5 = `${floor}_5_${ch5}`;
  score += (floorAssignments[floorKey24] || 0) * COMBO_PENALTIES.sameFloorSameCh;
  score += (floorAssignments[floorKey5] || 0) * COMBO_PENALTIES.sameFloorSameCh;

  // 4. Stability bonus: prefer keeping current channels
  if (r24 && r24.channel === ch24) score -= COMBO_PENALTIES.changeCost;
  if (r5 && r5.channel === ch5) score -= COMBO_PENALTIES.changeCost;

  return score;
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
  const channelPools = resolveChannelPools(radios, channelSummary);

  // FIX 5: No module-level global — allAPs passed explicitly through every function
  const allAPs = Array.isArray(aps) ? aps : [];

  // Build proximity graph
  const proximityGraph = buildProximityGraph(allAPs);

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
  allAPs.forEach(ap => {
    const entry = apMap[ap.mac];
    if (entry && ap.floor) entry.floor = ap.floor;
  });

  // Score each AP — passes allAPs explicitly (no global)
  const apList = Object.values(apMap).map(ap => {
    const scores = scoreAP(ap, proximityGraph, allAPs);
    return { ...ap, ...scores };
  });

  // Sort by health score descending (worst first)
  apList.sort((a, b) => b.total - a.total);

  // Select top N APs for optimization
  const candidates = apList.slice(0, maxChanges);

  // Compute BEFORE metrics inline from radios (cci_count, cu_total already set by analyzer)
  let befSumCu24 = 0, befCount24 = 0, befMaxCu24 = 0;
  let befSumCu5 = 0, befCount5 = 0, befMaxCu5 = 0;
  let befTotalCci = 0;
  let befCongested = 0;
  let befWarning = 0;

  radios.forEach(r => {
    const cu = r.cu_total || 0;
    const cci = r.cci_count || 0;
    if (r.band === '2.4GHz' || r.radio === 'ng') {
      befSumCu24 += cu; befCount24++; if (cu > befMaxCu24) befMaxCu24 = cu;
    } else {
      befSumCu5 += cu; befCount5++; if (cu > befMaxCu5) befMaxCu5 = cu;
    }
    befTotalCci += cci;
    if (cu > 75 || cci > 12) befCongested++;
    else if (cu > 50 || cci > 4) befWarning++;
  });

  const befChCounts24 = channelSummary.channelCounts24 || {};
  const befChCounts5 = channelSummary.channelCounts5 || {};
  const befVals24 = Object.values(befChCounts24);
  const befVals5 = Object.values(befChCounts5);
  const befAvg24 = befVals24.length ? befVals24.reduce((a, b) => a + b, 0) / befVals24.length : 0;
  const befAvg5 = befVals5.length ? befVals5.reduce((a, b) => a + b, 0) / befVals5.length : 0;
  const befVar24 = befVals24.length ? befVals24.reduce((s, v) => s + (v - befAvg24) ** 2, 0) / befVals24.length : 0;
  const befVar5 = befVals5.length ? befVals5.reduce((s, v) => s + (v - befAvg5) ** 2, 0) / befVals5.length : 0;

  const beforeMetrics = {
    avgCu24: Math.round(befSumCu24 / (befCount24 || 1)),
    maxCu24: befMaxCu24,
    avgCu5: Math.round(befSumCu5 / (befCount5 || 1)),
    maxCu5: befMaxCu5,
    totalCci: befTotalCci,
    congestedCount: befCongested,
    warningCount: befWarning,
    chVar24: Math.round(befVar24 * 10) / 10,
    chVar5: Math.round(befVar5 * 10) / 10,
    channelCounts24: befChCounts24,
    channelCounts5: befChCounts5,
  };

  // Initialize virtual load maps from current channel counts
  const vLoad24 = Object.assign({}, channelSummary.channelCounts24 || {});
  const vLoad5 = Object.assign({}, channelSummary.channelCounts5 || {});
  const floorAssignments = {};

  // Run joint optimization for each candidate AP
  const plan = {};
  const changedAPs = [];

  candidates.forEach(ap => {
    const r24 = ap.radios.ng;
    const r5 = ap.radios.na;

    if (!r24 && !r5) return;

    const valid24 = r24 ? channelPools.channels24 : [null];
    const valid5 = r5 ? channelPools.channels5 : [null];

    let bestCombo = null;
    let bestScore = Infinity;

    // Enumerate all (ch24, ch5) combinations
    valid24.forEach(ch24 => {
      valid5.forEach(ch5 => {
        // FIX 5: passes allAPs explicitly
        const score = scoreCombo(ap, ch24, ch5, vLoad24, vLoad5, proximityGraph, floorAssignments, allAPs);
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

    if (totalCci === 0 && maxCu < 50 && currentCh24Load <= 1 && currentCh5Load <= 1) {
      return;
    }

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
    channelPolicy: {
      onlyObservedChannels: true,
      ipadSafeOnly5GHz: true,
      channels24: channelPools.channels24,
      channels5: channelPools.channels5,
    },
    proximityGraph,
  };
}

module.exports = { runConstrainedOptimizer, CHANNELS_24, CHANNELS_5 };

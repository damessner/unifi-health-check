'use strict';

/**
 * optimizer.js
 *
 * CONSTRAINED JOINT-BAND PROXIMITY-AWARE BATCH OPTIMIZER
 *
 * Modes:
 *   heuristic  — fast deterministic single-pass (default, used by XLSX exports)
 *   ga         — full Genetic Algorithm with population, crossover, mutation,
 *                tournament selection, elitism. Explores all APs globally,
 *                not just top-N candidates. Async with progress callbacks.
 *
 * The GA mode is designed for thorough search over the enormous
 * channel-assignment space. It maintains a diverse population of complete
 * AP channel plans and evolves them using domain-specific crossover and
 * mutation operators.
 */

// ── Valid channels ────────────────────────────────────────────────────────────
const CHANNELS_24 = [1, 6, 11];

// Full EU 5 GHz channel set: UNII-1 non-DFS (36-48) + DFS channels (52-136).
const CHANNELS_5 = [
  36, 40, 44, 48, 52, 56, 60, 64,
  100, 104, 108, 112, 116, 120, 124, 128, 132, 136
];

// ── Scoring weights ───────────────────────────────────────────────────────────
const WEIGHTS = {
  cuUtil: 1.0,
  cci: 8.0,
  retry: 0.5,
  neighborConflict: 5.0,
  clientCount: 2.0,
};

const COMBO_PENALTIES = {
  ngOverlap: 12,
  naOverlap: 16,
  loadImbalance: 5,
  sameFloorSameCh: 8,
  changeCost: 8,
};

const DEFAULT_MAX_CHANGES = 10;
const MIN_IMPROVEMENT_THRESHOLD = 5;
const CU_REDUCTION_PER_CCI = 8;

// GA defaults
const GA_POPULATION_SIZE = 40;
const GA_ELITE_COUNT = 4;
const GA_TOURNAMENT_SIZE = 3;
const GA_MUTATION_RATE = 0.25;
const GA_CROSSOVER_RATE = 0.8;
const GA_STAGNATION_LIMIT = 200;

// ── Helper functions ─────────────────────────────────────────────────────────

function channelsOverlap24(ch1, ch2) {
  return Number.isFinite(ch1) && Number.isFinite(ch2) && Math.abs(ch1 - ch2) < 5;
}

function channelsOverlap5(ch1, bw1, ch2, bw2) {
  if (!Number.isFinite(ch1) || !Number.isFinite(ch2)) return false;
  const halfSpan1 = (Number(bw1) || 80) / 10;
  const halfSpan2 = (Number(bw2) || 80) / 10;
  return Math.abs(ch1 - ch2) <= (halfSpan1 + halfSpan2);
}

function inferFloor(name = '', index = 0) {
  const n = String(name).toUpperCase();
  if (/EG\b|GROUND|ERDGESCHOSS|0OG|0\.OG/.test(n)) return 'EG';
  if (/1OG\b|1\.OG|FIRST|1ST/.test(n)) return '1OG';
  if (/2OG\b|2\.OG|SECOND|2ND/.test(n)) return '2OG';
  const numMatch = n.match(/[FG][_\-\s]*(\d+)/i);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    if (num === 0) return 'EG';
    if (num === 1) return '1OG';
    if (num === 2) return '2OG';
  }
  return ['EG', '1OG', '2OG'][index % 3];
}

function buildProximityGraph(aps) {
  const graph = {};
  const apList = Array.isArray(aps) ? aps : [];
  apList.forEach((ap, i) => {
    graph[ap.mac] = { name: ap.name, floor: inferFloor(ap.name, i), neighbors: [] };
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
    scores.sort((a, b) => b.score - a.score).slice(0, 4)
      .forEach((entry) => graph[ap1.mac].neighbors.push(entry.mac));
  });
  return graph;
}

function scoreAP(ap, proximityGraph, allAPs) {
  const r24 = ap.radios && ap.radios.ng;
  const r5 = ap.radios && ap.radios.na;
  const cu24 = r24 ? r24.cu_total || 0 : 0;
  const cu5 = r5 ? r5.cu_total || 0 : 0;
  const maxCu = Math.max(cu24, cu5);
  const cci24 = r24 ? r24.cci_count || 0 : 0;
  const cci5 = r5 ? r5.cci_count || 0 : 0;
  const totalCci = cci24 + cci5;
  const maxRetry = Math.max(r24 ? r24.tx_retries_pct || 0 : 0, r5 ? r5.tx_retries_pct || 0 : 0);
  const clients = (r24 ? r24.num_sta || 0 : 0) + (r5 ? r5.num_sta || 0 : 0);
  let neighborConflicts = 0;
  const graphEntry = proximityGraph && proximityGraph[ap.mac];
  if (graphEntry) {
    graphEntry.neighbors.forEach(nMac => {
      const neighborAP = allAPs.find(a => a.mac === nMac);
      if (!neighborAP) return;
      if (r24 && neighborAP.radios && neighborAP.radios.ng && r24.channel && neighborAP.radios.ng.channel) {
        if (channelsOverlap24(r24.channel, neighborAP.radios.ng.channel)) neighborConflicts++;
      }
      if (r5 && neighborAP.radios && neighborAP.radios.na && r5.channel && neighborAP.radios.na.channel) {
        if (channelsOverlap5(r5.channel, r5.bw, neighborAP.radios.na.channel, neighborAP.radios.na && neighborAP.radios.na.bw)) neighborConflicts++;
      }
    });
  }
  return {
    cu: maxCu, cci: totalCci, retry: maxRetry, clients, neighborConflicts,
    total: Math.round(maxCu * WEIGHTS.cuUtil + totalCci * WEIGHTS.cci + maxRetry * WEIGHTS.retry + neighborConflicts * WEIGHTS.neighborConflict + clients * WEIGHTS.clientCount)
  };
}

function scoreCombo(ap, ch24, ch5, vLoad24, vLoad5, proximityGraph, floorAssignments, allAPs) {
  let score = 0;
  const r24 = ap.radios && ap.radios.ng;
  const r5 = ap.radios && ap.radios.na;
  const graphEntry = proximityGraph && proximityGraph[ap.mac];
  const floor = graphEntry ? graphEntry.floor : inferFloor(ap.name, 0);
  const maxLoad24 = Math.max(1, ...Object.values(vLoad24));
  const maxLoad5 = Math.max(1, ...Object.values(vLoad5));
  score += ((vLoad24[ch24] || 0) / maxLoad24) * COMBO_PENALTIES.loadImbalance;
  score += ((vLoad5[ch5] || 0) / maxLoad5) * COMBO_PENALTIES.loadImbalance;
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
        if (channelsOverlap5(ch5, r5 && r5.bw, n5._optCh5, n5.bw)) score += COMBO_PENALTIES.naOverlap;
      } else if (n5 && n5.channel) {
        if (channelsOverlap5(ch5, r5 && r5.bw, n5.channel, n5.bw)) score += COMBO_PENALTIES.naOverlap;
      }
    });
  }
  const floorKey24 = `${floor}_24_${ch24}`;
  const floorKey5 = `${floor}_5_${ch5}`;
  score += (floorAssignments[floorKey24] || 0) * COMBO_PENALTIES.sameFloorSameCh;
  score += (floorAssignments[floorKey5] || 0) * COMBO_PENALTIES.sameFloorSameCh;
  if (r24 && r24.channel === ch24) score -= COMBO_PENALTIES.changeCost;
  if (r5 && r5.channel === ch5) score -= COMBO_PENALTIES.changeCost;
  return score;
}

// ── Inline essential evaluator (no module references) ────────────────────────

/**
 * Compute a global "pain" score for a complete channel assignment.
 * Lower = better. Used by the GA as the fitness function.
 *
 * @param {Array} radios - Radio objects with their baseline cu_total, cci_count, etc.
 * @param {Object} assignment - Map[apMac_radio] → channel number
 * @param {Object} channelSummary - Current channel counts for computing before/after deltas
 * @param {number} maxChanges - Budget of APs we are allowed to change
 * @returns {{ pain: number, improvementPct: number, metrics: Object }}
 */
function evaluateAssignment(radios, assignment, channelSummary, maxChanges) {
  // Count changes
  let changes = 0;
  const changedMacs = new Set();

  // Build final channel counts from the assignment
  const finalCh24 = {};
  const finalCh5 = {};

  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const assignedCh = assignment[key];
    const finalCh = assignedCh != null ? assignedCh : r.channel;
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const target = is24 ? finalCh24 : finalCh5;
    target[String(finalCh)] = (target[String(finalCh)] || 0) + 1;

    if (assignedCh != null && Number(assignedCh) !== Number(r.channel)) {
      changes++;
      changedMacs.add(r.apMac);
    }
  });

  const distinctAPsChanged = changedMacs.size;

  // Compute CCI per radio and estimate CU improvement
  let sumCu24 = 0, count24 = 0, maxCu24 = 0;
  let sumCu5 = 0, count5 = 0, maxCu5 = 0;
  let totalCci = 0;
  let congested = 0;
  let warning = 0;

  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const assignedCh = assignment[key];
    const finalCh = assignedCh != null ? assignedCh : r.channel;
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const chCounts = is24 ? finalCh24 : finalCh5;
    const finalChLoad = chCounts[String(finalCh)] || 0;
    const newCci = Math.max(0, finalChLoad - 1);
    const cciReduction = (r.cci_count || 0) - newCci;
    const baseline = Math.max((r.cu_self_rx || 0) + (r.cu_self_tx || 0), 8);
    const estCu = Math.max(baseline, Math.min(100, (r.cu_total || baseline) - cciReduction * CU_REDUCTION_PER_CCI));

    if (is24) {
      sumCu24 += estCu; count24++;
      if (estCu > maxCu24) maxCu24 = estCu;
    } else {
      sumCu5 += estCu; count5++;
      if (estCu > maxCu5) maxCu5 = estCu;
    }
    totalCci += newCci;
    if (estCu > 75 || newCci > 12) congested++;
    else if (estCu > 50 || newCci > 4) warning++;
  });

  // Channel balance (variance)
  const vals24 = Object.values(finalCh24);
  const vals5 = Object.values(finalCh5);
  const avg24 = vals24.length ? vals24.reduce((a, b) => a + b, 0) / vals24.length : 0;
  const avg5 = vals5.length ? vals5.reduce((a, b) => a + b, 0) / vals5.length : 0;
  const var24 = vals24.length ? vals24.reduce((s, v) => s + (v - avg24) ** 2, 0) / vals24.length : 0;
  const var5 = vals5.length ? vals5.reduce((s, v) => s + (v - avg5) ** 2, 0) / vals5.length : 0;

  // Compute improvement vs current
  const befCh24 = channelSummary.channelCounts24 || {};
  const befCh5 = channelSummary.channelCounts5 || {};
  // Estimate current total CCI from current channel counts
  const curTotalCci = radios.reduce((sum, r) => {
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const curLoad = (is24 ? befCh24 : befCh5)[String(r.channel)] || 0;
    return sum + Math.max(0, curLoad - 1);
  }, 0);

  const avgCuBefore = Math.round(radios.reduce((s, r) => s + (r.cu_total || 0), 0) / (radios.length || 1));
  const avgCuAfter = Math.round((sumCu24 + sumCu5) / Math.max(1, count24 + count5));
  const improvementPct = avgCuBefore > 0
    ? Math.round((avgCuBefore - avgCuAfter) / avgCuBefore * 100)
    : 0;

  // Composite pain score (lower = better)
  const pain =
    (avgCuAfter || 0) * 1.4 +
    (totalCci || 0) * 2.2 +
    (congested || 0) * 30 +
    (warning || 0) * 10 +
    distinctAPsChanged * 0.3 -
    Math.max(0, improvementPct) * 8 +
    (var24 + var5) * 0.5;

  return {
    pain,
    improvementPct,
    distinctAPsChanged,
    metrics: {
      avgCu24: Math.round(sumCu24 / (count24 || 1)),
      maxCu24,
      avgCu5: Math.round(sumCu5 / (count5 || 1)),
      maxCu5,
      totalCci,
      congested,
      warning,
      chVar24: Math.round(var24 * 10) / 10,
      chVar5: Math.round(var5 * 10) / 10,
    }
  };
}

// ── GA-specific helpers ──────────────────────────────────────────────────────

function randomValidChannel(is24) {
  const pool = is24 ? CHANNELS_24 : CHANNELS_5;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Domain-aware channel selection: prefers less-crowded channels based on
 * the current assignment's channel load distribution, and avoids same-floor
 * channel reuse when proximity info is available.
 */
function smartChannel(is24, currentAssignment, radios, proximityGraph, apMac) {
  const pool = is24 ? CHANNELS_24 : CHANNELS_5;
  // Build channel load from current assignment
  const load = {};
  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const ch = currentAssignment[key] || r.channel;
    const rIs24 = r.band === '2.4GHz' || r.radio === 'ng';
    if (rIs24 === is24) {
      load[ch] = (load[ch] || 0) + 1;
    }
  });
  // Get this AP's floor neighbors
  const graphEntry = proximityGraph && proximityGraph[apMac];
  const floorNeighborChs = new Set();
  if (graphEntry) {
    graphEntry.neighbors.forEach(nMac => {
      radios.forEach(r => {
        if (r.apMac === nMac) {
          const key = `${r.apMac}_${r.radio}`;
          const rIs24 = r.band === '2.4GHz' || r.radio === 'ng';
          if (rIs24 === is24) {
            floorNeighborChs.add(currentAssignment[key] || r.channel);
          }
        }
      });
    });
  }
  // Score each channel: lower load + no floor neighbor overlap = better
  const scored = pool.map(ch => {
    let penalty = (load[ch] || 0) * 10;
    if (floorNeighborChs.has(ch)) penalty += 20;
    return { ch, penalty };
  });
  scored.sort((a, b) => a.penalty - b.penalty);
  // Weighted random pick among top candidates (80% pick from top 3, else fully random)
  const top = scored.slice(0, Math.min(3, scored.length));
  return Math.random() < 0.8
    ? top[Math.floor(Math.random() * top.length)].ch
    : pool[Math.floor(Math.random() * pool.length)];
}

function createRandomAssignment(radios, proximityGraph) {
  const assignment = {};
  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    if (Math.random() < 0.85) {
      assignment[key] = smartChannel(is24, assignment, radios, proximityGraph, r.apMac);
    }
  });
  return assignment;
}

function crossoverAssignments(assignmentA, assignmentB) {
  const child = {};
  const allKeys = new Set([...Object.keys(assignmentA), ...Object.keys(assignmentB)]);
  allKeys.forEach(key => {
    const a = assignmentA[key];
    const b = assignmentB[key];
    if (a !== undefined && b !== undefined) {
      child[key] = Math.random() < 0.5 ? a : b;
    } else if (a !== undefined) {
      child[key] = Math.random() < 0.9 ? a : undefined;
    } else if (b !== undefined) {
      child[key] = Math.random() < 0.9 ? b : undefined;
    }
  });
  return child;
}

/**
 * Domain-aware mutation with adaptive rate.
 * mutationRate is the base rate; it is adjusted by the cooling factor (0..1)
 * so that later generations have less disruptive mutations.
 */
function mutateAssignment(assignment, radios, mutationRate, coolingFactor, proximityGraph) {
  const result = { ...assignment };
  const adjustedRate = mutationRate * (0.3 + 0.7 * coolingFactor);
  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    if (Math.random() < adjustedRate) {
      const is24 = r.band === '2.4GHz' || r.radio === 'ng';
      result[key] = smartChannel(is24, result, radios, proximityGraph, r.apMac);
    }
  });
  return result;
}

/**
 * Local search refinement: for each changed radio in the best assignment,
 * try every valid channel and keep the best one. Repeat until no improvement.
 */
function refineAssignment(assignment, radios, channelSummary, maxChanges, proximityGraph) {
  let best = { ...assignment };
  const keys = Object.keys(best);
  let improved = true;
  let rounds = 0;
  while (improved && rounds < 5) {
    improved = false;
    rounds++;
    for (const key of keys) {
      const r = radios.find(x => `${x.apMac}_${x.radio}` === key);
      if (!r) continue;
      const is24 = r.band === '2.4GHz' || r.radio === 'ng';
      const pool = is24 ? CHANNELS_24 : CHANNELS_5;
      const original = best[key];
      const currentEval = evaluateAssignment(radios, best, channelSummary, maxChanges);
      for (const ch of pool) {
        if (ch === original) continue;
        const trial = { ...best, [key]: ch };
        const trialEval = evaluateAssignment(radios, trial, channelSummary, maxChanges);
        if (trialEval.pain < currentEval.pain) {
          best = trial;
          improved = true;
          break; // accept first improvement and move to next key
        }
      }
    }
  }
  return best;
}

function tournamentSelect(population, fitnessScores, tournamentSize) {
  let best = -1;
  let bestFitness = Infinity;
  for (let i = 0; i < tournamentSize; i++) {
    const idx = Math.floor(Math.random() * population.length);
    if (fitnessScores[idx] < bestFitness) {
      best = idx;
      bestFitness = fitnessScores[idx];
    }
  }
  return best;
}

function clampInt(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// ── Build the final result from a GA-found assignment ────────────────────────

function assignmentToResult(assignment, radios, channelSummary, aps, allAPs, proximityGraph, maxChanges, evaluation) {
  // Build plan and changedAPs in the same format as runConstrainedOptimizerSingle
  const plan = {};
  const changedAPs = [];
  const apMap = {};

  radios.forEach((r) => {
    if (!apMap[r.apMac]) {
      apMap[r.apMac] = { mac: r.apMac, name: r.apName, floor: inferFloor(r.apName, 0) };
    }
  });

  // Attach floor from aps
  allAPs.forEach(ap => {
    if (apMap[ap.mac] && ap.floor) apMap[ap.mac].floor = ap.floor;
  });

  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const assignedCh = assignment[key];
    if (assignedCh === undefined) return;
    if (Number(assignedCh) === Number(r.channel)) return;

    plan[key] = {
      suggestedChannel: assignedCh,
      changeNeeded: true,
      impact: Math.round(evaluation.metrics.avgCu24 + evaluation.metrics.avgCu5 / 2) || 1,
    };

    if (!changedAPs.find(c => c.mac === r.apMac)) {
      const r24 = r.radio === 'ng' ? r : null;
      const r5 = r.radio === 'na' ? r : null;
      // Compute per-AP impact score: higher CU/CCI/retry = higher impact to fix
      const apImpact = Math.round(
        (r.cu_total || 0) * 1.0 +
        (r.cci_count || 0) * 8.0 +
        (r.tx_retries_pct || 0) * 0.5 +
        (r.num_sta || 0) * 2.0
      );
      changedAPs.push({
        mac: r.apMac,
        name: r.apName,
        floor: apMap[r.apMac] ? apMap[r.apMac].floor : inferFloor(r.apName, 0),
        healthScore: apImpact,
        changes: `${r.radio === 'ng' ? '2.4G' : '5G'}: ${r.channel}→${assignedCh}`,
        oldNgCh: r24 ? r.channel : null,
        newNgCh: r24 ? assignedCh : null,
        oldNaCh: r5 ? r.channel : null,
        newNaCh: r5 ? assignedCh : null,
        cu: r.cu_total || 0,
        cci: r.cci_count || 0,
      });
    }
  });

  // SORT by impact descending (worst APs first), then KEEP only top maxChanges
  changedAPs.sort((a, b) => b.healthScore - a.healthScore);
  const kept = changedAPs.slice(0, Math.max(1, maxChanges));
  const removedMacs = new Set(changedAPs.slice(maxChanges).map(ap => ap.mac));

  // Remove plan entries for APs that didn't make the cut
  if (removedMacs.size > 0) {
    Object.keys(plan).forEach(pk => {
      const mac = pk.split('_')[0];
      if (removedMacs.has(mac)) delete plan[pk];
    });
  }

  changedAPs.length = 0;
  kept.forEach(ap => changedAPs.push(ap));

  // Build before metrics
  let befSumCu24 = 0, befCount24 = 0, befMaxCu24 = 0;
  let befSumCu5 = 0, befCount5 = 0, befMaxCu5 = 0;
  let befTotalCci = 0, befCongested = 0, befWarning = 0;
  radios.forEach(r => {
    const cu = r.cu_total || 0;
    const cci = r.cci_count || 0;
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    if (is24) { befSumCu24 += cu; befCount24++; if (cu > befMaxCu24) befMaxCu24 = cu; }
    else { befSumCu5 += cu; befCount5++; if (cu > befMaxCu5) befMaxCu5 = cu; }
    befTotalCci += cci;
    if (cu > 75 || cci > 12) befCongested++;
    else if (cu > 50 || cci > 4) befWarning++;
  });

  const m = evaluation.metrics;
  const beforeMetrics = {
    avgCu24: Math.round(befSumCu24 / (befCount24 || 1)),
    maxCu24: befMaxCu24,
    avgCu5: Math.round(befSumCu5 / (befCount5 || 1)),
    maxCu5: befMaxCu5,
    totalCci: befTotalCci,
    congestedCount: befCongested,
    warningCount: befWarning,
    channelCounts24: (channelSummary.channelCounts24 || {}),
    channelCounts5: (channelSummary.channelCounts5 || {}),
  };

  const afterMetrics = {
    avgCu24: m.avgCu24,
    maxCu24: m.maxCu24,
    avgCu5: m.avgCu5,
    maxCu5: m.maxCu5,
    totalCci: m.totalCci,
    congestedCount: m.congested,
    warningCount: m.warning,
  };

  const improvementReport = {
    before: beforeMetrics,
    after: afterMetrics,
    deltas: {
      avgCu24Delta: beforeMetrics.avgCu24 - m.avgCu24,
      avgCu5Delta: beforeMetrics.avgCu5 - m.avgCu5,
      maxCu24Delta: beforeMetrics.maxCu24 - m.maxCu24,
      maxCu5Delta: beforeMetrics.maxCu5 - m.maxCu5,
      cciReduction: befTotalCci - m.totalCci,
      congestedReduction: befCongested - m.congested,
    },
    estimatedImprovementPct: Math.max(0, evaluation.improvementPct),
  };

  return {
    plan,
    changedAPs,
    totalAPs: Object.keys(apMap).length,
    candidatesConsidered: changedAPs.length,
    batchSummary: {
      maxChanges,
      changesSuggested: changedAPs.length,
      remainingWorstAPs: Math.max(0, Object.keys(apMap).length - changedAPs.length),
      recommendation: changedAPs.length > 0
        ? `GA found ${changedAPs.length} changes to improve network. Apply, then re-scan and re-run.`
        : 'GA found no beneficial changes. Your network may be well-configured.',
    },
    improvementReport,
    proximityGraph,
  };
}

// ── Legacy single-pass optimizer (unchanged, used for heuristic mode + exports) ──

function runConstrainedOptimizerSingle(radios, channelSummary, aps, options = {}) {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const minImprovementThreshold = options.minImprovementThreshold ?? MIN_IMPROVEMENT_THRESHOLD;
  const comboJitter = Number.isFinite(Number(options.comboJitter)) ? Number(options.comboJitter) : 0;

  const allAPs = Array.isArray(aps) ? aps : [];
  const proximityGraph = buildProximityGraph(allAPs);

  const apMap = {};
  radios.forEach((r, idx) => {
    if (!apMap[r.apMac]) {
      apMap[r.apMac] = { mac: r.apMac, name: r.apName, ip: r.ip, model: r.model, radios: {}, floor: inferFloor(r.apName, idx) };
    }
    apMap[r.apMac].radios[r.radio] = r;
  });
  allAPs.forEach(ap => {
    const entry = apMap[ap.mac];
    if (entry && ap.floor) entry.floor = ap.floor;
  });

  const apList = Object.values(apMap).map(ap => ({ ...ap, ...scoreAP(ap, proximityGraph, allAPs) }));
  apList.sort((a, b) => b.total - a.total);
  const candidates = apList.slice(0, maxChanges);

  let befSumCu24 = 0, befCount24 = 0, befMaxCu24 = 0;
  let befSumCu5 = 0, befCount5 = 0, befMaxCu5 = 0;
  let befTotalCci = 0, befCongested = 0, befWarning = 0;
  radios.forEach(r => {
    const cu = r.cu_total || 0, cci = r.cci_count || 0;
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    if (is24) { befSumCu24 += cu; befCount24++; if (cu > befMaxCu24) befMaxCu24 = cu; }
    else { befSumCu5 += cu; befCount5++; if (cu > befMaxCu5) befMaxCu5 = cu; }
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
    avgCu24: Math.round(befSumCu24 / (befCount24 || 1)), maxCu24: befMaxCu24,
    avgCu5: Math.round(befSumCu5 / (befCount5 || 1)), maxCu5: befMaxCu5,
    totalCci: befTotalCci, congestedCount: befCongested, warningCount: befWarning,
    chVar24: Math.round(befVar24 * 10) / 10, chVar5: Math.round(befVar5 * 10) / 10,
    channelCounts24: befChCounts24, channelCounts5: befChCounts5,
  };

  const vLoad24 = Object.assign({}, channelSummary.channelCounts24 || {});
  const vLoad5 = Object.assign({}, channelSummary.channelCounts5 || {});
  const floorAssignments = {};
  const plan = {};
  const changedAPs = [];

  candidates.forEach(ap => {
    const r24 = ap.radios.ng, r5 = ap.radios.na;
    if (!r24 && !r5) return;
    const valid24 = r24 ? CHANNELS_24 : [null];
    const valid5 = r5 ? CHANNELS_5 : [null];
    let bestCombo = null, bestScore = Infinity;

    valid24.forEach(ch24 => {
      valid5.forEach(ch5 => {
        let score = scoreCombo(ap, ch24, ch5, vLoad24, vLoad5, proximityGraph, floorAssignments, allAPs);
        if (comboJitter > 0) score += (Math.random() - 0.5) * comboJitter;
        if (score < bestScore) { bestScore = score; bestCombo = { ch24, ch5 }; }
      });
    });

    if (!bestCombo) return;
    const { ch24, ch5 } = bestCombo;
    const needsNgChange = r24 && ch24 !== null && r24.channel !== ch24;
    const needsNaChange = r5 && ch5 !== null && r5.channel !== ch5;
    const maxCu = Math.max(r24 ? r24.cu_total || 0 : 0, r5 ? r5.cu_total || 0 : 0);
    const totalCci = (r24 ? r24.cci_count || 0 : 0) + (r5 ? r5.cci_count || 0 : 0);
    const currentCh24Load = r24 ? (vLoad24[r24.channel] || 0) : 0;
    const currentCh5Load = r5 ? (vLoad5[r5.channel] || 0) : 0;

    if (totalCci === 0 && maxCu < 50 && currentCh24Load <= 1 && currentCh5Load <= 1) return;

    if (needsNgChange || needsNaChange) {
      if (r24 && ch24 !== null && r24.channel !== ch24) {
        vLoad24[r24.channel] = Math.max(0, (vLoad24[r24.channel] || 0) - 1);
        vLoad24[ch24] = (vLoad24[ch24] || 0) + 1;
      }
      if (r5 && ch5 !== null && r5.channel !== ch5) {
        vLoad5[r5.channel] = Math.max(0, (vLoad5[r5.channel] || 0) - 1);
        vLoad5[ch5] = (vLoad5[ch5] || 0) + 1;
      }
      if (ch24 !== null) floorAssignments[`${ap.floor}_24_${ch24}`] = (floorAssignments[`${ap.floor}_24_${ch24}`] || 0) + 1;
      if (ch5 !== null) floorAssignments[`${ap.floor}_5_${ch5}`] = (floorAssignments[`${ap.floor}_5_${ch5}`] || 0) + 1;
      if (r24) r24._optCh24 = ch24 !== null ? ch24 : r24.channel;
      if (r5) r5._optCh5 = ch5 !== null ? ch5 : r5.channel;

      const changes = [];
      if (needsNgChange) changes.push(`2.4G: ${r24.channel}→${ch24}`);
      if (needsNaChange) changes.push(`5G: ${r5.channel}→${ch5}`);

      changedAPs.push({
        mac: ap.mac, name: ap.name, floor: ap.floor, healthScore: ap.total,
        changes: changes.join(', '),
        oldNgCh: r24 ? r24.channel : null, newNgCh: needsNgChange ? ch24 : null,
        oldNaCh: r5 ? r5.channel : null, newNaCh: needsNaChange ? ch5 : null,
        cu: ap.cu, cci: ap.cci,
      });

      if (r24) plan[`${ap.mac}_${r24.radio}`] = { suggestedChannel: ch24 !== null ? ch24 : r24.channel, changeNeeded: needsNgChange, impact: ap.total };
      if (r5) plan[`${ap.mac}_${r5.radio}`] = { suggestedChannel: ch5 !== null ? ch5 : r5.channel, changeNeeded: needsNaChange, impact: ap.total };
    }
  });

  // Compute after metrics (same as original)
  const finalChCounts24 = {}, finalChCounts5 = {};
  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const opt = plan[key];
    const finalCh = (opt && opt.changeNeeded) ? opt.suggestedChannel : r.channel;
    const target = (r.band === '2.4GHz' || r.radio === 'ng') ? finalChCounts24 : finalChCounts5;
    target[String(finalCh)] = (target[String(finalCh)] || 0) + 1;
  });

  let aftSumCu24 = 0, aftCount24 = 0, aftMaxCu24 = 0;
  let aftSumCu5 = 0, aftCount5 = 0, aftMaxCu5 = 0;
  let aftTotalCci = 0, aftCongested = 0, aftWarning = 0;

  radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const opt = plan[key];
    const is24 = r.band === '2.4GHz' || r.radio === 'ng';
    const finalCh = (opt && opt.changeNeeded) ? opt.suggestedChannel : r.channel;
    const finalChLoad = (is24 ? finalChCounts24 : finalChCounts5)[String(finalCh)] || 0;
    const newCci = Math.max(0, finalChLoad - 1);
    const cciReduction = (r.cci_count || 0) - newCci;
    const baseline = Math.max((r.cu_self_rx || 0) + (r.cu_self_tx || 0), 8);
    const estCu = Math.max(baseline, Math.min(100, (r.cu_total || baseline) - cciReduction * CU_REDUCTION_PER_CCI));

    if (is24) { aftSumCu24 += estCu; aftCount24++; if (estCu > aftMaxCu24) aftMaxCu24 = estCu; }
    else { aftSumCu5 += estCu; aftCount5++; if (estCu > aftMaxCu5) aftMaxCu5 = estCu; }
    aftTotalCci += newCci;
    if (estCu > 75 || newCci > 12) aftCongested++;
    else if (estCu > 50 || newCci > 4) aftWarning++;
  });

  const aftVals24 = Object.values(finalChCounts24), aftVals5 = Object.values(finalChCounts5);
  const aftAvg24 = aftVals24.length ? aftVals24.reduce((a, b) => a + b, 0) / aftVals24.length : 0;
  const aftAvg5 = aftVals5.length ? aftVals5.reduce((a, b) => a + b, 0) / aftVals5.length : 0;
  const aftVar24 = aftVals24.length ? aftVals24.reduce((s, v) => s + (v - aftAvg24) ** 2, 0) / aftVals24.length : 0;
  const aftVar5 = aftVals5.length ? aftVals5.reduce((s, v) => s + (v - aftAvg5) ** 2, 0) / aftVals5.length : 0;

  const afterMetrics = {
    avgCu24: Math.round(aftSumCu24 / (aftCount24 || 1)), maxCu24: aftMaxCu24,
    avgCu5: Math.round(aftSumCu5 / (aftCount5 || 1)), maxCu5: aftMaxCu5,
    totalCci: aftTotalCci, congestedCount: aftCongested, warningCount: aftWarning,
    chVar24: Math.round(aftVar24 * 10) / 10, chVar5: Math.round(aftVar5 * 10) / 10,
    channelCounts24: finalChCounts24, channelCounts5: finalChCounts5,
  };

  const improvementReport = {
    before: beforeMetrics, after: afterMetrics,
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
      ((beforeMetrics.avgCu24 + beforeMetrics.avgCu5) - (afterMetrics.avgCu24 + afterMetrics.avgCu5)) /
      Math.max(1, (beforeMetrics.avgCu24 + beforeMetrics.avgCu5)) * 100
    ),
  };

  const result = {
    plan, changedAPs, totalAPs: apList.length, candidatesConsidered: candidates.length,
    batchSummary: {
      maxChanges, changesSuggested: changedAPs.length,
      remainingWorstAPs: Math.max(0, apList.length - changedAPs.length),
      recommendation: changedAPs.length > 0
        ? `Apply these ${changedAPs.length} changes, then re-scan and run optimizer again.`
        : 'No beneficial changes found within the current budget.',
    },
    improvementReport, proximityGraph,
  };

  if (options.enforceMinImprovement === true && result.improvementReport.estimatedImprovementPct < minImprovementThreshold) {
    result.plan = {};
    result.changedAPs = [];
    result.batchSummary.changesSuggested = 0;
    result.batchSummary.recommendation = `No beneficial changes found above ${minImprovementThreshold}% predicted improvement.`;
  }

  return result;
}

// ── GA-based global optimizer (async, with progress callbacks) ───────────────

/**
 * Run a full Genetic Algorithm search over the complete channel assignment space.
 *
 * @param {Array} radios - Radio objects from analyzer
 * @param {Object} channelSummary - Current channel distribution
 * @param {Array} aps - AP model objects
 * @param {Object} options
 * @param {number} options.maxChanges - Budget (passed through to result format)
 * @param {number} options.timeBudgetMs - Maximum search time (default 150000)
 * @param {number} options.populationSize - GA population size (default 40)
 * @param {Function} [onProgress] - Called periodically: (progressObject) => void
 * @returns {Promise<Object>} Result in the same format as runConstrainedOptimizerSingle
 */
async function runGeneticOptimizer(radios, channelSummary, aps, options = {}, onProgress) {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const timeBudgetMs = clampInt(Number(options.timeBudgetMs), 1000, 28800000, 150000);
  const populationSize = clampInt(Number(options.populationSize), 10, 200, GA_POPULATION_SIZE);
  const mutationRate = Number(options.mutationRate) || GA_MUTATION_RATE;
  const eliteCount = Math.min(clampInt(Number(options.eliteCount), 1, 50, GA_ELITE_COUNT), Math.floor(populationSize / 4));
  const stagnationLimit = clampInt(Number(options.stagnationLimit), 10, 5000, GA_STAGNATION_LIMIT);
  const convergenceWindow = clampInt(Number(options.convergenceWindow), 20, 2000, 300);
  const convergenceThreshold = Number(options.convergenceThreshold) || 0.5;
  const searchMode = String(options.searchMode || 'ga').toLowerCase();

  const allAPs = Array.isArray(aps) ? aps : [];
  const proximityGraph = buildProximityGraph(allAPs);
  const started = Date.now();

  const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

  // ── Initialise population ──
  let population = [];
  let fitnessScores = [];

  // Seed with multiple heuristic variants (different jitter levels)
  const heuristicJitterValues = [0, 2, 5, 10, 20];
  for (const jitter of heuristicJitterValues) {
    const hResult = runConstrainedOptimizerSingle(radios, channelSummary, aps, { ...options, comboJitter: jitter });
    const hAssignment = {};
    let hasChanges = false;
    radios.forEach(r => {
      const key = `${r.apMac}_${r.radio}`;
      const opt = hResult.plan[key];
      if (opt && opt.changeNeeded) {
        hAssignment[key] = opt.suggestedChannel;
        hasChanges = true;
      } else {
        // Keep current channel encoded as no-change (undefined)
      }
    });
    // Only add if unique (no duplicates)
    if (hasChanges || jitter === 0) {
      const evalResult = evaluateAssignment(radios, hAssignment, channelSummary, maxChanges);
      population.push(hAssignment);
      fitnessScores.push(evalResult.pain);
    }
  }

  // Fill rest with smart random individuals
  while (population.length < populationSize) {
    const assignment = createRandomAssignment(radios, proximityGraph);
    const evalResult = evaluateAssignment(radios, assignment, channelSummary, maxChanges);
    population.push(assignment);
    fitnessScores.push(evalResult.pain);
  }

  // Track best
  let bestAssignment = population[0];
  let bestEval = { pain: fitnessScores[0] };
  // Evaluate best properly
  bestEval = evaluateAssignment(radios, bestAssignment, channelSummary, maxChanges);
  for (let i = 0; i < population.length; i++) {
    const ev = evaluateAssignment(radios, population[i], channelSummary, maxChanges);
    if (ev.pain < bestEval.pain) {
      bestEval = ev;
      bestAssignment = population[i];
    }
  }

  let bestGeneration = 0;

  // Sort initial population
  const sortPop = () => {
    const si = population.map((_, i) => i).sort((a, b) => fitnessScores[a] - fitnessScores[b]);
    population = si.map(i => population[i]);
    fitnessScores = si.map(i => fitnessScores[i]);
  };
  sortPop();

  let generations = 0;
  let stagnationCounter = 0;
  let lastImprovementGen = 0;
  let convergedEarly = false;

  // Convergence tracking: sliding window of best scores
  const bestHistory = [];

  // Progress sender (enhanced)
  const sendProgress = async (phase) => {
    if (typeof onProgress !== 'function') return;
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, timeBudgetMs - elapsed);
    const meanFit = fitnessScores.reduce((a, b) => a + b, 0) / fitnessScores.length;
    const sortedF = [...fitnessScores].sort((a, b) => a - b);
    const diversity = sortedF[sortedF.length - 1] - sortedF[0];
    const worstFit = sortedF[sortedF.length - 1];
    const medianFit = sortedF[Math.floor(sortedF.length / 2)];
    onProgress({
      phase,
      generation: generations,
      populationSize: population.length,
      elapsedMs: elapsed,
      remainingMs: remaining,
      totalBudgetMs: timeBudgetMs,
      bestPain: Math.round(bestEval.pain * 100) / 100,
      bestImprovementPct: bestEval.improvementPct,
      bestChangesCount: bestEval.distinctAPsChanged,
      bestGeneration,
      stagnationCounter,
      convergedEarly,
      diversity: Math.round(diversity * 100) / 100,
      meanPain: Math.round(meanFit * 100) / 100,
      medianPain: Math.round(medianFit * 100) / 100,
      worstPain: Math.round(worstFit * 100) / 100,
      statusText: convergedEarly
        ? `Converged at gen ${bestGeneration} (best ${Math.round(bestEval.pain * 100) / 100}). Refining...`
        : (phase === 'refining'
            ? `Refining best solution (gen ${generations})...`
            : (phase === 'searching'
                ? `Generation ${generations}: best ${Math.round(bestEval.pain * 100) / 100}, diversity ${Math.round(diversity)}`
                : phase)),
    });
    await yieldToLoop();
  };

  await sendProgress('initializing');

  // ── Main evolution loop ──
  let reportCounter = 0;
  const REPORT_INTERVAL = Math.max(1, Math.round(populationSize * 0.4));

  while ((Date.now() - started) < timeBudgetMs) {
    generations++;
    const elapsedFrac = Math.min(1, (Date.now() - started) / timeBudgetMs);
    const coolingFactor = 1 - elapsedFrac; // 1 → 0 over the run

    // Create next generation
    const nextPopulation = [];
    const nextFitnessScores = [];

    // Elitism
    for (let i = 0; i < eliteCount && i < population.length; i++) {
      nextPopulation.push(population[i]);
      nextFitnessScores.push(fitnessScores[i]);
    }

    // Fill rest via tournament + crossover + adaptive mutation
    while (nextPopulation.length < populationSize) {
      const p1Idx = tournamentSelect(population, fitnessScores, GA_TOURNAMENT_SIZE);
      const p2Idx = tournamentSelect(population, fitnessScores, GA_TOURNAMENT_SIZE);

      let child;
      if (Math.random() < GA_CROSSOVER_RATE) {
        child = crossoverAssignments(population[p1Idx], population[p2Idx]);
      } else {
        child = { ...population[p1Idx] };
      }

      child = mutateAssignment(child, radios, mutationRate, coolingFactor, proximityGraph);

      const evalResult = evaluateAssignment(radios, child, channelSummary, maxChanges);
      nextPopulation.push(child);
      nextFitnessScores.push(evalResult.pain);

      if (evalResult.pain < bestEval.pain) {
        bestEval = evalResult;
        bestAssignment = child;
        bestGeneration = generations;
        lastImprovementGen = generations;
      }
    }

    // Sort
    const sorted = nextPopulation.map((_, i) => i).sort((a, b) => nextFitnessScores[a] - nextFitnessScores[b]);
    population = sorted.map(i => nextPopulation[i]);
    fitnessScores = sorted.map(i => nextFitnessScores[i]);

    // Stagnation injection
    if (generations - lastImprovementGen > stagnationLimit) {
      const injectCount = Math.max(2, Math.floor(populationSize * 0.15));
      for (let i = 0; i < injectCount; i++) {
        const idx = population.length - 1 - i;
        if (idx < 0) break;
        const fresh = createRandomAssignment(radios, proximityGraph);
        const freshEval = evaluateAssignment(radios, fresh, channelSummary, maxChanges);
        population[idx] = fresh;
        fitnessScores[idx] = freshEval.pain;
        if (freshEval.pain < bestEval.pain) {
          bestEval = freshEval;
          bestAssignment = fresh;
          bestGeneration = generations;
          lastImprovementGen = generations;
        }
      }
      stagnationCounter++;
      // Re-sort after injection
      sortPop();
    }

    // Convergence detection
    bestHistory.push(bestEval.pain);
    if (bestHistory.length > convergenceWindow) bestHistory.shift();
    if (bestHistory.length >= convergenceWindow && generations >= 50) {
      const oldest = bestHistory[0];
      const newest = bestHistory[bestHistory.length - 1];
      const improvement = Math.abs(oldest - newest);
      const pctImprovement = oldest > 0 ? (improvement / oldest) * 100 : 0;
      // Deep mode: more lenient convergence — only stop if truly stuck for a very long window
      const convergeFrac = searchMode === 'deep' ? 0.85 : 0.4;
      const convergeWindowMul = searchMode === 'deep' ? 3 : 1;
      if (pctImprovement < convergenceThreshold * convergeWindowMul && 
          (Date.now() - started) > timeBudgetMs * convergeFrac) {
        convergedEarly = true;
        // Break out to move to refinement phase
        break;
      }
    }

    // Progress
    reportCounter++;
    if (reportCounter % REPORT_INTERVAL === 0 || generations === 1) {
      await sendProgress('searching');
    }
  }

  // ── Refinement phase: local search on best assignment ──
  if (!convergedEarly) {
    // If we didn't converge early, still try refinement in remaining time
    await sendProgress('refining');
  }
  // Single refinement pass (all modes)
  let refined = refineAssignment(bestAssignment, radios, channelSummary, maxChanges, proximityGraph);
  let refinedEval = evaluateAssignment(radios, refined, channelSummary, maxChanges);
  let refinementAccepted = false;
  let refinementPasses = 1;
  if (refinedEval.pain < bestEval.pain) {
    bestAssignment = refined;
    bestEval = refinedEval;
    bestGeneration = generations + 1; // refinement counts as an extra gen
    refinementAccepted = true;
  }

  // Deep mode: multiple refinement passes with increasing aggressiveness
  if (searchMode === 'deep') {
    for (let pass = 0; pass < 5; pass++) {
      // Each pass uses the current best as starting point
      refined = refineAssignment(bestAssignment, radios, channelSummary, maxChanges, proximityGraph);
      refinedEval = evaluateAssignment(radios, refined, channelSummary, maxChanges);
      if (refinedEval.pain < bestEval.pain) {
        bestAssignment = refined;
        bestEval = refinedEval;
        bestGeneration = generations + 1 + pass;
        refinementAccepted = true;
        refinementPasses++;
      }
      await sendProgress(`Refining pass ${pass + 2}...`);
    }
  }

  await sendProgress('finalizing');

  // ── Build final result ──
  const result = assignmentToResult(bestAssignment, radios, channelSummary, aps, allAPs, proximityGraph, maxChanges, bestEval);

  result.searchMeta = {
    mode: 'ga',
    searchMode: searchMode,
    populationSize,
    timeBudgetMs,
    generationsTried: generations,
    bestGeneration,
    durationMs: Date.now() - started,
    stagnationResets: stagnationCounter,
    convergedEarly,
    refinementApplied: refinementAccepted,
    refinementPasses: refinementPasses,
    objectiveScore: Math.round(bestEval.pain * 100) / 100,
    bestImprovementPct: bestEval.improvementPct,
  };

  return result;
}

// ── Public entrypoint ────────────────────────────────────────────────────────

function runConstrainedOptimizer(radios, channelSummary, aps, options = {}) {
  const mode = String(options.searchMode || 'heuristic').toLowerCase();

  if (mode === 'ga' || mode === 'generational') {
    // Synchronous version — will return the heuristic fallback immediately.
    // Use /api/optimize/progress (SSE) or pass onProgress for async GA.
    // For direct sync calls (e.g. tests), fall back to heuristic.
    const result = runConstrainedOptimizerSingle(radios, channelSummary, aps, options);
    result.searchMeta = { mode: 'ga_sync_fallback', reason: 'Use runGeneticOptimizer via SSE for GA' };
    return result;
  }

  const result = runConstrainedOptimizerSingle(radios, channelSummary, aps, options);
  result.searchMeta = { mode: 'heuristic', generationsTried: 1, durationMs: 0 };
  return result;
}

module.exports = {
  runConstrainedOptimizer,
  runGeneticOptimizer,
  evaluateAssignment,
  CHANNELS_24,
  CHANNELS_5,
};

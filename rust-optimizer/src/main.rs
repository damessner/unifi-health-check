use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::time::Instant;

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNELS_24: &[u32] = &[1, 6, 11];
const CHANNELS_5: &[u32] = &[36, 40, 44, 48, 52, 56, 60, 64,
                             100, 104, 108, 112, 116, 120, 124, 128, 132, 136];

fn default_generation_limit() -> u32 { 100_000 }
fn default_convergence_threshold() -> f64 { 0.5 }
fn default_min_improvement_threshold() -> f64 { 5.0 }
fn default_false() -> bool { false }
fn default_search_mode() -> String { "rust".to_string() }

// ── Input types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RadioInput {
    #[serde(rename = "apMac")]
    ap_mac: String,
    radio: String,
    channel: u32,
    #[serde(rename = "cu_total")]
    cu_total: f64,
    #[serde(rename = "cci_count")]
    cci_count: f64,
    #[serde(rename = "tx_retries_pct")]
    tx_retries_pct: f64,
    #[serde(rename = "num_sta")]
    num_sta: u32,
    bw: Option<u32>,
    #[serde(rename = "cu_self_rx")]
    cu_self_rx: Option<f64>,
    #[serde(rename = "cu_self_tx")]
    cu_self_tx: Option<f64>,
    band: Option<String>,
    #[serde(rename = "apName")]
    ap_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChannelSummary {
    #[serde(rename = "channelCounts24")]
    channel_counts_24: Option<HashMap<String, u32>>,
    #[serde(rename = "channelCounts5")]
    channel_counts_5: Option<HashMap<String, u32>>,
}

#[derive(Debug, Deserialize)]
struct InputData {
    radios: Vec<RadioInput>,
    #[serde(rename = "channel_summary")]
    channel_summary: ChannelSummary,
    #[serde(rename = "max_changes")]
    max_changes: u32,
    #[serde(rename = "time_budget_ms")]
    time_budget_ms: u64,
    #[serde(rename = "population_size")]
    population_size: usize,
    #[serde(rename = "mutation_rate")]
    mutation_rate: f64,
    #[serde(rename = "elite_count")]
    elite_count: usize,
    #[serde(rename = "stagnation_limit")]
    stagnation_limit: u32,
    #[serde(rename = "convergence_window")]
    convergence_window: usize,
    #[serde(default = "default_generation_limit", rename = "generation_limit")]
    generation_limit: u32,
    #[serde(default = "default_convergence_threshold", rename = "convergence_threshold")]
    convergence_threshold: f64,
    #[serde(default = "default_min_improvement_threshold", rename = "min_improvement_threshold")]
    min_improvement_threshold: f64,
    #[serde(default = "default_false", rename = "enforce_min_improvement")]
    enforce_min_improvement: bool,
    #[serde(default = "default_search_mode", rename = "search_mode")]
    search_mode: String,
}

// ── Output types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ProgressEvent {
    r#type: String,
    generation: u32,
    #[serde(rename = "best_pain")]
    best_pain: f64,
    #[serde(rename = "best_improvement_pct")]
    best_improvement_pct: f64,
    #[serde(rename = "best_changes")]
    best_changes: u32,
    diversity: f64,
    #[serde(rename = "mean_pain")]
    mean_pain: f64,
    #[serde(rename = "median_pain")]
    median_pain: f64,
    #[serde(rename = "worst_pain")]
    worst_pain: f64,
    #[serde(rename = "elapsed_ms")]
    elapsed_ms: u64,
    #[serde(rename = "status_text")]
    status_text: String,
}

#[derive(Debug, Serialize)]
struct Metrics {
    #[serde(rename = "avgCu24")]
    avg_cu_24: f64,
    #[serde(rename = "maxCu24")]
    max_cu_24: f64,
    #[serde(rename = "avgCu5")]
    avg_cu_5: f64,
    #[serde(rename = "maxCu5")]
    max_cu_5: f64,
    #[serde(rename = "totalCci")]
    total_cci: f64,
    #[serde(rename = "congestedCount")]
    congested_count: u32,
    #[serde(rename = "warningCount")]
    warning_count: u32,
    #[serde(rename = "chVar24")]
    ch_var_24: f64,
    #[serde(rename = "chVar5")]
    ch_var_5: f64,
}

#[derive(Debug, Serialize)]
struct BeforeAfter {
    #[serde(rename = "avgCu24")]
    avg_cu_24: f64,
    #[serde(rename = "maxCu24")]
    max_cu_24: f64,
    #[serde(rename = "avgCu5")]
    avg_cu_5: f64,
    #[serde(rename = "maxCu5")]
    max_cu_5: f64,
    #[serde(rename = "totalCci")]
    total_cci: f64,
    #[serde(rename = "congestedCount")]
    congested_count: u32,
    #[serde(rename = "warningCount")]
    warning_count: u32,
    #[serde(rename = "chVar24")]
    ch_var_24: f64,
    #[serde(rename = "chVar5")]
    ch_var_5: f64,
}

#[derive(Debug, Serialize)]
struct Deltas {
    #[serde(rename = "avgCu24Delta")]
    avg_cu_24_delta: f64,
    #[serde(rename = "avgCu5Delta")]
    avg_cu_5_delta: f64,
    #[serde(rename = "maxCu24Delta")]
    max_cu_24_delta: f64,
    #[serde(rename = "maxCu5Delta")]
    max_cu_5_delta: f64,
    #[serde(rename = "cciReduction")]
    cci_reduction: f64,
    #[serde(rename = "congestedReduction")]
    congested_reduction: i64,
    #[serde(rename = "chVar24Delta")]
    ch_var_24_delta: f64,
    #[serde(rename = "chVar5Delta")]
    ch_var_5_delta: f64,
}

#[derive(Debug, Serialize)]
struct ImprovementReport {
    before: BeforeAfter,
    after: BeforeAfter,
    deltas: Deltas,
    #[serde(rename = "estimatedImprovementPct")]
    estimated_improvement_pct: f64,
}

#[derive(Debug, Serialize)]
struct PlanEntry {
    #[serde(rename = "suggestedChannel")]
    suggested_channel: u32,
    #[serde(rename = "changeNeeded")]
    change_needed: bool,
    impact: f64,
}

#[derive(Debug, Serialize)]
struct ChangedAp {
    mac: String,
    name: String,
    floor: String,
    #[serde(rename = "healthScore")]
    health_score: f64,
    changes: String,
    #[serde(rename = "oldNgCh")]
    old_ng_ch: Option<u32>,
    #[serde(rename = "newNgCh")]
    new_ng_ch: Option<u32>,
    #[serde(rename = "oldNaCh")]
    old_na_ch: Option<u32>,
    #[serde(rename = "newNaCh")]
    new_na_ch: Option<u32>,
    cu: f64,
    cci: f64,
}

#[derive(Debug, Serialize)]
struct BatchSummary {
    #[serde(rename = "maxChanges")]
    max_changes: u32,
    #[serde(rename = "changesSuggested")]
    changes_suggested: u32,
    #[serde(rename = "remainingWorstAPs")]
    remaining_worst_aps: u32,
    recommendation: String,
}

#[derive(Debug, Serialize)]
struct SearchMeta {
    mode: String,
    #[serde(rename = "searchMode")]
    search_mode: String,
    #[serde(rename = "populationSize")]
    population_size: usize,
    #[serde(rename = "timeBudgetMs")]
    time_budget_ms: u64,
    #[serde(rename = "generationsTried")]
    generations_tried: u32,
    #[serde(rename = "bestGeneration")]
    best_generation: u32,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    #[serde(rename = "stagnationResets")]
    stagnation_resets: u32,
    #[serde(rename = "convergedEarly")]
    converged_early: bool,
    #[serde(rename = "stopReason")]
    stop_reason: String,
    #[serde(rename = "generationLimit")]
    generation_limit: u32,
    #[serde(rename = "minImprovementThreshold")]
    min_improvement_threshold: f64,
    #[serde(rename = "refinementApplied")]
    refinement_applied: bool,
    #[serde(rename = "refinementPasses")]
    refinement_passes: u32,
    #[serde(rename = "objectiveScore")]
    objective_score: f64,
    #[serde(rename = "bestImprovementPct")]
    best_improvement_pct: f64,
}

#[derive(Debug, Serialize)]
struct CompleteEvent {
    r#type: String,
    success: bool,
    plan: HashMap<String, PlanEntry>,
    #[serde(rename = "changedAPs")]
    changed_aps: Vec<ChangedAp>,
    #[serde(rename = "totalAPs")]
    total_aps: u32,
    #[serde(rename = "improvementReport")]
    improvement_report: ImprovementReport,
    #[serde(rename = "batchSummary")]
    batch_summary: BatchSummary,
    #[serde(rename = "searchMeta")]
    search_meta: SearchMeta,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn is_24(radio: &str, band: &Option<String>) -> bool {
    radio == "ng" || band.as_deref() == Some("2.4GHz")
}

fn random_valid_channel(is24: bool) -> u32 {
    let mut rng = rand::thread_rng();
    let pool = if is24 { CHANNELS_24 } else { CHANNELS_5 };
    pool[rng.gen_range(0..pool.len())]
}

fn infer_floor(name: &str, index: usize) -> String {
    let upper = name.to_uppercase();
    if upper.contains("EG") || upper.contains("GROUND") || upper.contains("ERDGESCHOSS") {
        return "EG".to_string();
    }
    if upper.contains("1OG") || upper.contains("FIRST") || upper.contains("1ST") || upper.contains("1.OG") {
        return "1OG".to_string();
    }
    if upper.contains("2OG") || upper.contains("SECOND") || upper.contains("2ND") || upper.contains("2.OG") {
        return "2OG".to_string();
    }
    ["EG", "1OG", "2OG"][index % 3].to_string()
}

fn assignment_loads(
    assignment: &HashMap<String, u32>,
    radios: &[RadioInput],
) -> (HashMap<u32, u32>, HashMap<u32, u32>) {
    let mut load24: HashMap<u32, u32> = HashMap::new();
    let mut load5: HashMap<u32, u32> = HashMap::new();
    for r in radios {
        let key = format!("{}_{}", r.ap_mac, r.radio);
        let final_ch = assignment.get(&key).copied().unwrap_or(r.channel);
        if is_24(&r.radio, &r.band) {
            *load24.entry(final_ch).or_insert(0) += 1;
        } else {
            *load5.entry(final_ch).or_insert(0) += 1;
        }
    }
    (load24, load5)
}

fn channel_variance(load: &HashMap<u32, u32>) -> f64 {
    if load.is_empty() {
        return 0.0;
    }
    let vals: Vec<f64> = load.values().map(|&v| v as f64).collect();
    let avg = vals.iter().sum::<f64>() / vals.len() as f64;
    vals.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / vals.len() as f64
}

fn smart_channel(
    is24: bool,
    current_assignment: &HashMap<String, u32>,
    radios: &[RadioInput],
    ap_mac: &str,
) -> u32 {
    let pool = if is24 { CHANNELS_24 } else { CHANNELS_5 };
    let mut load: HashMap<u32, u32> = HashMap::new();

    for r in radios {
        let key = format!("{}_{}", r.ap_mac, r.radio);
        let ch = current_assignment.get(&key).copied().unwrap_or(r.channel);
        let r_is24 = is_24(&r.radio, &r.band);
        if r_is24 == is24 {
            *load.entry(ch).or_insert(0) += 1;
        }
    }

    let mut floor_neighbor_chs: HashSet<u32> = HashSet::new();
    let this_name = radios
        .iter()
        .find(|r| r.ap_mac == ap_mac)
        .and_then(|r| r.ap_name.as_deref())
        .unwrap_or(ap_mac)
        .to_string();
    let this_floor = infer_floor(&this_name, 0);
    for r in radios {
        if r.ap_mac == ap_mac {
            continue;
        }
        let other_name = r.ap_name.as_deref().unwrap_or(&r.ap_mac);
        let other_floor = infer_floor(other_name, 0);
        let r_is24 = is_24(&r.radio, &r.band);
        if r_is24 == is24 && other_floor == this_floor {
            let key = format!("{}_{}", r.ap_mac, r.radio);
            let ch = current_assignment.get(&key).copied().unwrap_or(r.channel);
            floor_neighbor_chs.insert(ch);
        }
    }

    let mut scored: Vec<(u32, f64)> = pool
        .iter()
        .map(|&ch| {
            let mut penalty = (*load.get(&ch).unwrap_or(&0) as f64) * 10.0;
            if floor_neighbor_chs.contains(&ch) {
                penalty += 20.0;
            }
            (ch, penalty)
        })
        .collect();
    scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

    let mut rng = rand::thread_rng();
    if rng.gen::<f64>() < 0.8 {
        let top = scored.iter().take(3).collect::<Vec<_>>();
        let idx = rng.gen_range(0..top.len());
        top[idx].0
    } else {
        pool[rng.gen_range(0..pool.len())]
    }
}

fn per_ap_impact(r: &RadioInput) -> f64 {
    ((r.cu_total * 1.0) + (r.cci_count * 8.0) + (r.tx_retries_pct * 0.5) + (r.num_sta as f64 * 2.0)).round()
}

// ── Fitness evaluation ───────────────────────────────────────────────────────

struct EvalResult {
    pain: f64,
    improvement_pct: f64,
    changes_count: u32,
    metrics: Metrics,
}

fn evaluate_assignment(
    assignment: &HashMap<String, u32>,
    radios: &[RadioInput],
    channel_summary: &ChannelSummary,
) -> EvalResult {
    let _ = channel_summary;

    let (final_ch24, final_ch5) = assignment_loads(assignment, radios);
    let mut changes: u32 = 0;

    for r in radios {
        let key = format!("{}_{}", r.ap_mac, r.radio);
        if let Some(&assigned) = assignment.get(&key) {
            if assigned != r.channel {
                changes += 1;
            }
        }
    }

    // Compute estimated after-metrics
    let mut sum_cu_24 = 0.0; let mut count_24 = 0; let mut max_cu_24 = 0.0;
    let mut sum_cu_5 = 0.0; let mut count_5 = 0; let mut max_cu_5 = 0.0;
    let mut total_cci = 0.0;
    let mut congested = 0;
    let mut warning = 0;

    for r in radios {
        let key = format!("{}_{}", r.ap_mac, r.radio);
        let final_ch = assignment.get(&key).copied().unwrap_or(r.channel);
        let is24 = is_24(&r.radio, &r.band);
        let ch_counts = if is24 { &final_ch24 } else { &final_ch5 };
        let final_ch_load = *ch_counts.get(&final_ch).unwrap_or(&1);
        let new_cci = (final_ch_load as f64 - 1.0).max(0.0);
        let cci_reduction = r.cci_count - new_cci;
        let baseline = (r.cu_self_rx.unwrap_or(0.0) + r.cu_self_tx.unwrap_or(0.0)).max(8.0);
        let est_cu = baseline.max((r.cu_total - cci_reduction * 8.0).min(100.0));

        if is24 {
            sum_cu_24 += est_cu; count_24 += 1;
            if est_cu > max_cu_24 { max_cu_24 = est_cu; }
        } else {
            sum_cu_5 += est_cu; count_5 += 1;
            if est_cu > max_cu_5 { max_cu_5 = est_cu; }
        }
        total_cci += new_cci;
        if est_cu > 75.0 || new_cci > 12.0 { congested += 1; }
        else if est_cu > 50.0 || new_cci > 4.0 { warning += 1; }
    }

    // Compute improvement vs current
    let avg_cu_before = radios.iter().map(|r| r.cu_total).sum::<f64>() / radios.len() as f64;
    let avg_cu_after = (sum_cu_24 + sum_cu_5) / (count_24 + count_5).max(1) as f64;
    let improvement_pct = if avg_cu_before > 0.0 {
        ((avg_cu_before - avg_cu_after) / avg_cu_before * 100.0).round()
    } else { 0.0 };

    let var24 = channel_variance(&final_ch24);
    let var5 = channel_variance(&final_ch5);

    // Pain score
    let pain =
        avg_cu_after * 1.4 +
        total_cci * 2.2 +
        congested as f64 * 30.0 +
        warning as f64 * 10.0 +
        changes as f64 * 0.3 -
        improvement_pct.max(0.0) * 8.0 +
        (var24 + var5) * 0.5;

    EvalResult {
        pain: (pain * 100.0).round() / 100.0,
        improvement_pct,
        changes_count: changes,
        metrics: Metrics {
            avg_cu_24: (sum_cu_24 / count_24.max(1) as f64 * 10.0).round() / 10.0,
            max_cu_24,
            avg_cu_5: (sum_cu_5 / count_5.max(1) as f64 * 10.0).round() / 10.0,
            max_cu_5,
            total_cci: (total_cci * 10.0).round() / 10.0,
            congested_count: congested,
            warning_count: warning,
            ch_var_24: (var24 * 10.0).round() / 10.0,
            ch_var_5: (var5 * 10.0).round() / 10.0,
        },
    }
}

// ── GA helpers ───────────────────────────────────────────────────────────────

fn create_random_assignment(radios: &[RadioInput]) -> HashMap<String, u32> {
    let mut rng = rand::thread_rng();
    let mut assignment = HashMap::new();
    for r in radios {
        if rng.gen::<f64>() < 0.85 {
            let key = format!("{}_{}", r.ap_mac, r.radio);
            assignment.insert(key, smart_channel(is_24(&r.radio, &r.band), &assignment, radios, &r.ap_mac));
        }
    }
    assignment
}

fn crossover(a: &HashMap<String, u32>, b: &HashMap<String, u32>) -> HashMap<String, u32> {
    let mut rng = rand::thread_rng();
    let mut child = HashMap::new();
    let mut all_keys: Vec<&String> = Vec::new();
    for k in a.keys() { all_keys.push(k); }
    for k in b.keys() { if !all_keys.contains(&k) { all_keys.push(k); } }
    for key in all_keys {
        let a_val = a.get(key);
        let b_val = b.get(key);
        match (a_val, b_val) {
            (Some(&av), Some(&bv)) => { child.insert(key.clone(), if rng.gen::<f64>() < 0.5 { av } else { bv }); }
            (Some(&av), None) => { if rng.gen::<f64>() < 0.9 { child.insert(key.clone(), av); } }
            (None, Some(&bv)) => { if rng.gen::<f64>() < 0.9 { child.insert(key.clone(), bv); } }
            _ => {}
        }
    }
    child
}

fn mutate(assignment: &HashMap<String, u32>, radios: &[RadioInput], rate: f64) -> HashMap<String, u32> {
    let mut rng = rand::thread_rng();
    let mut result = assignment.clone();
    for r in radios {
        if rng.gen::<f64>() < rate {
            let key = format!("{}_{}", r.ap_mac, r.radio);
            result.insert(key, smart_channel(is_24(&r.radio, &r.band), &result, radios, &r.ap_mac));
        }
    }
    result
}

fn refine_assignment(
    assignment: &HashMap<String, u32>,
    radios: &[RadioInput],
    channel_summary: &ChannelSummary,
    _max_changes: u32,
) -> HashMap<String, u32> {
    let mut best = assignment.clone();
    let keys: Vec<String> = best.keys().cloned().collect();
    let mut improved = true;
    let mut rounds = 0;

    while improved && rounds < 5 {
        improved = false;
        rounds += 1;
        for key in &keys {
            let r_opt = radios.iter().find(|x| format!("{}_{}", x.ap_mac, x.radio) == *key);
            if r_opt.is_none() {
                continue;
            }
            let r = r_opt.unwrap();
            let is24 = is_24(&r.radio, &r.band);
            let pool = if is24 { CHANNELS_24 } else { CHANNELS_5 };
            let original = best.get(key).copied();
            let current_eval = evaluate_assignment(&best, radios, channel_summary);

            for &ch in pool {
                if Some(ch) == original {
                    continue;
                }
                let mut trial = best.clone();
                trial.insert(key.clone(), ch);
                let trial_eval = evaluate_assignment(&trial, radios, channel_summary);
                if trial_eval.pain < current_eval.pain {
                    best = trial;
                    improved = true;
                    break;
                }
            }
        }
    }

    best
}

fn tournament_select(fitness_scores: &[f64], tournament_size: usize) -> usize {
    let mut rng = rand::thread_rng();
    let mut best = 0;
    let mut best_fitness = f64::MAX;
    for _ in 0..tournament_size {
        let idx = rng.gen_range(0..fitness_scores.len());
        if fitness_scores[idx] < best_fitness {
            best = idx;
            best_fitness = fitness_scores[idx];
        }
    }
    best
}

// ── Output helpers ───────────────────────────────────────────────────────────

fn emit_progress(
    generation: u32,
    best_pain: f64,
    best_improvement_pct: f64,
    best_changes: u32,
    fitness_scores: &[f64],
    elapsed_ms: u64,
) {
    let mut sorted = fitness_scores.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let diversity = sorted.last().unwrap_or(&0.0) - sorted.first().unwrap_or(&0.0);
    let mean_pain = sorted.iter().sum::<f64>() / sorted.len() as f64;
    let median_pain = sorted[sorted.len() / 2];

    let ev = ProgressEvent {
        r#type: "progress".to_string(),
        generation,
        best_pain: (best_pain * 100.0).round() / 100.0,
        best_improvement_pct: best_improvement_pct.round(),
        best_changes,
        diversity: (diversity * 100.0).round() / 100.0,
        mean_pain: (mean_pain * 100.0).round() / 100.0,
        median_pain: (median_pain * 100.0).round() / 100.0,
        worst_pain: (sorted.last().unwrap_or(&0.0) * 100.0).round() / 100.0,
        elapsed_ms,
        status_text: format!("Generation {}: best {:.1}", generation, best_pain),
    };

    let mut stdout = io::stdout();
    let _ = writeln!(stdout, "{}", serde_json::to_string(&ev).unwrap());
    let _ = stdout.flush();
}

// ── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    let stdin = io::stdin();
    let input_line = stdin.lock().lines().next().expect("no input line").expect("failed to read input");
    let input: InputData = serde_json::from_str(&input_line).expect("failed to parse input JSON");

    let start = Instant::now();
    let max_gen: u32 = input.generation_limit.max(100);

    // Initialize population
    let pop_size = input.population_size;
    let elite_count = input.elite_count.min(pop_size / 4);
    let mut rng = rand::thread_rng();

    let mut population: Vec<HashMap<String, u32>> = Vec::with_capacity(pop_size);
    let mut fitness_scores: Vec<f64> = Vec::with_capacity(pop_size);

    for _ in 0..pop_size {
        let assignment = create_random_assignment(&input.radios);
        let eval = evaluate_assignment(&assignment, &input.radios, &input.channel_summary);
        population.push(assignment);
        fitness_scores.push(eval.pain);
    }

    // Sort
    let mut indices: Vec<usize> = (0..pop_size).collect();
    indices.sort_by(|&a, &b| fitness_scores[a].partial_cmp(&fitness_scores[b]).unwrap());
    let sorted_pop: Vec<HashMap<String, u32>> = indices.iter().map(|&i| population[i].clone()).collect();
    let sorted_fit: Vec<f64> = indices.iter().map(|&i| fitness_scores[i]).collect();
    population = sorted_pop;
    fitness_scores = sorted_fit;

    let mut best_assignment = population[0].clone();
    let mut best_eval = evaluate_assignment(&best_assignment, &input.radios, &input.channel_summary);
    let mut best_generation = 0u32;
    let mut generations: u32 = 0;
    let mut last_improvement_gen = 0u32;
    let mut stagnation_counter = 0u32;
    let mut converged_early = false;
    let mut stop_reason = "time_budget".to_string();
    let mut best_history: Vec<f64> = Vec::new();

    // Initial progress
    let elapsed = start.elapsed().as_millis() as u64;
    emit_progress(0, best_eval.pain, best_eval.improvement_pct, best_eval.changes_count, &fitness_scores, elapsed);

    let time_budget = std::time::Duration::from_millis(input.time_budget_ms);
    let mut report_counter = 0u32;
    let report_interval = (pop_size as u32 * 5).max(10);
    let mut last_report_ms = 0u64;

    // Evolution loop
    while start.elapsed() < time_budget && generations < max_gen {
        generations += 1;
        let elapsed_frac = start.elapsed().as_secs_f64() / time_budget.as_secs_f64();
        let cooling_factor = 1.0 - elapsed_frac.min(1.0);
        let adjusted_rate = input.mutation_rate * (0.3 + 0.7 * cooling_factor);

        let mut next_pop: Vec<HashMap<String, u32>> = Vec::with_capacity(pop_size);
        let mut next_fit: Vec<f64> = Vec::with_capacity(pop_size);

        // Elitism
        for i in 0..elite_count.min(pop_size) {
            next_pop.push(population[i].clone());
            next_fit.push(fitness_scores[i]);
        }

        // Fill rest
        while next_pop.len() < pop_size {
            let p1 = tournament_select(&fitness_scores, 3);
            let p2 = tournament_select(&fitness_scores, 3);

            let child = if rng.gen::<f64>() < 0.8 {
                crossover(&population[p1], &population[p2])
            } else {
                population[p1].clone()
            };

            let child = mutate(&child, &input.radios, adjusted_rate);
            let eval = evaluate_assignment(&child, &input.radios, &input.channel_summary);
            next_pop.push(child);
            next_fit.push(eval.pain);

            if eval.pain < best_eval.pain {
                best_eval = eval;
                best_assignment = next_pop.last().unwrap().clone();
                best_generation = generations;
                last_improvement_gen = generations;
            }
        }

        // Sort
        let mut si: Vec<usize> = (0..pop_size).collect();
        si.sort_by(|&a, &b| next_fit[a].partial_cmp(&next_fit[b]).unwrap());
        population = si.iter().map(|&i| next_pop[i].clone()).collect();
        fitness_scores = si.iter().map(|&i| next_fit[i]).collect();

        // Stagnation injection
        if generations - last_improvement_gen > input.stagnation_limit {
            let inject_count = (pop_size as f64 * 0.15).max(2.0) as usize;
            for i in 0..inject_count.min(pop_size) {
                let idx = pop_size - 1 - i;
                let fresh = create_random_assignment(&input.radios);
                let fresh_eval = evaluate_assignment(&fresh, &input.radios, &input.channel_summary);
                population[idx] = fresh;
                fitness_scores[idx] = fresh_eval.pain;
                if fresh_eval.pain < best_eval.pain {
                    best_eval = fresh_eval;
                    best_assignment = population[idx].clone();
                    best_generation = generations;
                    last_improvement_gen = generations;
                }
            }
            // Re-sort
            let mut si: Vec<usize> = (0..pop_size).collect();
            si.sort_by(|&a, &b| fitness_scores[a].partial_cmp(&fitness_scores[b]).unwrap());
            population = si.iter().map(|&i| population[i].clone()).collect();
            fitness_scores = si.iter().map(|&i| fitness_scores[i]).collect();
            stagnation_counter += 1;
        }

        // Convergence detection
        best_history.push(best_eval.pain);
        if best_history.len() > input.convergence_window {
            best_history.remove(0);
        }
        if best_history.len() >= input.convergence_window && generations >= 50 {
            let oldest = best_history[0];
            let newest = *best_history.last().unwrap_or(&oldest);
            let improvement = (oldest - newest).abs();
            let pct_improvement = if oldest > 0.0 { (improvement / oldest) * 100.0 } else { 0.0 };
            let deep = input.search_mode.to_lowercase() == "deep";
            let converge_frac = if deep { 0.85 } else { 0.4 };
            let converge_window_mul = if deep { 3.0 } else { 1.0 };
            let elapsed_frac = start.elapsed().as_secs_f64() / time_budget.as_secs_f64().max(1e-9);
            if pct_improvement < input.convergence_threshold * converge_window_mul && elapsed_frac > converge_frac {
                converged_early = true;
                stop_reason = "converged_early".to_string();
                break;
            }
        }

        // Progress
        report_counter += 1;
        let now_ms = start.elapsed().as_millis() as u64;
        if (report_counter % report_interval == 0 || generations == 1) && (now_ms - last_report_ms >= 100 || generations <= 5) {
            last_report_ms = now_ms;
            let elapsed = now_ms;
            emit_progress(generations, best_eval.pain, best_eval.improvement_pct, best_eval.changes_count, &fitness_scores, elapsed);
        }
    }

    if !converged_early && generations >= max_gen {
        stop_reason = "generation_limit".to_string();
    }

    // Local refinement pass (and extra passes for deep mode)
    let mut refinement_applied = false;
    let mut refinement_passes = 1u32;
    let refined = refine_assignment(&best_assignment, &input.radios, &input.channel_summary, input.max_changes);
    let refined_eval = evaluate_assignment(&refined, &input.radios, &input.channel_summary);
    if refined_eval.pain < best_eval.pain {
        best_assignment = refined;
        best_eval = refined_eval;
        best_generation = generations + 1;
        refinement_applied = true;
    }

    if input.search_mode.to_lowercase() == "deep" {
        for pass in 0..5 {
            let refined = refine_assignment(&best_assignment, &input.radios, &input.channel_summary, input.max_changes);
            let refined_eval = evaluate_assignment(&refined, &input.radios, &input.channel_summary);
            if refined_eval.pain < best_eval.pain {
                best_assignment = refined;
                best_eval = refined_eval;
                best_generation = generations + 1 + pass as u32;
                refinement_applied = true;
                refinement_passes += 1;
            }
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Build complete result
    let total_aps = input.radios.iter().map(|r| r.ap_mac.as_str()).collect::<HashSet<&str>>().len() as u32;

    let before_counts24: HashMap<u32, u32> = input
        .channel_summary
        .channel_counts_24
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| k.parse::<u32>().ok().map(|kk| (kk, v)))
        .collect();
    let before_counts5: HashMap<u32, u32> = input
        .channel_summary
        .channel_counts_5
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| k.parse::<u32>().ok().map(|kk| (kk, v)))
        .collect();
    let before_var_24 = channel_variance(&before_counts24);
    let before_var_5 = channel_variance(&before_counts5);

    // Compute before metrics
    let mut bef_sum_24 = 0.0; let mut bef_cnt_24 = 0; let mut bef_max_24 = 0.0;
    let mut bef_sum_5 = 0.0; let mut bef_cnt_5 = 0; let mut bef_max_5 = 0.0;
    let mut bef_cci = 0.0; let mut bef_con = 0; let mut bef_warn = 0;
    for r in &input.radios {
        let is24 = is_24(&r.radio, &r.band);
        if is24 { bef_sum_24 += r.cu_total; bef_cnt_24 += 1; if r.cu_total > bef_max_24 { bef_max_24 = r.cu_total; } }
        else { bef_sum_5 += r.cu_total; bef_cnt_5 += 1; if r.cu_total > bef_max_5 { bef_max_5 = r.cu_total; } }
        bef_cci += r.cci_count;
        if r.cu_total > 75.0 || r.cci_count > 12.0 { bef_con += 1; }
        else if r.cu_total > 50.0 || r.cci_count > 4.0 { bef_warn += 1; }
    }

    let before = BeforeAfter {
        avg_cu_24: (bef_sum_24 / bef_cnt_24.max(1) as f64).round(),
        max_cu_24: bef_max_24.round(),
        avg_cu_5: (bef_sum_5 / bef_cnt_5.max(1) as f64).round(),
        max_cu_5: bef_max_5.round(),
        total_cci: bef_cci.round(),
        congested_count: bef_con,
        warning_count: bef_warn,
        ch_var_24: (before_var_24 * 10.0).round() / 10.0,
        ch_var_5: (before_var_5 * 10.0).round() / 10.0,
    };

    // Compute deltas
    let avg_cu_24_delta = before.avg_cu_24 - best_eval.metrics.avg_cu_24;
    let avg_cu_5_delta = before.avg_cu_5 - best_eval.metrics.avg_cu_5;
    let max_cu_24_delta = before.max_cu_24 - best_eval.metrics.max_cu_24;
    let max_cu_5_delta = before.max_cu_5 - best_eval.metrics.max_cu_5;
    let cci_reduction = before.total_cci - best_eval.metrics.total_cci;
    let congested_reduction = before.congested_count as i64 - best_eval.metrics.congested_count as i64;
    let ch_var_24_delta = before.ch_var_24 - best_eval.metrics.ch_var_24;
    let ch_var_5_delta = before.ch_var_5 - best_eval.metrics.ch_var_5;

    let after = BeforeAfter {
        avg_cu_24: best_eval.metrics.avg_cu_24.round(),
        max_cu_24: best_eval.metrics.max_cu_24.round(),
        avg_cu_5: best_eval.metrics.avg_cu_5.round(),
        max_cu_5: best_eval.metrics.max_cu_5.round(),
        total_cci: best_eval.metrics.total_cci.round(),
        congested_count: best_eval.metrics.congested_count,
        warning_count: best_eval.metrics.warning_count,
        ch_var_24: best_eval.metrics.ch_var_24,
        ch_var_5: best_eval.metrics.ch_var_5,
    };

    let improvement_report = ImprovementReport {
        estimated_improvement_pct: best_eval.improvement_pct.max(0.0),
        before,
        after,
        deltas: Deltas {
            avg_cu_24_delta: (avg_cu_24_delta * 10.0).round() / 10.0,
            avg_cu_5_delta: (avg_cu_5_delta * 10.0).round() / 10.0,
            max_cu_24_delta: (max_cu_24_delta * 10.0).round() / 10.0,
            max_cu_5_delta: (max_cu_5_delta * 10.0).round() / 10.0,
            cci_reduction: (cci_reduction * 10.0).round() / 10.0,
            congested_reduction,
            ch_var_24_delta: (ch_var_24_delta * 10.0).round() / 10.0,
            ch_var_5_delta: (ch_var_5_delta * 10.0).round() / 10.0,
        },
    };

    let mut plan = HashMap::new();
    let mut changed_aps = Vec::new();
    let ap_name_map: HashMap<&str, &str> = input.radios.iter().map(|r| (r.ap_mac.as_str(), r.ap_name.as_deref().unwrap_or("?"))).collect();

    for r in &input.radios {
        let key = format!("{}_{}", r.ap_mac, r.radio);
        if let Some(&ch) = best_assignment.get(&key) {
            if ch != r.channel {
                plan.insert(key.clone(), PlanEntry {
                    suggested_channel: ch,
                    change_needed: true,
                    impact: ((best_eval.metrics.avg_cu_24 + best_eval.metrics.avg_cu_5) / 2.0).round(),
                });
                // Only add once per AP
                if !changed_aps.iter().any(|c: &ChangedAp| c.mac == r.ap_mac) {
                    let name = ap_name_map.get(r.ap_mac.as_str()).copied().unwrap_or("?").to_string();
                    changed_aps.push(ChangedAp {
                        mac: r.ap_mac.clone(),
                        floor: infer_floor(&name, changed_aps.len()),
                        name,
                        health_score: per_ap_impact(r),
                        changes: format!("{}: {}→{}", if is_24(&r.radio, &r.band) { "2.4G" } else { "5G" }, r.channel, ch),
                        old_ng_ch: if is_24(&r.radio, &r.band) { Some(r.channel) } else { None },
                        new_ng_ch: if is_24(&r.radio, &r.band) { Some(ch) } else { None },
                        old_na_ch: if !is_24(&r.radio, &r.band) { Some(r.channel) } else { None },
                        new_na_ch: if !is_24(&r.radio, &r.band) { Some(ch) } else { None },
                        cu: r.cu_total,
                        cci: r.cci_count,
                    });
                }
            }
        }
    }

    changed_aps.sort_by(|a, b| b.health_score.partial_cmp(&a.health_score).unwrap_or(std::cmp::Ordering::Equal));
    let keep_n = input.max_changes.max(1) as usize;
    if changed_aps.len() > keep_n {
        let keep_macs: HashSet<String> = changed_aps.iter().take(keep_n).map(|ap| ap.mac.clone()).collect();
        plan.retain(|k, _| keep_macs.contains(k.split('_').next().unwrap_or("")));
        changed_aps.truncate(keep_n);
    }

    if input.enforce_min_improvement && improvement_report.estimated_improvement_pct < input.min_improvement_threshold {
        plan.clear();
        changed_aps.clear();
    }

    let changes_count = changed_aps.len() as u32;
    let changes_empty = changed_aps.is_empty();

    let complete = CompleteEvent {
        r#type: "complete".to_string(),
        success: true,
        plan,
        changed_aps,
        total_aps,
        improvement_report,
        batch_summary: BatchSummary {
            max_changes: input.max_changes,
            changes_suggested: changes_count,
            remaining_worst_aps: total_aps.saturating_sub(changes_count),
            recommendation: if changes_empty {
                if input.enforce_min_improvement {
                    format!("No beneficial changes found above {:.0}% predicted improvement.", input.min_improvement_threshold)
                } else {
                    "No beneficial changes found.".to_string()
                }
            } else {
                format!("Apply these {} high-impact changes, then re-scan and re-run (3-5 rounds total).", changes_count)
            },
        },
        search_meta: SearchMeta {
            mode: "rust_ga".to_string(),
            search_mode: input.search_mode.clone(),
            population_size: pop_size,
            time_budget_ms: input.time_budget_ms,
            generations_tried: generations,
            best_generation,
            duration_ms: elapsed_ms,
            stagnation_resets: stagnation_counter,
            converged_early,
            stop_reason,
            generation_limit: max_gen,
            min_improvement_threshold: input.min_improvement_threshold,
            refinement_applied,
            refinement_passes,
            objective_score: (best_eval.pain * 100.0).round() / 100.0,
            best_improvement_pct: best_eval.improvement_pct.max(0.0),
        },
    };

    let mut stdout = io::stdout();
    let _ = writeln!(stdout, "{}", serde_json::to_string(&complete).unwrap());
    let _ = stdout.flush();
}

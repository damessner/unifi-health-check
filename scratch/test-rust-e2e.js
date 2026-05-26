'use strict';

const { spawn } = require('child_process');
const path = require('path');
const unifi = require('../services/unifiClient');
const analyzer = require('../services/analyzer');

async function main() {
  console.log('Fetching live UniFi data...');
  const devices = await unifi.getDevices();
  const clients = await unifi.getClients();
  const channel = analyzer.analyzeChannels(devices);

  const rustBin = path.join(__dirname, '..', 'rust-optimizer', 'target', 'release', 'unifi-ga-optimizer.exe');
  console.log('Binary:', rustBin);
  console.log('Radios:', channel.radios.length);

  const input = {
    radios: channel.radios
      .filter(r => r.channel != null)
      .map(r => ({
      apMac: r.apMac, radio: r.radio, channel: r.channel,
      cu_total: r.cu_total || 0, cci_count: r.cci_count || 0,
      tx_retries_pct: r.tx_retries_pct || 0, num_sta: r.num_sta || 0,
      bw: r.bw || null, cu_self_rx: r.cu_self_rx || 0, cu_self_tx: r.cu_self_tx || 0,
      band: r.band || null, apName: r.apName || r.apMac,
    })),
    channel_summary: {
      channelCounts24: channel.summary.channelCounts24 || {},
      channelCounts5: channel.summary.channelCounts5 || {},
    },
    max_changes: 8,
    time_budget_ms: 5000,
    population_size: 40,
    mutation_rate: 0.25,
    elite_count: 4,
    stagnation_limit: 200,
    convergence_window: 300,
  };

  console.log('Spawning Rust optimizer...');
  const proc = spawn(rustBin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let progressCount = 0;
  let completeData = null;

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'progress') {
          progressCount++;
          if (progressCount <= 3 || progressCount % 10 === 0) {
            console.log(`  [gen ${msg.generation}] best=${msg.best_pain.toFixed(1)} imp=${msg.best_improvement_pct}% elapsed=${msg.elapsed_ms}ms`);
          }
        } else if (msg.type === 'complete') {
          completeData = msg;
        }
      } catch (e) {
        console.error('Parse error');
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error('[stderr]', chunk.toString().trim());
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      console.log('Exit code:', code);
      if (code !== 0 && !completeData) {
        reject(new Error(`Exit code ${code}`));
      } else {
        resolve();
      }
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input) + '\n');
    proc.stdin.end();
  });

  if (completeData) {
    const changed = (completeData.changedAPs || []).length;
    const meta = completeData.searchMeta || completeData.search_meta || {};
    console.log('\n--- RESULT ---');
    console.log('Changed APs:', changed);
    console.log('Generations:', meta.generationsTried ?? meta.generations_tried);
    console.log('Duration:', meta.durationMs ?? meta.duration_ms, 'ms');
    console.log('Best score:', meta.objectiveScore ?? meta.objective_score);
    console.log('Improvement:', meta.bestImprovementPct ?? meta.best_improvement_pct, '%');
    completeData.changedAPs && completeData.changedAPs.slice(0, 5).forEach(ap => {
      console.log('  ', ap.mac, ap.name, '→', ap.changes);
    });
  }
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});

"use strict";

const unifi = require("../services/unifiClient");
const analyzer = require("../services/analyzer");

async function main() {
  const devices = await unifi.getDevices();
  const channel = analyzer.analyzeChannels(devices);

  const aps = devices.filter(d => d.type === "uap");

  const byStats = new Map();
  const byCfg = new Map();
  aps.forEach(ap => {
    (ap.radio_table_stats || []).forEach(rs => {
      byStats.set(`${ap.mac}_${rs.radio}`, {
        apName: ap.name || ap.hostname || ap.mac,
        radio: rs.radio,
        channel: rs.channel
      });
    });
    (ap.radio_table || []).forEach(r => {
      byCfg.set(`${ap.mac}_${r.radio}`, {
        apName: ap.name || ap.hostname || ap.mac,
        radio: r.radio,
        channel: r.channel
      });
    });
  });

  let mismatchVsStats = 0;
  let mismatchVsConfigured = 0;
  channel.radios.forEach(r => {
    const key = `${r.apMac}_${r.radio}`;
    const live = byStats.get(key);
    const cfg = byCfg.get(key);
    if (!live || live.channel !== r.channel) mismatchVsStats++;
    if (!cfg || cfg.channel !== r.channel) mismatchVsConfigured++;
  });

  const cfgVsLive = [];
  byCfg.forEach((cfg, key) => {
    const live = byStats.get(key);
    if (!live) return;
    if (cfg.channel !== live.channel) {
      cfgVsLive.push({
        apName: cfg.apName,
        radio: cfg.radio,
        configuredChannel: cfg.channel,
        liveChannel: live.channel
      });
    }
  });

  console.log(JSON.stringify({
    apCount: aps.length,
    radioCount: channel.radios.length,
    analyzerMismatchVsLiveStats: mismatchVsStats,
    analyzerMismatchVsConfigured: mismatchVsConfigured,
    configuredVsLiveMismatchCount: cfgVsLive.length
  }, null, 2));

  if (cfgVsLive.length > 0) {
    console.log("\nConfigured vs live mismatches (first 30):");
    console.table(cfgVsLive.slice(0, 30));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

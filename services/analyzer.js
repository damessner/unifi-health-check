/**
 * Diagnostic & Analysis Service for UniFi Network Data
 */

// UniFi Hardware Model Code to friendly name map
const MODEL_MAPPINGS = {
  'U7PG2': 'UAP-AC-Pro',
  'UAP6MP': 'U6-Pro',
  'U6Lite': 'U6-Lite',
  'U6LR': 'U6-LR',
  'U7Pro': 'U7-Pro',
  'UAP-AC-Pro': 'UAP-AC-Pro',
  'U6-Pro': 'U6-Pro'
};

function getFriendlyModelName(model) {
  if (!model) return 'UAP-AC-Pro';
  return MODEL_MAPPINGS[model] || model;
}

const HEALTH_THRESHOLDS = {
  criticalCu: 75,
  criticalCci: 12,
  warningCu: 50,
  warningCci: 4,
  warningRetries: 25
};

class NetworkAnalyzer {
  /**
   * Run RF channel loading and interference diagnostics.
   * @param {Array} devices - List of devices from UniFi API
   */
  analyzeChannels(devices) {
    const aps = devices.filter(d => d.type === 'uap');
    
    // 1. Group radios by band and channel
    const bands = {
      '2.4GHz': { total: 0, channels: {}, utilizationSum: 0, utilizationCount: 0 },
      '5GHz': { total: 0, channels: {}, utilizationSum: 0, utilizationCount: 0 }
    };

    const apRadios = [];

    aps.forEach(ap => {
      const radioSettings = {};
      if (ap.radio_table) {
        ap.radio_table.forEach(r => {
          radioSettings[r.radio] = r;
        });
      }

      if (ap.radio_table_stats) {
        ap.radio_table_stats.forEach(rs => {
          const bandName = rs.radio === 'ng' ? '2.4GHz' : '5GHz';
          const ch = String(rs.channel);
          
          bands[bandName].total++;
          bands[bandName].channels[ch] = (bands[bandName].channels[ch] || 0) + 1;
          
          if (rs.cu_total !== undefined && rs.cu_total !== null) {
            bands[bandName].utilizationSum += rs.cu_total;
            bands[bandName].utilizationCount++;
          }

          const rSetting = radioSettings[rs.radio] || {};

          apRadios.push({
            apName: ap.name || ap.hostname || getFriendlyModelName(ap.model) || ap.mac,
            apMac: ap.mac,
            ip: ap.ip,
            model: getFriendlyModelName(ap.model),
            radio: rs.radio,
            band: bandName,
            channel: rs.channel,
            cu_total: rs.cu_total || 0,
            cu_self_rx: rs.cu_self_rx || 0,
            cu_self_tx: rs.cu_self_tx || 0,
            tx_retries_pct: rs.tx_retries_pct || 0,
            satisfaction: rs.satisfaction || 100,
            num_sta: rs.num_sta || 0,
            
            // Detailed configured/live radio properties
            tx_power: rs.tx_power || null, // actual operational power
            tx_power_mode: rSetting.tx_power_mode || 'auto',
            configured_tx_power: rSetting.tx_power !== undefined ? rSetting.tx_power : null,
            antenna_gain: rSetting.antenna_gain !== undefined ? rSetting.antenna_gain : null,
            min_rssi_enabled: !!rSetting.min_rssi_enabled,
            min_rssi: rSetting.min_rssi || null,
            ht: rSetting.ht || '',
            bw: rs.bw || null
          });
        });
      }
    });

    // Compute average channel utilization per band
    const avgUtil24 = bands['2.4GHz'].utilizationCount > 0 
      ? Math.round(bands['2.4GHz'].utilizationSum / bands['2.4GHz'].utilizationCount) 
      : 0;
    const avgUtil5 = bands['5GHz'].utilizationCount > 0 
      ? Math.round(bands['5GHz'].utilizationSum / bands['5GHz'].utilizationCount) 
      : 0;

    // Calculate Co-Channel Interference (CCI) count for each AP radio
    apRadios.forEach(r => {
      const activeChannelCount = bands[r.band].channels[String(r.channel)] || 1;
      r.cci_count = activeChannelCount - 1; // Number of other APs sharing the same channel
      
      // Determine radio health level
      if (r.cu_total > HEALTH_THRESHOLDS.criticalCu || r.cci_count > HEALTH_THRESHOLDS.criticalCci) {
        r.health = 'critical';
      } else if (r.cu_total > HEALTH_THRESHOLDS.warningCu || r.cci_count > HEALTH_THRESHOLDS.warningCci || r.tx_retries_pct > HEALTH_THRESHOLDS.warningRetries) {
        r.health = 'warning';
      } else {
        r.health = 'healthy';
      }
    });

    // 2. Generate specific optimization suggestions
    const recommendations = [];
    
    // Check 2.4GHz recommendations
    const ch6Count = bands['2.4GHz'].channels['6'] || 0;
    const total24Count = bands['2.4GHz'].total || 1;
    if (ch6Count / total24Count > 0.4) {
      recommendations.push({
        band: '2.4GHz',
        severity: 'warning',
        title: 'High Channel 6 Concentration',
        description: `Currently ${ch6Count} out of ${total24Count} APs are operating on Channel 6. This is causing extreme Co-Channel Interference.`,
        action: 'Re-distribute APs evenly across non-overlapping Channels 1, 6, and 11. Reduce 2.4GHz Transmit Power to Low/Medium to limit cell overlap.'
      });
    }

    // Check 5GHz recommendations
    const ch40Count = bands['5GHz'].channels['40'] || 0;
    const ch44Count = bands['5GHz'].channels['44'] || 0;
    const total5Count = bands['5GHz'].total || 1;
    const stackedPercent = (ch40Count + ch44Count) / total5Count;

    // Count how many APs are already on UNII-3 non-DFS channels (149-165)
    const unii3Channels = ['149', '153', '157', '161', '165'];
    const unii3Count = unii3Channels.reduce((sum, ch) => sum + (bands['5GHz'].channels[ch] || 0), 0);

    if (stackedPercent > 0.8 && unii3Count < total5Count * 0.2) {
      recommendations.push({
        band: '5GHz',
        severity: 'critical',
        title: 'Severe 5GHz Channel Stacking — Expand to UNII-3 Channels',
        description: `An alarming ${Math.round(stackedPercent * 100)}% of your 5GHz access points (${ch40Count + ch44Count} out of ${total5Count}) are crammed onto just two frequencies (Channel 40 and 44), causing extreme co-channel interference. Only ${unii3Count} AP(s) use the UNII-3 non-DFS channels (149–165), leaving most of the available spectrum idle.`,
        action: 'Redistribute APs across the non-DFS UNII-3 channels (149, 153, 157, 161, 165). These channels are fully compatible with iPads and all client devices, and provide up to 5 additional non-overlapping 20/40 MHz channels. Avoid DFS channels (52–144) — they require radar-avoidance delays and are not supported by iPads and many other clients. Use the Channel Optimizer to automatically generate a channel plan using only non-DFS channels.'
      });
    }

    return {
      summary: {
        totalAPs: aps.length,
        totalRadios24: bands['2.4GHz'].total,
        totalRadios5: bands['5GHz'].total,
        avgUtil24,
        avgUtil5,
        channelCounts24: bands['2.4GHz'].channels,
        channelCounts5: bands['5GHz'].channels,
        congestedRadiosCount: apRadios.filter(r => r.health === 'critical').length,
        warningRadiosCount: apRadios.filter(r => r.health === 'warning').length
      },
      radios: apRadios.sort((a,b) => b.cu_total - a.cu_total),
      recommendations
    };
  }

  /**
   * Run deep diagnostics on client devices, focusing on iPads and Apple devices.
   * FIX 11: Single-pass analysis — all metrics collected in one forEach loop.
   */
  analyzeClients(clients, devices) {
    // Map AP MAC to AP Name for easy lookup
    const apMap = {};
    devices.forEach(d => {
      apMap[d.mac] = d.name || d.hostname || getFriendlyModelName(d.model) || d.ip || d.mac;
    });

    // Create a dictionary of AP radio channel utilization for client lookup
    const apRadioUtil = {};
    devices.forEach(ap => {
      if (ap.radio_table_stats) {
        ap.radio_table_stats.forEach(rs => {
          apRadioUtil[`${ap.mac}-${rs.channel}`] = rs.cu_total || 0;
        });
      }
    });

    const clientDiagnostics = [];
    let totalAppleClients = 0;
    let totalIpads = 0;
    let criticalCount = 0;
    let warningCount = 0;
    let healthyCount = 0;
    let totalDownloadKbps = 0;
    let totalUploadKbps = 0;

    // Single pass: diagnose, classify, and aggregate all clients
    clients.forEach(c => {
      const oui = (c.oui || '').toLowerCase();
      const hostname = (c.hostname || '').toLowerCase();
      const name = (c.name || '').toLowerCase();
      const isApple = oui === 'apple, inc.' || oui.includes('apple') || hostname.includes('ipad') || name.includes('ipad');
      const isIpad = (c.hostname || c.name || '').toLowerCase().includes('ipad');

      if (isApple) totalAppleClients++;
      if (isIpad) totalIpads++;

      const diag = {
        mac: c.mac,
        ip: c.ip || 'No IP',
        hostname: c.hostname || c.name || 'Unnamed Device',
        oui: c.oui || 'Generic Vendor',
        isApple: isApple,
        isIpad: isIpad,
        satisfaction: c.satisfaction !== undefined ? c.satisfaction : (c.experience_score || 100),
        signal: c.signal || -100,
        txRateKbps: c.tx_rate || 0,
        rxRateKbps: c.rx_rate || 0,
        txBytes: c.tx_bytes || 0,
        rxBytes: c.rx_bytes || 0,
        totalBytes: (c.tx_bytes || 0) + (c.rx_bytes || 0),
        txRetriesPct: c.wifi_tx_retries_percentage || 0,
        roamCount: c.roam_count || 0,
        channel: c.channel || 0,
        band: c.radio === 'ng' ? '2.4GHz' : '5GHz',
        apMac: c.ap_mac,
        apName: apMap[c.ap_mac] || 'Unknown Access Point',
        uptime: c.uptime || 0,
        anomalies: c.anomalies || [],
        flags: [],
        severity: 'healthy',
        recommendation: ''
      };

      totalDownloadKbps += c.tx_rate || 0;
      totalUploadKbps += c.rx_rate || 0;

      // 1. Diagnose Signal Strength (RSSI)
      if (diag.signal < -80) {
        diag.flags.push('Critical Weak Signal');
        diag.severity = 'critical';
      } else if (diag.signal < -72) {
        diag.flags.push('Weak Signal');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      // 2. Diagnose Satisfaction / Experience Score
      if (diag.satisfaction < 70) {
        diag.flags.push('Poor Connection Experience');
        diag.severity = 'critical';
      } else if (diag.satisfaction < 85) {
        diag.flags.push('Degraded Connection Experience');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      // 3. Diagnose TX Retries (Interference indicator)
      if (diag.txRetriesPct > 40) {
        diag.flags.push('Excessive TX Retries');
        diag.severity = 'critical';
      } else if (diag.txRetriesPct > 20) {
        diag.flags.push('High TX Retries');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      // 4. Diagnose Band Choice
      if (diag.band === '2.4GHz') {
        diag.flags.push('Sub-optimal Band (Connected to 2.4GHz)');
        if (diag.severity === 'healthy') diag.severity = 'warning';
      }

      // 5. Diagnose Associated AP channel congestion
      const apChanKey = `${c.ap_mac}-${c.channel}`;
      const apCongestion = apRadioUtil[apChanKey] || 0;
      diag.apCongestion = apCongestion;
      if (apCongestion > 70) {
        diag.flags.push('Severe AP Channel Utilization');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      // 6. Diagnose Reconnection / Roam Counts
      if (diag.roamCount > 8) {
        diag.flags.push(`Frequent Reconnection (${diag.roamCount} roams)`);
        diag.severity = 'critical';
      } else if (diag.roamCount > 4) {
        diag.flags.push(`Moderate Roaming (${diag.roamCount} roams)`);
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      // 7. Diagnose IP Assigned State (DHCP failures or self-assigned IPs)
      const isSelfAssigned = diag.ip.startsWith('169.254');
      const hasNoIp = diag.ip === 'No IP' || isSelfAssigned;
      if (hasNoIp) {
        diag.flags.push('No IP Address (DHCP Failure)');
        diag.severity = 'critical';
      }

      // 8. Formulate specialized actions based on symptoms
      const deviceWord = isIpad ? 'iPad' : 'client device';
      if (diag.severity === 'critical') {
        if (hasNoIp) {
          diag.recommendation = `The ${deviceWord} failed to obtain a valid IP address. Check your DHCP scope limits, VLAN subnet bindings, or restart the DHCP service.`;
        } else if (diag.roamCount > 8) {
          diag.recommendation = `Frequent reassociations/roams (${diag.roamCount}). Reduce overlapping cell coverage, adjust power output, or optimize channel configuration.`;
        } else if (diag.signal < -80) {
          diag.recommendation = `The ${deviceWord} is too far from the Access Point or blocked by walls. Relocate the client closer to the AP or install an AP in this coverage dead zone.`;
        } else if (diag.txRetriesPct > 40) {
          diag.recommendation = `Severe local RF interference on Channel ${diag.channel}. Change the connected AP (${diag.apName}) channel away from the heavily clogged Channel 6/40/44.`;
        } else {
          diag.recommendation = `Poor network negotiation. Try toggling Wi-Fi off and on on the ${deviceWord}, or renew the DHCP lease. Ensure the AP does not have high CPU load.`;
        }
      } else if (diag.severity === 'warning') {
        if (diag.roamCount > 4) {
          diag.recommendation = `Moderate roaming detected. Client is moving frequently between AP cells or AP signal thresholds are triggering minor roams.`;
        } else if (diag.band === '2.4GHz') {
          diag.recommendation = `${deviceWord} is stuck on the slow, congested 2.4GHz band. Enable "Band Steering" on the UniFi SSID settings to prefer 5GHz, or set separate 5GHz SSID.`;
        } else if (diag.signal < -72) {
          diag.recommendation = 'Marginal signal strength. Verify that the user is in the same room as the AP, and ensure walls are not blocking the line-of-sight.';
        } else if (diag.apCongestion > 70) {
          diag.recommendation = `The AP is operating on an extremely congested channel (${diag.channel}). Re-distribute the channel configurations of neighboring APs.`;
        } else {
          diag.recommendation = 'Slight congestion. Monitor this client; if connection drops, check for overlapping APs nearby on the same frequency.';
        }
      } else {
        diag.recommendation = 'Connection is optimal. No action required.';
      }

      // Aggregate severity counts in the same pass
      if (diag.severity === 'critical') criticalCount++;
      else if (diag.severity === 'warning') warningCount++;
      else healthyCount++;

      clientDiagnostics.push(diag);
    });

    const totalCount = clientDiagnostics.length || 1;
    const healthIndex = Math.round((healthyCount + warningCount * 0.5) / totalCount * 100);

    // Sort once at the end
    const sorted = clientDiagnostics.sort((a, b) => {
      const score = { 'critical': 3, 'warning': 2, 'healthy': 1 };
      return score[b.severity] - score[a.severity] || (a.hostname.localeCompare(b.hostname));
    });

    // Top downloaders (single sort + slice)
    const topDownloaders = [...sorted]
      .sort((a, b) => b.txRateKbps - a.txRateKbps)
      .slice(0, 10);

    const strugglingAll = sorted.filter(c => c.severity !== 'healthy');

    return {
      summary: {
        totalAppleClients,
        totalIpads,
        criticalCount,
        warningCount,
        healthyCount,
        healthIndex,
        totalAllClients: clients.length,
        totalDownloadKbps,
        totalUploadKbps
      },
      clients: sorted,
      allClients: clientDiagnostics,
      topDownloaders,
      strugglingAll
    };
  }
}

// Export a single instance to share across the application
const analyzerInstance = new NetworkAnalyzer();
analyzerInstance.HEALTH_THRESHOLDS = HEALTH_THRESHOLDS;
module.exports = analyzerInstance;

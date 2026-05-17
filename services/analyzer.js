/**
 * Diagnostic & Analysis Service for UniFi Network Data
 */

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
            apName: ap.name || ap.mac,
            apMac: ap.mac,
            ip: ap.ip,
            model: ap.model,
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
      if (r.cu_total > 75 || r.cci_count > 12) {
        r.health = 'critical';
      } else if (r.cu_total > 50 || r.cci_count > 4 || r.tx_retries_pct > 25) {
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

    // Check 5GHz recommendations (This is the critical school catastrophe!)
    const ch40Count = bands['5GHz'].channels['40'] || 0;
    const ch44Count = bands['5GHz'].channels['44'] || 0;
    const total5Count = bands['5GHz'].total || 1;
    const stackedPercent = (ch40Count + ch44Count) / total5Count;

    if (stackedPercent > 0.8) {
      recommendations.push({
        band: '5GHz',
        severity: 'critical',
        title: 'Severe 5GHz Channel Stacking & DFS Exclusion',
        description: `An alarming ${Math.round(stackedPercent * 100)}% of your 5GHz access points (${ch40Count + ch44Count} out of ${total5Count}) are crammed onto just two frequencies (Channel 40 and 44) at 40 MHz width. Your UniFi Network 10.0.160 Channel Plan has excluded all DFS channels (52-144), leaving the entire school with only TWO non-overlapping 40MHz channels (36+40 and 44+48).`,
        action: 'In UniFi Network 10.0.160, click the "Channel AI" tab (sine wave icon on left) and enable the excluded DFS channels (52 to 144) under the 5 GHz Channel Plan. This will expand your available spectrum from 2 to 10 non-overlapping channels! Then, click the "Optimize" button to trigger the UniFi AI Optimization.'
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
   * @param {Array} clients - List of clients from UniFi API
   * @param {Array} devices - List of devices from UniFi API
   */
  analyzeClients(clients, devices) {
    // Map AP MAC to AP Name for easy lookup
    const apMap = {};
    devices.forEach(d => {
      apMap[d.mac] = d.name || d.ip || d.mac;
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

    const ipadDiagnostics = [];

    // Filter for Apple devices / iPads
    const appleClients = clients.filter(c => {
      const oui = (c.oui || '').toLowerCase();
      const hostname = (c.hostname || '').toLowerCase();
      const name = (c.name || '').toLowerCase();
      
      // Specifically target iPads, or generally Apple devices since teachers report iPad issues
      return oui === 'apple, inc.' || oui.includes('apple') || hostname.includes('ipad') || name.includes('ipad');
    });

    appleClients.forEach(c => {
      const diag = {
        mac: c.mac,
        ip: c.ip || 'No IP',
        hostname: c.hostname || c.name || 'Unnamed Apple Device',
        isIpad: (c.hostname || c.name || '').toLowerCase().includes('ipad'),
        satisfaction: c.satisfaction !== undefined ? c.satisfaction : (c.experience_score || 100),
        signal: c.signal || -100,
        txRateKbps: c.tx_rate || 0,
        rxRateKbps: c.rx_rate || 0,
        txRetriesPct: c.wifi_tx_retries_percentage || 0,
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

      // 6. Formulate specialized actions based on symptoms
      if (diag.severity === 'critical') {
        if (diag.signal < -80) {
          diag.recommendation = 'The iPad is too far from the Access Point or blocked by walls. Relocate the client closer to the AP or install an AP in this coverage dead zone.';
        } else if (diag.txRetriesPct > 40) {
          diag.recommendation = `Severe local RF interference on Channel ${diag.channel}. Change the connected AP (${diag.apName}) channel away from the heavily clogged Channel 6/40/44.`;
        } else {
          diag.recommendation = 'Poor network negotiation. Try toggling Wi-Fi off and on on the iPad, or renew the DHCP lease. Ensure the AP does not have high CPU load.';
        }
      } else if (diag.severity === 'warning') {
        if (diag.band === '2.4GHz') {
          diag.recommendation = 'iPad is stuck on the slow, congested 2.4GHz band. Enable "Band Steering" on the UniFi SSID settings to prefer 5GHz, or set separate 5GHz SSID.';
        } else if (diag.signal < -72) {
          diag.recommendation = 'Marginal signal strength. Verify that the pupil is in the same room as the AP, and ensure walls are not blocking the line-of-sight.';
        } else if (diag.apCongestion > 70) {
          diag.recommendation = `The AP is operating on an extremely congested channel (${diag.channel}). Re-distribute the channel configurations of neighboring APs.`;
        } else {
          diag.recommendation = 'Slight congestion. Monitor this client; if connection drops, check for overlapping APs nearby on the same frequency.';
        }
      } else {
        diag.recommendation = 'Connection is optimal. No action required.';
      }

      ipadDiagnostics.push(diag);
    });

    // Overall Client Health Score
    const totalCount = appleClients.length || 1;
    const criticalCount = ipadDiagnostics.filter(d => d.severity === 'critical').length;
    const warningCount = ipadDiagnostics.filter(d => d.severity === 'warning').length;
    const healthyCount = ipadDiagnostics.filter(d => d.severity === 'healthy').length;
    const healthIndex = Math.round((healthyCount + warningCount * 0.5) / totalCount * 100);

    // === All-client processing for speed & struggling metrics ===
    const allClientDiags = clients.map(c => {
      const diag = {
        mac: c.mac,
        ip: c.ip || 'No IP',
        hostname: c.hostname || c.name || 'Unnamed Client',
        oui: c.oui || '',
        isApple: (c.oui || '').toLowerCase().includes('apple'),
        satisfaction: c.satisfaction !== undefined ? c.satisfaction : (c.experience_score || 100),
        signal: c.signal || -100,
        txRateKbps: c.tx_rate || 0,
        rxRateKbps: c.rx_rate || 0,
        txRetriesPct: c.wifi_tx_retries_percentage || 0,
        channel: c.channel || 0,
        band: c.radio === 'ng' ? '2.4GHz' : '5GHz',
        apMac: c.ap_mac,
        apName: apMap[c.ap_mac] || 'Unknown AP',
        uptime: c.uptime || 0,
        flags: [],
        severity: 'healthy'
      };

      if (diag.signal < -80) {
        diag.flags.push('Weak Signal');
        diag.severity = 'critical';
      } else if (diag.signal < -72) {
        diag.flags.push('Low Signal');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      if (diag.satisfaction < 70) {
        diag.flags.push('Poor Experience');
        diag.severity = 'critical';
      } else if (diag.satisfaction < 85) {
        diag.flags.push('Degraded Experience');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      if (diag.txRetriesPct > 40) {
        diag.flags.push('High TX Retries');
        if (diag.severity !== 'critical') diag.severity = 'critical';
      } else if (diag.txRetriesPct > 20) {
        diag.flags.push('Elevated TX Retries');
        if (diag.severity === 'healthy') diag.severity = 'warning';
      }

      if (diag.band === '2.4GHz') {
        diag.flags.push('2.4GHz Band');
        if (diag.severity === 'healthy') diag.severity = 'warning';
      }

      return diag;
    });

    // Aggregate speed metrics (kbps → sum across all clients)
    const totalDownloadKbps = clients.reduce((sum, c) => sum + (c.tx_rate || 0), 0);
    const totalUploadKbps = clients.reduce((sum, c) => sum + (c.rx_rate || 0), 0);

    // Top downloaders (top 10 by tx_rate)
    const topDownloaders = [...allClientDiags]
      .sort((a, b) => b.txRateKbps - a.txRateKbps)
      .slice(0, 10);

    // All struggling clients across all vendors
    const strugglingAll = allClientDiags
      .filter(c => c.severity !== 'healthy')
      .sort((a, b) => {
        const score = { critical: 3, warning: 2, healthy: 1 };
        return score[b.severity] - score[a.severity];
      });

    return {
      summary: {
        totalAppleClients: appleClients.length,
        totalIpads: ipadDiagnostics.filter(d => d.isIpad).length,
        criticalCount,
        warningCount,
        healthyCount,
        healthIndex,
        totalAllClients: clients.length,
        totalDownloadKbps,
        totalUploadKbps
      },
      clients: ipadDiagnostics.sort((a, b) => {
        // Sort critical first, then warning, then healthy
        const score = { 'critical': 3, 'warning': 2, 'healthy': 1 };
        return score[b.severity] - score[a.severity] || (a.hostname.localeCompare(b.hostname));
      }),
      allClients: allClientDiags,
      topDownloaders,
      strugglingAll
    };
  }
}

module.exports = new NetworkAnalyzer();

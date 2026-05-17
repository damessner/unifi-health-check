/**
 * Diagnostic & Analysis Service for UniFi Network Data
 */

class NetworkAnalyzer {
  parseFloorFromName(apName = '') {
    const name = apName.toUpperCase();
    if (name.includes('EG') || name.includes('ERDGESCHOSS') || name.startsWith('AP-EG')) return 'EG';
    if (name.includes('1OG') || name.includes('1.OG') || name.includes('AP-1G') || name.includes('AP-1OG')) return '1OG';
    if (name.includes('2OG') || name.includes('2.OG') || name.includes('AP-2G') || name.includes('AP-2OG')) return '2OG';
    return 'Other';
  }

  extractRoomFromApName(apName = '') {
    const cleaned = apName.replace(/^AP[-_]/i, '');
    const parts = cleaned.split(/[-_]/).filter(Boolean);
    if (parts.length <= 1) return cleaned || 'Unknown';
    return parts.slice(1).join(' ');
  }

  getBlueprintOffsetByFloor(floor) {
    if (floor === 'EG') return 0;
    if (floor === '1OG') return 3;
    if (floor === '2OG') return 6;
    return 9;
  }

  findActiveLesson(scheduleByRoom = {}, room = '', now = new Date()) {
    const roomKey = room.toLowerCase();
    const roomSchedule = scheduleByRoom[roomKey] || scheduleByRoom[room] || [];
    const currentHour = now.getHours();
    return roomSchedule.find(slot => currentHour >= slot.startHour && currentHour < slot.endHour) || null;
  }

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

    // 3. Build AP blueprint model (used for remediation and floorplan rendering)
    const radiosByAp = {};
    apRadios.forEach(radio => {
      if (!radiosByAp[radio.apMac]) {
        radiosByAp[radio.apMac] = {
          mac: radio.apMac,
          name: radio.apName,
          ip: radio.ip,
          model: radio.model,
          radios: {}
        };
      }
      radiosByAp[radio.apMac].radios[radio.radio] = radio;
    });

    const ch24Options = [1, 6, 11];
    const ch5Options = [36, 44, 52, 60, 100, 108, 116, 124, 132, 140];
    const blueprint = Object.values(radiosByAp)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ap, index) => {
        const floor = this.parseFloorFromName(ap.name);
        const floorOffset = this.getBlueprintOffsetByFloor(floor);
        const r24 = ap.radios.ng || null;
        const r5 = ap.radios.na || null;
        const optCh24 = ch24Options[(index + Math.floor(floorOffset / 3)) % ch24Options.length];
        const optCh5 = ch5Options[(index + floorOffset) % ch5Options.length];
        const optPower24 = 9;
        const optPower5 = 15;
        const optMinRssi = -75;

        const currentMinRssi = r24 && r24.min_rssi_enabled
          ? r24.min_rssi
          : (r5 && r5.min_rssi_enabled ? r5.min_rssi : null);

        const drift = {
          ch24: !!r24 && r24.channel !== optCh24,
          ch5: !!r5 && r5.channel !== optCh5,
          power24: !!r24 && (r24.tx_power_mode === 'auto' || (r24.tx_power !== null && r24.tx_power > 10)),
          power5: !!r5 && (r5.tx_power_mode === 'auto' || (r5.tx_power !== null && r5.tx_power > 16)),
          minRssi: !currentMinRssi || currentMinRssi !== optMinRssi
        };
        const driftReasons = Object.entries(drift)
          .filter(([, value]) => value)
          .map(([key]) => key);
        const hasDrift = driftReasons.length > 0;

        const maxCci = Math.max(r24?.cci_count || 0, r5?.cci_count || 0);
        const maxUtil = Math.max(r24?.cu_total || 0, r5?.cu_total || 0);
        const heavyOverlap = maxCci > 10 || maxUtil > 75;
        const lowCci = maxCci <= 2 && maxUtil < 45;
        const floorplanStatus = hasDrift || heavyOverlap
          ? 'critical'
          : (lowCci ? 'optimized' : 'normal');

        return {
          mac: ap.mac,
          name: ap.name,
          ip: ap.ip,
          model: ap.model,
          floor,
          room: this.extractRoomFromApName(ap.name),
          floorplanStatus,
          metrics: {
            maxCci,
            maxUtil
          },
          current: {
            channel24: r24 ? r24.channel : null,
            power24: r24 ? r24.tx_power : null,
            power24Mode: r24 ? r24.tx_power_mode : null,
            channel5: r5 ? r5.channel : null,
            power5: r5 ? r5.tx_power : null,
            power5Mode: r5 ? r5.tx_power_mode : null,
            minRssi: currentMinRssi
          },
          optimal: {
            channel24: optCh24,
            power24: optPower24,
            channel5: optCh5,
            power5: optPower5,
            minRssi: optMinRssi
          },
          drift,
          driftReasons,
          hasDrift
        };
      });

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
      recommendations,
      blueprint
    };
  }

  /**
   * Run deep diagnostics on client devices, focusing on iPads and Apple devices.
   * @param {Array} clients - List of clients from UniFi API
   * @param {Array} devices - List of devices from UniFi API
   * @param {Object} webUntisData - WebUntis-linked classroom scheduling data
   */
  analyzeClients(clients, devices, webUntisData = {}) {
    // Map AP MAC to AP Name for easy lookup
    const apMap = {};
    const apRoomMap = {};
    devices.forEach(d => {
      apMap[d.mac] = d.name || d.ip || d.mac;
      apRoomMap[d.mac] = this.extractRoomFromApName(d.name || d.mac);
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
      const linkedApName = apMap[c.ap_mac] || 'Unknown Access Point';
      const linkedRoom = apRoomMap[c.ap_mac] || 'Unknown Room';
      const activeLesson = this.findActiveLesson(webUntisData.scheduleByRoom, linkedRoom, new Date());

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
        apName: linkedApName,
        uptime: c.uptime || 0,
        anomalies: c.anomalies || [],
        estimatedRoom: linkedRoom,
        schoolHour: activeLesson ? activeLesson.label : 'No active class',
        teacherName: activeLesson ? activeLesson.teacher : 'n/a',
        className: activeLesson ? activeLesson.className : 'n/a',
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

    return {
      summary: {
        totalAppleClients: appleClients.length,
        totalIpads: ipadDiagnostics.filter(d => d.isIpad).length,
        criticalCount,
        warningCount,
        healthyCount,
        healthIndex
      },
      scheduleContext: {
        source: webUntisData.source || 'mock',
        currentHour: webUntisData.currentHour || new Date().getHours()
      },
      clients: ipadDiagnostics.sort((a, b) => {
        // Sort critical first, then warning, then healthy
        const score = { 'critical': 3, 'warning': 2, 'healthy': 1 };
        return score[b.severity] - score[a.severity] || (a.hostname.localeCompare(b.hostname));
      })
    };
  }
}

module.exports = new NetworkAnalyzer();

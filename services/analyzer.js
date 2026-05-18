/**
 * Diagnostic & Analysis Service for UniFi Network Data
 */

const DFS_CHANNELS_5GHZ = ['52', '56', '60', '64', '100', '104', '108', '112', '116', '120', '124', '128', '132', '136', '144'];
const SEVERITY_SCORE = { healthy: 1, warning: 2, critical: 3 };
const MAX_CONNECTIVITY_ITEMS = 10;

function formatTrafficState(totalTrafficKbps) {
  if (totalTrafficKbps >= 100000) return 'very-active';
  if (totalTrafficKbps >= 25000) return 'active';
  if (totalTrafficKbps >= 5000) return 'light';
  return 'idle';
}

function buildClientRecommendation(diag) {
  if (!diag.connectedSuccessfully) {
    if (diag.signal < -80) {
      return 'Move the device closer to the access point or improve coverage in this area.';
    }
    if (diag.txRetriesPct > 35 || diag.apCongestion > 70) {
      return `Reduce RF congestion on ${diag.apName} by moving clients to cleaner channels or lowering nearby TX power.`;
    }
    if (diag.hasErrors) {
      return 'Review the reported client anomalies in UniFi and verify DHCP/DNS/authentication health.';
    }
    return 'Reconnect the client and verify roaming, DHCP lease, and SSID settings.';
  }

  if (diag.trafficState === 'idle') {
    return 'Connection is healthy but currently idle. If this client should be active, verify the application or upstream service.';
  }

  if (diag.band === '2.4GHz') {
    return 'Steer this client toward 5 GHz where possible to reduce airtime contention.';
  }

  return 'No action required.';
}

class NetworkAnalyzer {
  /**
   * Run RF channel loading and interference diagnostics.
   * @param {Array} devices - List of devices from UniFi API
   */
  analyzeChannels(devices) {
    const aps = devices.filter((d) => d.type === 'uap');

    const bands = {
      '2.4GHz': { total: 0, channels: {}, utilizationSum: 0, utilizationCount: 0 },
      '5GHz': { total: 0, channels: {}, utilizationSum: 0, utilizationCount: 0 }
    };

    const apRadios = [];

    aps.forEach((ap) => {
      const radioSettings = {};
      if (ap.radio_table) {
        ap.radio_table.forEach((radio) => {
          radioSettings[radio.radio] = radio;
        });
      }

      if (ap.radio_table_stats) {
        ap.radio_table_stats.forEach((stats) => {
          const bandName = stats.radio === 'ng' ? '2.4GHz' : '5GHz';
          const channel = String(stats.channel);

          bands[bandName].total += 1;
          bands[bandName].channels[channel] = (bands[bandName].channels[channel] || 0) + 1;

          if (stats.cu_total !== undefined && stats.cu_total !== null) {
            bands[bandName].utilizationSum += stats.cu_total;
            bands[bandName].utilizationCount += 1;
          }

          const configuredRadio = radioSettings[stats.radio] || {};

          apRadios.push({
            apName: ap.name || ap.mac,
            apMac: ap.mac,
            ip: ap.ip,
            model: ap.model,
            radio: stats.radio,
            band: bandName,
            channel: stats.channel,
            cu_total: stats.cu_total || 0,
            cu_self_rx: stats.cu_self_rx || 0,
            cu_self_tx: stats.cu_self_tx || 0,
            tx_retries_pct: stats.tx_retries_pct || 0,
            satisfaction: stats.satisfaction || 100,
            num_sta: stats.num_sta || 0,
            tx_power: stats.tx_power || null,
            tx_power_mode: configuredRadio.tx_power_mode || 'auto',
            configured_tx_power: configuredRadio.tx_power !== undefined ? configuredRadio.tx_power : null,
            antenna_gain: configuredRadio.antenna_gain !== undefined ? configuredRadio.antenna_gain : null,
            min_rssi_enabled: !!configuredRadio.min_rssi_enabled,
            min_rssi: configuredRadio.min_rssi || null,
            ht: configuredRadio.ht || '',
            bw: stats.bw || null
          });
        });
      }
    });

    const avgUtil24 = bands['2.4GHz'].utilizationCount > 0
      ? Math.round(bands['2.4GHz'].utilizationSum / bands['2.4GHz'].utilizationCount)
      : 0;
    const avgUtil5 = bands['5GHz'].utilizationCount > 0
      ? Math.round(bands['5GHz'].utilizationSum / bands['5GHz'].utilizationCount)
      : 0;

    apRadios.forEach((radio) => {
      const activeChannelCount = bands[radio.band].channels[String(radio.channel)] || 1;
      radio.cci_count = activeChannelCount - 1;

      if (radio.cu_total > 75 || radio.cci_count > 12) {
        radio.health = 'critical';
      } else if (radio.cu_total > 50 || radio.cci_count > 4 || radio.tx_retries_pct > 25) {
        radio.health = 'warning';
      } else {
        radio.health = 'healthy';
      }
    });

    const dfsChannelsInUse = DFS_CHANNELS_5GHZ.filter((channel) => (bands['5GHz'].channels[channel] || 0) > 0);
    const nonDfsChannelsInUse = Object.keys(bands['5GHz'].channels).filter((channel) => !DFS_CHANNELS_5GHZ.includes(channel));
    const positiveFindings = [];
    const recommendations = [];

    const ch6Count = bands['2.4GHz'].channels['6'] || 0;
    const total24Count = bands['2.4GHz'].total || 1;
    if (ch6Count / total24Count > 0.4) {
      recommendations.push({
        band: '2.4GHz',
        severity: 'warning',
        title: 'High Channel 6 Concentration',
        description: `Currently ${ch6Count} out of ${total24Count} APs are operating on Channel 6. This is causing elevated Co-Channel Interference.`,
        action: 'Re-distribute APs evenly across non-overlapping Channels 1, 6, and 11. Reduce 2.4GHz transmit power to Low/Medium to limit cell overlap.'
      });
    } else if (bands['2.4GHz'].total > 0) {
      positiveFindings.push({
        title: '2.4 GHz channel plan is reasonably balanced',
        detail: `${Math.max(total24Count - ch6Count, 0)} of ${total24Count} radios are already off Channel 6, reducing overlap.`
      });
    }

    const ch40Count = bands['5GHz'].channels['40'] || 0;
    const ch44Count = bands['5GHz'].channels['44'] || 0;
    const total5Count = bands['5GHz'].total || 1;
    const stackedPercent = (ch40Count + ch44Count) / total5Count;

    if (stackedPercent > 0.8) {
      recommendations.push({
        band: '5GHz',
        severity: 'critical',
        title: 'Severe 5GHz Channel Stacking & DFS Exclusion',
        description: `An alarming ${Math.round(stackedPercent * 100)}% of your 5GHz access points (${ch40Count + ch44Count} out of ${total5Count}) are crammed onto just two frequencies (Channel 40 and 44) at 40 MHz width.`,
        action: `Enable additional DFS channels in UniFi so the optimizer can distribute radios across ${DFS_CHANNELS_5GHZ.join(', ')} instead of keeping the entire site on only a few non-DFS channels.`
      });
    } else if (dfsChannelsInUse.length === 0 && total5Count >= 4) {
      recommendations.push({
        band: '5GHz',
        severity: 'warning',
        title: 'No DFS spectrum currently in use',
        description: `All ${total5Count} active 5GHz radios are still using only non-DFS channels (${nonDfsChannelsInUse.join(', ') || '36-48'}).`,
        action: `Review the 5GHz channel plan and consider enabling supported DFS channels (${DFS_CHANNELS_5GHZ.join(', ')}) to expand available spectrum.`
      });
    } else if (dfsChannelsInUse.length > 0) {
      positiveFindings.push({
        title: 'DFS spectrum is active on 5 GHz',
        detail: `${dfsChannelsInUse.length} DFS channels are currently in use (${dfsChannelsInUse.join(', ')}), which improves channel diversity.`
      });
    }

    if (avgUtil5 < 55) {
      positiveFindings.push({
        title: '5 GHz airtime load is under control',
        detail: `Average 5 GHz utilization is ${avgUtil5}%, below the high-risk threshold.`
      });
    }

    if (avgUtil24 < 45) {
      positiveFindings.push({
        title: '2.4 GHz airtime is manageable',
        detail: `Average 2.4 GHz utilization is ${avgUtil24}%, leaving margin for slower legacy devices.`
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
        congestedRadiosCount: apRadios.filter((radio) => radio.health === 'critical').length,
        warningRadiosCount: apRadios.filter((radio) => radio.health === 'warning').length,
        healthyRadiosCount: apRadios.filter((radio) => radio.health === 'healthy').length,
        dfsChannelsInUse,
        supportedDfsChannels: DFS_CHANNELS_5GHZ,
        nonDfsChannelsInUse,
        bandHealth: {
          '2.4GHz': {
            critical: apRadios.filter((radio) => radio.band === '2.4GHz' && radio.health === 'critical').length,
            warning: apRadios.filter((radio) => radio.band === '2.4GHz' && radio.health === 'warning').length,
            healthy: apRadios.filter((radio) => radio.band === '2.4GHz' && radio.health === 'healthy').length
          },
          '5GHz': {
            critical: apRadios.filter((radio) => radio.band === '5GHz' && radio.health === 'critical').length,
            warning: apRadios.filter((radio) => radio.band === '5GHz' && radio.health === 'warning').length,
            healthy: apRadios.filter((radio) => radio.band === '5GHz' && radio.health === 'healthy').length
          }
        }
      },
      radios: apRadios.sort((a, b) => b.cu_total - a.cu_total),
      recommendations,
      positiveFindings
    };
  }

  /**
   * Run deep diagnostics on client devices, focusing on iPads and Apple devices.
   * @param {Array} clients - List of clients from UniFi API
   * @param {Array} devices - List of devices from UniFi API
   */
  analyzeClients(clients, devices) {
    const apMap = {};
    devices.forEach((device) => {
      apMap[device.mac] = device.name || device.ip || device.mac;
    });

    const apRadioUtil = {};
    devices.forEach((ap) => {
      if (ap.radio_table_stats) {
        ap.radio_table_stats.forEach((radioStats) => {
          apRadioUtil[`${ap.mac}-${radioStats.channel}`] = radioStats.cu_total || 0;
        });
      }
    });

    const ipadDiagnostics = [];

    const appleClients = clients.filter((client) => {
      const oui = (client.oui || '').toLowerCase();
      const hostname = (client.hostname || '').toLowerCase();
      const name = (client.name || '').toLowerCase();
      return oui === 'apple, inc.' || oui.includes('apple') || hostname.includes('ipad') || name.includes('ipad');
    });

    appleClients.forEach((client) => {
      const diag = {
        mac: client.mac,
        ip: client.ip || 'No IP',
        hostname: client.hostname || client.name || 'Unnamed Apple Device',
        isIpad: (client.hostname || client.name || '').toLowerCase().includes('ipad'),
        satisfaction: client.satisfaction !== undefined ? client.satisfaction : (client.experience_score || 100),
        signal: client.signal || -100,
        txRateKbps: client.tx_rate || 0,
        rxRateKbps: client.rx_rate || 0,
        txRetriesPct: client.wifi_tx_retries_percentage || 0,
        channel: client.channel || 0,
        band: client.radio === 'ng' ? '2.4GHz' : '5GHz',
        apMac: client.ap_mac,
        apName: apMap[client.ap_mac] || 'Unknown Access Point',
        uptime: client.uptime || 0,
        anomalies: client.anomalies || [],
        flags: [],
        severity: 'healthy',
        recommendation: ''
      };

      if (diag.signal < -80) {
        diag.flags.push('Critical Weak Signal');
        diag.severity = 'critical';
      } else if (diag.signal < -72) {
        diag.flags.push('Weak Signal');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      if (diag.satisfaction < 70) {
        diag.flags.push('Poor Connection Experience');
        diag.severity = 'critical';
      } else if (diag.satisfaction < 85) {
        diag.flags.push('Degraded Connection Experience');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      if (diag.txRetriesPct > 40) {
        diag.flags.push('Excessive TX Retries');
        diag.severity = 'critical';
      } else if (diag.txRetriesPct > 20) {
        diag.flags.push('High TX Retries');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      if (diag.band === '2.4GHz') {
        diag.flags.push('Sub-optimal Band (Connected to 2.4GHz)');
        if (diag.severity === 'healthy') diag.severity = 'warning';
      }

      const apChannelKey = `${client.ap_mac}-${client.channel}`;
      const apCongestion = apRadioUtil[apChannelKey] || 0;
      diag.apCongestion = apCongestion;
      if (apCongestion > 70) {
        diag.flags.push('Severe AP Channel Utilization');
        if (diag.severity !== 'critical') diag.severity = 'warning';
      }

      if (diag.severity === 'critical') {
        if (diag.signal < -80) {
          diag.recommendation = 'The iPad is too far from the access point or blocked by walls. Move it closer or improve classroom coverage.';
        } else if (diag.txRetriesPct > 40) {
          diag.recommendation = `Severe local RF interference on Channel ${diag.channel}. Move the connected AP (${diag.apName}) to a cleaner channel.`;
        } else {
          diag.recommendation = 'Poor network negotiation. Toggle Wi-Fi on the device, review DHCP, and verify AP health.';
        }
      } else if (diag.severity === 'warning') {
        if (diag.band === '2.4GHz') {
          diag.recommendation = 'Enable band steering or provide a cleaner 5 GHz path to keep this device off 2.4 GHz.';
        } else if (diag.signal < -72) {
          diag.recommendation = 'Signal is marginal. Verify classroom coverage and check for obstructions.';
        } else if (diag.apCongestion > 70) {
          diag.recommendation = `The AP is operating on a congested channel (${diag.channel}). Re-balance nearby AP channel assignments.`;
        } else {
          diag.recommendation = 'Monitor this client. If drops continue, inspect roaming and overlapping APs.';
        }
      } else {
        diag.recommendation = 'Connection is optimal. No action required.';
      }

      ipadDiagnostics.push(diag);
    });

    const totalCount = appleClients.length || 1;
    const criticalCount = ipadDiagnostics.filter((diag) => diag.severity === 'critical').length;
    const warningCount = ipadDiagnostics.filter((diag) => diag.severity === 'warning').length;
    const healthyCount = ipadDiagnostics.filter((diag) => diag.severity === 'healthy').length;
    const healthIndex = Math.round(((healthyCount + warningCount * 0.5) / totalCount) * 100);

    const allClientDiags = clients.map((client) => {
      const diag = {
        mac: client.mac,
        ip: client.ip || 'No IP',
        hostname: client.hostname || client.name || 'Unnamed Client',
        oui: client.oui || '',
        anomalies: client.anomalies || [],
        isApple: (client.oui || '').toLowerCase().includes('apple'),
        satisfaction: client.satisfaction !== undefined ? client.satisfaction : (client.experience_score || 100),
        signal: client.signal || -100,
        txRateKbps: client.tx_rate || 0,
        rxRateKbps: client.rx_rate || 0,
        txRetriesPct: client.wifi_tx_retries_percentage || 0,
        channel: client.channel || 0,
        band: client.radio === 'ng' ? '2.4GHz' : '5GHz',
        apMac: client.ap_mac,
        apName: apMap[client.ap_mac] || 'Unknown AP',
        uptime: client.uptime || 0,
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
        diag.severity = 'critical';
      } else if (diag.txRetriesPct > 20) {
        diag.flags.push('Elevated TX Retries');
        if (diag.severity === 'healthy') diag.severity = 'warning';
      }

      if (diag.band === '2.4GHz') {
        diag.flags.push('2.4GHz Band');
        if (diag.severity === 'healthy') diag.severity = 'warning';
      }

      diag.apCongestion = apRadioUtil[`${client.ap_mac}-${client.channel}`] || 0;
      if (diag.apCongestion > 75 && diag.severity === 'healthy') {
        diag.severity = 'warning';
        diag.flags.push('High AP Congestion');
      }

      if (diag.anomalies.length > 0 && diag.severity === 'healthy') {
        diag.severity = 'warning';
      }

      diag.totalTrafficKbps = diag.txRateKbps + diag.rxRateKbps;
      diag.trafficState = formatTrafficState(diag.totalTrafficKbps);
      diag.hasErrors = diag.anomalies.length > 0 || diag.severity !== 'healthy';
      diag.connectedSuccessfully = diag.uptime > 60 && diag.signal > -82 && diag.satisfaction >= 70 && diag.txRetriesPct <= 35;
      diag.connectionState = !diag.connectedSuccessfully
        ? 'unstable'
        : diag.uptime < 900
          ? 'recently-connected'
          : 'stable';
      diag.errorSummary = diag.anomalies.length > 0
        ? diag.anomalies.join(', ')
        : (diag.flags.join(', ') || 'No errors detected');
      diag.recommendation = buildClientRecommendation(diag);

      return diag;
    });

    const totalDownloadKbps = clients.reduce((sum, client) => sum + (client.tx_rate || 0), 0);
    const totalUploadKbps = clients.reduce((sum, client) => sum + (client.rx_rate || 0), 0);

    const topDownloaders = [...allClientDiags]
      .sort((a, b) => b.txRateKbps - a.txRateKbps)
      .slice(0, 10);

    const topUploaders = [...allClientDiags]
      .sort((a, b) => b.rxRateKbps - a.rxRateKbps)
      .slice(0, 10);

    const strugglingAll = allClientDiags
      .filter((client) => client.severity !== 'healthy' || !client.connectedSuccessfully || client.hasErrors)
      .sort((a, b) => {
        if (SEVERITY_SCORE[b.severity] !== SEVERITY_SCORE[a.severity]) {
          return SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity];
        }
        return b.totalTrafficKbps - a.totalTrafficKbps;
      });

    const stableConnectedCount = allClientDiags.filter((client) => client.connectionState === 'stable').length;
    const recentConnectedCount = allClientDiags.filter((client) => client.connectionState === 'recently-connected').length;
    const unstableCount = allClientDiags.filter((client) => client.connectionState === 'unstable').length;
    const activeTransferClients = allClientDiags.filter((client) => client.trafficState === 'very-active' || client.trafficState === 'active');
    const lightTrafficClients = allClientDiags.filter((client) => client.trafficState === 'light');
    const idleClients = allClientDiags.filter((client) => client.trafficState === 'idle');
    const errorClients = allClientDiags.filter((client) => client.hasErrors);
    const healthyAllClients = allClientDiags.filter((client) => client.severity === 'healthy');
    const warningAllClients = allClientDiags.filter((client) => client.severity === 'warning');
    const criticalAllClients = allClientDiags.filter((client) => client.severity === 'critical');
    const connectedSuccessfullyCount = allClientDiags.filter((client) => client.connectedSuccessfully).length;

    const apLoadMap = {};
    allClientDiags.forEach((client) => {
      if (!apLoadMap[client.apName]) {
        apLoadMap[client.apName] = {
          apName: client.apName,
          clientCount: 0,
          totalTrafficKbps: 0,
          unhealthyClients: 0
        };
      }
      apLoadMap[client.apName].clientCount += 1;
      apLoadMap[client.apName].totalTrafficKbps += client.totalTrafficKbps;
      if (client.severity !== 'healthy' || !client.connectedSuccessfully) {
        apLoadMap[client.apName].unhealthyClients += 1;
      }
    });

    const busiestAps = Object.values(apLoadMap)
      .sort((a, b) => {
        if (b.clientCount !== a.clientCount) {
          return b.clientCount - a.clientCount;
        }
        return b.totalTrafficKbps - a.totalTrafficKbps;
      })
      .slice(0, MAX_CONNECTIVITY_ITEMS);

    return {
      summary: {
        totalAppleClients: appleClients.length,
        totalIpads: ipadDiagnostics.filter((diag) => diag.isIpad).length,
        criticalCount,
        warningCount,
        healthyCount,
        healthIndex,
        totalAllClients: clients.length,
        totalNonAppleClients: clients.length - appleClients.length,
        totalDownloadKbps,
        totalUploadKbps,
        totalHealthyAllClients: healthyAllClients.length,
        totalWarningAllClients: warningAllClients.length,
        totalCriticalAllClients: criticalAllClients.length,
        connectedSuccessfullyCount,
        stableConnectedCount,
        recentConnectedCount,
        unstableCount,
        totalActiveTrafficClients: activeTransferClients.length,
        totalLightTrafficClients: lightTrafficClients.length,
        totalIdleClients: idleClients.length,
        totalErrorClients: errorClients.length,
        connectivitySuccessRate: clients.length > 0 ? Math.round((connectedSuccessfullyCount / clients.length) * 100) : 100,
        activityRate: clients.length > 0 ? Math.round((activeTransferClients.length / clients.length) * 100) : 0,
        avgSignal: clients.length > 0 ? Math.round(allClientDiags.reduce((sum, client) => sum + client.signal, 0) / clients.length) : 0,
        avgSatisfaction: clients.length > 0 ? Math.round(allClientDiags.reduce((sum, client) => sum + client.satisfaction, 0) / clients.length) : 100,
        avgTxRetriesPct: clients.length > 0 ? Math.round(allClientDiags.reduce((sum, client) => sum + client.txRetriesPct, 0) / clients.length) : 0
      },
      clients: ipadDiagnostics.sort((a, b) => {
        if (SEVERITY_SCORE[b.severity] !== SEVERITY_SCORE[a.severity]) {
          return SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity];
        }
        return a.hostname.localeCompare(b.hostname);
      }),
      allClients: allClientDiags,
      topDownloaders,
      topUploaders,
      strugglingAll,
      connectivity: {
        issuesDetected: errorClients.slice(0, MAX_CONNECTIVITY_ITEMS),
        noIssues: healthyAllClients
          .filter((client) => client.connectedSuccessfully)
          .sort((a, b) => b.totalTrafficKbps - a.totalTrafficKbps)
          .slice(0, MAX_CONNECTIVITY_ITEMS),
        activeTransfers: [...activeTransferClients]
          .sort((a, b) => b.totalTrafficKbps - a.totalTrafficKbps)
          .slice(0, MAX_CONNECTIVITY_ITEMS),
        idleClients: [...idleClients]
          .sort((a, b) => a.totalTrafficKbps - b.totalTrafficKbps)
          .slice(0, MAX_CONNECTIVITY_ITEMS),
        unstableClients: [...allClientDiags]
          .filter((client) => client.connectionState === 'unstable')
          .sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity])
          .slice(0, MAX_CONNECTIVITY_ITEMS),
        busiestAps
      }
    };
  }
}

module.exports = new NetworkAnalyzer();

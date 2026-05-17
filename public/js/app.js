/**
 * Network Health & Channel Analyzer - Client Controller
 * Single Page Application Core Controller
 */

// Global State
let apiData = null;
let activeTab = 'overview';
let searchQueryParams = {
  ap: '',
  ipad: ''
};
let filterParams = {
  apBand: 'all',
  apFloor: 'all',
  ipadStatus: 'all',
  ipadType: 'all'
};

// DOMContentLoaded Initialization
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Initializing dashboard UI elements...');
  
  // Set initial page header text
  updateHeaderContext();

  // Load Initial Data
  fetchData();
  
  // Note: Auto-sync / polling is disabled to prevent overloading the UniFi Hardware controller.
  // Refresh manually using the prominent 'Get Live Data' action button.
});

/**
 * Dynamically update progress metrics in the PDF print-only header
 */
function updatePrintProgress() {
  const checkboxes = document.querySelectorAll('.opt-done-checkbox');
  const total = checkboxes.length;
  let completed = 0;
  checkboxes.forEach(cb => {
    if (cb.checked) completed++;
  });
  
  const printProgress = document.getElementById('print-progress');
  if (printProgress) {
    const completedPct = total > 0 ? Math.round((completed / total) * 100) : 0;
    printProgress.textContent = `${completed} / ${total} APs marked (${completedPct}% complete)`;
  }
}

/**
 * Toggle checked status for an AP and save to localStorage
 * @param {string} mac 
 * @param {boolean} isChecked 
 */
function toggleAPChecked(mac, isChecked) {
  let checkedMacs = [];
  try {
    const raw = localStorage.getItem('unifi_opt_checked_macs');
    if (raw) checkedMacs = JSON.parse(raw);
  } catch (e) {
    console.error('Error reading checked MACs from localStorage:', e);
  }

  if (isChecked) {
    if (!checkedMacs.includes(mac)) {
      checkedMacs.push(mac);
    }
  } else {
    checkedMacs = checkedMacs.filter(m => m !== mac);
  }

  localStorage.setItem('unifi_opt_checked_macs', JSON.stringify(checkedMacs));
  
  // Toggle style on active row
  const row = document.querySelector(`tr[data-ap-row-mac="${mac}"]`);
  if (row) {
    if (isChecked) {
      row.classList.add('row-opt-done');
    } else {
      row.classList.remove('row-opt-done');
    }
  }

  // Update print metrics
  updatePrintProgress();
}

/**
 * Reset all checked states in the blueprint list
 */
function resetCheckedAPs() {
  if (confirm('Are you sure you want to reset all checked off items in your optimization checklist?')) {
    localStorage.removeItem('unifi_opt_checked_macs');
    
    // Uncheck all checkboxes in the DOM
    document.querySelectorAll('.opt-done-checkbox').forEach(cb => {
      cb.checked = false;
    });
    
    // Remove done class from all rows
    document.querySelectorAll('tr[data-ap-row-mac]').forEach(row => {
      row.classList.remove('row-opt-done');
    });

    // Update print metrics
    updatePrintProgress();
  }
}

/**
 * Switch Active Dashboard Tabs
 * @param {string} tabId - Target tab container ID
 */
function switchTab(tabId) {
  if (tabId === activeTab) return;
  
  console.log(`[Tab Switch] Switching from ${activeTab} to ${tabId}`);
  
  // 1. Remove active state from current buttons & sections
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(pane => pane.classList.remove('active'));
  
  // 2. Add active state to selected button & section
  const targetBtn = document.getElementById(`btn-${tabId}`);
  const targetPane = document.getElementById(`tab-${tabId}`);
  
  if (targetBtn && targetPane) {
    targetBtn.classList.add('active');
    targetPane.classList.add('active');
    activeTab = tabId;
    updateHeaderContext();
  }
}

/**
 * Update Header Text based on active tab
 */
function updateHeaderContext() {
  const title = document.getElementById('page-title');
  const subtitle = document.getElementById('page-subtitle');
  
  const headers = {
    overview: {
      title: 'Network Overview',
      subtitle: 'Real-time school wireless environment dashboard'
    },
    channels: {
      title: 'RF Channel Analyzer',
      subtitle: 'Analysis of radio congestion and Co-Channel Interference (CCI)'
    },
    aps: {
      title: 'Access Point Inventory',
      subtitle: 'Active school AP status and radio configurations'
    },
    ipads: {
      title: 'iPad Telemetry Diagnostics',
      subtitle: 'Real-time health monitoring of pupils\' iPads and Apple devices'
    },
    optimizer: {
      title: 'SSID & RF Optimization Plan',
      subtitle: 'Automated network improvement blueprint and best practices'
    }
  };

  if (title && subtitle && headers[activeTab]) {
    title.textContent = headers[activeTab].title;
    subtitle.textContent = headers[activeTab].subtitle;
  }
}

/**
 * Fetch stats payload from Node backend
 * @param {boolean} isSilent - If true, do not display the full page loading overlay
 * @param {boolean} force - If true, bypasses the backend cache and fetches fresh controller data
 */
async function fetchData(isSilent = false, force = false) {
  const loadingOverlay = document.getElementById('loading-overlay');
  const refreshBtn = document.getElementById('refresh-button');
  
  if (!isSilent && loadingOverlay) {
    loadingOverlay.style.visibility = 'visible';
    loadingOverlay.style.opacity = '1';
  }
  
  if (refreshBtn) {
    refreshBtn.disabled = true;
    const spinIcon = refreshBtn.querySelector('i');
    if (spinIcon) spinIcon.style.animation = 'spin 1s infinite linear';
  }

  try {
    const url = force ? '/api/diagnostics?force=true' : '/api/diagnostics';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP status error: ${res.status}`);
    
    const payload = await res.json();
    if (!payload.success) throw new Error(payload.error || 'Server returned negative status');

    apiData = payload;
    console.log('[API Fetch] Successfully fetched fresh telemetry!', apiData);
    
    // Process and render all segments
    renderOverview();
    renderChannelsTab();
    renderApsTab();
    renderIpadsTab();
    updateGlobalBadges();
    renderOptimalGrid();

    // Verify backend connectivity health state
    updateControllerStatusCard(true);
    
    // Set Timestamp
    const lastUpdatedLabel = document.getElementById('last-updated');
    if (lastUpdatedLabel) {
      const now = new Date(payload.timestamp);
      lastUpdatedLabel.textContent = `Last updated: ${now.toLocaleTimeString()}`;
    }

  } catch (err) {
    console.error('[API Fetch Error] Failed to update telemetry:', err);
    updateControllerStatusCard(false, err.message);
    showErrorNotification(err.message);
  } finally {
    if (loadingOverlay) {
      loadingOverlay.style.opacity = '0';
      setTimeout(() => {
        loadingOverlay.style.visibility = 'hidden';
      }, 400);
    }
    
    if (refreshBtn) {
      refreshBtn.disabled = false;
      const spinIcon = refreshBtn.querySelector('i');
      if (spinIcon) spinIcon.style.animation = '';
    }
    
    // Re-initialize Lucide Icons
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }
}

/**
 * Update Sidebar Connection Status Card
 * @param {boolean} isOnline 
 * @param {string} errText 
 */
function updateControllerStatusCard(isOnline, errText = '') {
  const statusIndicator = document.querySelector('.status-indicator-dot');
  const statusValue = document.getElementById('status-controller-ip');
  
  if (statusIndicator && statusValue) {
    if (isOnline) {
      statusIndicator.className = 'status-indicator-dot online';
      statusValue.textContent = 'ONLINE (Observer)';
      statusValue.style.color = 'var(--color-success)';
    } else {
      statusIndicator.className = 'status-indicator-dot offline';
      statusValue.textContent = errText ? `FAILED (${errText.substring(0, 15)})` : 'OFFLINE';
      statusValue.style.color = 'var(--color-danger)';
    }
  }
}

/**
 * Render dynamic overview widgets
 */
function renderOverview() {
  if (!apiData) return;

  const summaryCh = apiData.channels.summary;
  const summaryCl = apiData.clients.summary;

  // 1. Populate Metrics Cards
  const valAPs = document.getElementById('metric-total-aps');
  if (valAPs) valAPs.textContent = summaryCh.totalAPs;

  const subRadios = document.getElementById('metric-radios-counts');
  if (subRadios) {
    subRadios.textContent = `${summaryCh.totalRadios24} (2.4GHz) / ${summaryCh.totalRadios5} (5GHz) active`;
  }

  const valClients = document.getElementById('metric-total-clients');
  if (valClients) valClients.textContent = summaryCl.totalAppleClients;

  const subVendors = document.getElementById('metric-vendor-breakdown');
  if (subVendors) subVendors.textContent = `${summaryCl.totalIpads} Apple iPads detected`;

  const valIpads = document.getElementById('metric-total-ipads');
  if (valIpads) valIpads.textContent = summaryCl.totalIpads;

  const subIpadHealth = document.getElementById('metric-ipad-health');
  if (subIpadHealth) {
    subIpadHealth.innerHTML = `iPad Health Index: <strong style="color: ${getHealthColor(summaryCl.healthIndex)}">${summaryCl.healthIndex}%</strong>`;
  }

  const valClogged = document.getElementById('metric-congested-radios');
  if (valClogged) valClogged.textContent = summaryCh.congestedRadiosCount;

  const subWarnings = document.getElementById('metric-warning-radios');
  if (subWarnings) {
    subWarnings.textContent = `${summaryCh.warningRadiosCount} warning radios | ${summaryCl.criticalCount} iPad criticals`;
  }

  // Set card alert glow if congested radios exist
  const cloggedCard = document.getElementById('metric-clogged-card');
  if (cloggedCard) {
    if (summaryCh.congestedRadiosCount > 0) {
      cloggedCard.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.15)';
      cloggedCard.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    } else {
      cloggedCard.style.boxShadow = '';
      cloggedCard.style.borderColor = '';
    }
  }

  // 2. Populate RF Environment Summary Fills
  const txtUtil24 = document.getElementById('overview-util-24');
  const barUtil24 = document.getElementById('bar-util-24');
  if (txtUtil24 && barUtil24) {
    txtUtil24.textContent = `${summaryCh.avgUtil24}%`;
    barUtil24.style.width = `${summaryCh.avgUtil24}%`;
    barUtil24.style.background = getGradientForUtilization(summaryCh.avgUtil24);
  }

  const txtUtil5 = document.getElementById('overview-util-5');
  const barUtil5 = document.getElementById('bar-util-5');
  if (txtUtil5 && barUtil5) {
    txtUtil5.textContent = `${summaryCh.avgUtil5}%`;
    barUtil5.style.width = `${summaryCh.avgUtil5}%`;
    barUtil5.style.background = getGradientForUtilization(summaryCh.avgUtil5);
  }

  // Update co-channel summary fact
  const cciSummary = document.getElementById('fact-cci-summary');
  if (cciSummary) {
    const ch40Count = summaryCh.channelCounts5['40'] || 0;
    const ch44Count = summaryCh.channelCounts5['44'] || 0;
    const total5 = summaryCh.totalRadios5 || 1;
    const stacked5GPercent = Math.round(((ch40Count + ch44Count) / total5) * 100);
    cciSummary.textContent = `${stacked5GPercent}% of 5GHz APs stacked on channels 40/44. Highly severe overlap!`;
  }

  // 3. Automated Diagnosis Alert Board
  const alertsContainer = document.getElementById('overview-alerts');
  if (alertsContainer) {
    alertsContainer.innerHTML = '';

    // Render RF Recommendations
    apiData.channels.recommendations.forEach(rec => {
      const card = document.createElement('div');
      card.className = `alert-item-card ${rec.severity}`;
      
      const icon = rec.severity === 'critical' ? 'shield-alert' : 'alert-triangle';
      const iconColor = rec.severity === 'critical' ? 'text-critical' : 'text-warning';

      card.innerHTML = `
        <div class="alert-icon ${iconColor}"><i data-lucide="${icon}"></i></div>
        <div class="alert-text ${rec.severity}">
          <h4>${rec.title} (${rec.band})</h4>
          <p>${rec.description}</p>
          <p style="margin-top: 6px;"><strong>Root Cause Fix:</strong> ${rec.action}</p>
          <span class="alert-action-suggest ${rec.severity}" onclick="switchTab('optimizer')">View optimization steps →</span>
        </div>
      `;
      alertsContainer.appendChild(card);
    });

    // Render top 4 degraded iPads as alerts to instantly warn the admin
    const problematicIpads = apiData.clients.clients.filter(c => c.severity !== 'healthy');
    const displayIpads = problematicIpads.slice(0, 4);

    displayIpads.forEach(ipad => {
      const card = document.createElement('div');
      card.className = `alert-item-card ${ipad.severity}`;
      
      const symptoms = ipad.flags.join(', ');
      
      card.innerHTML = `
        <div class="alert-icon ${ipad.severity === 'critical' ? 'text-critical' : 'text-warning'}">
          <i data-lucide="tablet"></i>
        </div>
        <div class="alert-text ${ipad.severity}">
          <h4>Client degraded: ${escapeHtml(ipad.hostname)} (${ipad.isIpad ? 'iPad' : 'Apple Device'})</h4>
          <p>Connected to <strong>${escapeHtml(ipad.apName)}</strong>. Symptoms: <strong>${symptoms}</strong>. Signal is ${ipad.signal} dBm, TX retries at ${ipad.txRetriesPct}%.</p>
          <p style="margin-top: 6px;"><strong>Resolution:</strong> ${ipad.recommendation}</p>
          <span class="alert-action-suggest ${ipad.severity}" onclick="switchTab('ipads')">Analyze this iPad in roster →</span>
        </div>
      `;
      alertsContainer.appendChild(card);
    });

    if (alertsContainer.children.length === 0) {
      alertsContainer.innerHTML = `
        <div class="alert-item-card healthy" style="background-color: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.15); border-left: 4px solid var(--color-success);">
          <div class="alert-icon text-success"><i data-lucide="check-circle-2"></i></div>
          <div class="alert-text healthy">
            <h4 style="color: #A7F3D0;">All Systems Normal</h4>
            <p>We ran diagnostics across all ${summaryCh.totalAPs} APs and ${summaryCl.totalAppleClients} Apple devices. No channel congestion or client connectivity issues were detected!</p>
          </div>
        </div>
      `;
    }
  }
}

/**
 * Render Channel Analyzer tab
 */
function renderChannelsTab() {
  if (!apiData) return;

  const chSummary = apiData.channels.summary;

  // 1. Draw 2.4 GHz Histogram
  drawHistogram('histogram-24', chSummary.channelCounts24, ['1', '6', '11'], '2.4GHz');
  
  // Update 2.4 GHz Analysis note
  const note24 = document.getElementById('analysis-note-24');
  if (note24) {
    const ch6 = chSummary.channelCounts24['6'] || 0;
    const total = chSummary.totalRadios24 || 1;
    if (ch6 / total > 0.3) {
      note24.style.display = 'block';
      note24.className = 'analysis-note alert-warning';
      note24.innerHTML = `<strong>Overcrowding Flag:</strong> ${ch6} out of ${total} 2.4GHz radios are running on channel 6. Highly elevated sideband interference is occurring. Spread APs onto channels 1 and 11.`;
    } else {
      note24.style.display = 'block';
      note24.className = 'analysis-note';
      note24.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
      note24.innerHTML = `<strong>2.4GHz Status:</strong> Radio load is relatively balanced. Keep monitoring channel utilization levels.`;
    }
  }

  // 2. Draw 5 GHz Histogram
  // Generate a broad selection of 5GHz channels to display nice column representations
  const standard5G = ['36', '40', '44', '48', '52', '56', '60', '64', '100', '104', '108', '112', '116', '120'];
  drawHistogram('histogram-5', chSummary.channelCounts5, standard5G, '5GHz');

  // Update 5 GHz Analysis note
  const note5 = document.getElementById('analysis-note-5');
  if (note5) {
    const ch40 = chSummary.channelCounts5['40'] || 0;
    const ch44 = chSummary.channelCounts5['44'] || 0;
    const total = chSummary.totalRadios5 || 1;
    const stackedPercent = Math.round(((ch40 + ch44) / total) * 100);
    
    if (stackedPercent > 60) {
      note5.style.display = 'block';
      note5.className = 'analysis-note alert-danger';
      note5.style.backgroundColor = 'rgba(239, 68, 68, 0.08)';
      note5.style.border = '1px solid rgba(239, 68, 68, 0.2)';
      note5.style.color = '#f87171';
      note5.innerHTML = `<strong>Critical Overlap Catastrophe:</strong> A massive ${stackedPercent}% of all 5GHz APs (${ch40 + ch44} out of ${total}) are stacked on just two channels (40 & 44). This creates a massive packet transmission backup, explaining why iPad download speeds are sluggish. Enact the Optimization Plan immediately.`;
    } else {
      note5.style.display = 'block';
      note5.className = 'analysis-note';
      note5.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
      note5.innerHTML = `<strong>5GHz Status:</strong> Channels appear evenly distributed.`;
    }
  }

  // 3. Populate Clogged Radios Table (`#channels-table-body`)
  const tableBody = document.getElementById('channels-table-body');
  const countLabel = document.getElementById('congested-radios-count');
  
  if (tableBody) {
    tableBody.innerHTML = '';
    
    // Sort all AP radios with critical/warning issues first
    const items = apiData.channels.radios;
    const countFlagged = items.filter(r => r.health !== 'healthy').length;
    if (countLabel) countLabel.textContent = `${countFlagged} radios flagged with issues`;

    items.forEach(r => {
      const tr = document.createElement('tr');
      
      const healthBadge = `<span class="health-status-badge ${r.health}">${r.health}</span>`;
      const bandName = r.radio === 'ng' ? '2.4GHz' : '5GHz';
      const cciDisplay = r.cci_count > 0 
        ? `<strong style="color: ${r.cci_count > 10 ? 'var(--color-danger)' : 'var(--color-warning)'}">${r.cci_count} overlapping APs</strong>`
        : '<span style="color: var(--text-dark);">0 (Optimal)</span>';

      tr.innerHTML = `
        <td style="font-weight:600;">${escapeHtml(r.apName)}</td>
        <td style="color:var(--text-muted);font-family:monospace;">${r.ip}</td>
        <td><span style="font-size:0.8rem;text-transform:uppercase;color:var(--text-dark);">${r.model}</span></td>
        <td><strong style="color:var(--primary-light);">${r.channel}</strong> (${bandName})</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="progress-bar-bg" style="width:60px;">
              <div class="progress-bar-fill" style="width:${r.cu_total}%; background:${getGradientForUtilization(r.cu_total)};"></div>
            </div>
            <strong style="color:${getHealthColor(100 - r.cu_total)};">${r.cu_total}%</strong>
          </div>
        </td>
        <td style="color:${r.tx_retries_pct > 20 ? 'var(--color-warning)' : 'var(--text-main)'}; font-weight:600;">${r.tx_retries_pct}%</td>
        <td style="font-weight:600;">${r.num_sta} clients</td>
        <td>${cciDisplay}</td>
        <td>${healthBadge}</td>
      `;
      tableBody.appendChild(tr);
    });
  }
}

/**
 * Render Access Points Inventory Tab
 */
function renderApsTab() {
  if (!apiData) return;

  filterAPs(); // Automatically triggers structured rendering with search query filters
}

/**
 * AP Filter and Roster populating
 */
function filterAPs() {
  const query = document.getElementById('ap-search').value.toLowerCase();
  const bandFilter = document.getElementById('ap-filter-band').value;
  const floorFilter = document.getElementById('ap-filter-floor').value;
  
  const tableBody = document.getElementById('aps-table-body');
  const countLabel = document.getElementById('ap-count-label');
  
  if (!tableBody || !apiData) return;

  tableBody.innerHTML = '';
  
  // Aggregate radios into APs structure for clean display
  // Structure: { MAC: { name, ip, model, radios: { ng: { ... }, na: { ... } }, clients: 0 } }
  const apList = {};
  
  apiData.channels.radios.forEach(r => {
    if (!apList[r.apMac]) {
      apList[r.apMac] = {
        mac: r.apMac,
        name: r.apName,
        ip: r.ip,
        model: r.model,
        radios: {},
        totalClients: 0,
        maxSeverity: 'healthy',
        min_rssi_enabled: false,
        min_rssi: null
      };
    }
    
    apList[r.apMac].radios[r.radio] = {
      channel: r.channel,
      cu_total: r.cu_total,
      cci_count: r.cci_count,
      health: r.health,
      tx_power: r.tx_power,
      tx_power_mode: r.tx_power_mode,
      configured_tx_power: r.configured_tx_power,
      antenna_gain: r.antenna_gain,
      min_rssi_enabled: r.min_rssi_enabled,
      min_rssi: r.min_rssi,
      ht: r.ht,
      bw: r.bw
    };
    
    if (r.min_rssi_enabled) {
      apList[r.apMac].min_rssi_enabled = true;
      apList[r.apMac].min_rssi = r.min_rssi;
    }
    
    apList[r.apMac].totalClients += r.num_sta;
    
    // Track maximum severity level
    const severityScore = { 'critical': 3, 'warning': 2, 'healthy': 1 };
    if (severityScore[r.health] > severityScore[apList[r.apMac].maxSeverity]) {
      apList[r.apMac].maxSeverity = r.health;
    }
  });

  const apArray = Object.values(apList);
  
  // Apply Search Queries
  let filtered = apArray.filter(ap => {
    const matchesSearch = ap.name.toLowerCase().includes(query) || 
                          ap.ip.toLowerCase().includes(query) || 
                          ap.model.toLowerCase().includes(query) || 
                          ap.mac.toLowerCase().includes(query);
    
    // Apply Band filter
    let matchesBand = true;
    if (bandFilter === 'ng') {
      matchesBand = !!ap.radios.ng;
    } else if (bandFilter === 'na') {
      matchesBand = !!ap.radios.na;
    }

    // Apply Floor filters
    // AP names follow school conventions, e.g. "EG-Flur", "1OG-Klasse12", "2OG-Physik"
    let matchesFloor = true;
    if (floorFilter !== 'all') {
      const name = ap.name.toUpperCase();
      if (floorFilter === 'EG') {
        matchesFloor = name.includes('EG') || name.startsWith('E-') || name.includes('ERDGESCHOSS');
      } else if (floorFilter === '1OG') {
        matchesFloor = name.includes('1OG') || name.includes('1.OG') || name.includes('FIRST');
      } else if (floorFilter === '2OG') {
        matchesFloor = name.includes('2OG') || name.includes('2.OG') || name.includes('SECOND');
      } else if (floorFilter === '3F') {
        // match anything else
        matchesFloor = !name.includes('EG') && !name.startsWith('E-') && 
                       !name.includes('1OG') && !name.includes('1.OG') && 
                       !name.includes('2OG') && !name.includes('2.OG');
      }
    }

    return matchesSearch && matchesBand && matchesFloor;
  });

  countLabel.textContent = `${filtered.length} Access Points active`;

  filtered.forEach(ap => {
    const tr = document.createElement('tr');
    
    const display24 = getRadioCardHtml(ap.radios.ng);
    const display5 = getRadioCardHtml(ap.radios.na);
    const displayMinRssi = getMinRssiHtml(ap);
    const overallBadge = `<span class="health-status-badge ${ap.maxSeverity}">${ap.maxSeverity}</span>`;

    tr.innerHTML = `
      <td>
        <div class="ap-info-cell">
          <span class="ap-name-title">${escapeHtml(ap.name)}</span>
          <div class="ap-meta-sub">
            <span class="ap-ip-badge">${ap.ip}</span>
            <span class="ap-model-badge">${ap.model}</span>
          </div>
        </div>
      </td>
      <td>${display24}</td>
      <td>${display5}</td>
      <td>${displayMinRssi}</td>
      <td style="font-weight:600; color:var(--primary-light); font-size: 0.95rem;">${ap.totalClients} clients</td>
      <td>${overallBadge}</td>
    `;
    tableBody.appendChild(tr);
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:40px; color:var(--text-dark);">
          <i data-lucide="search-code" style="width:32px; height:32px; margin-bottom:12px; display:inline-block;"></i>
          <p>No Access Points match your search filters.</p>
        </td>
      </tr>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
}

/**
 * Render iPad Diagnostics Tab
 */
function renderIpadsTab() {
  if (!apiData) return;

  const clSummary = apiData.clients.summary;

  // 1. Render iPad Health Circular Gauge
  const gaugeVal = document.getElementById('ipad-health-gauge-val');
  const gaugeRing = document.getElementById('ipad-health-gauge');
  if (gaugeVal && gaugeRing) {
    gaugeVal.textContent = `${clSummary.healthIndex}%`;
    gaugeRing.style.borderColor = getHealthColor(clSummary.healthIndex);
    gaugeRing.style.boxShadow = `0 0 18px ${getGlowColor(clSummary.healthIndex)}`;
  }

  // 2. Mini Grid Stats
  const miniAppleTotal = document.getElementById('mini-apple-total');
  const miniAppleWarning = document.getElementById('mini-apple-warning');
  const miniAppleCritical = document.getElementById('mini-apple-critical');
  
  if (miniAppleTotal) miniAppleTotal.textContent = clSummary.totalAppleClients;
  if (miniAppleWarning) miniAppleWarning.textContent = clSummary.warningCount;
  if (miniAppleCritical) miniAppleCritical.textContent = clSummary.criticalCount;

  // 3. Filter and populate
  filterIpads();
}

/**
 * iPad Filter and Roster populating
 */
function filterIpads() {
  const query = document.getElementById('ipad-search').value.toLowerCase();
  const statusFilter = document.getElementById('ipad-filter-status').value;
  const typeFilter = document.getElementById('ipad-filter-type').value;
  
  const tableBody = document.getElementById('ipads-table-body');
  if (!tableBody || !apiData) return;

  tableBody.innerHTML = '';
  
  const filtered = apiData.clients.clients.filter(c => {
    // Search filter
    const matchesSearch = c.hostname.toLowerCase().includes(query) || 
                          c.ip.toLowerCase().includes(query) || 
                          c.mac.toLowerCase().includes(query) ||
                          c.apName.toLowerCase().includes(query);
    
    // Status Filter
    let matchesStatus = true;
    if (statusFilter !== 'all') {
      matchesStatus = c.severity === statusFilter;
    }

    // Type Filter
    let matchesType = true;
    if (typeFilter === 'ipad') {
      matchesType = c.isIpad;
    }

    return matchesSearch && matchesStatus && matchesType;
  });

  filtered.forEach(c => {
    const tr = document.createElement('tr');
    
    // Render symptom tags
    const symptomTags = c.flags.map(f => {
      const cls = (f.includes('Critical') || f.includes('Poor')) ? 'danger' : 'warning';
      return `<span class="symptom-tag ${cls}">${f}</span>`;
    }).join('');

    // Format uptime
    const hours = Math.floor(c.uptime / 3600);
    const mins = Math.floor((c.uptime % 3600) / 60);
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    const experienceColor = getHealthColor(c.satisfaction);
    const signalColor = c.signal < -80 ? 'var(--color-danger)' : (c.signal < -70 ? 'var(--color-warning)' : 'var(--color-success)');

    tr.innerHTML = `
      <td>
        <div style="font-weight:700; color:white; display:flex; align-items:center; gap:8px;">
          <i data-lucide="${c.isIpad ? 'tablet' : 'laptop'}" style="width:16px; height:16px; color:var(--text-muted);"></i>
          <span>${escapeHtml(c.hostname)}</span>
        </div>
        <span style="font-size:0.72rem; color:var(--text-dark); display:block; margin-top:2px;">Uptime: ${uptimeStr}</span>
      </td>
      <td>
        <span style="display:block; font-weight:550; font-size:0.82rem;">${c.ip}</span>
        <span style="display:block; font-family:monospace; font-size:0.75rem; color:var(--text-dark);">${c.mac}</span>
      </td>
      <td>
        <strong style="color:white; display:block;">${escapeHtml(c.apName)}</strong>
        <span style="font-size:0.75rem; color:var(--text-muted); display:block; margin-top:2px;">Associated AP utilization: <strong style="color:${getHealthColor(100 - c.apCongestion)}">${c.apCongestion}%</strong></span>
      </td>
      <td>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <strong style="color:${signalColor}; font-size:0.95rem;">${c.signal} dBm</strong>
          <span style="font-size:0.72rem; color:var(--text-dark);">${getSignalLabel(c.signal)}</span>
        </div>
      </td>
      <td>
        <strong style="color:var(--primary-light);">${c.band}</strong>
        <span style="display:block; font-size:0.75rem; color:var(--text-muted); margin-top:2px;">Channel ${c.channel}</span>
      </td>
      <td>
        <strong style="font-size:1.05rem; color:${experienceColor};">${c.satisfaction}%</strong>
      </td>
      <td>
        <strong style="color:${c.txRetriesPct > 30 ? 'var(--color-danger)' : (c.txRetriesPct > 15 ? 'var(--color-warning)' : 'var(--text-main)')};">${c.txRetriesPct}%</strong>
      </td>
      <td>
        <div class="symptom-tag-container">${symptomTags || '<span style="color:var(--color-success); font-size:0.78rem;">✔ No anomalies</span>'}</div>
      </td>
      <td class="diag-action-text">${c.recommendation}</td>
    `;
    tableBody.appendChild(tr);
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center; padding:40px; color:var(--text-dark);">
          <i data-lucide="tablet" style="width:32px; height:32px; margin-bottom:12px; display:inline-block;"></i>
          <p>No Apple clients match your active filters.</p>
        </td>
      </tr>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
}

/**
 * Render and compute live global sidebar alert badges
 */
function updateGlobalBadges() {
  if (!apiData) return;

  const chSummary = apiData.channels.summary;
  const clSummary = apiData.clients.summary;

  // 1. Channel Congestion Warning Badge
  const badgeChannels = document.getElementById('badge-channels-alert');
  if (badgeChannels) {
    if (chSummary.congestedRadiosCount > 0 || apiData.channels.recommendations.some(r => r.severity === 'critical')) {
      badgeChannels.style.display = 'inline-block';
    } else {
      badgeChannels.style.display = 'none';
    }
  }

  // 2. iPad Critical Count Badge
  const badgeIpad = document.getElementById('badge-ipad-critical');
  if (badgeIpad) {
    badgeIpad.textContent = clSummary.criticalCount;
    if (clSummary.criticalCount > 0) {
      badgeIpad.style.display = 'inline-block';
    } else {
      badgeIpad.style.display = 'none';
    }
  }

  // 3. Optimization Step Indicator
  const badgeAction = document.getElementById('badge-action-alert');
  if (badgeAction) {
    if (apiData.channels.recommendations.length > 0) {
      badgeAction.style.display = 'flex';
      badgeAction.textContent = apiData.channels.recommendations.length;
    } else {
      badgeAction.style.display = 'none';
    }
  }
}

/**
 * Draw a beautiful Column Bar-Chart Histogram dynamically
 * @param {string} containerId - Target container element
 * @param {object} channelCounts - Object detailing channel counts e.g. { "6": 22 }
 * @param {Array} standardChannels - Array of channels to render columns for
 * @param {string} band - Band ID e.g. "2.4GHz" or "5GHz"
 */
function drawHistogram(containerId, channelCounts, standardChannels, band) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  
  // Calculate maximum count to scale columns heights appropriately (min scaling denominator is 1 to avoid Division by Zero)
  const counts = Object.values(channelCounts);
  const maxCount = Math.max(...counts, 1);

  standardChannels.forEach(ch => {
    const count = channelCounts[String(ch)] || 0;
    
    // Scale column height between 5% and 85% for awesome aesthetics
    const heightPercent = count > 0 
      ? Math.max(8, Math.round((count / maxCount) * 85)) 
      : 0;

    const column = document.createElement('div');
    column.className = 'hist-column';

    // Build specific beautiful gradients based on loading severity
    let barColor = 'rgba(79, 70, 229, 0.3)'; // base primary tint for empty/low
    if (count > 0) {
      if (band === '5GHz') {
        barColor = count > 15 
          ? 'linear-gradient(to top, #DC2626, #EF4444)' // Clogged red
          : 'linear-gradient(to top, #4F46E5, #818CF8)'; // Clean blue
      } else {
        // 2.4GHz severity limits
        barColor = count > 10 
          ? 'linear-gradient(to top, #D97706, #F59E0B)' // Warning amber
          : 'linear-gradient(to top, #4F46E5, #818CF8)';
      }
    }

    column.innerHTML = `
      <div class="hist-bar-wrapper" style="height:${heightPercent}%; background:${barColor};">
        ${count > 0 ? `<span class="hist-bar-value" style="color:${count > 15 && band === '5GHz' ? 'var(--color-danger)' : 'white'};">${count}</span>` : ''}
      </div>
      <span class="hist-label">${ch}</span>
    `;
    container.appendChild(column);
  });
}

/**
 * Utility Colors helper
 * @param {number} healthVal 
 */
function getHealthColor(healthVal) {
  if (healthVal >= 85) return 'var(--color-success)';
  if (healthVal >= 70) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

/**
 * Glow shadows helper
 * @param {number} healthVal 
 */
function getGlowColor(healthVal) {
  if (healthVal >= 85) return 'rgba(16, 185, 129, 0.25)';
  if (healthVal >= 70) return 'rgba(245, 158, 11, 0.25)';
  return 'rgba(239, 68, 68, 0.25)';
}

/**
 * Utilization Gradients Helper
 * @param {number} util 
 */
function getGradientForUtilization(util) {
  if (util > 75) return 'linear-gradient(90deg, #EF4444, #F87171)';
  if (util > 50) return 'linear-gradient(90deg, #F59E0B, #FBBF24)';
  return 'linear-gradient(90deg, #10B981, #34D399)';
}

/**
 * Convert signal RSSI into semantic terms
 * @param {number} rssi 
 */
function getSignalLabel(rssi) {
  if (rssi >= -65) return 'Excellent Connection';
  if (rssi >= -72) return 'Good / Stable';
  if (rssi >= -80) return 'Weak / Sluggish';
  return 'Critical Signal Drop';
}

/**
 * Error Toast Alert popup
 * @param {string} msg 
 */
function showErrorNotification(msg) {
  const alertsContainer = document.getElementById('overview-alerts');
  if (alertsContainer && activeTab === 'overview') {
    const errCard = document.createElement('div');
    errCard.className = 'alert-item-card critical';
    errCard.style.marginBottom = '20px';
    errCard.innerHTML = `
      <div class="alert-icon text-critical"><i data-lucide="shield-alert"></i></div>
      <div class="alert-text critical">
        <h4>Telemetry Sync Interrupted</h4>
        <p>We are currently unable to retrieve raw statistics from the local UniFi Controller (Host: 172.16.0.200:8443). The local express server is serving stale cached data or reported: <code>${msg}</code>.</p>
        <p style="margin-top:6px;"><strong>Troubleshooting:</strong> Check that the UniFi hardware controller is powered on, reachable on the school intranet network, and that the credentials configured in the environment file are correct.</p>
      </div>
    `;
    alertsContainer.prepend(errCard);
  }
}

/**
 * Escape string to prevent XSS
 * @param {string} str 
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

/**
 * Generate beautiful detailed Radio Cards HTML
 * @param {object} r - Radio detail structure
 */
function getRadioCardHtml(r) {
  if (!r) {
    return `<div class="radio-disabled-card">Disabled</div>`;
  }
  
  let powerClass = 'power-auto';
  if (r.tx_power_mode === 'low') powerClass = 'power-low';
  else if (r.tx_power_mode === 'medium') powerClass = 'power-medium';
  else if (r.tx_power_mode === 'high') powerClass = 'power-high';
  else if (r.tx_power_mode === 'custom') powerClass = 'power-custom';

  const powerDisplay = r.tx_power !== null ? `${r.tx_power} dBm` : (r.configured_tx_power !== null ? `${r.configured_tx_power} dBm` : 'Auto');
  const powerModeLbl = r.tx_power_mode ? r.tx_power_mode.toUpperCase() : 'AUTO';
  
  const utilClass = r.cu_total > 70 ? 'bad' : (r.cu_total > 40 ? 'warning' : 'good');
  const bwDisplay = r.bw ? `${r.bw}MHz` : (r.ht || '');

  return `
    <div class="radio-details-card ${r.health || 'healthy'}">
      <div class="radio-header-row">
        <span class="channel-main">Ch <strong>${r.channel}</strong></span>
        ${bwDisplay ? `<span class="width-badge">${bwDisplay}</span>` : ''}
      </div>
      <div class="radio-details-grid">
        <div class="radio-stat">
          <span class="stat-lbl">Power</span>
          <span class="stat-val ${powerClass}" title="Mode: ${powerModeLbl}">${powerDisplay}</span>
          ${r.antenna_gain !== null ? `<span class="gain-sub">+${r.antenna_gain}dBi</span>` : ''}
        </div>
        <div class="radio-stat">
          <span class="stat-lbl">Load</span>
          <span class="stat-val ${r.cu_total > 70 ? 'bad' : ''}">${r.cu_total}%</span>
        </div>
        <div class="radio-stat">
          <span class="stat-lbl">CCI</span>
          <span class="stat-val ${r.cci_count > 5 ? 'bad' : ''}">${r.cci_count}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate beautiful Minimum RSSI Badge Card HTML
 * @param {object} ap - Aggregate AP structure
 */
function getMinRssiHtml(ap) {
  const ng = ap.radios.ng;
  const na = ap.radios.na;
  
  const hasMinRssi = (ng && ng.min_rssi_enabled) || (na && na.min_rssi_enabled);
  if (!hasMinRssi) {
    return `<div class="min-rssi-card disabled">Not Configured</div>`;
  }
  
  return `
    <div class="min-rssi-card">
      ${ng && ng.min_rssi_enabled ? `
        <div class="rssi-row">
          <span class="band-lbl">2.4G</span>
          <span class="rssi-val">${ng.min_rssi} dBm</span>
        </div>
      ` : ''}
      ${na && na.min_rssi_enabled ? `
        <div class="rssi-row">
          <span class="band-lbl">5G</span>
          <span class="rssi-val">${na.min_rssi} dBm</span>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Compile and render the comparative optimal network channel plan grid layout
 */
function renderOptimalGrid() {
  const tableBody = document.getElementById('optimization-grid-body');
  const driftLabel = document.getElementById('opt-drift-label');
  if (!tableBody || !apiData) return;

  tableBody.innerHTML = '';

  const apList = {};
  apiData.channels.radios.forEach(r => {
    if (!apList[r.apMac]) {
      apList[r.apMac] = {
        mac: r.apMac,
        name: r.apName,
        model: r.model,
        radios: {}
      };
    }
    apList[r.apMac].radios[r.radio] = r;
  });

  const apArray = Object.values(apList).sort((a, b) => a.name.localeCompare(b.name));

  const ch24Options = [1, 6, 11];
  const ch5Options = [36, 44, 52, 60, 100, 108, 116, 124, 132, 140];

  let driftCount = 0;
  let totalAudits = 0;

  // Retrieve checked MACs from localStorage for persistent state rendering
  let checkedMacs = [];
  try {
    const raw = localStorage.getItem('unifi_opt_checked_macs');
    if (raw) checkedMacs = JSON.parse(raw);
  } catch (e) {
    console.error('Error fetching checked MACs:', e);
  }

  apArray.forEach((ap, index) => {
    let floor = 'EG';
    let floorOffset = 0;
    const name = ap.name.toUpperCase();
    if (name.includes('EG') || name.startsWith('E-') || name.includes('ERDGESCHOSS')) {
      floor = 'EG';
      floorOffset = 0;
    } else if (name.includes('1OG') || name.includes('1.OG') || name.includes('FIRST')) {
      floor = '1OG';
      floorOffset = 3;
    } else if (name.includes('2OG') || name.includes('2.OG') || name.includes('SECOND')) {
      floor = '2OG';
      floorOffset = 6;
    } else {
      floor = 'Other';
      floorOffset = 9;
    }

    const optCh24 = ch24Options[(index + Math.floor(floorOffset / 3)) % ch24Options.length];
    const optCh5 = ch5Options[(index + floorOffset) % ch5Options.length];

    const optPower24 = 9;
    const optPower5 = 15;
    const optMinRssi = -75;

    const r24 = ap.radios.ng;
    const r5 = ap.radios.na;

    const curCh24 = r24 ? r24.channel : null;
    const curPower24 = r24 ? r24.tx_power : null;

    const curCh5 = r5 ? r5.channel : null;
    const curPower5 = r5 ? r5.tx_power : null;

    const curMinRssi = r24 && r24.min_rssi_enabled ? r24.min_rssi : (r5 && r5.min_rssi_enabled ? r5.min_rssi : null);

    const isCh24Drift = r24 && curCh24 !== optCh24;
    const isCh5Drift = r5 && curCh5 !== optCh5;
    const isPower24Drift = r24 && (r24.tx_power_mode === 'auto' || (curPower24 !== null && curPower24 > 10));
    const isPower5Drift = r5 && (r5.tx_power_mode === 'auto' || (curPower5 !== null && curPower5 > 16));
    const isMinRssiDrift = !curMinRssi || curMinRssi !== optMinRssi;

    const hasDrift = isCh24Drift || isCh5Drift || isPower24Drift || isPower5Drift || isMinRssiDrift;

    if (hasDrift) {
      driftCount++;
    }
    totalAudits++;

    const cell24Ch = r24 
      ? `<span class="${isCh24Drift ? 'text-drift' : ''}">${curCh24} ➔ <strong>${optCh24}</strong></span>`
      : '<span class="text-muted">Disabled</span>';

    const cell24Power = r24
      ? `<span class="${isPower24Drift ? 'text-drift' : ''}">${r24.tx_power_mode === 'auto' ? 'Auto' : `${curPower24} dBm`} ➔ <strong>9 dBm (Low)</strong></span>`
      : '<span class="text-muted">Disabled</span>';

    const cell5Ch = r5
      ? `<span class="${isCh5Drift ? 'text-drift' : ''}">${curCh5} ➔ <strong>${optCh5}</strong></span>`
      : '<span class="text-muted">Disabled</span>';

    const cell5Power = r5
      ? `<span class="${isPower5Drift ? 'text-drift' : ''}">${r5.tx_power_mode === 'auto' ? 'Auto' : `${curPower5} dBm`} ➔ <strong>15 dBm (Med)</strong></span>`
      : '<span class="text-muted">Disabled</span>';

    const cellMinRssi = `<span class="${isMinRssiDrift ? 'text-drift' : ''}">${curMinRssi ? `${curMinRssi} dBm` : 'Disabled'} ➔ <strong>-75 dBm</strong></span>`;

    const auditBadge = hasDrift
      ? `<span class="badge-drift"><i data-lucide="alert-triangle" style="width:12px; height:12px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>DRIFT DETECTED</span>`
      : `<span class="badge-ok"><i data-lucide="check" style="width:12px; height:12px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>OPTIMAL</span>`;

    const isChecked = checkedMacs.includes(ap.mac);
    const tr = document.createElement('tr');
    tr.setAttribute('data-ap-row-mac', ap.mac);
    if (isChecked) {
      tr.classList.add('row-opt-done');
    }

    tr.innerHTML = `
      <td style="text-align:center; vertical-align:middle;" class="print-checkbox-cell">
        <input type="checkbox" class="opt-done-checkbox" data-ap-mac="${ap.mac}" ${isChecked ? 'checked' : ''} onchange="toggleAPChecked('${ap.mac}', this.checked)">
      </td>
      <td style="font-weight:700; color:white;">${escapeHtml(ap.name)}</td>
      <td><span style="font-size:0.75rem; background-color:rgba(255,255,255,0.03); padding:4px 8px; border-radius:4px;">${floor}</span></td>
      <td><span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase;">${ap.model}</span></td>
      <td>${cell24Ch}</td>
      <td>${cell24Power}</td>
      <td>${cell5Ch}</td>
      <td>${cell5Power}</td>
      <td>${cellMinRssi}</td>
      <td>${auditBadge}</td>
    `;
    tableBody.appendChild(tr);
  });

  if (driftLabel) {
    const driftPct = Math.round((driftCount / totalAudits) * 100);
    driftLabel.textContent = `${driftCount} APs drifted (${driftPct}% configuration drift)`;
    driftLabel.className = driftCount > 0 ? 'count-badge bg-red-alpha' : 'count-badge bg-teal-alpha';
    if (driftCount > 0) {
      driftLabel.style.color = 'var(--color-danger)';
    } else {
      driftLabel.style.color = 'var(--color-success)';
    }

    // Populate print drift badge
    const printDrift = document.getElementById('print-drift');
    if (printDrift) {
      printDrift.textContent = `${driftCount} APs drifted (${driftPct}% drift)`;
    }
  }

  // Populate print date
  const printDate = document.getElementById('print-date');
  if (printDate) {
    const now = new Date();
    printDate.textContent = now.toLocaleString('de-AT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Populate print progress
  updatePrintProgress();

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

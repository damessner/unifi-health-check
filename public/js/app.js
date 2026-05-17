/**
 * Network Health & Channel Analyzer - Client Controller
 * Single Page Application Core Controller
 */

// Global State
let apiData = null;
let rawApiData = null;
let sandboxModeEnabled = false;
let sandboxOverrides = {};
let selectedAPMac = null;
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

// ============================================================
//  DASHBOARD CONSTANTS
// ============================================================

/** Maximum expected throughput for speed gauge scaling (Mbps) */
const GAUGE_MAX_MBPS = 2000;

/** Expected total client count for capacity planning readiness checks */
const CAPACITY_TARGET_CLIENTS = 800;

/** Maximum number of entries to keep in the struggling-clients event log */
const EVENTS_LOG_MAX = 200;

/** kbps to Mbps conversion factor */
const KBPS_PER_MBPS = 1000;

/** DFS 5 GHz channel numbers (channels 52–144) */
const DFS_CHANNELS_5GHZ = ['52','56','60','64','100','104','108','112','116','120','124','128','132','136','140','144'];


// DOMContentLoaded Initialization
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Initializing dashboard UI elements...');
  
  // Initialize Sandbox Mode state from localStorage
  try {
    const savedEnabled = localStorage.getItem('unifi_sandbox_enabled');
    sandboxModeEnabled = savedEnabled === 'true';
    const savedOverrides = localStorage.getItem('unifi_sandbox_overrides');
    if (savedOverrides) {
      sandboxOverrides = JSON.parse(savedOverrides);
    }
  } catch (e) {
    console.error('Error loading sandbox settings from localStorage:', e);
  }

  // Update toggle checkbox in UI
  const toggle = document.getElementById('sandbox-toggle');
  if (toggle) {
    toggle.checked = sandboxModeEnabled;
  }
  const toggleWrap = document.querySelector('.sandbox-toggle-wrap');
  if (toggleWrap && sandboxModeEnabled) {
    toggleWrap.classList.add('active');
  }
  
  // Toggle proximity panel display state based on active sandbox settings
  const proximityPanel = document.getElementById('sandbox-proximity-panel');
  if (proximityPanel) {
    proximityPanel.style.display = sandboxModeEnabled ? 'grid' : 'none';
  }
  
  // Set initial sync labels
  const syncModeText = document.getElementById('sync-mode-text');
  if (syncModeText) {
    syncModeText.textContent = sandboxModeEnabled ? 'Sandbox Tuning Active' : 'Manual Sync Only';
  }
  
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
    // Lazily load history when navigating to the history tab
    if (tabId === 'history') {
      fetchAndRenderHistory();
    }
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
    speeds: {
      title: 'Speed Monitor',
      subtitle: 'Live download/upload rates, top clients, struggling devices log & capacity planning'
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
    history: {
      title: 'History & Trends',
      subtitle: 'Trend analysis of channel utilization, client counts and network speeds over time'
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

    rawApiData = payload;
    console.log('[API Fetch] Successfully fetched fresh telemetry!', rawApiData);
    
    // Process sandbox mapping or direct deep clone
    if (sandboxModeEnabled) {
      runRFPropagationEngine();
    } else {
      apiData = JSON.parse(JSON.stringify(rawApiData));
    }
    
    // Process and render all segments
    renderOverview();
    renderSpeedsTab();
    renderChannelsTab();
    renderApsTab();
    renderIpadsTab();
    updateGlobalBadges();
    renderOptimalGrid();
<<<<<<< Updated upstream
=======
    renderProximityMap();
>>>>>>> Stashed changes
    updateEventsLog();
    // Refresh history charts if history tab is active
    if (activeTab === 'history') {
      fetchAndRenderHistory();
    }

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

  // 3. Struggling clients badge on Speed Monitor
  const badgeSpeeds = document.getElementById('badge-speeds-struggling');
  if (badgeSpeeds && apiData.clients.strugglingAll) {
    const n = apiData.clients.strugglingAll.length;
    badgeSpeeds.textContent = n;
    badgeSpeeds.style.display = n > 0 ? 'inline-block' : 'none';
  }

  // 4. Optimization Step Indicator
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

    let cell24Ch, cell5Ch;
    
    if (sandboxModeEnabled) {
      const ch24SelectOptions = [1, 6, 11].map(ch => 
        `<option value="${ch}" ${curCh24 === ch ? 'selected' : ''}>Ch ${ch}</option>`
      ).join('');
      
      const ch5SelectOptions = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144].map(ch => 
        `<option value="${ch}" ${curCh5 === ch ? 'selected' : ''}>Ch ${ch}</option>`
      ).join('');
      
      cell24Ch = r24
        ? `<div style="display:flex; align-items:center; gap:6px;">
             <select class="sandbox-dropdown ${isCh24Drift ? 'changed' : ''}" onchange="changeSandboxChannel('${ap.mac}', 'ng', this.value)">
               ${ch24SelectOptions}
             </select>
             <span>➔ <strong>${optCh24}</strong></span>
           </div>`
        : '<span class="text-muted">Disabled</span>';
        
      cell5Ch = r5
        ? `<div style="display:flex; align-items:center; gap:6px;">
             <select class="sandbox-dropdown ${isCh5Drift ? 'changed' : ''}" onchange="changeSandboxChannel('${ap.mac}', 'na', this.value)">
               ${ch5SelectOptions}
             </select>
             <span>➔ <strong>${optCh5}</strong></span>
           </div>`
        : '<span class="text-muted">Disabled</span>';
    } else {
      cell24Ch = r24 
        ? `<span class="${isCh24Drift ? 'text-drift' : ''}">${curCh24} ➔ <strong>${optCh24}</strong></span>`
        : '<span class="text-muted">Disabled</span>';
        
      cell5Ch = r5
        ? `<span class="${isCh5Drift ? 'text-drift' : ''}">${curCh5} ➔ <strong>${optCh5}</strong></span>`
        : '<span class="text-muted">Disabled</span>';
    }

    const cell24Power = r24
      ? `<span class="${isPower24Drift ? 'text-drift' : ''}">${r24.tx_power_mode === 'auto' ? 'Auto' : `${curPower24} dBm`} ➔ <strong>9 dBm (Low)</strong></span>`
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

// ============================================================
//  SPEED MONITOR TAB
// ============================================================

/**
 * Format kbps value into a human-readable Mbps string.
 */
function kbpsToMbps(kbps) {
  if (kbps >= KBPS_PER_MBPS * KBPS_PER_MBPS) return `${(kbps / (KBPS_PER_MBPS * KBPS_PER_MBPS)).toFixed(1)} Gbps`;
  if (kbps >= KBPS_PER_MBPS) return `${(kbps / KBPS_PER_MBPS).toFixed(0)} Mbps`;
  return `${kbps} kbps`;
}

/**
 * Set the CSS conic-gradient gauge needle on a .speed-gauge element.
 */
function setGauge(gaugeEl, pct, color) {
  if (!gaugeEl) return;
  const safe = Math.min(100, Math.max(0, pct));
  const deg = safe * 3.6;
  gaugeEl.style.background = `conic-gradient(${color} ${deg}deg, rgba(255,255,255,0.05) ${deg}deg)`;
}

/**
 * Render the Speed Monitor tab.
 */
function renderSpeedsTab() {
  if (!apiData) return;

  const cl = apiData.clients;
  const sum = cl.summary;

  // Speed gauge values (capped to GAUGE_MAX_MBPS for gauge scale)
  const dlMbps = Math.round(sum.totalDownloadKbps / KBPS_PER_MBPS);
  const ulMbps = Math.round(sum.totalUploadKbps / KBPS_PER_MBPS);
  const dlPct = Math.min(100, (dlMbps / GAUGE_MAX_MBPS) * 100);
  const ulPct = Math.min(100, (ulMbps / GAUGE_MAX_MBPS) * 100);
  const dlColor = dlPct > 80 ? '#EF4444' : dlPct > 50 ? '#F59E0B' : '#10B981';
  const ulColor = ulPct > 80 ? '#EF4444' : ulPct > 50 ? '#F59E0B' : '#818CF8';

  setGauge(document.getElementById('gauge-download'), dlPct, dlColor);
  setGauge(document.getElementById('gauge-upload'), ulPct, ulColor);

  const dlVal = document.getElementById('speed-dl-val');
  const ulVal = document.getElementById('speed-ul-val');
  if (dlVal) dlVal.textContent = dlMbps >= 1000 ? `${(dlMbps / 1000).toFixed(1)}G` : dlMbps;
  if (ulVal) ulVal.textContent = ulMbps >= 1000 ? `${(ulMbps / 1000).toFixed(1)}G` : ulMbps;

  const dlUnit = document.querySelector('#gauge-download .gauge-unit');
  const ulUnit = document.querySelector('#gauge-upload .gauge-unit');
  if (dlUnit) dlUnit.textContent = dlMbps >= 1000 ? 'Gbps' : 'Mbps';
  if (ulUnit) ulUnit.textContent = ulMbps >= 1000 ? 'Gbps' : 'Mbps';

  const dlSub = document.getElementById('speed-dl-sub');
  const ulSub = document.getElementById('speed-ul-sub');
  if (dlSub) dlSub.textContent = `Aggregate AP → Client TX rate`;
  if (ulSub) ulSub.textContent = `Aggregate Client → AP RX rate`;

  // All clients count
  const clientCount = document.getElementById('speed-client-count');
  if (clientCount) clientCount.textContent = sum.totalAllClients;
  const avgDlEl = document.getElementById('speed-avg-dl');
  if (avgDlEl) {
    const avg = sum.totalAllClients > 0 ? Math.round(sum.totalDownloadKbps / sum.totalAllClients / 1000) : 0;
    avgDlEl.textContent = `Avg: ${avg} Mbps/client DL`;
  }

  // Capacity count
  const capCountEl = document.getElementById('capacity-count');
  if (capCountEl) {
    capCountEl.innerHTML = `${sum.totalAllClients}<span style="font-size:0.45em; color:var(--text-dark)">&nbsp;/ ${CAPACITY_TARGET_CLIENTS}</span>`;
  }
  const capReadinessEl = document.getElementById('capacity-readiness-label');
  if (capReadinessEl) {
    const pctFull = Math.round((sum.totalAllClients / CAPACITY_TARGET_CLIENTS) * 100);
    capReadinessEl.textContent = `${pctFull}% capacity utilized`;
    capReadinessEl.style.color = pctFull > 80 ? 'var(--color-danger)' : pctFull > 50 ? 'var(--color-warning)' : 'var(--color-success)';
  }

  // Top Downloaders table
  renderTopDownloadersTable();

  // Per-AP throughput chart
  renderApThroughputChart();

  // Capacity planning widget
  renderCapacityWidget();
}

/**
 * Render the Top Downloaders table
 */
function renderTopDownloadersTable() {
  const tbody = document.getElementById('top-downloaders-body');
  if (!tbody || !apiData || !apiData.clients.topDownloaders) return;

  tbody.innerHTML = '';
  apiData.clients.topDownloaders.forEach((c, i) => {
    const dlFormatted = kbpsToMbps(c.txRateKbps);
    const ulFormatted = kbpsToMbps(c.rxRateKbps);
    const signalColor = c.signal < -80 ? 'var(--color-danger)' : c.signal < -70 ? 'var(--color-warning)' : 'var(--color-success)';
    const severityBadge = `<span class="health-status-badge ${c.severity}">${c.severity}</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:var(--text-dark); font-weight:600; text-align:center;">${i + 1}</td>
      <td>
        <div style="font-weight:600; color:white;">${escapeHtml(c.hostname)}</div>
        <div style="font-size:0.72rem; color:var(--text-dark); font-family:monospace;">${c.mac}</div>
      </td>
      <td style="color:var(--text-muted); font-size:0.82rem;">${escapeHtml(c.apName)}</td>
      <td>
        <strong style="color:var(--primary-light);">${c.band}</strong>
        <span style="display:block; font-size:0.72rem; color:var(--text-dark);">Ch ${c.channel}</span>
      </td>
      <td><strong style="color:#34D399; font-size:0.95rem;">↓ ${dlFormatted}</strong></td>
      <td><strong style="color:#818CF8; font-size:0.95rem;">↑ ${ulFormatted}</strong></td>
      <td><strong style="color:${signalColor};">${c.signal} dBm</strong></td>
      <td>${severityBadge}</td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) window.lucide.createIcons();
}

/**
 * Render per-AP throughput horizontal bar chart
 */
function renderApThroughputChart() {
  const container = document.getElementById('ap-throughput-chart');
  if (!container || !apiData || !apiData.clients.allClients) return;

  // Aggregate by AP
  const apData = {};
  apiData.clients.allClients.forEach(c => {
    const key = c.apName || 'Unknown AP';
    if (!apData[key]) apData[key] = { dl: 0, ul: 0, count: 0 };
    apData[key].dl += c.txRateKbps;
    apData[key].ul += c.rxRateKbps;
    apData[key].count++;
  });

  const entries = Object.entries(apData).sort((a, b) => b[1].dl - a[1].dl);
  if (entries.length === 0) {
    container.innerHTML = '<p class="text-muted" style="padding:20px;">No client data available.</p>';
    return;
  }

  const maxDl = Math.max(...entries.map(e => e[1].dl), 1);

  container.innerHTML = '';
  entries.forEach(([apName, data]) => {
    const dlPct = Math.round((data.dl / maxDl) * 100);
    const ulPct = Math.round((data.ul / maxDl) * 100);
    const row = document.createElement('div');
    row.className = 'ap-throughput-row';
    row.innerHTML = `
      <div class="ap-tp-label">
        <span class="ap-tp-name">${escapeHtml(apName)}</span>
        <span class="ap-tp-count">${data.count} client${data.count !== 1 ? 's' : ''}</span>
      </div>
      <div class="ap-tp-bars">
        <div class="ap-tp-bar-wrap">
          <div class="ap-tp-bar dl-bar" style="width:${dlPct}%; min-width:2px;"></div>
          <span class="ap-tp-bar-val">↓ ${kbpsToMbps(data.dl)}</span>
        </div>
        <div class="ap-tp-bar-wrap">
          <div class="ap-tp-bar ul-bar" style="width:${ulPct}%; min-width:2px;"></div>
          <span class="ap-tp-bar-val">↑ ${kbpsToMbps(data.ul)}</span>
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}

/**
 * Render the Capacity Planning readiness checklist widget
 */
function renderCapacityWidget() {
  const container = document.getElementById('capacity-widget');
  if (!container || !apiData) return;

  const ch = apiData.channels.summary;
  const cl = apiData.clients.summary;

  const numAPs = ch.totalAPs;
  const expectedClients = CAPACITY_TARGET_CLIENTS;
  const perAP = numAPs > 0 ? Math.round(expectedClients / numAPs) : 0;

  const checks = [
    {
      label: 'AP Deployment Density',
      detail: `${numAPs} APs → ${perAP} clients/AP expected (target: ≤ 30/AP)`,
      pass: numAPs > 0 && perAP <= 30,
      warn: numAPs > 0 && perAP > 30 && perAP <= 40
    },
    {
      label: '5 GHz Channel Diversity',
      detail: (() => {
        const ch40 = ch.channelCounts5['40'] || 0;
        const ch44 = ch.channelCounts5['44'] || 0;
        const total5 = ch.totalRadios5 || 1;
        const stacked = Math.round(((ch40 + ch44) / total5) * 100);
        return `${stacked}% of 5 GHz APs on channels 40/44 (target: < 30% per channel)`;
      })(),
      pass: (() => {
        const ch40 = ch.channelCounts5['40'] || 0;
        const ch44 = ch.channelCounts5['44'] || 0;
        const total5 = ch.totalRadios5 || 1;
        return ((ch40 + ch44) / total5) < 0.3;
      })(),
      warn: false
    },
    {
      label: '5 GHz Average Channel Utilization',
      detail: `Current: ${ch.avgUtil5}% (target: < 60%; at ${CAPACITY_TARGET_CLIENTS} clients it will be much higher)`,
      pass: ch.avgUtil5 < 60,
      warn: ch.avgUtil5 >= 60 && ch.avgUtil5 < 75
    },
    {
      label: '2.4 GHz Average Channel Utilization',
      detail: `Current: ${ch.avgUtil24}% (target: < 50%)`,
      pass: ch.avgUtil24 < 50,
      warn: ch.avgUtil24 >= 50 && ch.avgUtil24 < 65
    },
    {
      label: 'DFS Channel Availability',
      detail: (() => {
        const dfsInUse = DFS_CHANNELS_5GHZ.filter(c => (ch.channelCounts5[c] || 0) > 0).length;
        return dfsInUse > 0
          ? `${dfsInUse} DFS channels in use — spectrum expanded`
          : 'No DFS channels active. Only 2 usable non-DFS 5 GHz channels available.';
      })(),
      pass: DFS_CHANNELS_5GHZ.some(c => (ch.channelCounts5[c] || 0) > 0),
      warn: false
    },
    {
      label: 'Critical Client Issues',
      detail: `${cl.criticalCount} critical + ${cl.warningCount} warning clients currently (target: 0 critical)`,
      pass: cl.criticalCount === 0,
      warn: cl.criticalCount === 0 && cl.warningCount > 0
    }
  ];

  const passCount = checks.filter(c => c.pass).length;
  const readinessPct = Math.round((passCount / checks.length) * 100);
  const readinessColor = readinessPct >= 80 ? '#10B981' : readinessPct >= 50 ? '#F59E0B' : '#EF4444';
  const readinessLabel = readinessPct >= 80 ? '✅ READY' : readinessPct >= 50 ? '⚠️ MARGINAL' : '❌ NOT READY';

  let html = `
    <div class="capacity-header">
      <div class="capacity-score" style="color:${readinessColor}; border-color:${readinessColor};">${readinessPct}%</div>
      <div>
        <h3 style="color:${readinessColor}; margin:0 0 4px;">Network Readiness: ${readinessLabel}</h3>
        <p class="text-muted" style="margin:0; font-size:0.85rem;">${passCount} of ${checks.length} readiness checks passed</p>
      </div>
    </div>
    <div class="capacity-checklist">
  `;

  checks.forEach(c => {
    const icon = c.pass ? '✔' : c.warn ? '⚠' : '✖';
    const cls = c.pass ? 'cap-pass' : c.warn ? 'cap-warn' : 'cap-fail';
    html += `
      <div class="cap-check-item ${cls}">
        <span class="cap-icon">${icon}</span>
        <div>
          <strong>${c.label}</strong>
          <p>${c.detail}</p>
        </div>
      </div>
    `;
  });

  html += `</div>`;

  if (readinessPct < 80) {
    html += `
      <div class="capacity-action-note">
        <i data-lucide="alert-triangle"></i>
        <p><strong>Action required before the event:</strong> Execute the <a onclick="switchTab('optimizer')" href="#" style="color:var(--primary-light);">Optimization Plan</a> immediately to resolve channel stacking and improve readiness.</p>
      </div>
    `;
  }

  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================
//  STRUGGLING CLIENTS EVENT LOG
// ============================================================

const EVENTS_LOG_KEY = 'unifi_events_log';

/**
 * Read events log from localStorage
 */
function readEventsLog() {
  try {
    const raw = localStorage.getItem(EVENTS_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

/**
 * Write events log to localStorage
 */
function writeEventsLog(entries) {
  try {
    localStorage.setItem(EVENTS_LOG_KEY, JSON.stringify(entries));
  } catch (e) {
    console.warn('Could not persist events log:', e);
  }
}

/**
 * Compare current struggling clients against previous set and log new / resolved events.
 */
function updateEventsLog() {
  if (!apiData || !apiData.clients.strugglingAll) return;

  const entries = readEventsLog();
  const now = new Date().toISOString();

  apiData.clients.strugglingAll.forEach(c => {
    // Only add an entry if this client isn't already the latest entry in the log
    const lastEntry = entries.filter(e => e.mac === c.mac).pop();
    if (!lastEntry || lastEntry.severity !== c.severity) {
      entries.push({
        time: now,
        mac: c.mac,
        hostname: c.hostname,
        severity: c.severity,
        flags: c.flags,
        apName: c.apName,
        signal: c.signal,
        band: c.band
      });
    }
  });

  // Keep only the most recent entries
  const trimmed = entries.slice(-EVENTS_LOG_MAX);
  writeEventsLog(trimmed);

  renderEventsLog();
}

/**
 * Render the events log in the Speed Monitor tab
 */
function renderEventsLog() {
  const container = document.getElementById('events-log');
  if (!container) return;

  const entries = readEventsLog();
  if (entries.length === 0) {
    container.innerHTML = `
      <div class="log-empty-state">
        <i data-lucide="check-circle-2"></i>
        <p>No struggling clients detected. Log will populate when issues arise.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Show newest entries first
  const reversed = [...entries].reverse();
  container.innerHTML = reversed.map(e => {
    const timeStr = new Date(e.time).toLocaleTimeString();
    const dateStr = new Date(e.time).toLocaleDateString();
    const iconCls = e.severity === 'critical' ? 'text-critical' : 'text-warning';
    const icon = e.severity === 'critical' ? '🔴' : '🟡';
    const flagStr = (e.flags || []).join(', ') || 'Unknown issue';
    return `
      <div class="log-entry ${e.severity}">
        <div class="log-entry-icon">${icon}</div>
        <div class="log-entry-body">
          <div class="log-entry-title">${escapeHtml(e.hostname)}</div>
          <div class="log-entry-meta">
            <span class="log-tag">${e.severity.toUpperCase()}</span>
            <span>${flagStr}</span>
            <span style="color:var(--text-dark);">via ${escapeHtml(e.apName || 'Unknown AP')}</span>
          </div>
        </div>
        <div class="log-entry-time">${timeStr}<br><span style="font-size:0.65rem; opacity:0.6;">${dateStr}</span></div>
      </div>
    `;
  }).join('');
}

/**
 * Clear the events log from localStorage and re-render
 */
function clearEventsLog() {
  if (confirm('Clear the struggling clients event log?')) {
    localStorage.removeItem(EVENTS_LOG_KEY);
    renderEventsLog();
  }
}

// ============================================================
//  CSV EXPORT
// ============================================================

/**
 * Export all clients as a CSV file download
 */
function exportClientsCSV() {
  if (!apiData || !apiData.clients.allClients) {
    alert('No client data available to export. Please fetch data first.');
    return;
  }

  const rows = [
    ['Hostname', 'MAC', 'IP', 'OUI', 'AP Name', 'Band', 'Channel', 'Signal (dBm)', 'Satisfaction (%)', 'TX Rate (kbps)', 'RX Rate (kbps)', 'TX Retries (%)', 'Uptime (s)', 'Severity', 'Flags']
  ];

  apiData.clients.allClients.forEach(c => {
    rows.push([
      c.hostname,
      c.mac,
      c.ip,
      c.oui,
      c.apName,
      c.band,
      c.channel,
      c.signal,
      c.satisfaction,
      c.txRateKbps,
      c.rxRateKbps,
      c.txRetriesPct,
      c.uptime,
      c.severity,
      (c.flags || []).join('; ')
    ]);
  });

  const csvContent = rows.map(r =>
    r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `unifi-clients-${new Date().toISOString().slice(0, 19).replace(/[:]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ============================================================
//  HISTORY & TRENDS TAB
// ============================================================

// Chart.js instances (kept in module scope for re-use / destroy)
let chartUtilization = null;
let chartClients = null;
let chartSpeeds = null;

/**
 * Fetch history from the backend and render the history tab
 */
async function fetchAndRenderHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.success && data.samples) {
      renderHistoryTab(data.samples);
    }
  } catch (err) {
    console.error('[History] Failed to load history:', err);
  }
}

/**
 * Chart.js global defaults for dark theme
 */
function applyChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = 'rgba(255,255,255,0.55)';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
  Chart.defaults.plugins.legend.labels.color = 'rgba(255,255,255,0.7)';
}

/**
 * Render the History & Trends tab from an array of historical samples
 * @param {Array} samples
 */
function renderHistoryTab(samples) {
  if (!window.Chart) {
    console.warn('[History] Chart.js not loaded yet.');
    return;
  }

  applyChartDefaults();

  // Sample count display
  const countEl = document.getElementById('history-sample-count');
  if (countEl) countEl.textContent = samples.length;

  const labels = samples.map(s => {
    const d = new Date(s.timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top' },
      tooltip: {
        backgroundColor: 'rgba(17, 24, 39, 0.95)',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1
      }
    },
    scales: {
      x: {
        ticks: { color: 'rgba(255,255,255,0.45)', maxRotation: 45 },
        grid: { color: 'rgba(255,255,255,0.05)' }
      },
      y: {
        ticks: { color: 'rgba(255,255,255,0.45)' },
        grid: { color: 'rgba(255,255,255,0.05)' }
      }
    }
  };

  // 1. Utilization Trend Chart
  const ctxUtil = document.getElementById('chart-utilization');
  if (ctxUtil) {
    if (chartUtilization) chartUtilization.destroy();
    chartUtilization = new Chart(ctxUtil, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '2.4 GHz Util %',
            data: samples.map(s => s.avgUtil24),
            borderColor: '#F59E0B',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3
          },
          {
            label: '5 GHz Util %',
            data: samples.map(s => s.avgUtil5),
            borderColor: '#EF4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3
          }
        ]
      },
      options: {
        ...chartOptions,
        scales: {
          ...chartOptions.scales,
          y: { ...chartOptions.scales.y, min: 0, max: 100, title: { display: true, text: 'Utilization %', color: 'rgba(255,255,255,0.45)' } }
        }
      }
    });
  }

  // 2. Client Count Trend Chart
  const ctxClients = document.getElementById('chart-clients');
  if (ctxClients) {
    if (chartClients) chartClients.destroy();
    chartClients = new Chart(ctxClients, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'All Clients',
            data: samples.map(s => s.totalAllClients),
            borderColor: '#818CF8',
            backgroundColor: 'rgba(129, 140, 248, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3
          },
          {
            label: 'Apple Clients',
            data: samples.map(s => s.totalAppleClients),
            borderColor: '#34D399',
            backgroundColor: 'rgba(52, 211, 153, 0.1)',
            fill: false,
            tension: 0.3,
            pointRadius: 3
          },
          {
            label: 'Critical Clients',
            data: samples.map(s => s.criticalCount),
            borderColor: '#EF4444',
            backgroundColor: 'rgba(239, 68, 68, 0)',
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            borderDash: [4, 4]
          }
        ]
      },
      options: chartOptions
    });
  }

  // 3. Speed Trend Chart
  const ctxSpeeds = document.getElementById('chart-speeds');
  if (ctxSpeeds) {
    if (chartSpeeds) chartSpeeds.destroy();
    chartSpeeds = new Chart(ctxSpeeds, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Download (Mbps)',
            data: samples.map(s => s.totalDownloadMbps),
            borderColor: '#34D399',
            backgroundColor: 'rgba(52, 211, 153, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3
          },
          {
            label: 'Upload (Mbps)',
            data: samples.map(s => s.totalUploadMbps),
            borderColor: '#818CF8',
            backgroundColor: 'rgba(129, 140, 248, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3
          }
        ]
      },
      options: {
        ...chartOptions,
        scales: {
          ...chartOptions.scales,
          y: { ...chartOptions.scales.y, title: { display: true, text: 'Mbps', color: 'rgba(255,255,255,0.45)' } }
        }
      }
    });
  }

  // 4. History table (last 20 entries, newest first)
  const historyBody = document.getElementById('history-table-body');
  if (historyBody) {
    historyBody.innerHTML = '';
    [...samples].reverse().slice(0, 20).forEach(s => {
      const ts = new Date(s.timestamp).toLocaleTimeString();
      const tr = document.createElement('tr');
      const util24Color = s.avgUtil24 > 70 ? 'var(--color-danger)' : s.avgUtil24 > 50 ? 'var(--color-warning)' : 'var(--color-success)';
      const util5Color = s.avgUtil5 > 70 ? 'var(--color-danger)' : s.avgUtil5 > 50 ? 'var(--color-warning)' : 'var(--color-success)';
      tr.innerHTML = `
        <td style="font-family:monospace; color:var(--text-muted); font-size:0.82rem;">${ts}</td>
        <td style="font-weight:600;">${s.totalAllClients}</td>
        <td>${s.totalAppleClients}</td>
        <td><strong style="color:${util24Color};">${s.avgUtil24}%</strong></td>
        <td><strong style="color:${util5Color};">${s.avgUtil5}%</strong></td>
        <td style="color:#34D399;">↓ ${s.totalDownloadMbps}</td>
        <td style="color:#818CF8;">↑ ${s.totalUploadMbps}</td>
        <td style="color:${s.criticalCount > 0 ? 'var(--color-danger)' : 'var(--text-dark)'}; font-weight:600;">${s.criticalCount}</td>
        <td style="color:${s.warningCount > 0 ? 'var(--color-warning)' : 'var(--text-dark)'};">${s.warningCount}</td>
      `;
      historyBody.appendChild(tr);
    });
  }
}

/**
 * Clear server-side history is not possible from the client, but clear localStorage sample cache.
 * Notify user.
 */
function clearHistory() {
  if (confirm('Clear the displayed history charts? (Server-side buffer persists until server restart.)')) {
    // Destroy existing charts so they re-initialize empty
    if (chartUtilization) { chartUtilization.destroy(); chartUtilization = null; }
    if (chartClients) { chartClients.destroy(); chartClients = null; }
    if (chartSpeeds) { chartSpeeds.destroy(); chartSpeeds = null; }

    const historyBody = document.getElementById('history-table-body');
    if (historyBody) historyBody.innerHTML = '';
    const countEl = document.getElementById('history-sample-count');
    if (countEl) countEl.textContent = '0';
  }
}

// ============================================================
//  AUTO-REFRESH
// ============================================================

let autoRefreshTimer = null;
let autoRefreshCountdown = 0;
let autoRefreshInterval = 0;

/**
 * Set or disable the auto-refresh interval.
 * @param {string|number} seconds
 */
function setAutoRefresh(seconds) {
  const secs = parseInt(seconds, 10);

  // Clear any existing timer
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  autoRefreshInterval = secs;
  autoRefreshCountdown = secs;

  const syncLabel = document.getElementById('sync-mode-text');
  const syncWrap = document.getElementById('sync-mode-label');

  if (secs <= 0) {
    if (syncLabel) syncLabel.textContent = 'Manual Sync Only';
    if (syncWrap) {
      syncWrap.style.color = '#f59e0b';
      syncWrap.style.borderColor = 'rgba(245, 158, 11, 0.2)';
      syncWrap.style.background = 'rgba(245, 158, 11, 0.05)';
    }
    return;
  }

  if (syncWrap) {
    syncWrap.style.color = '#10B981';
    syncWrap.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    syncWrap.style.background = 'rgba(16, 185, 129, 0.05)';
  }

  const updateCountdown = () => {
    if (syncLabel) syncLabel.textContent = `Auto-refresh in ${autoRefreshCountdown}s`;
    autoRefreshCountdown--;
    if (autoRefreshCountdown < 0) {
      autoRefreshCountdown = autoRefreshInterval;
      fetchData(true, true);
    }
  };

  updateCountdown();
  autoRefreshTimer = setInterval(updateCountdown, 1000);

  // Restore interval selector value in case it got out of sync
  const sel = document.getElementById('auto-refresh-interval');
  if (sel) sel.value = String(secs);
}

<<<<<<< Updated upstream
=======
// ============================================================
//  RF NEIGHBORHOOD PROXIMITY GRAPH & INTERACTIVE SANDBOX ENGINE
// ============================================================

/**
 * 3D Physical Adjacency and Structural Overlap mapping database for Mittelschule Telfs.
 * Models EG (Ground Floor), 1OG (First Floor) and 2OG (Second Floor) physical adjacency grids.
 */
const AP_PROXIMITY_NEIGHBORS = {
  'fc:ec:da:11:55:88': {
    name: 'AP-EG-Lehrerzimmer',
    floor: 'eg',
    neighbors: [
      'fc:ec:da:11:22:33', // Horizontal: Lehrerzimmer <-> 1a
      'fc:ec:da:22:33:55'  // Diagonal: Lehrerzimmer <-> 2a
    ]
  },
  'fc:ec:da:11:22:33': {
    name: 'AP-EG-Klasse-1a',
    floor: 'eg',
    neighbors: [
      'fc:ec:da:11:55:88', // Horizontal: 1a <-> Lehrerzimmer
      'fc:ec:da:11:22:44', // Horizontal: 1a <-> 1b
      'fc:ec:da:22:33:55'  // Vertical: 1a <-> 2a
    ]
  },
  'fc:ec:da:11:22:44': {
    name: 'AP-EG-Klasse-1b',
    floor: 'eg',
    neighbors: [
      'fc:ec:da:11:22:33', // Horizontal: 1b <-> 1a
      'fc:ec:da:22:33:66'  // Vertical: 1b <-> 2b
    ]
  },
  'fc:ec:da:22:33:55': {
    name: 'AP-1G-Klasse-2a',
    floor: '1og',
    neighbors: [
      'fc:ec:da:22:33:66', // Horizontal: 2a <-> 2b
      'fc:ec:da:11:22:33', // Vertical: 2a <-> 1a
      'fc:ec:da:33:44:77', // Vertical: 2a <-> Physikraum
      'fc:ec:da:11:55:88'  // Diagonal: 2a <-> Lehrerzimmer
    ]
  },
  'fc:ec:da:22:33:66': {
    name: 'AP-1G-Klasse-2b',
    floor: '1og',
    neighbors: [
      'fc:ec:da:22:33:55', // Horizontal: 2b <-> 2a
      'fc:ec:da:11:22:44'  // Vertical: 2b <-> 1b
    ]
  },
  'fc:ec:da:33:44:77': {
    name: 'AP-2G-Physikraum',
    floor: '2og',
    neighbors: [
      'fc:ec:da:22:33:55'  // Vertical: Physikraum <-> 2a
    ]
  }
};

/**
 * Recursive physical RF cascade and co-channel propagation engine.
 * Computes channel bleed-through and mutual Airtime utilization load penalties
 * and updates Apple client device satisfaction scores in real-time.
 */
function runRFPropagationEngine() {
  if (!rawApiData) return;
  
  console.log('[RF Simulation] Executing cascade propagation math...');
  
  // 1. Deep clone raw apiData payload
  apiData = JSON.parse(JSON.stringify(rawApiData));
  
  const cascadeLogs = [];
  
  // 2. Apply active inline dropdown override tunings
  apiData.aps.forEach(ap => {
    const override = sandboxOverrides[ap.mac];
    if (override) {
      if (override.ng !== undefined && ap.radios.ng) {
        ap.radios.ng.channel = override.ng;
      }
      if (override.na !== undefined && ap.radios.na) {
        ap.radios.na.channel = override.na;
      }
    }
  });
  
  // Create lookup table
  const mutatedAps = {};
  apiData.aps.forEach(ap => {
    mutatedAps[ap.mac] = ap;
  });
  
  // 3. Reset all AP radio airtime load to baseline (self congestion)
  apiData.aps.forEach(ap => {
    const config = AP_PROXIMITY_NEIGHBORS[ap.mac];
    if (!config) return;
    
    ['ng', 'na'].forEach(band => {
      const radio = ap.radios[band];
      if (!radio) return;
      
      const baselineLoad = Math.max(12, (radio.cu_self_rx || 0) + (radio.cu_self_tx || 0));
      radio.cu_total = baselineLoad;
      radio.cci_count = 0;
    });
  });
  
  // 4. Calculate mutual Co-Channel interference contention penalties
  const checkedPairs = new Set();
  
  Object.keys(AP_PROXIMITY_NEIGHBORS).forEach(apMac1 => {
    const config1 = AP_PROXIMITY_NEIGHBORS[apMac1];
    const ap1 = mutatedAps[apMac1];
    if (!ap1) return;
    
    config1.neighbors.forEach(apMac2 => {
      const ap2 = mutatedAps[apMac2];
      if (!ap2) return;
      
      const pairKey = [apMac1, apMac2].sort().join('-');
      if (checkedPairs.has(pairKey)) return;
      checkedPairs.add(pairKey);
      
      ['ng', 'na'].forEach(band => {
        const r1 = ap1.radios[band];
        const r2 = ap2.radios[band];
        if (!r1 || !r2 || !r1.channel || !r2.channel) return;
        
        let overlaps = false;
        if (band === 'ng') {
          // 2.4 GHz: channels overlap if their absolute difference is <= 4
          overlaps = Math.abs(r1.channel - r2.channel) <= 4;
        } else {
          // 5 GHz: channels overlap if they share the exact primary channel frequency
          overlaps = r1.channel === r2.channel;
        }
        
        if (overlaps) {
          // Increment CCI counters
          r1.cci_count = (r1.cci_count || 0) + 1;
          r2.cci_count = (r2.cci_count || 0) + 1;
          
          // Apply mutual +18% airtime load penalty
          r1.cu_total = Math.min(100, r1.cu_total + 18);
          r2.cu_total = Math.min(100, r2.cu_total + 18);
          
          const bandLabel = band === 'ng' ? '2.4 GHz' : '5 GHz';
          cascadeLogs.push({
            type: 'conflict',
            msg: `Overlap between adjacent rooms <strong>${ap1.name}</strong> and <strong>${ap2.name}</strong> (Ch ${r1.channel} / ${r2.channel}) on ${bandLabel}. Mutual <strong>+18%</strong> contention penalty applied!`
          });
        }
      });
    });
  });
  
  // 5. Update connected client experience satisfaction metrics
  let criticalClientsCount = 0;
  let warningClientsCount = 0;
  
  const clientsList = apiData.clients.allClients || [];
  clientsList.forEach(client => {
    const parentAp = mutatedAps[client.apMac];
    if (!parentAp) return;
    
    const band = client.band === '2.4G' ? 'ng' : 'na';
    const radio = parentAp.radios[band];
    if (!radio) return;
    
    client.channel = radio.channel;
    
    // Recalculate iPad Experience Satisfaction based on host AP load and tx_retries
    const txRetriesPct = client.txRetriesPct || 5;
    const clientSatisfaction = Math.max(10, Math.round(100 - radio.cu_total * 0.7 - txRetriesPct * 0.5));
    client.satisfaction = clientSatisfaction;
    
    if (clientSatisfaction < 70) {
      client.severity = 'critical';
      client.warning = 'Severe AP Channel Utilization';
      criticalClientsCount++;
      
      if (cascadeLogs.length < 8 && client.hostname.toLowerCase().includes('ipad')) {
        cascadeLogs.push({
          type: 'client',
          msg: `Client <strong>${escapeHtml(client.hostname)}</strong> on <strong>${escapeHtml(parentAp.name)}</strong> satisfaction dropped to <span class="text-critical">${clientSatisfaction}%</span> due to congestion.`
        });
      }
    } else if (clientSatisfaction < 85) {
      client.severity = 'warning';
      client.warning = 'Elevated Airtime Retries';
      warningClientsCount++;
    } else {
      client.severity = 'success';
      client.warning = '';
    }
  });
  
  // Synchronize clients in topDownloaders
  if (apiData.clients.topDownloaders) {
    apiData.clients.topDownloaders.forEach(client => {
      const match = clientsList.find(c => c.mac === client.mac);
      if (match) {
        client.channel = match.channel;
        client.satisfaction = match.satisfaction;
        client.severity = match.severity;
      }
    });
  }
  
  // 6. Recalculate global metrics and aggregates in apiData
  let sumLoad24 = 0, count24 = 0;
  let sumLoad5 = 0, count5 = 0;
  let warningRadiosCount = 0;
  let congestedRadiosCount = 0;
  
  apiData.aps.forEach(ap => {
    if (ap.radios.ng) {
      sumLoad24 += ap.radios.ng.cu_total;
      count24++;
      if (ap.radios.ng.cu_total > 70) congestedRadiosCount++;
      else if (ap.radios.ng.cu_total > 50) warningRadiosCount++;
    }
    if (ap.radios.na) {
      sumLoad5 += ap.radios.na.cu_total;
      count5++;
      if (ap.radios.na.cu_total > 70) congestedRadiosCount++;
      else if (ap.radios.na.cu_total > 50) warningRadiosCount++;
    }
  });
  
  if (apiData.overview) {
    apiData.overview.avgChannelLoad24 = Math.round(sumLoad24 / (count24 || 1));
    apiData.overview.avgChannelLoad5 = Math.round(sumLoad5 / (count5 || 1));
    apiData.overview.congestedRadiosCount = congestedRadiosCount;
    apiData.overview.warningRadiosCount = warningRadiosCount;
    
    const appleClients = clientsList.filter(c => c.hostname.toLowerCase().includes('ipad'));
    if (appleClients.length > 0) {
      const avgHealth = Math.round(appleClients.reduce((acc, c) => acc + c.satisfaction, 0) / appleClients.length);
      apiData.overview.avgIpadHealth = avgHealth;
      apiData.overview.criticalCount = appleClients.filter(c => c.satisfaction < 70).length;
      apiData.overview.warningCount = appleClients.filter(c => c.satisfaction >= 70 && c.satisfaction < 85).length;
    }
  }
  
  // Render cascade logs into the side panel
  const cascadeLogList = document.getElementById('cascade-log-list');
  if (cascadeLogList) {
    if (cascadeLogs.length === 0) {
      cascadeLogList.innerHTML = `
        <div class="cascade-item info">
          <i data-lucide="info"></i>
          <span>No physical overlaps or active client degradation warnings. Your current RF channel tuning is structurally optimized!</span>
        </div>
      `;
    } else {
      cascadeLogList.innerHTML = cascadeLogs.map(log => {
        let icon = 'info';
        let itemClass = 'info';
        if (log.type === 'conflict') {
          icon = 'alert-triangle';
          itemClass = 'conflict';
        } else if (log.type === 'client') {
          icon = 'smartphone';
          itemClass = 'client';
        }
        return `
          <div class="cascade-item ${itemClass}">
            <i data-lucide="${icon}"></i>
            <span>${log.msg}</span>
          </div>
        `;
      }).join('');
    }
    
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }
}

/**
 * Handle channel selection changes in sandbox mode
 */
function changeSandboxChannel(apMac, radio, value) {
  const numericValue = parseInt(value, 10);
  if (!sandboxOverrides[apMac]) {
    sandboxOverrides[apMac] = {};
  }
  sandboxOverrides[apMac][radio] = numericValue;
  
  localStorage.setItem('unifi_sandbox_overrides', JSON.stringify(sandboxOverrides));
  
  console.log(`[Sandbox Override] Set AP ${apMac} radio ${radio} to channel ${numericValue}`);
  
  // Re-run propagation and update all tabs
  runRFPropagationEngine();
  renderAllTabs();
}

/**
 * Toggle sandbox mode state
 */
function toggleSandboxMode(enabled) {
  sandboxModeEnabled = enabled;
  localStorage.setItem('unifi_sandbox_enabled', String(enabled));
  
  const proximityPanel = document.getElementById('sandbox-proximity-panel');
  if (proximityPanel) {
    proximityPanel.style.display = enabled ? 'grid' : 'none';
  }
  
  const toggleWrap = document.querySelector('.sandbox-toggle-wrap');
  if (toggleWrap) {
    if (enabled) {
      toggleWrap.classList.add('active');
    } else {
      toggleWrap.classList.remove('active');
    }
  }
  
  const syncModeText = document.getElementById('sync-mode-text');
  if (syncModeText) {
    syncModeText.textContent = enabled ? 'Sandbox Tuning Active' : 'Manual Sync Only';
  }
  
  if (enabled) {
    runRFPropagationEngine();
  } else {
    if (rawApiData) {
      apiData = JSON.parse(JSON.stringify(rawApiData));
    }
    const cascadeLogList = document.getElementById('cascade-log-list');
    if (cascadeLogList) {
      cascadeLogList.innerHTML = `
        <div class="cascade-item info">
          <i data-lucide="info"></i>
          <span>Sandbox disabled. Telemetry and grids now reflect live UniFi hardware controller state.</span>
        </div>
      `;
    }
  }
  
  renderAllTabs();
}

/**
 * Reset all manual sandbox overrides back to original controller configurations
 */
function resetSandboxOverrides() {
  sandboxOverrides = {};
  localStorage.removeItem('unifi_sandbox_overrides');
  selectedAPMac = null;
  
  console.log('[Sandbox Reset] Cleared all custom channel tuning overrides!');
  
  if (sandboxModeEnabled) {
    runRFPropagationEngine();
  } else {
    if (rawApiData) {
      apiData = JSON.parse(JSON.stringify(rawApiData));
    }
  }
  
  renderAllTabs();
}

/**
 * Select/focus an AP inside the physical proximity map
 */
function selectAPInProximityMap(apMac) {
  if (selectedAPMac === apMac) {
    selectedAPMac = null; // Deselect on secondary click
  } else {
    selectedAPMac = apMac;
  }
  renderProximityMap();
}

/**
 * Render the interactive classroom-floor physical layout map
 */
function renderProximityMap() {
  const floors = {
    '2og': document.getElementById('floor-2og-cards'),
    '1og': document.getElementById('floor-1og-cards'),
    'eg': document.getElementById('floor-eg-cards')
  };
  
  Object.values(floors).forEach(el => {
    if (el) el.innerHTML = '';
  });
  
  if (!apiData || !apiData.aps) return;
  
  const apMap = {};
  apiData.aps.forEach(ap => {
    apMap[ap.mac] = ap;
  });
  
  apiData.aps.forEach(ap => {
    const config = AP_PROXIMITY_NEIGHBORS[ap.mac];
    if (!config) return; // Only render APs registered at Mittelschule Telfs
    
    const floorEl = floors[config.floor];
    if (!floorEl) return;
    
    const ngCh = ap.radios.ng ? ap.radios.ng.channel : 'N/A';
    const naCh = ap.radios.na ? ap.radios.na.channel : 'N/A';
    
    let maxCu = 0;
    if (ap.radios.ng) maxCu = Math.max(maxCu, ap.radios.ng.cu_total);
    if (ap.radios.na) maxCu = Math.max(maxCu, ap.radios.na.cu_total);
    
    let indicatorClass = 'green';
    if (maxCu > 70) indicatorClass = 'red';
    else if (maxCu > 50) indicatorClass = 'orange';
    
    let cardClass = '';
    let isNgConflict = false;
    let isNaConflict = false;
    
    if (selectedAPMac) {
      if (ap.mac === selectedAPMac) {
        cardClass = 'selected';
      } else if (config.neighbors.includes(selectedAPMac)) {
        const selAp = apMap[selectedAPMac];
        if (selAp) {
          if (ap.radios.ng && selAp.radios.ng) {
            isNgConflict = Math.abs(ap.radios.ng.channel - selAp.radios.ng.channel) <= 4;
          }
          if (ap.radios.na && selAp.radios.na) {
            isNaConflict = ap.radios.na.channel === selAp.radios.na.channel;
          }
        }
        cardClass = (isNgConflict || isNaConflict) ? 'conflict' : 'neighbor';
      }
    } else {
      config.neighbors.forEach(neighMac => {
        const neighAp = apMap[neighMac];
        if (neighAp) {
          if (ap.radios.ng && neighAp.radios.ng) {
            if (Math.abs(ap.radios.ng.channel - neighAp.radios.ng.channel) <= 4) {
              isNgConflict = true;
            }
          }
          if (ap.radios.na && neighAp.radios.na) {
            if (ap.radios.na.channel === neighAp.radios.na.channel) {
              isNaConflict = true;
            }
          }
        }
      });
      if (isNgConflict || isNaConflict) {
        cardClass = 'conflict';
      }
    }
    
    const card = document.createElement('div');
    card.className = `ap-graph-card ${cardClass}`;
    card.setAttribute('onclick', `selectAPInProximityMap('${ap.mac}')`);
    card.innerHTML = `
      <div class="ap-graph-header">
        <span class="ap-graph-name">${escapeHtml(ap.name)}</span>
        <span class="ap-graph-indicator ${indicatorClass}"></span>
      </div>
      <div class="ap-graph-bands">
        <div class="ap-band-row">
          <span class="ap-band-label">2.4G:</span>
          <span class="ap-band-ch ${isNgConflict ? 'conflict-text' : ''}">Ch ${ngCh}</span>
        </div>
        <div class="ap-band-row">
          <span class="ap-band-label">5G:</span>
          <span class="ap-band-ch ${isNaConflict ? 'conflict-text' : ''}">Ch ${naCh}</span>
        </div>
      </div>
    `;
    floorEl.appendChild(card);
  });
  
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

/**
 * Re-render all dashboard panels and components
 */
function renderAllTabs() {
  renderOverview();
  renderSpeedsTab();
  renderChannelsTab();
  renderApsTab();
  renderIpadsTab();
  updateGlobalBadges();
  renderOptimalGrid();
  renderProximityMap();
  updateEventsLog();
  
  if (activeTab === 'history') {
    fetchAndRenderHistory();
  }
  
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

>>>>>>> Stashed changes

const https = require('https');
const config = require('../config');

class UnifiClient {
  constructor() {
    this.host = config.unifi.host;
    this.port = config.unifi.port;
    this.username = config.unifi.username;
    this.password = config.unifi.password;
    this.site = config.unifi.site;
    this.timeoutMs = config.unifi.timeoutMs;
    this.cookie = null;
    this.agent = new https.Agent({
      rejectUnauthorized: false
    });
    this.status = {
      controller: `${this.host}:${this.port}`,
      site: this.site,
      requestTimeoutMs: this.timeoutMs,
      sessionActive: false,
      auth: {
        mode: 'live',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastDurationMs: null
      },
      devices: {
        source: 'unknown',
        lastSuccessAt: null,
        lastError: null,
        lastCount: 0,
        lastDurationMs: null
      },
      clients: {
        source: 'unknown',
        lastSuccessAt: null,
        lastError: null,
        lastCount: 0,
        lastDurationMs: null
      }
    };
  }

  _recordDataStatus(kind, updates) {
    this.status[kind] = {
      ...this.status[kind],
      ...updates
    };
  }

  getStatusSummary() {
    return JSON.parse(JSON.stringify(this.status));
  }

  /**
   * Performs an HTTP request to the UniFi API.
   * @param {Object} options - Request options (method, path, headers)
   * @param {Object} [postData] - Optional JSON body
   * @returns {Promise<{statusCode: number, headers: Object, body: string}>}
   */
  _request(options, postData) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        ...options.headers
      };

      if (this.cookie) {
        headers.Cookie = this.cookie;
      }

      const req = https.request({
        host: this.host,
        port: this.port,
        agent: this.agent,
        path: options.path,
        method: options.method || 'GET',
        headers
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          });
        });
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (postData) {
        req.write(JSON.stringify(postData));
      }
      req.end();
    });
  }

  /**
   * Authenticate with the UniFi controller.
   */
  async login() {
    const startedAt = Date.now();
    this.status.auth.lastAttemptAt = new Date(startedAt).toISOString();

    if (process.env.MOCK_MODE === 'true') {
      this.cookie = 'unifises=mock-session';
      this.status.sessionActive = true;
      this.status.auth = {
        mode: 'mock',
        lastAttemptAt: this.status.auth.lastAttemptAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastDurationMs: 0
      };
      console.log('[UniFi Mock] Skipping controller authentication in MOCK_MODE.');
      return true;
    }


    if (this.password === 'change-me') {
      const error = new Error('UNIFI_PASS is still set to the placeholder value `change-me`. Update it before attempting live controller authentication.');
      this.status.sessionActive = false;
      this.status.auth = {
        mode: 'live',
        lastAttemptAt: this.status.auth.lastAttemptAt,
        lastSuccessAt: this.status.auth.lastSuccessAt,
        lastError: error.message,
        lastDurationMs: Date.now() - startedAt
      };
      throw error;
    }

    console.log(`[UniFi] Attempting authentication on https://${this.host}:${this.port}/api/login`);
    try {
      const res = await this._request({
        method: 'POST',
        path: '/api/login'
      }, {
        username: this.username,
        password: this.password,
        remember: true
      });

      if (res.statusCode !== 200) {
        throw new Error(`Auth failed with status ${res.statusCode}: ${res.body}`);
      }

      const cookies = res.headers['set-cookie'] || [];
      const unifisesCookie = cookies.find((cookie) => cookie.startsWith('unifises='));
      if (!unifisesCookie) {
        throw new Error('Did not receive unifises cookie from controller.');
      }

      this.cookie = unifisesCookie.split(';')[0];
      this.status.sessionActive = true;
      this.status.auth = {
        mode: 'live',
        lastAttemptAt: this.status.auth.lastAttemptAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastDurationMs: Date.now() - startedAt
      };
      console.log('[UniFi] Authentication successful.');
      return true;
    } catch (err) {
      this.status.sessionActive = false;
      this.status.auth = {
        mode: 'live',
        lastAttemptAt: this.status.auth.lastAttemptAt,
        lastSuccessAt: this.status.auth.lastSuccessAt,
        lastError: err.message,
        lastDurationMs: Date.now() - startedAt
      };
      console.error('[UniFi] Login error:', err.message);
      throw err;
    }
  }

  /**
   * Helper to perform an authenticated GET request, with automatic login retry if needed.
   * @param {string} path - API endpoint path
   */
  async _getWithRetry(path) {
    if (!this.cookie) {
      await this.login();
    }

    try {
      let res = await this._request({ method: 'GET', path });

      if (res.statusCode === 401 || res.statusCode === 400 || res.body.includes('api.err.LoginRequired')) {
        console.warn(`[UniFi] Session expired (status ${res.statusCode}). Re-authenticating...`);
        await this.login();
        res = await this._request({ method: 'GET', path });
      }

      if (res.statusCode !== 200) {
        throw new Error(`API call to ${path} failed with status ${res.statusCode}: ${res.body}`);
      }

      const data = JSON.parse(res.body);
      return data.data || [];
    } catch (err) {
      console.error(`[UniFi] Error fetching ${path}:`, err.message);
      throw err;
    }
  }

  /**
   * Fetch all UniFi devices on the configured site.
   */
  async getDevices() {
    const startedAt = Date.now();

    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated access point devices...');
      this._recordDataStatus('devices', {
        source: 'mock',
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastCount: MOCK_DEVICES.length,
        lastDurationMs: 0
      });
      return MOCK_DEVICES;
    }

    try {
      const devices = await this._getWithRetry(`/api/s/${this.site}/stat/device`);
      this._recordDataStatus('devices', {
        source: 'live',
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastCount: devices.length,
        lastDurationMs: Date.now() - startedAt
      });
      return devices;
    } catch (err) {
      console.warn(`[UniFi Connection Failed] Using simulated demo AP devices instead: ${err.message}`);
      this._recordDataStatus('devices', {
        source: 'mock-fallback',
        lastError: err.message,
        lastCount: MOCK_DEVICES.length,
        lastDurationMs: Date.now() - startedAt
      });
      return MOCK_DEVICES;
    }
  }

  /**
   * Fetch all active wireless clients on the configured site.
   */
  async getClients() {
    const startedAt = Date.now();

    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated wireless clients...');
      this._recordDataStatus('clients', {
        source: 'mock',
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastCount: MOCK_CLIENTS.length,
        lastDurationMs: 0
      });
      return MOCK_CLIENTS;
    }

    try {
      const clients = await this._getWithRetry(`/api/s/${this.site}/stat/sta`);
      this._recordDataStatus('clients', {
        source: 'live',
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastCount: clients.length,
        lastDurationMs: Date.now() - startedAt
      });
      return clients;
    } catch (err) {
      console.warn(`[UniFi Connection Failed] Using simulated demo clients instead: ${err.message}`);
      this._recordDataStatus('clients', {
        source: 'mock-fallback',
        lastError: err.message,
        lastCount: MOCK_CLIENTS.length,
        lastDurationMs: Date.now() - startedAt
      });
      return MOCK_CLIENTS;
    }
  }
}

// Simulated Rich Offline Datasets
const MOCK_DEVICES = [
  {
    type: 'uap',
    name: 'AP-EG-Klasse-1a',
    mac: 'fc:ec:da:11:22:33',
    ip: '172.16.1.10',
    model: 'U6-Pro',
    radio_table: [
      { radio: 'ng', tx_power_mode: 'auto', tx_power: 20, antenna_gain: 3, min_rssi_enabled: false, min_rssi: -80, ht: 'HT20' },
      { radio: 'na', tx_power_mode: 'auto', tx_power: 22, antenna_gain: 4, min_rssi_enabled: false, min_rssi: -80, ht: 'HE40' }
    ],
    radio_table_stats: [
      { radio: 'ng', channel: 6, cu_total: 82, cu_self_rx: 15, cu_self_tx: 40, tx_retries_pct: 35, satisfaction: 65, num_sta: 28, tx_power: 20, bw: 20 },
      { radio: 'na', channel: 40, cu_total: 89, cu_self_rx: 20, cu_self_tx: 45, tx_retries_pct: 32, satisfaction: 60, num_sta: 34, tx_power: 22, bw: 40 }
    ]
  },
  {
    type: 'uap',
    name: 'AP-EG-Klasse-1b',
    mac: 'fc:ec:da:11:22:44',
    ip: '172.16.1.11',
    model: 'U6-Pro',
    radio_table: [
      { radio: 'ng', tx_power_mode: 'auto', tx_power: 20, antenna_gain: 3, min_rssi_enabled: false, min_rssi: -80, ht: 'HT20' },
      { radio: 'na', tx_power_mode: 'auto', tx_power: 22, antenna_gain: 4, min_rssi_enabled: false, min_rssi: -80, ht: 'HE40' }
    ],
    radio_table_stats: [
      { radio: 'ng', channel: 6, cu_total: 78, cu_self_rx: 10, cu_self_tx: 30, tx_retries_pct: 25, satisfaction: 75, num_sta: 22, tx_power: 20, bw: 20 },
      { radio: 'na', channel: 40, cu_total: 85, cu_self_rx: 15, cu_self_tx: 35, tx_retries_pct: 28, satisfaction: 70, num_sta: 29, tx_power: 22, bw: 40 }
    ]
  },
  {
    type: 'uap',
    name: 'AP-1G-Klasse-2a',
    mac: 'fc:ec:da:22:33:55',
    ip: '172.16.2.10',
    model: 'UAP-AC-Pro',
    radio_table: [
      { radio: 'ng', tx_power_mode: 'custom', tx_power: 20, antenna_gain: 3, min_rssi_enabled: false, min_rssi: -80, ht: 'HT20' },
      { radio: 'na', tx_power_mode: 'custom', tx_power: 22, antenna_gain: 4, min_rssi_enabled: false, min_rssi: -80, ht: 'VHT40' }
    ],
    radio_table_stats: [
      { radio: 'ng', channel: 1, cu_total: 35, cu_self_rx: 5, cu_self_tx: 10, tx_retries_pct: 8, satisfaction: 95, num_sta: 12, tx_power: 20, bw: 20 },
      { radio: 'na', channel: 44, cu_total: 87, cu_self_rx: 22, cu_self_tx: 40, tx_retries_pct: 24, satisfaction: 72, num_sta: 30, tx_power: 22, bw: 40 }
    ]
  },
  {
    type: 'uap',
    name: 'AP-1G-Klasse-2b',
    mac: 'fc:ec:da:22:33:66',
    ip: '172.16.2.11',
    model: 'UAP-AC-Pro',
    radio_table: [
      { radio: 'ng', tx_power_mode: 'auto', tx_power: 20, antenna_gain: 3, min_rssi_enabled: false, min_rssi: -80, ht: 'HT20' },
      { radio: 'na', tx_power_mode: 'auto', tx_power: 22, antenna_gain: 4, min_rssi_enabled: false, min_rssi: -80, ht: 'VHT40' }
    ],
    radio_table_stats: [
      { radio: 'ng', channel: 11, cu_total: 28, cu_self_rx: 4, cu_self_tx: 8, tx_retries_pct: 5, satisfaction: 98, num_sta: 8, tx_power: 20, bw: 20 },
      { radio: 'na', channel: 44, cu_total: 81, cu_self_rx: 18, cu_self_tx: 38, tx_retries_pct: 21, satisfaction: 78, num_sta: 27, tx_power: 22, bw: 40 }
    ]
  },
  {
    type: 'uap',
    name: 'AP-2G-Physikraum',
    mac: 'fc:ec:da:33:44:77',
    ip: '172.16.3.10',
    model: 'U6-Pro',
    radio_table: [
      { radio: 'ng', tx_power_mode: 'auto', tx_power: 20, antenna_gain: 3, min_rssi_enabled: false, min_rssi: -80, ht: 'HT20' },
      { radio: 'na', tx_power_mode: 'auto', tx_power: 22, antenna_gain: 4, min_rssi_enabled: false, min_rssi: -80, ht: 'HE40' }
    ],
    radio_table_stats: [
      { radio: 'ng', channel: 6, cu_total: 85, cu_self_rx: 18, cu_self_tx: 42, tx_retries_pct: 38, satisfaction: 62, num_sta: 32, tx_power: 20, bw: 20 },
      { radio: 'na', channel: 40, cu_total: 92, cu_self_rx: 25, cu_self_tx: 50, tx_retries_pct: 35, satisfaction: 55, num_sta: 40, tx_power: 22, bw: 40 }
    ]
  },
  {
    type: 'uap',
    name: 'AP-EG-Lehrerzimmer',
    mac: 'fc:ec:da:11:55:88',
    ip: '172.16.1.5',
    model: 'U6-Pro',
    radio_table: [
      { radio: 'ng', tx_power_mode: 'custom', tx_power: 9, antenna_gain: 3, min_rssi_enabled: true, min_rssi: -75, ht: 'HT20' },
      { radio: 'na', tx_power_mode: 'custom', tx_power: 15, antenna_gain: 4, min_rssi_enabled: true, min_rssi: -75, ht: 'HE40' }
    ],
    radio_table_stats: [
      { radio: 'ng', channel: 11, cu_total: 18, cu_self_rx: 2, cu_self_tx: 5, tx_retries_pct: 3, satisfaction: 99, num_sta: 5, tx_power: 9, bw: 20 },
      { radio: 'na', channel: 100, cu_total: 22, cu_self_rx: 4, cu_self_tx: 8, tx_retries_pct: 4, satisfaction: 99, num_sta: 11, tx_power: 15, bw: 40 }
    ]
  }
];

const MOCK_CLIENTS = [
  { mac: '00:11:22:33:44:55', ip: '172.16.1.101', hostname: 'iPad-Schueler-1A-01', oui: 'Apple, Inc.', satisfaction: 55, signal: -82, tx_rate: 6500, rx_rate: 13000, wifi_tx_retries_percentage: 45, channel: 6, radio: 'ng', ap_mac: 'fc:ec:da:11:22:33', uptime: 1200, anomalies: ['High latency', 'Weak signal'] },
  { mac: '00:11:22:33:44:56', ip: '172.16.1.102', hostname: 'iPad-Schueler-1A-02', oui: 'Apple, Inc.', satisfaction: 62, signal: -79, tx_rate: 8100, rx_rate: 16200, wifi_tx_retries_percentage: 38, channel: 6, radio: 'ng', ap_mac: 'fc:ec:da:11:22:33', uptime: 2400, anomalies: ['Weak signal'] },
  { mac: '00:11:22:33:44:57', ip: '172.16.1.103', hostname: 'iPad-Schueler-1A-03', oui: 'Apple, Inc.', satisfaction: 88, signal: -68, tx_rate: 54000, rx_rate: 72000, wifi_tx_retries_percentage: 12, channel: 40, radio: 'na', ap_mac: 'fc:ec:da:11:22:33', uptime: 3600, anomalies: [] },
  { mac: '00:11:22:33:44:60', ip: '172.16.1.120', hostname: 'iPad-Schueler-1B-01', oui: 'Apple, Inc.', satisfaction: 70, signal: -74, tx_rate: 18000, rx_rate: 24000, wifi_tx_retries_percentage: 28, channel: 6, radio: 'ng', ap_mac: 'fc:ec:da:11:22:44', uptime: 900, anomalies: ['Clogged AP'] },
  { mac: '00:11:22:33:44:61', ip: '172.16.1.121', hostname: 'iPad-Schueler-1B-02', oui: 'Apple, Inc.', satisfaction: 94, signal: -62, tx_rate: 108000, rx_rate: 120000, wifi_tx_retries_percentage: 5, channel: 40, radio: 'na', ap_mac: 'fc:ec:da:11:22:44', uptime: 1800, anomalies: [] },
  { mac: '00:11:22:33:44:70', ip: '172.16.2.101', hostname: 'iPad-Schueler-2A-01', oui: 'Apple, Inc.', satisfaction: 75, signal: -71, tx_rate: 24000, rx_rate: 36000, wifi_tx_retries_percentage: 22, channel: 44, radio: 'na', ap_mac: 'fc:ec:da:22:33:55', uptime: 1500, anomalies: [] },
  { mac: '00:11:22:33:44:71', ip: '172.16.2.102', hostname: 'iPad-Schueler-2A-02', oui: 'Apple, Inc.', satisfaction: 50, signal: -81, tx_rate: 7200, rx_rate: 14400, wifi_tx_retries_percentage: 42, channel: 44, radio: 'na', ap_mac: 'fc:ec:da:22:33:55', uptime: 300, anomalies: ['High latency', 'Weak signal'] },
  { mac: '00:11:22:33:44:80', ip: '172.16.3.101', hostname: 'iPad-Physik-01', oui: 'Apple, Inc.', satisfaction: 45, signal: -85, tx_rate: 4500, rx_rate: 9000, wifi_tx_retries_percentage: 48, channel: 6, radio: 'ng', ap_mac: 'fc:ec:da:33:44:77', uptime: 800, anomalies: ['Weak signal', 'Extreme interference'] },
  { mac: '00:11:22:33:44:81', ip: '172.16.3.102', hostname: 'iPad-Physik-02', oui: 'Apple, Inc.', satisfaction: 58, signal: -80, tx_rate: 8100, rx_rate: 16200, wifi_tx_retries_percentage: 39, channel: 40, radio: 'na', ap_mac: 'fc:ec:da:33:44:77', uptime: 1100, anomalies: ['Weak signal'] },
  { mac: '00:11:22:33:44:82', ip: '172.16.3.103', hostname: 'iPad-Physik-03', oui: 'Apple, Inc.', satisfaction: 96, signal: -58, tx_rate: 144000, rx_rate: 180000, wifi_tx_retries_percentage: 3, channel: 40, radio: 'na', ap_mac: 'fc:ec:da:33:44:77', uptime: 2000, anomalies: [] },
  { mac: '00:11:22:33:44:90', ip: '172.16.1.51', hostname: 'iPad-Teacher-Lehrer1', oui: 'Apple, Inc.', satisfaction: 99, signal: -52, tx_rate: 288000, rx_rate: 300000, wifi_tx_retries_percentage: 1, channel: 100, radio: 'na', ap_mac: 'fc:ec:da:11:55:88', uptime: 7200, anomalies: [] },
  { mac: '00:11:22:33:44:91', ip: '172.16.1.52', hostname: 'iPad-Teacher-Lehrer2', oui: 'Apple, Inc.', satisfaction: 98, signal: -55, tx_rate: 240000, rx_rate: 288000, wifi_tx_retries_percentage: 2, channel: 100, radio: 'na', ap_mac: 'fc:ec:da:11:55:88', uptime: 6400, anomalies: [] },
  { mac: '22:33:44:55:66:77', ip: '172.16.1.150', hostname: 'PC-Klassenzimmer-Win10', oui: 'Intel Corporate', satisfaction: 90, signal: -65, tx_rate: 86600, rx_rate: 86600, wifi_tx_retries_percentage: 8, channel: 40, radio: 'na', ap_mac: 'fc:ec:da:11:22:33', uptime: 18000, anomalies: [] }
];

module.exports = new UnifiClient();

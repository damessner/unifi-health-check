const https = require('https');
const config = require('../config');

function normalizeMac(mac) {
  return String(mac || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, ':');
}

function inferTxPowerMode(txPower) {
  if (txPower <= 10) return 'low';
  if (txPower <= 18) return 'medium';
  return 'high';
}

class UnifiClient {
  constructor() {
    this.host = config.unifi.host;
    this.port = config.unifi.port;
    this.username = config.unifi.username;
    this.password = config.unifi.password;
    this.site = config.unifi.site;
    this.cookie = null;
    this.agent = new https.Agent({
      rejectUnauthorized: !config.unifi.allowSelfSigned
    });
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
        headers['Cookie'] = this.cookie;
      }

      const req = https.request({
        host: this.host,
        port: this.port,
        agent: this.agent,
        path: options.path,
        method: options.method || 'GET',
        headers: headers
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: body
          });
        });
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
    if (!this.username || !this.password) {
      throw new Error('UNIFI_USER and UNIFI_PASS must be configured.');
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
      const unifisesCookie = cookies.find(c => c.startsWith('unifises='));
      if (!unifisesCookie) {
        throw new Error('Did not receive unifises cookie from controller.');
      }

      this.cookie = unifisesCookie.split(';')[0];
      console.log('[UniFi] Authentication successful.');
      return true;
    } catch (err) {
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
      
      // If we get an unauthorized or login-required error, retry login and query once
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
    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated access point devices...');
      return MOCK_DEVICES;
    }
    try {
      return await this._getWithRetry(`/api/s/${this.site}/stat/device`);
    } catch (err) {
      console.warn(`[UniFi Connection Failed] Using simulated demo AP devices instead: ${err.message}`);
      return MOCK_DEVICES;
    }
  }

  /**
   * Fetch all active wireless clients on the configured site.
   */
  async getClients() {
    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated wireless clients...');
      return MOCK_CLIENTS;
    }
    try {
      return await this._getWithRetry(`/api/s/${this.site}/stat/sta`);
    } catch (err) {
      console.warn(`[UniFi Connection Failed] Using simulated demo clients instead: ${err.message}`);
      return MOCK_CLIENTS;
    }
  }

  /**
   * Fetch nearby rogue / neighboring AP telemetry for interference analysis.
   */
  async getRogueAps() {
    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated rogue AP scan results...');
      return MOCK_ROGUE_APS;
    }
    try {
      return await this._getWithRetry(`/api/s/${this.site}/stat/rogueap`);
    } catch (err) {
      console.warn(`[UniFi Connection Failed] Using simulated rogue AP data instead: ${err.message}`);
      return MOCK_ROGUE_APS;
    }
  }

  /**
   * Helper to perform an authenticated PUT request, with automatic login retry if needed.
   * @param {string} path - API endpoint path
   * @param {Object} payload - JSON body
   */
  async _putWithRetry(path, payload) {
    if (!this.cookie) {
      await this.login();
    }

    try {
      let res = await this._request({ method: 'PUT', path }, payload);
      
      // If we get an unauthorized or login-required error, retry login and query once
      if (res.statusCode === 401 || res.statusCode === 400 || (res.body && res.body.includes('api.err.LoginRequired'))) {
        console.warn(`[UniFi] Session expired (status ${res.statusCode}). Re-authenticating...`);
        await this.login();
        res = await this._request({ method: 'PUT', path }, payload);
      }

      if (res.statusCode !== 200) {
        throw new Error(`API call to ${path} failed with status ${res.statusCode}: ${res.body}`);
      }

      const data = JSON.parse(res.body);
      return data.data || [];
    } catch (err) {
      console.error(`[UniFi] Error updating ${path}:`, err.message);
      throw err;
    }
  }

  /**
   * Update settings for a specific AP device.
   * @param {string} deviceId - Internal device ID (_id)
   * @param {Object} settings - Object of settings to update
   */
  async updateDeviceSettings(deviceId, settings) {
    if (process.env.MOCK_MODE === 'true') {
      console.log(`[UniFi Mock] Simulating updating device ${deviceId} settings:`, JSON.stringify(settings));
      const device = MOCK_DEVICES.find((item) => item._id === deviceId);
      if (!device) {
        throw new Error(`Mock device ${deviceId} not found.`);
      }

      Object.assign(device, JSON.parse(JSON.stringify(settings)));

      if (Array.isArray(settings.radio_table)) {
        device.radio_table = JSON.parse(JSON.stringify(settings.radio_table));
        const statsByRadio = new Map((device.radio_table_stats || []).map((item) => [item.radio, item]));
        device.radio_table.forEach((radioSetting) => {
          const stats = statsByRadio.get(radioSetting.radio);
          if (!stats) return;
          if (radioSetting.channel !== undefined) stats.channel = radioSetting.channel;
          if (radioSetting.tx_power !== undefined) stats.tx_power = radioSetting.tx_power;
        });
      }

      return [JSON.parse(JSON.stringify(device))];
    }
    return await this._putWithRetry(`/api/s/${this.site}/rest/device/${deviceId}`, settings);
  }

  /**
   * Update the channel and/or transmit power for a specific AP radio.
   * @param {string} apMac - MAC address of the target AP
   * @param {string} radio - Radio band name ('ng' or 'na')
   * @param {{channel?: number, txPower?: number}} changes - Radio settings to update
   */
  async setApRadioSettings(apMac, radio, changes = {}) {
    const devices = await this.getDevices();
    const ap = devices.find((d) => normalizeMac(d.mac) === normalizeMac(apMac));
    if (!ap) {
      throw new Error(`Access Point with MAC ${apMac} not found.`);
    }

    const deviceId = ap._id;
    if (!deviceId) {
      throw new Error(`Internal device ID not found for AP with MAC ${apMac}`);
    }

    // 2. Clone and modify the radio table
    const radioTable = ap.radio_table ? JSON.parse(JSON.stringify(ap.radio_table)) : [];
    const rIndex = radioTable.findIndex(r => r.radio === radio);
    if (rIndex === -1) {
      throw new Error(`Radio band "${radio}" not found on AP ${apMac}`);
    }

    if (changes.channel !== undefined) {
      radioTable[rIndex].channel = parseInt(changes.channel, 10);
    }

    if (changes.txPower !== undefined) {
      const txPower = parseInt(changes.txPower, 10);
      radioTable[rIndex].tx_power = txPower;
      radioTable[rIndex].tx_power_mode = inferTxPowerMode(txPower);
    }

    const payload = {
      radio_table: radioTable
    };

    return await this.updateDeviceSettings(deviceId, payload);
  }

  /**
   * Backward-compatible helper for channel-only updates.
   */
  async setApChannel(apMac, radio, channel) {
    return await this.setApRadioSettings(apMac, radio, { channel });
  }
}


const MOCK_DEVICES = buildMockDevices(12);
const MOCK_CLIENTS = buildMockClients(MOCK_DEVICES, 60);
const MOCK_ROGUE_APS = buildMockRogueAps();

function buildMockDevices(count) {
  const devices = [];
  const channels24 = [1, 6, 11];
  const channels5 = [36, 40, 44, 48, 100, 104, 108, 112, 116, 120];

  for (let i = 0; i < count; i++) {
    const id = String(i + 1).padStart(2, '0');
    const mac = `02:00:00:00:00:${id}`;
    const channel24 = channels24[i % channels24.length];
    const channel5 = channels5[i % channels5.length];
    const utilBase = 25 + (i * 7) % 55;

    devices.push({
      _id: `mock-ap-${id}`,
      type: 'uap',
      name: `AP-${id}`,
      mac,
      ip: `10.0.0.${10 + i}`,
      model: i % 2 === 0 ? 'U6-Pro' : 'UAP-AC-Pro',
      radio_table: [
        { radio: 'ng', tx_power_mode: 'auto', tx_power: 18, antenna_gain: 3, min_rssi_enabled: false, min_rssi: -80, ht: 'HT20' },
        { radio: 'na', tx_power_mode: 'auto', tx_power: 20, antenna_gain: 4, min_rssi_enabled: false, min_rssi: -80, ht: 'HE40' }
      ],
      radio_table_stats: [
        { radio: 'ng', channel: channel24, cu_total: utilBase, cu_self_rx: 5, cu_self_tx: 12, tx_retries_pct: 8 + (i % 20), satisfaction: 90, num_sta: 8 + (i % 15), tx_power: 18, bw: 20 },
        { radio: 'na', channel: channel5, cu_total: Math.min(95, utilBase + 10), cu_self_rx: 8, cu_self_tx: 16, tx_retries_pct: 6 + (i % 18), satisfaction: 88, num_sta: 10 + (i % 20), tx_power: 20, bw: 40 }
      ]
    });
  }

  return devices;
}

function buildMockClients(devices, count) {
  const clients = [];
  for (let i = 0; i < count; i++) {
    const ap = devices[i % devices.length];
    const is24 = i % 4 === 0;
    const radioStats = (ap.radio_table_stats || []).find((r) => r.radio === (is24 ? 'ng' : 'na'));
    const id = String(i + 1).padStart(3, '0');
    const isApple = i % 5 !== 0;

    const macSuffix = ((i + 1) % 256).toString(16).padStart(2, '0');

    clients.push({
      mac: `02:11:00:00:00:${macSuffix}`,
      ip: `10.0.10.${20 + i}`,
      hostname: isApple ? `ipad-${id}` : `client-${id}`,
      oui: isApple ? 'Apple, Inc.' : 'Generic Vendor',
      satisfaction: Math.max(40, 96 - (i % 45)),
      signal: -58 - (i % 28),
      tx_rate: 8000 + (i % 20) * 6000,
      rx_rate: 7000 + (i % 18) * 5000,
      wifi_tx_retries_percentage: 4 + (i % 35),
      channel: radioStats ? radioStats.channel : 0,
      radio: is24 ? 'ng' : 'na',
      ap_mac: ap.mac,
      uptime: 600 + i * 45,
      anomalies: []
    });
  }

  return clients;
}

function buildMockRogueAps() {
  return [
    { ap: 'Neighbor-House-2G', channel: 6, signal: -51, radio: 'ng', bssid: '08:aa:bb:00:00:01' },
    { ap: 'Printer-Setup', channel: 11, signal: -67, radio: 'ng', bssid: '08:aa:bb:00:00:02' },
    { ap: 'OfficeMesh-5G', channel: 44, signal: -58, radio: 'na', bssid: '08:aa:bb:00:00:03' },
    { ap: 'Apartment-DFS', channel: 100, signal: -64, radio: 'na', bssid: '08:aa:bb:00:00:04' },
    { ap: 'Hallway-Repeater', channel: 40, signal: -49, radio: 'na', bssid: '08:aa:bb:00:00:05' }
  ];
}

// Export a single instance to share the session cookie across the application
module.exports = new UnifiClient();

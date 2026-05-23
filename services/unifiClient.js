const https = require('https');
const config = require('../config');

const REQUEST_TIMEOUT_MS = 15000;

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
        headers: headers,
        timeout: REQUEST_TIMEOUT_MS
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

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${options.path} timed out after ${REQUEST_TIMEOUT_MS}ms`));
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
   * FIX 7: No longer falls back to mock data silently on failure.
   */
  async getDevices() {
    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated access point devices...');
      return MOCK_DEVICES;
    }
    return await this._getWithRetry(`/api/s/${this.site}/stat/device`);
  }

  /**
   * Fetch all active wireless clients on the configured site.
   * FIX 7: No longer falls back to mock data silently on failure.
   */
  async getClients() {
    if (process.env.MOCK_MODE === 'true') {
      console.log('[UniFi Mock] Serving simulated wireless clients...');
      return MOCK_CLIENTS;
    }
    return await this._getWithRetry(`/api/s/${this.site}/stat/sta`);
  }

  /**
   * Helper to perform an authenticated PUT request, with automatic login retry if needed.
   */
  async _putWithRetry(path, payload) {
    if (!this.cookie) {
      await this.login();
    }

    try {
      let res = await this._request({ method: 'PUT', path }, payload);

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
   */
  async updateDeviceSettings(deviceId, settings) {
    if (process.env.MOCK_MODE === 'true') {
      console.log(`[UniFi Mock] Simulating updating device ${deviceId} settings:`, JSON.stringify(settings));
      return [{ _id: deviceId, ...settings }];
    }
    return await this._putWithRetry(`/api/s/${this.site}/rest/device/${deviceId}`, settings);
  }

  /**
   * Update the channel for a specific AP's radio.
   */
  async setApChannel(apMac, radio, channel) {
    const devices = await this.getDevices();
    const ap = devices.find(d => d.mac === apMac);
    if (!ap) {
      throw new Error(`Access Point with MAC ${apMac} not found.`);
    }

    const deviceId = ap._id;
    if (!deviceId) {
      throw new Error(`Internal device ID not found for AP with MAC ${apMac}`);
    }

    const radioTable = ap.radio_table ? JSON.parse(JSON.stringify(ap.radio_table)) : [];
    const rIndex = radioTable.findIndex(r => r.radio === radio);
    if (rIndex === -1) {
      throw new Error(`Radio band "${radio}" not found on AP ${apMac}`);
    }

    radioTable[rIndex].channel = parseInt(channel, 10);

    const payload = {
      radio_table: radioTable
    };

    return await this.updateDeviceSettings(deviceId, payload);
  }
}


const MOCK_DEVICES = buildMockDevices(12);
const MOCK_CLIENTS = buildMockClients(MOCK_DEVICES, 60);

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

// Export a single instance to share the session cookie across the application
module.exports = new UnifiClient();

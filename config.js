require('dotenv').config();

module.exports = {
  unifi: {
    host: process.env.UNIFI_HOST || '172.16.0.200',
    port: parseInt(process.env.UNIFI_PORT, 10) || 8443,
    username: process.env.UNIFI_USER || 'observer',
    password: process.env.UNIFI_PASS || 'change-me',
    site: process.env.UNIFI_SITE || 'default',
    timeoutMs: parseInt(process.env.UNIFI_TIMEOUT_MS, 10) || 10000
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    hostPort: parseInt(process.env.HOST_PORT, 10) || 38443,
    cacheExpiryMs: (parseInt(process.env.CACHE_EXPIRY_SEC, 10) || 15) * 1000,
    historyMaxSamples: parseInt(process.env.HISTORY_MAX_SAMPLES, 10) || 288
  }
};

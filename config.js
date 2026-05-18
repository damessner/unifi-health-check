require('dotenv').config();
const path = require('path');

// Sanitize UNIFI_HOST: strip protocol prefix (https:// or http://) and trailing :port
// so that pasting a full URL like "https://172.16.0.200:8443" still works correctly.
function sanitizeHost(raw) {
  if (!raw) return '127.0.0.1';
  return raw
    .replace(/^https?:\/\//i, '') // strip https:// or http://
    .replace(/:\d+$/, '')          // strip trailing :port
    .trim();
}

module.exports = {
  unifi: {
    host: sanitizeHost(process.env.UNIFI_HOST),
    port: parseInt(process.env.UNIFI_PORT, 10) || 8443,
    username: process.env.UNIFI_USER || '',
    password: process.env.UNIFI_PASS || '',
    site: process.env.UNIFI_SITE || 'default',
    allowSelfSigned: process.env.UNIFI_ALLOW_SELF_SIGNED !== 'false'
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3445,
    cacheExpiryMs: (parseInt(process.env.CACHE_EXPIRY_SEC, 10) || 15) * 1000,
    apiToken: process.env.API_TOKEN || '',
    historyDbPath: process.env.HISTORY_DB_PATH || path.join(__dirname, 'data', 'unifi-history.sqlite'),
    historyRetentionSamples: parseInt(process.env.HISTORY_RETENTION_SAMPLES, 10) || 2000,
    historyApiLimit: parseInt(process.env.HISTORY_API_LIMIT, 10) || 240
  }
};

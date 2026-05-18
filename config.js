require('dotenv').config();

module.exports = {
  unifi: {
    host: process.env.UNIFI_HOST || '127.0.0.1',
    port: parseInt(process.env.UNIFI_PORT, 10) || 8443,
    username: process.env.UNIFI_USER || '',
    password: process.env.UNIFI_PASS || '',
    site: process.env.UNIFI_SITE || 'default',
    allowSelfSigned: process.env.UNIFI_ALLOW_SELF_SIGNED !== 'false'
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3445,
    cacheExpiryMs: (parseInt(process.env.CACHE_EXPIRY_SEC, 10) || 15) * 1000,
    apiToken: process.env.API_TOKEN || ''
  }
};

require('dotenv').config();

module.exports = {
  unifi: {
    host: process.env.UNIFI_HOST || '172.16.0.200',
    port: parseInt(process.env.UNIFI_PORT, 10) || 8443,
    username: process.env.UNIFI_USER || 'observer',
    password: process.env.UNIFI_PASS || '3^K@nP:!$@Hc;,P',
    site: process.env.UNIFI_SITE || 'default'
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    cacheExpiryMs: (parseInt(process.env.CACHE_EXPIRY_SEC, 10) || 15) * 1000
  }
};

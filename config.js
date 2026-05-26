require('dotenv').config();

// Sanitize UNIFI_HOST: strip protocol prefix (https:// or http://) and trailing :port
// so that pasting a full URL like "https://172.16.0.200:8443" still works correctly.
function sanitizeHost(raw) {
  if (!raw) return '127.0.0.1';
  return raw
    .replace(/^https?:\/\//i, '') // strip https:// or http://
    .replace(/:\d+$/, '')          // strip trailing :port
    .trim();
}

const cfg = {
  unifi: {
    host: sanitizeHost(process.env.UNIFI_HOST),
    port: parseInt(process.env.UNIFI_PORT, 10) || 8443,
    username: process.env.UNIFI_USER || '',
    password: process.env.UNIFI_PASS || '',
    site: process.env.UNIFI_SITE || 'default',
    // Secure default: self-signed certs are REJECTED unless explicitly opted in.
    // Set UNIFI_ALLOW_SELF_SIGNED=true only for local test controllers.
    allowSelfSigned: process.env.UNIFI_ALLOW_SELF_SIGNED === 'true'
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3445,
    cacheExpiryMs: (parseInt(process.env.CACHE_EXPIRY_SEC, 10) || 15) * 1000,
    apiToken: process.env.API_TOKEN || '',
    // CORS allowed origin for external API consumers (e.g. Grafana).
    // Set to a specific origin like 'https://grafana.school.local' to restrict.
    // Leave blank ('') to disable CORS headers entirely (same-origin only).
    corsOrigin: process.env.CORS_ORIGIN || '*'
  },
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    // Intentionally no default — empty string forces login to fail if unset.
    password: process.env.ADMIN_PASS || ''
  },
  mock: {
    enabled: process.env.MOCK_MODE === 'true',
    stackMode: process.env.MOCK_STACK_MODE === 'true'
  },
  opt: {
    maxChanges: parseInt(process.env.OPT_MAX_CHANGES, 10) || 10
  }
};

// Startup safety check: warn loudly if running with no admin password configured.
if (!cfg.admin.password && !cfg.mock.enabled) {
  console.warn('[Config] WARNING: ADMIN_PASS is not set. Admin login will be disabled until it is configured.');
}

module.exports = cfg;

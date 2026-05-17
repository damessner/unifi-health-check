require('dotenv').config();

const isMockMode = process.env.MOCK_MODE === 'true';

function parseIntWithDefault(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function resolveUnifiEndpoint() {
  if (isMockMode) {
    return { host: 'mock-controller.local', port: 443 };
  }

  const unifiUrl = getRequiredEnv('UNIFI_URL');
  let parsed;
  try {
    parsed = new URL(unifiUrl);
  } catch (error) {
    throw new Error('UNIFI_URL must be a valid URL (example: https://controller.example.com:8443)');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('UNIFI_URL must use https://');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 443
  };
}

const endpoint = resolveUnifiEndpoint();
const authEnabled = process.env.API_AUTH_ENABLED !== 'false';
const apiKey = process.env.API_KEY || '';

if (authEnabled && !apiKey.trim()) {
  throw new Error('Missing required environment variable: API_KEY');
}

module.exports = {
  unifi: {
    host: endpoint.host,
    port: endpoint.port,
    username: isMockMode ? (process.env.UNIFI_USER || 'mock-user') : getRequiredEnv('UNIFI_USER'),
    password: isMockMode ? (process.env.UNIFI_PASS || 'mock-pass') : getRequiredEnv('UNIFI_PASS'),
    site: process.env.UNIFI_SITE || 'default',
    allowSelfSignedCert: process.env.UNIFI_ALLOW_SELF_SIGNED_CERT === 'true'
  },
  server: {
    port: parseIntWithDefault(process.env.PORT, 3000),
    cacheExpiryMs: parseIntWithDefault(process.env.CACHE_EXPIRY_SEC, 15) * 1000,
    forceRefreshMinIntervalMs: parseIntWithDefault(process.env.FORCE_REFRESH_MIN_INTERVAL_SEC, 30) * 1000
  },
  api: {
    authEnabled,
    apiKey: apiKey.trim(),
    rateLimitWindowMs: parseIntWithDefault(process.env.RATE_LIMIT_WINDOW_SEC, 60) * 1000,
    rateLimitMaxRequests: parseIntWithDefault(process.env.RATE_LIMIT_MAX_REQUESTS, 60)
  }
};

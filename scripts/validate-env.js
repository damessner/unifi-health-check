require('dotenv').config();

const isMockMode = process.env.MOCK_MODE === 'true';
const requiredVars = isMockMode
  ? ['API_KEY']
  : ['UNIFI_URL', 'UNIFI_USER', 'UNIFI_PASS', 'API_KEY'];

const placeholderPatterns = [
  /^changeme$/i,
  /^your_.*$/i,
  /^example$/i
];

const missing = [];
const weak = [];

for (const name of requiredVars) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    missing.push(name);
    continue;
  }

  const trimmed = value.trim();
  if (placeholderPatterns.some((pattern) => pattern.test(trimmed))) {
    weak.push(name);
  }
}

if (!isMockMode && process.env.UNIFI_URL && process.env.UNIFI_URL.trim()) {
  try {
    const parsed = new URL(process.env.UNIFI_URL);
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      throw new Error('UNIFI_URL must use https://');
    }
  } catch (error) {
    missing.push('UNIFI_URL (must be a valid https:// URL)');
  }
}

if (missing.length || weak.length) {
  if (missing.length) {
    console.error(`[Security] Missing required environment values: ${missing.join(', ')}`);
  }
  if (weak.length) {
    console.error(`[Security] Replace placeholder values for: ${weak.join(', ')}`);
  }
  process.exit(1);
}

console.log('[Security] Environment validation passed.');

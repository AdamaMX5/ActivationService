const REQUIRED_IN_PRODUCTION = [
  'MONGODB_URI',
  'AUTH_SERVICE_URL',
  'REDIS_URL',
  'SECRET_ENC_KEY',
  'CHECKIN_SIGNING_KEY',
];

function readEnv() {
  const env = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: parseInt(process.env.PORT, 10) || 3000,
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/activation-service',

    AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL || 'https://auth.freischule.info',
    AUTH_JWT_PUBLIC_KEY: process.env.AUTH_JWT_PUBLIC_KEY || null,

    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

    SECRET_ENC_KEY: process.env.SECRET_ENC_KEY || '',
    CHECKIN_SIGNING_KEY: process.env.CHECKIN_SIGNING_KEY || '',

    CHECKIN_COOLDOWN_H: parseInt(process.env.CHECKIN_COOLDOWN_H, 10) || 4,
    LOCATION_HOURLY_CAP: parseInt(process.env.LOCATION_HOURLY_CAP, 10) || 300,

    PROFILE_SERVICE_URL: process.env.PROFILE_SERVICE_URL || 'https://profile.freischule.info',
    PROFILE_SERVICE_API_KEY: process.env.PROFILE_SERVICE_API_KEY || '',

    WAVE_SERVICE_URL: process.env.WAVE_SERVICE_URL || 'https://wave.freischule.info',
    WAVE_SERVICE_API_KEY: process.env.WAVE_SERVICE_API_KEY || '',

    EXCEPTION_SERVICE_URL: process.env.EXCEPTION_SERVICE_URL || 'https://exception.freischule.info',
    EXCEPTION_SERVICE_API_KEY: process.env.EXCEPTION_SERVICE_API_KEY || '',
  };

  // Collect INTERNAL_API_KEY_<SERVICENAME> -> serviceName lookup, mirroring AuthService's
  // internal-key convention: one env var per caller, never a shared master key.
  env.internalApiKeys = new Map();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('INTERNAL_API_KEY_') && value) {
      const serviceName = key.slice('INTERNAL_API_KEY_'.length);
      env.internalApiKeys.set(serviceName, value);
    }
  }

  if (env.NODE_ENV === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars in production: ${missing.join(', ')}`);
    }
  }

  // Enforced outside of NODE_ENV=test (which the jest CLI sets automatically) so that a
  // container that forgets to set NODE_ENV=production still can't encrypt TOTP secrets with a
  // weak/short key or sign check-ins with an empty one — a production-only gate would silently
  // allow exactly that.
  if (env.NODE_ENV !== 'test') {
    if (!/^[0-9a-fA-F]{64}$/.test(env.SECRET_ENC_KEY)) {
      throw new Error('SECRET_ENC_KEY must be a 64-character hex string (32 bytes for AES-256-GCM)');
    }
    if (env.CHECKIN_SIGNING_KEY.length < 32) {
      throw new Error('CHECKIN_SIGNING_KEY must be set and at least 32 characters long');
    }
  }

  return env;
}

module.exports = readEnv();

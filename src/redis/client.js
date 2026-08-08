const Redis = require('ioredis');
const env = require('../config/env');

// lazyConnect: true -- constructing the client (and therefore requiring this module, which
// happens transitively from the check-in route) never opens a socket. The actual connection is
// established explicitly in src/index.js at startup. This keeps `require('./app')` side-effect
// free, which matters for tests that stub Redis entirely.
const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[redis] connection error:', err.message);
});

module.exports = redis;

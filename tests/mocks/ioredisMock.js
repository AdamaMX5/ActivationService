'use strict';

/**
 * Test-only stand-in for the `ioredis` module, wired in via jest's `moduleNameMapper`
 * (see package.json) so `require('ioredis')` resolves to `ioredis-mock` everywhere,
 * including transitively through src/redis/client.js -- production code is never touched.
 */
module.exports = require('ioredis-mock');

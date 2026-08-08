'use strict';

// Runs once per test file, before the test framework is installed, in that file's own realm --
// so `process.env` mutations here are visible to every `require()` the test file makes
// afterwards (crucially: before src/config/env.js is ever required, since that module reads
// process.env exactly once at require-time and caches the result as a singleton export).

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.REDIS_URL = 'redis://localhost:6379'; // never dialed -- ioredis is mocked entirely

process.env.SECRET_ENC_KEY = '0'.repeat(32) + 'f'.repeat(32); // 32 bytes, hex
process.env.CHECKIN_SIGNING_KEY = 'test-checkin-signing-key-0123456789abcdef';

process.env.CHECKIN_COOLDOWN_H = '4';
process.env.LOCATION_HOURLY_CAP = '300';

process.env.AUTH_SERVICE_URL = 'http://auth.test.invalid';
process.env.PROFILE_SERVICE_URL = 'http://profile.test.invalid';
process.env.PROFILE_SERVICE_API_KEY = 'profile-test-key';
process.env.WAVE_SERVICE_URL = 'http://wave.test.invalid';
process.env.WAVE_SERVICE_API_KEY = 'wave-test-key';
process.env.EXCEPTION_SERVICE_URL = 'http://exception.test.invalid';
// Every test file that can reach reportException() also `jest.mock('axios')`s, so a real key
// here is safe (the "outbound call" always hits the mock) and lets tests exercise the real
// report path instead of the missing-key early return.
process.env.EXCEPTION_SERVICE_API_KEY = 'exception-test-key';

// One internal-service API key for tests exercising the /internal/* routes.
process.env.INTERNAL_API_KEY_TEST_CALLER = 'test-internal-key-0123456789';

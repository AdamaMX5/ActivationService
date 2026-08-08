/**
 * Smoke coverage: proves the app boots and every router is wired together. The six
 * Akzeptanzkriterien are covered in acceptance.integration.test.js.
 *
 * Requires downloading a MongoDB binary via mongodb-memory-server on first run — needs
 * outbound network access to fastdl.mongodb.org (works in normal dev/CI, not in
 * network-restricted sandboxes).
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const axios = require('axios');

const { createApp } = require('../../src/app');
const Location = require('../../src/models/Location');
const { Checkin } = require('../../src/models/Checkin');
const redis = require('../../src/redis/client');
const env = require('../../src/config/env');
const { decrypt } = require('../../src/services/secretCipher');
const { authHeader } = require('../helpers/testAuth');
const { codeAtOffset } = require('../helpers/totp');

jest.mock('axios');

let mongod;
let app;

// POST /checkins requires an ObjectId-shaped waveId, so a caller-supplied value can never be
// interpolated as extra path segments into the WaveService URL.
const WAVE_ID = '65a1b2c3d4e5f6a7b8c9d0e1';

const merchant = authHeader({ sub: 'merchant-1', roles: ['merchant'] });
const otherMerchant = authHeader({ sub: 'merchant-2', roles: ['merchant'] });
const consumer = authHeader({ sub: 'user-1', roles: ['consumer'] });
const admin = authHeader({ sub: 'admin-1', roles: ['admin'] });
const internalKey = { 'X-API-Key': process.env.INTERNAL_API_KEY_TEST_CALLER };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = createApp();
  await Promise.all([Location.init(), Checkin.init()]);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  await redis.quit();
});

beforeEach(async () => {
  await Promise.all([Location.deleteMany({}), Checkin.deleteMany({})]);
  await redis.flushall();
  axios.post.mockReset();
  axios.post.mockResolvedValue({ data: {} });
});

async function createLocation(auth = merchant, body = {}) {
  const res = await request(app)
    .post('/locations')
    .set(auth)
    .send({ name: 'Café Milchbart, Theke', lat: 52.52, lng: 13.405, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function validCodeFor(locationId, stepOffset = 0) {
  const doc = await Location.findById(locationId).select('+totpSecret');
  return codeAtOffset(decrypt(doc.totpSecret), doc.codeStepS, stepOffset);
}

test('health endpoint responds', async () => {
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok', service: 'ActivationService' });
});

describe('merchant locations', () => {
  test('create never returns the TOTP secret and computes an h3 cell', async () => {
    const location = await createLocation();
    expect(location.totpSecret).toBeUndefined();
    expect(location.h3Cell).toEqual(expect.any(String));
    expect(location.merchantId).toBe('merchant-1');
  });

  test('consumers may not create locations', async () => {
    const res = await request(app).post('/locations').set(consumer).send({ name: 'x', lat: 1, lng: 2 });
    expect(res.status).toBe(403);
  });

  test('code endpoint returns an uncacheable current code', async () => {
    const location = await createLocation();
    const res = await request(app).get(`/locations/${location.id}/code`).set(merchant);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.code).toMatch(/^\d{8}$/);
    expect(res.body.expiresInS).toBeGreaterThan(0);
    expect(res.body.totpSecret).toBeUndefined();
  });

  test('a foreign merchant gets 403, a missing location 404', async () => {
    const location = await createLocation();

    const foreign = await request(app).get(`/locations/${location.id}/code`).set(otherMerchant);
    expect(foreign.status).toBe(403);

    const missing = await request(app)
      .get(`/locations/${new mongoose.Types.ObjectId()}/code`)
      .set(merchant);
    expect(missing.status).toBe(404);
  });

  test('an admin cannot mint check-in codes for a merchant location', async () => {
    const location = await createLocation();
    const res = await request(app).get(`/locations/${location.id}/code`).set(admin);
    expect(res.status).toBe(403);
  });

  test('rotate-secret replaces the stored secret', async () => {
    const location = await createLocation();
    const before = await Location.findById(location.id).select('+totpSecret');

    const res = await request(app).post(`/locations/${location.id}/rotate-secret`).set(merchant);
    expect(res.status).toBe(200);
    expect(res.body.totpSecret).toBeUndefined();

    const after = await Location.findById(location.id).select('+totpSecret');
    expect(decrypt(after.totpSecret)).not.toBe(decrypt(before.totpSecret));
  });

  test('check-in list pseudonymizes the user', async () => {
    const location = await createLocation();
    await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id) });

    const res = await request(app).get(`/locations/${location.id}/checkins`).set(merchant);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].userRef).toEqual(expect.any(String));
    expect(res.body.items[0].userId).toBeUndefined();
  });
});

describe('check-ins', () => {
  test('a valid code creates a signed check-in and fires follow-up events', async () => {
    const location = await createLocation();
    const res = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id), waveId: WAVE_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      plausibility: 'unknown',
      createdAt: expect.any(String),
    });
    expect(res.body.signature).toBeUndefined();

    const stored = await Checkin.findById(res.body.id);
    expect(stored.signature).toEqual(expect.any(String));
    expect(stored.merchantId).toBe('merchant-1');

    await new Promise((resolve) => setImmediate(resolve));
    const urls = axios.post.mock.calls.map(([url]) => url);
    expect(urls).toContain('http://profile.test.invalid/internal/xp-events');
    expect(urls).toContain(`http://wave.test.invalid/internal/waves/${WAVE_ID}/stats`);
  });

  test('a code two steps in the past is rejected', async () => {
    const location = await createLocation();
    const res = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id, -2) });

    expect(res.status).toBe(403);
  });

  test('a second check-in within the cooldown is rejected', async () => {
    const location = await createLocation();
    const code = await validCodeFor(location.id);

    const first = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code });
    expect(second.status).toBe(429);
  });

  test('an inactive location is invisible to check-ins', async () => {
    const location = await createLocation();
    const code = await validCodeFor(location.id);
    await request(app).patch(`/locations/${location.id}`).set(merchant).send({ active: false });

    const res = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code });
    expect(res.status).toBe(404);
  });

  test.each([
    ['path traversal', '../../admin/waves/x'],
    ['slash-separated', 'wave-1/stats'],
    ['legacy non-hex id', 'wave-1'],
    ['wrong length', 'a'.repeat(23)],
  ])('a waveId that is not an object id is rejected (%s)', async (_label, waveId) => {
    const location = await createLocation();
    const res = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id), waveId });

    expect(res.status).toBe(400);
    await new Promise((resolve) => setImmediate(resolve));
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('own history is listed without billing-side fields', async () => {
    const location = await createLocation();
    await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id) });

    const res = await request(app).get('/me/checkins').set(consumer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 1 });
    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'clientH3',
      'createdAt',
      'id',
      'locationId',
      'plausibility',
      'waveId',
    ]);
  });
});

describe('internal', () => {
  test('rejects a request without a valid API key', async () => {
    const res = await request(app).get('/internal/checkins');
    expect(res.status).toBe(401);
  });

  test('verify-signature detects a tampered waveId', async () => {
    const location = await createLocation();
    const created = await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id), waveId: WAVE_ID });

    const valid = await request(app)
      .post('/internal/verify-signature')
      .set(internalKey)
      .send({ checkinId: created.body.id });
    expect(valid.body).toEqual({ valid: true });

    await Checkin.updateOne({ _id: created.body.id }, { $set: { waveId: 'wave-2' } });

    const tampered = await request(app)
      .post('/internal/verify-signature')
      .set(internalKey)
      .send({ checkinId: created.body.id });
    expect(tampered.body).toEqual({ valid: false });
  });

  test('billing list exposes signatures', async () => {
    const location = await createLocation();
    await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id) });

    const res = await request(app).get('/internal/checkins?merchantId=merchant-1').set(internalKey);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].signature).toEqual(expect.any(String));
  });
});

describe('admin', () => {
  test('fraud report is admin-only', async () => {
    expect((await request(app).get('/admin/fraud-report').set(consumer)).status).toBe(403);
    expect((await request(app).get('/admin/fraud-report').set(admin)).status).toBe(200);
  });

  test('a location that reaches its hourly cap shows up in hourlyCapBreaches', async () => {
    const location = await createLocation();
    const code = await validCodeFor(location.id);

    // Distinct users: the per-user+location cooldown would otherwise reject long before the
    // location cap does. Driving this through the real endpoint (rather than inserting rows) is
    // the point — it pins the report's threshold to what the rate limiter actually permits,
    // which is exactly where the $gt/$gte bug lived.
    for (let i = 0; i < env.LOCATION_HOURLY_CAP; i += 1) {
      const res = await request(app)
        .post('/checkins')
        .set(authHeader({ sub: `cap-user-${i}`, roles: ['consumer'] }))
        .send({ locationId: location.id, code });
      expect([i, res.status]).toEqual([i, 201]);
    }

    const res = await request(app).get('/admin/fraud-report').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.hourlyCap).toBe(env.LOCATION_HOURLY_CAP);
    expect(res.body.hourlyCapBreaches).toHaveLength(1);
    expect(res.body.hourlyCapBreaches[0]).toMatchObject({
      locationId: location.id,
      count: env.LOCATION_HOURLY_CAP,
    });
  }, 120000);

  test('a location below its cap is not reported', async () => {
    const location = await createLocation();
    await request(app)
      .post('/checkins')
      .set(consumer)
      .send({ locationId: location.id, code: await validCodeFor(location.id) });

    const res = await request(app).get('/admin/fraud-report').set(admin);
    expect(res.body.hourlyCapBreaches).toEqual([]);
  });
});

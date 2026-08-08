/**
 * End-to-end validation of the six Akzeptanzkriterien in ActivationService.md, one describe
 * block per criterion, numbered to match the spec.
 *
 * The wall clock is frozen (Date only — every timer API stays real, so mongo/mongoose I/O is
 * untouched). Both the TOTP step window and the rate limiter's hour bucket are derived from the
 * clock, so freezing it removes the two sources of flakiness these tests would otherwise have:
 * a step boundary rolling between generating a code and verifying it, and the UTC hour rolling
 * mid-loop during the 301-check-in cap test.
 *
 * Requires downloading a MongoDB binary via mongodb-memory-server on first run.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const axios = require('axios');
const { latLngToCell, gridDisk, gridDistance } = require('h3-js');

const { createApp } = require('../../src/app');
const Location = require('../../src/models/Location');
const { Checkin } = require('../../src/models/Checkin');
const redis = require('../../src/redis/client');
const env = require('../../src/config/env');
const { decrypt } = require('../../src/services/secretCipher');
const { RESOLUTION } = require('../../src/services/h3');
const { authHeader } = require('../helpers/testAuth');
const { codeAtOffset } = require('../helpers/totp');

jest.mock('axios');

const LAT = 52.52;
const LNG = 13.405;

// POST /checkins requires an ObjectId-shaped waveId, so a caller-supplied value can never be
// interpolated as extra path segments into the WaveService URL.
const WAVE_ID = '65a1b2c3d4e5f6a7b8c9d0e1';

// Everything @sinonjs/fake-timers can fake except `Date` — so only the clock is frozen.
const TIMERS_LEFT_REAL = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
];

let mongod;
let app;

const merchant = authHeader({ sub: 'merchant-1', roles: ['merchant'] });
const internalKey = { 'X-API-Key': process.env.INTERNAL_API_KEY_TEST_CALLER };
const userAuth = (n) => authHeader({ sub: `user-${n}`, roles: ['consumer'] });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = createApp();
  await Promise.all([Location.init(), Checkin.init()]);
  // Frozen at the real "now" rather than a fixed calendar date, so the test JWTs (signed at
  // module load with a 1h expiry) stay valid.
  jest.useFakeTimers({ now: Date.now(), doNotFake: TIMERS_LEFT_REAL });
}, 60000);

afterAll(async () => {
  jest.useRealTimers();
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

async function createLocation(body = {}) {
  const res = await request(app)
    .post('/locations')
    .set(merchant)
    .send({ name: 'Café Milchbart, Theke', lat: LAT, lng: LNG, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function plainSecret(locationId) {
  const doc = await Location.findById(locationId).select('+totpSecret');
  return { secret: decrypt(doc.totpSecret), step: doc.codeStepS };
}

async function codeFor(locationId, stepOffset = 0) {
  const { secret, step } = await plainSecret(locationId);
  return codeAtOffset(secret, step, stepOffset);
}

function checkin(auth, body) {
  return request(app).post('/checkins').set(auth).send(body);
}

/** An 8-digit code that is deterministically in none of the three accepted TOTP windows. */
async function wrongCodeFor(locationId) {
  const { secret, step } = await plainSecret(locationId);
  const accepted = new Set([-1, 0, 1].map((o) => codeAtOffset(secret, step, o)));

  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(8, '0');
    if (!accepted.has(candidate)) return candidate;
  }
}

/** A cell exactly `rings` grid steps from the location's own cell. */
function cellAtDistance(origin, rings) {
  const cell = gridDisk(origin, rings).find((c) => gridDistance(origin, c) === rings);
  expect(cell).toBeDefined();
  return cell;
}

/** The report bodies ActivationService pushed to ExceptionService during this test. */
function exceptionReports() {
  return axios.post.mock.calls
    .filter(([url]) => String(url).endsWith('/report'))
    .map(([, body]) => body);
}

describe('1. TOTP window: ±1 step accepted, −2 steps and wrong codes rejected', () => {
  test.each([-1, 0, 1])('a code %i step(s) from now creates the check-in (201)', async (offset) => {
    const location = await createLocation();
    const res = await checkin(userAuth(`w${offset}`), {
      locationId: location.id,
      code: await codeFor(location.id, offset),
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));
  });

  test('a code exactly 2 steps in the past is rejected with 403 (boundary)', async () => {
    const location = await createLocation();
    const res = await checkin(userAuth('past'), {
      locationId: location.id,
      code: await codeFor(location.id, -2),
    });

    expect(res.status).toBe(403);
    expect(await Checkin.countDocuments({})).toBe(0);
  });

  test('a code 2 steps in the future is rejected with 403 (boundary)', async () => {
    const location = await createLocation();
    const res = await checkin(userAuth('future'), {
      locationId: location.id,
      code: await codeFor(location.id, 2),
    });

    expect(res.status).toBe(403);
  });

  test('a wrong code is rejected with 403 and burns no cooldown', async () => {
    const location = await createLocation();
    const rejected = await checkin(userAuth('wrong'), {
      locationId: location.id,
      code: await wrongCodeFor(location.id),
    });
    expect(rejected.status).toBe(403);

    // The TOTP check runs before the rate limiter, so a failed attempt must not consume the
    // user's 4h cooldown for this location.
    const retry = await checkin(userAuth('wrong'), {
      locationId: location.id,
      code: await codeFor(location.id),
    });
    expect(retry.status).toBe(201);
  });

  test("a code from another location's secret is rejected with 403", async () => {
    const [a, b] = [await createLocation(), await createLocation({ name: 'Other' })];
    const res = await checkin(userAuth('cross'), {
      locationId: a.id,
      code: await codeFor(b.id),
    });

    expect(res.status).toBe(403);
  });
});

describe('2. Cooldown: a second check-in at the same location within the window is 429', () => {
  test('the second check-in is rejected and no second document is written', async () => {
    const location = await createLocation();
    const code = await codeFor(location.id);
    const auth = userAuth('cooldown');

    expect((await checkin(auth, { locationId: location.id, code })).status).toBe(201);

    const second = await checkin(auth, { locationId: location.id, code });
    expect(second.status).toBe(429);
    expect(await Checkin.countDocuments({ userId: 'user-cooldown' })).toBe(1);
  });

  test('the cooldown is scoped per user+location, not global', async () => {
    const [a, b] = [await createLocation(), await createLocation({ name: 'Second venue' })];
    const auth = userAuth('scoped');

    expect((await checkin(auth, { locationId: a.id, code: await codeFor(a.id) })).status).toBe(201);
    // Same user, different location -> allowed.
    expect((await checkin(auth, { locationId: b.id, code: await codeFor(b.id) })).status).toBe(201);
    // Different user, first location -> allowed.
    expect(
      (await checkin(userAuth('other'), { locationId: a.id, code: await codeFor(a.id) })).status
    ).toBe(201);
  });

  test('a cooldown rejection is not reported to ExceptionService (only cap breaches are)', async () => {
    const location = await createLocation();
    const code = await codeFor(location.id);
    const auth = userAuth('quiet');

    await checkin(auth, { locationId: location.id, code });
    await checkin(auth, { locationId: location.id, code });

    expect(exceptionReports()).toEqual([]);
  });
});

describe('3. Plausibility is a data point, never a blocker', () => {
  const locationCell = latLngToCell(LAT, LNG, RESOLUTION);

  test('clientH3 at the location is a match and still creates the check-in', async () => {
    const location = await createLocation();
    expect(location.h3Cell).toBe(locationCell);

    const res = await checkin(userAuth('here'), {
      locationId: location.id,
      code: await codeFor(location.id),
      h3: locationCell,
    });

    expect(res.status).toBe(201);
    expect(res.body.plausibility).toBe('match');
    expect((await Checkin.findById(res.body.id)).clientH3).toBe(locationCell);
  });

  test('clientH3 3 rings away is a mismatch and still creates the check-in', async () => {
    const location = await createLocation();
    const far = cellAtDistance(locationCell, 3);

    const res = await checkin(userAuth('far'), {
      locationId: location.id,
      code: await codeFor(location.id),
      h3: far,
    });

    expect(res.status).toBe(201);
    expect(res.body.plausibility).toBe('mismatch');
    expect((await Checkin.findById(res.body.id)).plausibility).toBe('mismatch');
  });

  test('a missing clientH3 is unknown and still creates the check-in', async () => {
    const location = await createLocation();
    const res = await checkin(userAuth('nogps'), {
      locationId: location.id,
      code: await codeFor(location.id),
    });

    expect(res.status).toBe(201);
    expect(res.body.plausibility).toBe('unknown');
    expect((await Checkin.findById(res.body.id)).clientH3).toBeNull();
  });

  test('all three outcomes persist and surface in the fraud report', async () => {
    const location = await createLocation();
    const cases = [
      ['match', locationCell],
      ['mismatch', cellAtDistance(locationCell, 3)],
      ['unknown', undefined],
    ];

    for (const [expected, h3] of cases) {
      const res = await checkin(userAuth(`p-${expected}`), {
        locationId: location.id,
        code: await codeFor(location.id),
        ...(h3 ? { h3 } : {}),
      });
      expect(res.status).toBe(201);
      expect(res.body.plausibility).toBe(expected);
    }

    expect(await Checkin.countDocuments({ locationId: location.id })).toBe(3);

    const report = await request(app)
      .get('/admin/fraud-report')
      .set(authHeader({ sub: 'admin-1', roles: ['admin'] }));
    expect(report.status).toBe(200);
    expect(report.body.mismatchRates).toEqual([
      expect.objectContaining({ locationId: location.id, total: 3, mismatches: 1 }),
    ]);
  });
});

describe('4. Location hourly cap: the 301st check-in in one hour is 429 + a fraud signal', () => {
  test(`the cap defaults to 300 and the cap+1-th check-in is rejected`, async () => {
    expect(env.LOCATION_HOURLY_CAP).toBe(300);

    const location = await createLocation();
    const code = await codeFor(location.id);
    // Distinct users throughout: the per-user+location cooldown would otherwise reject long
    // before the location cap does, so this isolates the hourly cap.
    const auths = Array.from({ length: env.LOCATION_HOURLY_CAP + 1 }, (_, i) => userAuth(`cap-${i}`));

    for (let i = 0; i < env.LOCATION_HOURLY_CAP; i += 1) {
      const res = await checkin(auths[i], { locationId: location.id, code });
      expect([i, res.status]).toEqual([i, 201]);
    }

    expect(exceptionReports()).toEqual([]);

    const overCap = await checkin(auths[env.LOCATION_HOURLY_CAP], { locationId: location.id, code });
    expect(overCap.status).toBe(429);

    // Rejected -> not persisted, and the cap counter was rolled back rather than left inflated.
    expect(await Checkin.countDocuments({ locationId: location.id })).toBe(env.LOCATION_HOURLY_CAP);

    const reports = exceptionReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      service: 'ActivationService',
      message: expect.stringMatching(/hourly/i),
      statusCode: 429,
      metadata: { locationId: location.id, cap: env.LOCATION_HOURLY_CAP },
    });

    const [, , config] = axios.post.mock.calls.find(([url]) => String(url).endsWith('/report'));
    expect(config.headers['X-API-Key']).toBe(process.env.EXCEPTION_SERVICE_API_KEY);
  }, 120000);

  test('a rejected over-cap check-in does not burn the rejected user’s cooldown', async () => {
    const location = await createLocation();
    const code = await codeFor(location.id);

    for (let i = 0; i < env.LOCATION_HOURLY_CAP; i += 1) {
      await checkin(userAuth(`fill-${i}`), { locationId: location.id, code });
    }

    const blocked = userAuth('unlucky');
    expect((await checkin(blocked, { locationId: location.id, code })).status).toBe(429);

    // A second location is unaffected by the first one's cap, and the user's cooldown is intact.
    const other = await createLocation({ name: 'Unaffected venue' });
    const res = await checkin(blocked, { locationId: other.id, code: await codeFor(other.id) });
    expect(res.status).toBe(201);
  }, 120000);
});

describe('5. verify-signature detects post-hoc database tampering', () => {
  async function createCheckin(overrides = {}) {
    const location = await createLocation();
    const res = await checkin(userAuth('sig'), {
      locationId: location.id,
      code: await codeFor(location.id),
      waveId: WAVE_ID,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  function verifySignature(checkinId) {
    return request(app).post('/internal/verify-signature').set(internalKey).send({ checkinId });
  }

  test('an untouched check-in verifies as valid', async () => {
    const res = await verifySignature(await createCheckin());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  test('a waveId altered directly in the database verifies as invalid', async () => {
    const id = await createCheckin();
    expect((await verifySignature(id)).body).toEqual({ valid: true });

    // Bypasses the API entirely — this is the "someone with DB access edited billing data" case.
    await Checkin.updateOne({ _id: id }, { $set: { waveId: 'wave-2' } });

    expect((await verifySignature(id)).body).toEqual({ valid: false });
  });

  test('a merchantId repointed directly in the database verifies as invalid', async () => {
    const id = await createCheckin();
    expect((await verifySignature(id)).body).toEqual({ valid: true });

    // The CPA payout case: redirect an existing check-in's revenue to another merchant.
    await Checkin.updateOne({ _id: id }, { $set: { merchantId: 'merchant-impostor' } });

    expect((await verifySignature(id)).body).toEqual({ valid: false });
  });

  test.each([
    ['userId', { userId: 'user-impostor' }],
    ['locationId', { locationId: '000000000000000000000000' }],
    ['merchantId', { merchantId: 'merchant-2' }],
    ['createdAt', { createdAt: new Date('2020-01-01T00:00:00.000Z') }],
    ['waveId removed', { waveId: null }],
    ['signature', { signature: 'f'.repeat(64) }],
  ])('an altered %s verifies as invalid', async (_label, mutation) => {
    const id = await createCheckin();
    await Checkin.updateOne({ _id: id }, { $set: mutation });

    expect((await verifySignature(id)).body).toEqual({ valid: false });
  });

  test('the tampered record still shows up in the billing list, flagged only by verification', async () => {
    const id = await createCheckin();
    await Checkin.updateOne({ _id: id }, { $set: { waveId: 'wave-2' } });

    const billing = await request(app).get('/internal/checkins?waveId=wave-2').set(internalKey);
    expect(billing.status).toBe(200);
    expect(billing.body.total).toBe(1);
    expect(billing.body.items[0].signature).toEqual(expect.any(String));
    expect((await verifySignature(id)).body).toEqual({ valid: false });
  });

  test('an unknown or malformed checkinId is 404 / 400, never a crash', async () => {
    expect((await verifySignature(String(new mongoose.Types.ObjectId()))).status).toBe(404);
    expect((await verifySignature('not-an-object-id')).status).toBe(404);
    expect(
      (await request(app).post('/internal/verify-signature').set(internalKey).send({})).status
    ).toBe(400);
  });
});

describe('6. totpSecret never leaves the service', () => {
  /** Every string value and object key reachable in a JSON body. */
  function walk(value, onKey, onString) {
    if (typeof value === 'string') return onString(value);
    if (Array.isArray(value)) return value.forEach((v) => walk(v, onKey, onString));
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        onKey(k);
        walk(v, onKey, onString);
      }
    }
  }

  function assertClean(label, body, secrets) {
    const serialized = JSON.stringify(body ?? null);
    expect(`${label}: ${serialized}`).not.toContain('totpSecret');
    for (const secret of secrets) {
      expect(`${label}: ${serialized}`).not.toContain(secret);
    }
    walk(body, (key) => expect(`${label}.${key}`).not.toMatch(/totpSecret/i), () => {});
  }

  test('no read path returns the secret, in plaintext or encrypted form', async () => {
    const created = await createLocation();
    const stored = await Location.findById(created.id).select('+totpSecret');
    const secrets = [decrypt(stored.totpSecret), stored.totpSecret];

    const code = await codeFor(created.id);
    const checkinRes = await checkin(userAuth('leak'), {
      locationId: created.id,
      code,
      h3: latLngToCell(LAT, LNG, RESOLUTION),
      waveId: WAVE_ID,
    });
    expect(checkinRes.status).toBe(201);

    const responses = [
      ['POST /locations', created],
      ['POST /checkins', checkinRes.body],
      ['GET /locations', (await request(app).get('/locations').set(merchant)).body],
      [
        'PATCH /locations/:id',
        (await request(app).patch(`/locations/${created.id}`).set(merchant).send({ name: 'Renamed' }))
          .body,
      ],
      [
        'GET /locations/:id/code',
        (await request(app).get(`/locations/${created.id}/code`).set(merchant)).body,
      ],
      [
        'GET /locations/:id/checkins',
        (await request(app).get(`/locations/${created.id}/checkins`).set(merchant)).body,
      ],
      ['GET /me/checkins', (await request(app).get('/me/checkins').set(userAuth('leak'))).body],
      [
        'GET /internal/checkins',
        (await request(app).get('/internal/checkins').set(internalKey)).body,
      ],
      [
        'GET /admin/fraud-report',
        (await request(app)
          .get('/admin/fraud-report')
          .set(authHeader({ sub: 'admin-1', roles: ['admin'] }))).body,
      ],
    ];

    for (const [label, body] of responses) {
      assertClean(label, body, secrets);
    }

    // rotate-secret loads and replaces the secret — the response must expose neither the old
    // nor the new one.
    const rotated = await request(app).post(`/locations/${created.id}/rotate-secret`).set(merchant);
    expect(rotated.status).toBe(200);
    const after = await Location.findById(created.id).select('+totpSecret');
    assertClean('POST /locations/:id/rotate-secret', rotated.body, [
      ...secrets,
      decrypt(after.totpSecret),
      after.totpSecret,
    ]);
  });

  test('an error response never leaks the secret', async () => {
    const created = await createLocation();
    const stored = await Location.findById(created.id).select('+totpSecret');
    const secrets = [decrypt(stored.totpSecret), stored.totpSecret];

    const forbidden = await checkin(userAuth('err'), {
      locationId: created.id,
      code: await wrongCodeFor(created.id),
    });
    expect(forbidden.status).toBe(403);
    assertClean('403 body', forbidden.body, secrets);

    const foreign = await request(app)
      .get(`/locations/${created.id}/code`)
      .set(authHeader({ sub: 'merchant-2', roles: ['merchant'] }));
    expect(foreign.status).toBe(403);
    assertClean('foreign 403 body', foreign.body, secrets);
  });

  test('nothing written to the console contains the secret', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {})
    );

    try {
      const created = await createLocation();
      const before = await Location.findById(created.id).select('+totpSecret');
      const secrets = [decrypt(before.totpSecret), before.totpSecret];

      // Exercise every path that loads the secret into memory, plus a failing one.
      await request(app).get(`/locations/${created.id}/code`).set(merchant);
      await checkin(userAuth('log'), {
        locationId: created.id,
        code: await codeFor(created.id),
      });
      await checkin(userAuth('log2'), {
        locationId: created.id,
        code: await wrongCodeFor(created.id),
      });
      await request(app).post(`/locations/${created.id}/rotate-secret`).set(merchant);

      const after = await Location.findById(created.id).select('+totpSecret');
      secrets.push(decrypt(after.totpSecret), after.totpSecret);

      const written = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join('\n');

      for (const secret of secrets) {
        expect(written).not.toContain(secret);
      }
      expect(written).not.toContain('totpSecret');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

/**
 * Not one of the six spec criteria — regression cover for the audit fixes, so the hardening
 * can't be silently undone later.
 */
describe('Security regressions (post-audit hardening)', () => {
  /** Outbound WaveService stats calls fired during this test. */
  async function waveStatsCalls() {
    // The follow-up is fire-and-forget; let the microtask/immediate queue drain first.
    await new Promise((resolve) => setImmediate(resolve));
    return axios.post.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/internal/waves/'));
  }

  test.each([
    ['a path traversal', '../../admin/waves/hijacked'],
    ['an appended path segment', '65a1b2c3d4e5f6a7b8c9d0e1/../../foo'],
    ['a non-hex slug', 'wave-1'],
    ['a 24-char non-hex string', 'z'.repeat(24)],
    ['an over-long hex string', 'a'.repeat(25)],
    ['a short hex string', 'a'.repeat(23)],
    ['a non-string', 42],
  ])('%s in waveId is rejected with 400 before any check-in or outbound call', async (_l, waveId) => {
    const location = await createLocation();
    const res = await checkin(userAuth('inject'), {
      locationId: location.id,
      code: await codeFor(location.id),
      waveId,
    });

    expect(res.status).toBe(400);
    expect(await Checkin.countDocuments({})).toBe(0);
    expect(await waveStatsCalls()).toEqual([]);
  });

  test('an ObjectId-shaped waveId is accepted and hits exactly the intended WaveService path', async () => {
    const location = await createLocation();
    const res = await checkin(userAuth('wave'), {
      locationId: location.id,
      code: await codeFor(location.id),
      waveId: WAVE_ID,
    });

    expect(res.status).toBe(201);
    expect(await waveStatsCalls()).toEqual([
      `${process.env.WAVE_SERVICE_URL}/internal/waves/${WAVE_ID}/stats`,
    ]);
  });

  test('a check-in without a waveId fires no WaveService call at all', async () => {
    const location = await createLocation();
    const res = await checkin(userAuth('nowave'), {
      locationId: location.id,
      code: await codeFor(location.id),
    });

    expect(res.status).toBe(201);
    expect(await waveStatsCalls()).toEqual([]);
  });

  test('merchantId is covered by the signature, so a repointed payout is detectable', async () => {
    const location = await createLocation();
    const created = await checkin(userAuth('payout'), {
      locationId: location.id,
      code: await codeFor(location.id),
    });
    expect(created.status).toBe(201);

    const stored = await Checkin.findById(created.body.id);
    expect(stored.merchantId).toBe('merchant-1');

    // Same location, different payee — only the signature can catch this.
    await Checkin.updateOne({ _id: created.body.id }, { $set: { merchantId: 'merchant-2' } });

    const res = await request(app)
      .post('/internal/verify-signature')
      .set(internalKey)
      .send({ checkinId: created.body.id });
    expect(res.body).toEqual({ valid: false });
  });
});

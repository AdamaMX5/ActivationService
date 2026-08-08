/**
 * Akzeptanzkriterium 5 at the unit level: the HMAC covers every field it claims to, so any
 * post-hoc edit of stored billing evidence surfaces as `valid: false`.
 */
const { sign, verify, pseudonymize } = require('../../src/services/checkinSignature');

const base = {
  userId: 'user-1',
  locationId: 'loc-1',
  merchantId: 'merchant-1',
  waveId: 'wave-1',
  createdAt: new Date('2026-08-08T12:00:00.000Z'),
};

function signed(overrides = {}) {
  const checkin = { ...base, ...overrides };
  return { ...checkin, signature: sign(checkin) };
}

test('a freshly signed check-in verifies', () => {
  expect(verify(signed())).toBe(true);
});

test('the signature is a hex SHA-256 digest and is deterministic', () => {
  expect(sign(base)).toMatch(/^[0-9a-f]{64}$/);
  expect(sign(base)).toBe(sign(base));
});

test('createdAt is normalised, so an equivalent Date/ISO string signs identically', () => {
  expect(sign({ ...base, createdAt: base.createdAt.toISOString() })).toBe(sign(base));
});

test.each([
  ['userId', { userId: 'user-2' }],
  ['locationId', { locationId: 'loc-2' }],
  // merchantId decides the CPA payout, so it must be covered by the HMAC like everything else.
  ['merchantId', { merchantId: 'merchant-2' }],
  ['merchantId cleared', { merchantId: null }],
  ['waveId', { waveId: 'wave-2' }],
  ['waveId cleared', { waveId: null }],
  ['createdAt', { createdAt: new Date('2026-08-08T12:00:01.000Z') }],
])('tampering with %s after signing is detected', (_label, mutation) => {
  const tampered = { ...signed(), ...mutation };
  expect(verify(tampered)).toBe(false);
});

test.each([[''], [null], [undefined], ['deadbeef']])(
  'a missing or truncated signature (%p) verifies as false rather than throwing',
  (signature) => {
    expect(verify({ ...base, signature })).toBe(false);
  }
);

test('a check-in without a waveId still signs and verifies', () => {
  const withoutWave = signed({ waveId: null });
  expect(verify(withoutWave)).toBe(true);
  // A null waveId and an empty-string waveId must not collide into the same payload preimage
  // in a way that lets one be swapped for the other undetected.
  expect(verify({ ...withoutWave, waveId: 'wave-1' })).toBe(false);
});

test('two check-ins differing only by merchantId get different signatures', () => {
  // The CPA payout case: same visit, different payee.
  expect(sign(base)).not.toBe(sign({ ...base, merchantId: 'merchant-2' }));
});

test('pseudonymize is stable, collision-distinct and never echoes the raw userId', () => {
  const ref = pseudonymize('user-1');
  expect(ref).toBe(pseudonymize('user-1'));
  expect(ref).not.toBe(pseudonymize('user-2'));
  expect(ref).not.toContain('user-1');
  expect(ref).toMatch(/^[0-9a-f]{16}$/);
});

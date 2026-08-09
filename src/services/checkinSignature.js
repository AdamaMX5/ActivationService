const crypto = require('crypto');
const env = require('../config/env');

function hmac(input) {
  return crypto.createHmac('sha256', env.CHECKIN_SIGNING_KEY).update(input).digest('hex');
}

// merchantId is part of the preimage because it, not locationId, decides who gets paid for a
// check-in: without it, repointing a stored check-in at another merchant would still verify.
//
// JSON-encoded rather than joined on a separator: a plain `join('|')` is ambiguous the moment
// any field could contain the separator itself, because {userId:'a|b', locationId:'c'} and
// {userId:'a', locationId:'b|c'} then collapse to the same preimage and share a signature.
// JSON escapes quotes and backslashes, so distinct field values always yield distinct strings —
// the guarantee no longer rests on an assumption about ID formats owned by other services.
function payload({ userId, locationId, merchantId, waveId, createdAt }) {
  return JSON.stringify([
    userId,
    locationId,
    merchantId,
    waveId || '',
    new Date(createdAt).toISOString(),
  ]);
}

function sign(checkin) {
  return hmac(payload(checkin));
}

/**
 * Recomputes the HMAC from the check-in's *current* stored fields — so any post-hoc edit to
 * userId/locationId/merchantId/waveId/createdAt in the database surfaces as `false`. This is
 * what makes billing data tamper-evident.
 */
function verify(checkin) {
  const expected = Buffer.from(sign(checkin));
  const stored = Buffer.from(String(checkin.signature || ''));
  if (expected.length !== stored.length) return false;
  return crypto.timingSafeEqual(expected, stored);
}

/**
 * Stable pseudonym for merchant-facing check-in lists — merchants get repeat-visitor analytics
 * without ever receiving a raw userId (GDPR data minimisation).
 */
function pseudonymize(userId) {
  return hmac(String(userId)).slice(0, 16);
}

module.exports = { sign, verify, pseudonymize };

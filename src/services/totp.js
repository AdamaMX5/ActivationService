const speakeasy = require('speakeasy');

const DIGITS = 8;

function generateSecret() {
  return speakeasy.generateSecret({ length: 20 }).base32;
}

function currentCode(secretBase32, step) {
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32', step, digits: DIGITS });
}

/** Seconds left in the current TOTP window — drives the QR display's refresh timing. */
function expiresInS(step) {
  return step - (Math.floor(Date.now() / 1000) % step);
}

/** window: 1 gives the ±1-step clock-drift tolerance ActivationService.md requires. */
function verifyCode(secretBase32, token, step) {
  if (typeof token !== 'string' || !/^\d+$/.test(token)) return false;
  return speakeasy.totp.verify({
    secret: secretBase32,
    encoding: 'base32',
    token,
    step,
    digits: DIGITS,
    window: 1,
  });
}

module.exports = { generateSecret, currentCode, expiresInS, verifyCode, DIGITS };

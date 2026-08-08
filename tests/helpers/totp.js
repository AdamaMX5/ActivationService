const speakeasy = require('speakeasy');

const DIGITS = 8;

/**
 * Computes a TOTP code for `secret` offset by `stepOffset` windows from now — 0 is the current
 * code, -2 is two steps in the past (outside the ±1 drift tolerance the service accepts).
 */
function codeAtOffset(secretBase32, step, stepOffset = 0) {
  return speakeasy.totp({
    secret: secretBase32,
    encoding: 'base32',
    step,
    digits: DIGITS,
    time: Math.floor(Date.now() / 1000) + stepOffset * step,
  });
}

module.exports = { codeAtOffset };

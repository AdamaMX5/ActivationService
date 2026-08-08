const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function key() {
  const buf = Buffer.from(env.SECRET_ENC_KEY, 'hex');
  if (buf.length !== 32) {
    throw new Error('SECRET_ENC_KEY must decode to exactly 32 bytes');
  }
  return buf;
}

/** Encrypts a TOTP secret for storage. Format: <ivB64>:<authTagB64>:<ciphertextB64>. */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Reverses `encrypt`. Throws if the payload was tampered with (GCM auth tag mismatch). */
function decrypt(payload) {
  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload');
  }
  const [ivB64, tagB64, ciphertextB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };

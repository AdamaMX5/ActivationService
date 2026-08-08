const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { setPublicKey } = require('../../src/services/authKey');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

setPublicKey(publicKey);

function signToken({ sub, email = 'user@example.com', roles = [] }) {
  return jwt.sign({ sub, email, roles, permissions: {} }, privateKey, {
    algorithm: 'RS256',
    expiresIn: '1h',
  });
}

function authHeader(opts) {
  return { Authorization: `Bearer ${signToken(opts)}` };
}

module.exports = { signToken, authHeader };

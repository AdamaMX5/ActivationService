/**
 * Akzeptanzkriterium 1 at the unit level: the ±1-step drift window is exactly ±1.
 * The clock is frozen so a step boundary can never roll between generating a code and
 * verifying it (which would otherwise make the −2/+2 cases flaky).
 */
const { generateSecret, currentCode, verifyCode, expiresInS, DIGITS } = require('../../src/services/totp');
const { codeAtOffset } = require('../helpers/totp');

const STEP = 60;
let secret;

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-08-08T12:00:30.000Z'),
    doNotFake: [
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
    ],
  });
  secret = generateSecret();
});

afterAll(() => {
  jest.useRealTimers();
});

test('generated secrets are base32 and codes are 8 digits', () => {
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  expect(DIGITS).toBe(8);
  expect(currentCode(secret, STEP)).toMatch(/^\d{8}$/);
});

test.each([-1, 0, 1])('a code %i step(s) from now is accepted', (offset) => {
  expect(verifyCode(secret, codeAtOffset(secret, STEP, offset), STEP)).toBe(true);
});

test.each([-2, 2, -5, 10])('a code %i step(s) from now is rejected', (offset) => {
  expect(verifyCode(secret, codeAtOffset(secret, STEP, offset), STEP)).toBe(false);
});

test('a code from a different secret is rejected', () => {
  expect(verifyCode(secret, currentCode(generateSecret(), STEP), STEP)).toBe(false);
});

test.each([['abcdefgh'], [''], ['1234 567'], ['-1234567']])(
  'non-numeric input %p is rejected without reaching speakeasy',
  (token) => {
    expect(verifyCode(secret, token, STEP)).toBe(false);
  }
);

test.each([[null], [undefined], [12345678], [{}]])('non-string input %p is rejected', (token) => {
  expect(verifyCode(secret, token, STEP)).toBe(false);
});

test('expiresInS counts down within the current step', () => {
  // Frozen at :00:30 — half a 60s step consumed, so 30s remain.
  expect(expiresInS(STEP)).toBe(30);
  expect(expiresInS(STEP)).toBeGreaterThan(0);
  expect(expiresInS(STEP)).toBeLessThanOrEqual(STEP);
});

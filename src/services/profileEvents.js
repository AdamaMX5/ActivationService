const axios = require('axios');
const env = require('../config/env');

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(payload) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await axios.post(`${env.PROFILE_SERVICE_URL}/internal/xp-events`, payload, {
        headers: { 'X-API-Key': env.PROFILE_SERVICE_API_KEY },
        timeout: 5000,
      });
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        // eslint-disable-next-line no-console
        console.error(`[profileEvents] giving up on checkin XP for ${payload.userId}: ${err.message}`);
        return;
      }
      await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/**
 * Fire-and-forget XP event for ProfileService. Intentionally not awaited by callers —
 * ProfileService being down must never block or fail a check-in.
 */
function fireXpEvent(userId, waveId) {
  const payload = { type: 'checkin', userId, ...(waveId ? { waveId } : {}) };
  postWithRetry(payload).catch(() => {});
}

module.exports = { fireXpEvent };

const axios = require('axios');
const env = require('../config/env');

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(waveId) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // Callers already validate the id's shape; encoding here too so this module stays safe
      // to call from any future code path that doesn't.
      await axios.post(
        `${env.WAVE_SERVICE_URL}/internal/waves/${encodeURIComponent(waveId)}/stats`,
        { field: 'checkins', delta: 1 },
        { headers: { 'X-API-Key': env.WAVE_SERVICE_API_KEY }, timeout: 5000 }
      );
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        // eslint-disable-next-line no-console
        console.error(`[waveStats] giving up on checkins increment for wave ${waveId}: ${err.message}`);
        return;
      }
      await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/** Fire-and-forget denormalized counter bump on WaveService; never blocks the check-in. */
function incrementCheckins(waveId) {
  postWithRetry(waveId).catch(() => {});
}

module.exports = { incrementCheckins };

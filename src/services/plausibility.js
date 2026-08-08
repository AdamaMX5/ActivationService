const { gridDistance } = require('h3-js');

/**
 * Classifies the client-reported cell against the location's own cell. Never throws and never
 * blocks a check-in: plausibility is a data point for fraud analysis, not an authorization
 * decision (the TOTP code is the actual proof of presence).
 */
function classify(locationH3Cell, clientH3) {
  if (!clientH3 || typeof clientH3 !== 'string') return 'unknown';
  if (!locationH3Cell) return 'unknown';
  try {
    return gridDistance(locationH3Cell, clientH3) <= 1 ? 'match' : 'mismatch';
  } catch (_err) {
    // Malformed cell, or one at an incompatible resolution — treat as a failed check, not unknown.
    return 'mismatch';
  }
}

module.exports = { classify };

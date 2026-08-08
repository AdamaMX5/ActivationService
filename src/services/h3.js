const { latLngToCell } = require('h3-js');

const RESOLUTION = 9;

/** Computes the serverside h3Cell for a location; returns undefined if lat/lng are absent. */
function computeH3Cell(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return undefined;
  return latLngToCell(lat, lng, RESOLUTION);
}

module.exports = { computeH3Cell, RESOLUTION };

/**
 * Akzeptanzkriterium 3 at the unit level: match / mismatch / unknown classification.
 * classify() must never throw — plausibility is a data point, never an authorization decision.
 */
const { latLngToCell, gridDisk, gridDistance } = require('h3-js');
const { classify } = require('../../src/services/plausibility');
const { RESOLUTION } = require('../../src/services/h3');

const locationCell = latLngToCell(52.52, 13.405, RESOLUTION);

/** A cell exactly `rings` grid steps away from `origin`. */
function cellAtDistance(origin, rings) {
  const cell = gridDisk(origin, rings).find((c) => gridDistance(origin, c) === rings);
  expect(cell).toBeDefined();
  return cell;
}

test('the location cell itself is a match', () => {
  expect(classify(locationCell, locationCell)).toBe('match');
});

test('a directly adjacent cell (1 ring) is still a match', () => {
  expect(classify(locationCell, cellAtDistance(locationCell, 1))).toBe('match');
});

test.each([2, 3, 5])('a cell %i rings away is a mismatch', (rings) => {
  expect(classify(locationCell, cellAtDistance(locationCell, rings))).toBe('mismatch');
});

test.each([[null], [undefined], [''], [123], [{}]])(
  'a missing or non-string client cell (%p) is unknown',
  (clientH3) => {
    expect(classify(locationCell, clientH3)).toBe('unknown');
  }
);

test('a location without its own cell is unknown', () => {
  expect(classify(null, locationCell)).toBe('unknown');
});

test('a malformed client cell is a mismatch, not a crash', () => {
  expect(() => classify(locationCell, 'not-an-h3-cell')).not.toThrow();
  expect(classify(locationCell, 'not-an-h3-cell')).toBe('mismatch');
});

test('a cell at a different resolution is a mismatch, not a crash', () => {
  const coarse = latLngToCell(52.52, 13.405, 5);
  expect(classify(locationCell, coarse)).toBe('mismatch');
});

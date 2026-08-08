const { HttpError } = require('../middleware/errorHandler');

const CREATABLE_FIELDS = ['name', 'lat', 'lng'];
const PATCHABLE_FIELDS = ['name', 'active', 'codeStepS'];

function validateName(name) {
  if (!name || typeof name !== 'string' || name.length > 200) {
    throw new HttpError(400, 'name is required and must be at most 200 characters');
  }
}

function validateCodeStepS(codeStepS) {
  if (!Number.isInteger(codeStepS) || codeStepS < 15 || codeStepS > 300) {
    throw new HttpError(400, 'codeStepS must be an integer between 15 and 300');
  }
}

/** Validates + normalizes the body for POST /locations. Throws HttpError(400) on violation. */
function validateLocationCreate(body) {
  const unknown = Object.keys(body).filter((k) => !CREATABLE_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new HttpError(400, `Unknown/forbidden fields: ${unknown.join(', ')}`);
  }

  const { name, lat, lng } = body;
  validateName(name);
  if (typeof lat !== 'number' || lat < -90 || lat > 90) {
    throw new HttpError(400, 'lat must be a number between -90 and 90');
  }
  if (typeof lng !== 'number' || lng < -180 || lng > 180) {
    throw new HttpError(400, 'lng must be a number between -180 and 180');
  }

  return { name, lat, lng };
}

/** Validates + normalizes the body for PATCH /locations/:id. */
function validateLocationPatch(body) {
  const unknown = Object.keys(body).filter((k) => !PATCHABLE_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new HttpError(400, `Unknown/forbidden fields: ${unknown.join(', ')}`);
  }

  const update = {};
  if (body.name !== undefined) {
    validateName(body.name);
    update.name = body.name;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
    update.active = body.active;
  }
  if (body.codeStepS !== undefined) {
    validateCodeStepS(body.codeStepS);
    update.codeStepS = body.codeStepS;
  }

  return update;
}

module.exports = { validateLocationCreate, validateLocationPatch };

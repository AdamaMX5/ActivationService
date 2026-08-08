const express = require('express');
const Location = require('../models/Location');
const { Checkin } = require('../models/Checkin');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../middleware/errorHandler');
const { validateLocationCreate, validateLocationPatch } = require('../services/locationValidation');
const { computeH3Cell } = require('../services/h3');
const { encrypt, decrypt } = require('../services/secretCipher');
const { generateSecret, currentCode, expiresInS } = require('../services/totp');
const { pseudonymize } = require('../services/checkinSignature');
const { parsePagination } = require('../utils/pagination');

const router = express.Router();

const MERCHANT_ROLES = ['merchant', 'organizer'];

/**
 * ActivationService.md specifies "nur eigene Locations, sonst 403" — so a foreign location is
 * a 403, not WaveService's 404-masking. A location's existence is not itself a secret here;
 * the TOTP secret behind it is what's protected.
 *
 * There is deliberately no admin override: these routes hand out live check-in codes, and an
 * admin with no stake in the location has no reason to mint proof of presence at someone
 * else's counter. Admin oversight lives on /admin/* instead.
 */
async function loadOwnLocation(req, { withSecret = false } = {}) {
  const location = await Location.findByIdSafe(req.params.id, { withSecret });
  if (!location) throw new HttpError(404, 'Location not found');
  if (location.merchantId !== req.user.id) {
    throw new HttpError(403, 'Not your location');
  }
  return location;
}

router.use('/locations', requireAuth, requireRoles(...MERCHANT_ROLES));

router.post(
  '/locations',
  asyncHandler(async (req, res) => {
    const { name, lat, lng } = validateLocationCreate(req.body || {});
    const location = await Location.create({
      merchantId: req.user.id,
      name,
      lat,
      lng,
      h3Cell: computeH3Cell(lat, lng),
      totpSecret: encrypt(generateSecret()),
    });
    res.status(201).json(location);
  })
);

router.get(
  '/locations',
  asyncHandler(async (req, res) => {
    const locations = await Location.find({ merchantId: req.user.id }).sort({ createdAt: -1 });
    res.json({ items: locations });
  })
);

router.patch(
  '/locations/:id',
  asyncHandler(async (req, res) => {
    const location = await loadOwnLocation(req);
    Object.assign(location, validateLocationPatch(req.body || {}));
    await location.save();
    res.json(location);
  })
);

router.post(
  '/locations/:id/rotate-secret',
  asyncHandler(async (req, res) => {
    const location = await loadOwnLocation(req);
    location.totpSecret = encrypt(generateSecret());
    await location.save();
    res.json(location);
  })
);

router.get(
  '/locations/:id/code',
  asyncHandler(async (req, res) => {
    const location = await loadOwnLocation(req, { withSecret: true });
    if (!location.active) throw new HttpError(404, 'Location not found');

    const step = location.codeStepS;
    res.set('Cache-Control', 'no-store');
    res.json({ code: currentCode(decrypt(location.totpSecret), step), expiresInS: expiresInS(step) });
  })
);

router.get(
  '/locations/:id/checkins',
  asyncHandler(async (req, res) => {
    const location = await loadOwnLocation(req);
    const { page, limit, skip } = parsePagination(req.query);

    const filter = { locationId: location.id };
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) {
        const from = new Date(req.query.from);
        if (Number.isNaN(from.getTime())) throw new HttpError(400, 'from must be a valid date');
        filter.createdAt.$gte = from;
      }
      if (req.query.to) {
        const to = new Date(req.query.to);
        if (Number.isNaN(to.getTime())) throw new HttpError(400, 'to must be a valid date');
        filter.createdAt.$lte = to;
      }
    }

    const [checkins, total] = await Promise.all([
      Checkin.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Checkin.countDocuments(filter),
    ]);

    // Merchants get a stable pseudonym instead of the raw userId (GDPR data minimisation) —
    // enough for repeat-visitor analytics, not enough to identify the person.
    const items = checkins.map((c) => ({
      id: c.id,
      userRef: pseudonymize(c.userId),
      waveId: c.waveId,
      plausibility: c.plausibility,
      createdAt: c.createdAt,
    }));

    res.json({ items, page, limit, total });
  })
);

module.exports = router;

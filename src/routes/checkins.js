const express = require('express');
const Location = require('../models/Location');
const { Checkin } = require('../models/Checkin');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../middleware/errorHandler');
const { decrypt } = require('../services/secretCipher');
const { verifyCode } = require('../services/totp');
const { classify } = require('../services/plausibility');
const { sign } = require('../services/checkinSignature');
const { reserveCheckinSlot, rollback } = require('../services/rateLimiter');
const { fireXpEvent } = require('../services/profileEvents');
const { incrementCheckins } = require('../services/waveStats');
const { parsePagination } = require('../utils/pagination');

const router = express.Router();

// WaveService wave ids are Mongo ObjectIds. Pinning the shape here keeps a caller-supplied
// waveId from being interpolated as path segments into the WaveService URL waveStats.js builds.
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function validateCheckinBody(body) {
  const { locationId, code, h3, waveId } = body;
  if (!locationId || typeof locationId !== 'string') {
    throw new HttpError(400, 'locationId is required');
  }
  if (!code || typeof code !== 'string') {
    throw new HttpError(400, 'code is required');
  }
  if (h3 !== undefined && h3 !== null && typeof h3 !== 'string') {
    throw new HttpError(400, 'h3 must be a string');
  }
  if (waveId !== undefined && waveId !== null && (typeof waveId !== 'string' || !OBJECT_ID_RE.test(waveId))) {
    throw new HttpError(400, 'waveId must be a 24-character hex id');
  }
  return { locationId, code, h3: h3 || null, waveId: waveId || null };
}

router.post(
  '/checkins',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { locationId, code, h3, waveId } = validateCheckinBody(req.body || {});

    const location = await Location.findByIdSafe(locationId, { withSecret: true });
    if (!location || !location.active) throw new HttpError(404, 'Location not found');

    if (!verifyCode(decrypt(location.totpSecret), code, location.codeStepS)) {
      throw new HttpError(403, 'Invalid or expired code');
    }

    const reservation = await reserveCheckinSlot(req.user.id, location.id);
    if (!reservation.ok) throw new HttpError(reservation.statusCode, reservation.message);

    const createdAt = new Date();
    const fields = {
      userId: req.user.id,
      locationId: location.id,
      merchantId: location.merchantId,
      waveId,
      createdAt,
    };

    let checkin;
    try {
      checkin = await Checkin.create({
        ...fields,
        clientH3: h3,
        plausibility: classify(location.h3Cell, h3),
        signature: sign(fields),
      });
    } catch (err) {
      await rollback(req.user.id, location.id);
      throw err;
    }

    fireXpEvent(req.user.id, waveId);
    if (waveId) incrementCheckins(waveId);

    res.status(201).json({
      id: checkin.id,
      plausibility: checkin.plausibility,
      createdAt: checkin.createdAt,
    });
  })
);

router.get(
  '/me/checkins',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { userId: req.user.id };

    const [items, total] = await Promise.all([
      // `signature` and `merchantId` are billing-side data: the signature is the tamper-evidence
      // for CPA settlement (handing it to the signed-over party invites offline forgery attempts)
      // and merchantId is not the consumer's business. Both stay on /internal/checkins.
      Checkin.find(filter)
        .select('locationId waveId clientH3 plausibility createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Checkin.countDocuments(filter),
    ]);

    res.json({ items, page, limit, total });
  })
);

module.exports = router;

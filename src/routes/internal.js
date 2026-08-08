const express = require('express');
const { Checkin } = require('../models/Checkin');
const { requireApiKey } = require('../middleware/apiKey');
const { asyncHandler, HttpError } = require('../middleware/errorHandler');
const { verify } = require('../services/checkinSignature');
const { parsePagination } = require('../utils/pagination');

const router = express.Router();

router.get(
  '/internal/checkins',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};

    for (const field of ['merchantId', 'waveId']) {
      if (req.query[field] !== undefined) {
        if (typeof req.query[field] !== 'string') {
          throw new HttpError(400, `${field} must be a string`);
        }
        filter[field] = req.query[field];
      }
    }

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

    const [items, total] = await Promise.all([
      Checkin.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Checkin.countDocuments(filter),
    ]);

    res.json({ items, page, limit, total });
  })
);

router.post(
  '/internal/verify-signature',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { checkinId } = req.body || {};
    if (!checkinId || typeof checkinId !== 'string') {
      throw new HttpError(400, 'checkinId is required');
    }

    let checkin;
    try {
      checkin = await Checkin.findById(checkinId);
    } catch (err) {
      if (err.name !== 'CastError') throw err;
    }
    if (!checkin) throw new HttpError(404, 'Checkin not found');

    res.json({ valid: verify(checkin) });
  })
);

module.exports = router;

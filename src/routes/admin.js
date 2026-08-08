const express = require('express');
const { Checkin } = require('../models/Checkin');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { DAILY_USER_CAP } = require('../services/rateLimiter');
const { pseudonymize } = require('../services/checkinSignature');
const env = require('../config/env');

const router = express.Router();

const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

router.get(
  '/admin/fraud-report',
  requireAuth,
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - REPORT_WINDOW_MS);
    const match = { createdAt: { $gte: since } };

    const [hourlyCapBreaches, dailyCapUsers, mismatchRates] = await Promise.all([
      Checkin.aggregate([
        { $match: match },
        {
          $group: {
            _id: { locationId: '$locationId', hour: { $dateTrunc: { date: '$createdAt', unit: 'hour' } } },
            count: { $sum: 1 },
          },
        },
        // $gte, not $gt: reserveCheckinSlot rolls back the increment that would exceed the cap,
        // so a location can only ever reach LOCATION_HOURLY_CAP, never pass it. Reaching it is
        // the observable breach signal — with $gt this report could never fire at all.
        { $match: { count: { $gte: env.LOCATION_HOURLY_CAP } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, locationId: '$_id.locationId', hour: '$_id.hour', count: 1 } },
      ]),
      Checkin.aggregate([
        { $match: match },
        {
          $group: {
            _id: { userId: '$userId', day: { $dateTrunc: { date: '$createdAt', unit: 'day' } } },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gte: DAILY_USER_CAP } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, userId: '$_id.userId', day: '$_id.day', count: 1 } },
      ]),
      Checkin.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$locationId',
            total: { $sum: 1 },
            mismatches: { $sum: { $cond: [{ $eq: ['$plausibility', 'mismatch'] }, 1, 0] } },
          },
        },
        { $match: { mismatches: { $gt: 0 } } },
        {
          $project: {
            _id: 0,
            locationId: '$_id',
            total: 1,
            mismatches: 1,
            mismatchRate: { $divide: ['$mismatches', '$total'] },
          },
        },
        { $sort: { mismatchRate: -1 } },
      ]),
    ]);

    res.json({
      windowFrom: since,
      hourlyCap: env.LOCATION_HOURLY_CAP,
      dailyUserCap: DAILY_USER_CAP,
      hourlyCapBreaches,
      // Pseudonymised for the same reason merchant-facing lists are: a fraud report needs to
      // show that *someone* is farming check-ins, not who they are.
      dailyCapUsers: dailyCapUsers.map(({ userId, ...rest }) => ({ userRef: pseudonymize(userId), ...rest })),
      mismatchRates,
    });
  })
);

module.exports = router;

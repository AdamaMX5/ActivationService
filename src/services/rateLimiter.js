const redis = require('../redis/client');
const env = require('../config/env');
const { reportException } = require('./exceptionReporter');

const DAILY_USER_CAP = 20;

const cooldownKey = (userId, locationId) => `checkin:cooldown:${userId}:${locationId}`;
const dailyKey = (userId, day) => `checkin:daily:${userId}:${day}`;
const hourlyKey = (locationId, hour) => `checkin:hourly:${locationId}:${hour}`;

/** `YYYY-MM-DD` in UTC — the bucket the per-user daily cap counts against. */
function dayBucket(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH` in UTC — the bucket the per-location hourly cap counts against. */
function hourBucket(now = new Date()) {
  return now.toISOString().slice(0, 13);
}

async function incrWithTtl(key, ttlSeconds) {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ttlSeconds);
  return count;
}

/**
 * Atomically reserves the three rate-limit budgets a check-in consumes. Each step rolls back
 * the ones before it on failure, so a rejected check-in never burns a user's cooldown or
 * counts against a location's hourly cap.
 */
async function reserveCheckinSlot(userId, locationId) {
  const cooldown = cooldownKey(userId, locationId);
  const daily = dailyKey(userId, dayBucket());
  const hourly = hourlyKey(locationId, hourBucket());

  const acquired = await redis.set(cooldown, '1', 'EX', env.CHECKIN_COOLDOWN_H * 3600, 'NX');
  if (acquired !== 'OK') {
    return { ok: false, statusCode: 429, message: 'Cooldown active for this location' };
  }

  const dailyCount = await incrWithTtl(daily, 86400);
  if (dailyCount > DAILY_USER_CAP) {
    await redis.decr(daily);
    await redis.del(cooldown);
    return { ok: false, statusCode: 429, message: 'Daily check-in limit reached' };
  }

  const hourlyCount = await incrWithTtl(hourly, 3600);
  if (hourlyCount > env.LOCATION_HOURLY_CAP) {
    await redis.decr(hourly);
    await redis.decr(daily);
    await redis.del(cooldown);
    // Fraud signal: a location past its hourly cap usually means the QR code is being
    // redistributed off-site (e.g. forwarded into a Telegram group).
    reportException({
      message: 'Location hourly check-in cap exceeded',
      statusCode: 429,
      metadata: { locationId, cap: env.LOCATION_HOURLY_CAP },
    });
    return { ok: false, statusCode: 429, message: 'Location hourly cap exceeded' };
  }

  return { ok: true };
}

/** Releases a reservation whose check-in ultimately failed to persist. */
async function rollback(userId, locationId) {
  await Promise.all([
    redis.del(cooldownKey(userId, locationId)),
    redis.decr(dailyKey(userId, dayBucket())),
    redis.decr(hourlyKey(locationId, hourBucket())),
  ]);
}

module.exports = { reserveCheckinSlot, rollback, DAILY_USER_CAP };

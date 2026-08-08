const mongoose = require('mongoose');
const serialize = require('./plugins/serialize');

const PLAUSIBILITY = ['match', 'mismatch', 'unknown'];

const checkinSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    locationId: { type: String, required: true, index: true },
    merchantId: { type: String, required: true, index: true },
    waveId: { type: String, default: null, index: true },
    clientH3: { type: String, default: null },
    plausibility: { type: String, required: true, enum: PLAUSIBILITY },
    signature: { type: String, required: true },
    // Declared manually rather than via `timestamps` because the signature is computed over
    // this exact value before insert — the timestamps plugin would overwrite it on save and
    // every stored check-in would verify as tampered. Check-ins are immutable billing
    // evidence, so there is no updatedAt to track either.
    createdAt: { type: Date, required: true, default: Date.now },
  }
);

checkinSchema.index({ locationId: 1, createdAt: -1 });
checkinSchema.index({ userId: 1, createdAt: -1 });

serialize(checkinSchema);

module.exports = { Checkin: mongoose.model('Checkin', checkinSchema) };

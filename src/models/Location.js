const mongoose = require('mongoose');
const serialize = require('./plugins/serialize');

const locationSchema = new mongoose.Schema(
  {
    merchantId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    h3Cell: { type: String },
    // select: false keeps the encrypted secret out of every query that doesn't explicitly ask
    // for it, so no route can leak it by accident; the toJSON transform below is the second
    // layer for the one route that does load it.
    totpSecret: { type: String, required: true, select: false },
    codeStepS: { type: Number, default: 60, min: 15, max: 300 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

serialize(locationSchema);

// Composed after serialize() so it also runs on the code-generation path, where the secret is
// explicitly selected. The TOTP secret must never reach an API response or a log line.
const baseTransform = locationSchema.get('toJSON').transform;
locationSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret, options) => {
    const out = baseTransform(doc, ret, options);
    delete out.totpSecret;
    return out;
  },
});

/** Like findById, but an invalid ObjectId format resolves to null instead of throwing. */
locationSchema.statics.findByIdSafe = async function findByIdSafe(id, { withSecret = false } = {}) {
  try {
    const query = this.findById(id);
    if (withSecret) query.select('+totpSecret');
    return await query;
  } catch (err) {
    if (err.name === 'CastError') return null;
    throw err;
  }
};

module.exports = mongoose.model('Location', locationSchema);

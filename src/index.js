require('dotenv').config();

const mongoose = require('mongoose');
const { createApp } = require('./app');
const env = require('./config/env');
const redis = require('./redis/client');
const { loadPublicKey } = require('./services/authKey');

async function main() {
  await loadPublicKey();
  await mongoose.connect(env.MONGODB_URI);
  await redis.connect();

  const app = createApp();
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`ActivationService listening on port ${env.PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('ActivationService failed to start:', err);
  process.exit(1);
});

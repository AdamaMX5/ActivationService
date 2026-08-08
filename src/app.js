const express = require('express');
const locationsRouter = require('./routes/locations');
const checkinsRouter = require('./routes/checkins');
const internalRouter = require('./routes/internal');
const adminRouter = require('./routes/admin');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ActivationService' }));

  app.use(locationsRouter);
  app.use(checkinsRouter);
  app.use(internalRouter);
  app.use(adminRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

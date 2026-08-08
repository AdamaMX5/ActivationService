const { reportException } = require('../services/exceptionReporter');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;

  if (statusCode >= 500) {
    reportException({
      message: err.message,
      stack: err.stack,
      statusCode,
      method: req.method,
      path: req.originalUrl,
    });
  }

  const publicMessage =
    statusCode >= 500 ? 'Internal server error' : err.publicMessage || err.message || 'Request failed';
  res.status(statusCode).json({ error: publicMessage });
}

class HttpError extends Error {
  constructor(statusCode, message, publicMessage) {
    super(message);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage || message;
  }
}

module.exports = { asyncHandler, errorHandler, HttpError };

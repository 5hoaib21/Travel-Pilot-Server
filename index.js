require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');
const { connectToDatabase, getDb } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 8008;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait.', code: 'RATE_LIMITED' },
});

app.use('/api/trips/generate', aiLimiter);
app.use('/api/trips/:id/regenerate', aiLimiter);
app.use('/api/trips/:id/regenerate-day', aiLimiter);
app.use('/api/trips/:id/copilot', aiLimiter);

app.get('/api/health', async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  logger.error(err.message, { method: req.method, path: req.path, stack: err.stack });
  res.status(status).json({
    error: status === 500 ? 'An unexpected error occurred' : err.message,
    code,
    ...(process.env.NODE_ENV === 'development' && { details: err.stack }),
  });
});

async function start() {
  try {
    await connectToDatabase();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();

module.exports = app;

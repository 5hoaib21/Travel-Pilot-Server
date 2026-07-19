require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');
const { connectToDatabase, getDb } = require('./lib/db');
const { generateContent, DEFAULT_MODEL } = require('./lib/gemini');

const AIErrorTypes = {
  AI_PARSE_ERROR: 'AI_PARSE_ERROR',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_SAFETY_BLOCK: 'AI_SAFETY_BLOCK',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
};

class AIError extends Error {
  constructor(type, message, details = null) {
    super(message);
    this.name = 'AIError';
    this.type = type;
    this.code = type;
    this.details = details;
  }
}

async function logAICall({ userId, tripId, featureType, prompt, response, model, responseTimeMs, success, errorMessage }) {
  try {
    const db = await getDb();
    await db.collection('ai_generations').insertOne({
      userId,
      tripId,
      featureType,
      prompt,
      response,
      model,
      responseTimeMs,
      success,
      errorMessage,
      createdAt: new Date(),
    });
  } catch (err) {
    logger.error('Failed to log AI call', { error: err.message });
  }
}

function buildAgentContext(preferences, enrichedDestination = null, days = null, budgetBreakdown = null, tips = null, review = null) {
  return {
    preferences,
    enrichedDestination,
    days,
    budgetBreakdown,
    tips,
    review,
  };
}

function extractJSON(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new AIError(AIErrorTypes.AI_PARSE_ERROR, 'No JSON object found in AI response', { text });
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new AIError(AIErrorTypes.AI_PARSE_ERROR, `Failed to parse AI response: ${err.message}`, { text: jsonMatch[0] });
  }
}

async function callWithRetry(prompt, validateFn, options = {}) {
  const { maxRetries = 2, modelName = DEFAULT_MODEL, userId = null, tripId = null, featureType = 'unknown' } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const result = await generateContent(prompt, { modelName });
      const parsed = extractJSON(result.text);
      const responseTimeMs = Date.now() - start;

      if (validateFn) {
        const validation = validateFn(parsed);
        if (!validation.valid) {
          throw new AIError(AIErrorTypes.AI_PARSE_ERROR, validation.error, { parsed });
        }
      }

      await logAICall({
        userId,
        tripId,
        featureType,
        prompt,
        response: result.text,
        model: result.model,
        responseTimeMs,
        success: true,
      });

      return parsed;
    } catch (err) {
      const responseTimeMs = Date.now() - start;

      if (err instanceof AIError && err.type === AIErrorTypes.AI_PARSE_ERROR) {
        lastError = err;
        logger.warn(`AI parse error on attempt ${attempt + 1}/${maxRetries + 1}`, { error: err.message, featureType });

        await logAICall({
          userId,
          tripId,
          featureType,
          prompt: attempt < maxRetries ? `${prompt}\n\nPrevious error: ${err.message}. Please ensure the response is valid JSON only.` : prompt,
          response: err.details?.text || null,
          model: modelName,
          responseTimeMs,
          success: false,
          errorMessage: err.message,
        });

        if (attempt < maxRetries) {
          prompt = `${prompt}\n\nPrevious error: ${err.message}. Please ensure the response is valid JSON only.`;
        }
        continue;
      }

      if (err.isTimeout) {
        await logAICall({ userId, tripId, featureType, prompt, response: null, model: modelName, responseTimeMs, success: false, errorMessage: 'AI_TIMEOUT' });
        throw new AIError(AIErrorTypes.AI_TIMEOUT, 'AI request timed out', { model: modelName });
      }
      if (err.isSafety) {
        await logAICall({ userId, tripId, featureType, prompt, response: null, model: modelName, responseTimeMs, success: false, errorMessage: 'AI_SAFETY_BLOCK' });
        throw new AIError(AIErrorTypes.AI_SAFETY_BLOCK, 'AI request blocked by safety filters');
      }
      if (err.isRateLimit) {
        await logAICall({ userId, tripId, featureType, prompt, response: null, model: modelName, responseTimeMs, success: false, errorMessage: 'AI_RATE_LIMIT' });
        throw new AIError(AIErrorTypes.AI_RATE_LIMIT, 'AI rate limit exceeded');
      }

      logger.error(`Unexpected AI error on attempt ${attempt + 1}`, { error: err.message, featureType });
      lastError = err;
    }
  }

  throw lastError || new AIError(AIErrorTypes.AI_PARSE_ERROR, 'All retries exhausted');
}

const { ENRICH_DESTINATION } = require('./prompts');

async function enrichDestination(rawDestination, userId = null) {
  if (!rawDestination || typeof rawDestination !== 'string' || rawDestination.trim().length < 1) {
    throw new AIError(AIErrorTypes.AI_PARSE_ERROR, 'Destination must be a non-empty string');
  }

  const prompt = ENRICH_DESTINATION(rawDestination.trim());
  const result = await callWithRetry(
    prompt,
    (parsed) => {
      if (!parsed || typeof parsed.found === 'undefined') {
        return { valid: false, error: 'Response missing "found" field' };
      }
      if (parsed.found === true) {
        if (!parsed.destination || !parsed.destination.fullName) {
          return { valid: false, error: 'Response marked found but missing destination.fullName' };
        }
        if (!parsed.destination.continent) {
          return { valid: false, error: 'Destination missing continent' };
        }
        if (!parsed.destination.currency) {
          return { valid: false, error: 'Destination missing currency' };
        }
      }
      return { valid: true };
    },
    { maxRetries: 2, userId, featureType: 'enrich_destination' }
  );

  if (!result.found) {
    throw new AIError(AIErrorTypes.AI_PARSE_ERROR, result.message || 'Destination not recognized', { input: rawDestination });
  }

  return result.destination;
}

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

module.exports = {
  app,
  enrichDestination,
  callWithRetry,
  buildAgentContext,
  AIError,
  AIErrorTypes,
  logAICall,
};

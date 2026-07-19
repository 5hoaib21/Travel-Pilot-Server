require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');
const { connectToDatabase, getDb } = require('./lib/db');
const { ObjectId } = require('mongodb');
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

const { ENRICH_DESTINATION, PLANNER, BUDGETER, CURATOR, REVIEWER, AUTOSUGGEST } = require('./prompts');

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

async function plannerAgent(context, userId = null, tripId = null) {
  const budget = context.preferences.budget;
  const duration = context.preferences.duration;

  function validateDays(parsed) {
    if (!parsed.days || !Array.isArray(parsed.days) || parsed.days.length !== duration) {
      return { valid: false, error: `Expected ${duration} days, got ${parsed.days?.length || 0}` };
    }

    for (let i = 0; i < parsed.days.length; i++) {
      const day = parsed.days[i];
      if (!day.morning || !day.afternoon || !day.evening) {
        return { valid: false, error: `Day ${day.dayNumber || i + 1} missing time slot activities`, day: day.dayNumber || i + 1 };
      }
      if (!day.accommodation || !day.accommodation.name) {
        return { valid: false, error: `Day ${day.dayNumber || i + 1} missing accommodation`, day: day.dayNumber || i + 1 };
      }
      const slots = ['morning', 'afternoon', 'evening'];
      for (const slot of slots) {
        const activity = day[slot];
        if (activity && !['attraction', 'meal', 'transport', 'rest'].includes(activity.category)) {
          return { valid: false, error: `Day ${day.dayNumber || i + 1} ${slot} has invalid category: ${activity.category}`, day: day.dayNumber || i + 1 };
        }
      }
    }

    const totalAccommodationCost = parsed.days.reduce((sum, d) => {
      const cost = parseFloat(d.accommodation?.costPerNight) || 0;
      return sum + cost;
    }, 0);

    if (totalAccommodationCost > budget * 0.5) {
      return { valid: false, error: `Accommodation costs (${totalAccommodationCost}) exceed 50% of budget (${budget})` };
    }

    return { valid: true };
  }

  const prompt = PLANNER(context);
  const result = await callWithRetry(
    prompt,
    validateDays,
    { maxRetries: 2, userId, tripId, featureType: 'planner' }
  );

  const orderedDays = result.days
    .sort((a, b) => (a.dayNumber || 0) - (b.dayNumber || 0))
    .map((day, idx) => ({ ...day, dayNumber: idx + 1 }));

  return orderedDays;
}

async function budgeterAgent(context, userId = null, tripId = null) {
  const budget = context.preferences.budget;

  function validateBudget(parsed) {
    if (!parsed.budgetBreakdown || !Array.isArray(parsed.budgetBreakdown)) {
      return { valid: false, error: 'Missing budgetBreakdown array' };
    }

    const requiredCategories = ['Accommodation', 'Food', 'Activities', 'Transport', 'Miscellaneous'];
    const categories = parsed.budgetBreakdown.map((b) => b.category);
    for (const cat of requiredCategories) {
      if (!categories.includes(cat)) {
        return { valid: false, error: `Missing category: ${cat}` };
      }
    }

    for (const item of parsed.budgetBreakdown) {
      if (item.amount == null || item.percentage == null) {
        return { valid: false, error: `Category ${item.category} missing amount or percentage` };
      }
      if (typeof item.amount !== 'number' || typeof item.percentage !== 'number') {
        return { valid: false, error: `Category ${item.category} has non-numeric amount or percentage` };
      }
    }

    const totalPercentage = Math.round(parsed.budgetBreakdown.reduce((sum, b) => sum + b.percentage, 0));
    if (totalPercentage < 99 || totalPercentage > 101) {
      return { valid: false, error: `Percentages sum to ${totalPercentage}%, expected ~100%` };
    }

    const totalAmount = parsed.budgetBreakdown.reduce((sum, b) => sum + b.amount, 0);
    if (totalAmount > budget * 1.05) {
      return { valid: false, error: `Total budget (${totalAmount}) exceeds trip budget (${budget}) by more than 5%` };
    }

    return { valid: true };
  }

  const prompt = BUDGETER(context);
  const result = await callWithRetry(
    prompt,
    validateBudget,
    { maxRetries: 2, userId, tripId, featureType: 'budgeter' }
  );

  return result.budgetBreakdown;
}

async function curatorAgent(context, userId = null, tripId = null) {
  function validateTips(parsed) {
    if (!parsed.tips || !Array.isArray(parsed.tips)) {
      return { valid: false, error: 'Missing tips array' };
    }
    if (parsed.tips.length < 5 || parsed.tips.length > 8) {
      return { valid: false, error: `Expected 5-8 tips, got ${parsed.tips.length}` };
    }

    const requiredCategories = ['Weather', 'Culture', 'Safety', 'Packing', 'Currency', 'Language'];
    const categories = parsed.tips.map((t) => t.category);
    for (const cat of requiredCategories) {
      if (!categories.includes(cat)) {
        return { valid: false, error: `Missing tip category: ${cat}` };
      }
    }

    for (const tip of parsed.tips) {
      if (!tip.category || !tip.content || tip.priority == null) {
        return { valid: false, error: `Tip missing required field(s): category, content, or priority` };
      }
      if (tip.priority < 1 || tip.priority > 5) {
        return { valid: false, error: `Tip priority ${tip.priority} out of range (1-5)` };
      }
    }

    return { valid: true };
  }

  const prompt = CURATOR(context);
  const result = await callWithRetry(
    prompt,
    validateTips,
    { maxRetries: 2, userId, tripId, featureType: 'curator' }
  );

  return result.tips;
}

async function reviewerAgent(context, userId = null, tripId = null) {
  const fixes = [];

  function validateReview(parsed) {
    if (!parsed.review) {
      return { valid: false, error: 'Missing review object' };
    }
    if (typeof parsed.review.passed !== 'boolean') {
      return { valid: false, error: 'Review missing passed boolean' };
    }
    if (!Array.isArray(parsed.review.issues)) {
      return { valid: false, error: 'Review missing issues array' };
    }
    if (!Array.isArray(parsed.review.warnings)) {
      return { valid: false, error: 'Review missing warnings array' };
    }
    return { valid: true };
  }

  const prompt = REVIEWER(context);
  let result;

  try {
    result = await callWithRetry(
      prompt,
      validateReview,
      { maxRetries: 1, userId, tripId, featureType: 'reviewer' }
    );
  } catch (err) {
    result = { review: { passed: false, issues: [err.message], warnings: [] } };
  }

  let fixedContext = { ...context };

  if (!result.review.passed) {
    logger.warn('Reviewer found issues, applying auto-fix', { issues: result.review.issues });

    const bb = fixedContext.budgetBreakdown;
    if (bb && Array.isArray(bb)) {
      const totalPercent = bb.reduce((s, b) => s + (b.percentage || 0), 0);
      if (totalPercent !== 100) {
        const factor = 100 / totalPercent;
        for (const item of bb) {
          item.percentage = Math.round(item.percentage * factor);
          item.amount = Math.round(item.amount * factor);
        }
        const remainder = 100 - bb.reduce((s, b) => s + b.percentage, 0);
        if (remainder !== 0) {
          const misc = bb.find((b) => b.category === 'Miscellaneous');
          if (misc) misc.percentage += remainder;
        }
        fixes.push(`Clamped budget percentages from ${totalPercent}% to 100%`);
      }
    }

    const budget = context.preferences?.budget;
    if (budget && bb && Array.isArray(bb)) {
      const totalAmount = bb.reduce((s, b) => s + (b.amount || 0), 0);
      if (totalAmount > budget) {
        const factor = budget / totalAmount;
        for (const item of bb) {
          item.amount = Math.round(item.amount * factor);
        }
        fixes.push(`Proportionally reduced budget amounts from ${totalAmount} to ${budget}`);
      }
    }

    fixedContext.review = {
      passed: fixes.length === 0,
      issues: result.review.issues,
      warnings: result.review.warnings,
      fixes,
    };
  } else {
    fixedContext.review = result.review;
  }

  return fixedContext;
}

async function generateTrip(preferences, userId = null) {
  const tripId = null;

  const enriched = await enrichDestination(preferences.destination, userId);
  let context = buildAgentContext(preferences, enriched);

  context.days = await plannerAgent(context, userId, tripId);
  context.budgetBreakdown = await budgeterAgent(context, userId, tripId);
  context.tips = await curatorAgent(context, userId, tripId);
  context = await reviewerAgent(context, userId, tripId);

  const tripDoc = {
    userId,
    destination: enriched.fullName,
    title: `${enriched.fullName} Adventure`,
    budget: preferences.budget,
    currency: preferences.currency,
    duration: preferences.duration,
    travelStyle: preferences.travelStyle,
    interests: preferences.interests,
    companion: preferences.companion,
    additionalNotes: preferences.additionalNotes || null,
    days: context.days,
    budgetBreakdown: context.budgetBreakdown,
    tips: context.tips,
    review: context.review || null,
    status: 'completed',
    enrichedDestination: enriched,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const db = await getDb();
  const result = await db.collection('trips').insertOne(tripDoc);
  tripDoc._id = result.insertedId;

  return tripDoc;
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
app.use('/api/trips/autosuggest', aiLimiter);
app.use('/api/trips/:id/regenerate', aiLimiter);
app.use('/api/trips/:id/regenerate-day', aiLimiter);
app.use('/api/trips/:id/copilot', aiLimiter);

app.post('/api/trips/generate', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const prefs = req.body;

    if (!prefs.destination || typeof prefs.destination !== 'string') {
      return res.status(400).json({ error: 'Destination is required', code: 'VALIDATION_ERROR' });
    }
    if (!prefs.budget || typeof prefs.budget !== 'number' || prefs.budget <= 0) {
      return res.status(400).json({ error: 'Valid budget is required', code: 'VALIDATION_ERROR' });
    }
    if (!prefs.duration || !Number.isInteger(prefs.duration) || prefs.duration < 1 || prefs.duration > 30) {
      return res.status(400).json({ error: 'Duration must be 1-30 days', code: 'VALIDATION_ERROR' });
    }
    if (!prefs.travelStyle) {
      return res.status(400).json({ error: 'Travel style is required', code: 'VALIDATION_ERROR' });
    }
    if (!prefs.interests || !Array.isArray(prefs.interests) || prefs.interests.length === 0) {
      return res.status(400).json({ error: 'At least one interest is required', code: 'VALIDATION_ERROR' });
    }
    if (!prefs.companion) {
      return res.status(400).json({ error: 'Companion type is required', code: 'VALIDATION_ERROR' });
    }

    const trip = await generateTrip(prefs, userId);
    res.status(201).json({ trip });
  } catch (err) {
    if (err instanceof AIError) {
      return res.status(400).json({
        error: err.message,
        code: err.type,
        details: err.details,
      });
    }
    next(err);
  }
});

app.post('/api/trips/:id/regenerate', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { id } = req.params;

    const db = await getDb();
    const existing = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    if (!existing) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    const preferences = {
      destination: existing.enrichedDestination?.fullName || existing.destination,
      budget: existing.budget,
      currency: existing.currency,
      duration: existing.duration,
      travelStyle: existing.travelStyle,
      interests: existing.interests,
      companion: existing.companion,
      additionalNotes: existing.additionalNotes,
    };

    const trip = await generateTrip(preferences, userId);

    await db.collection('trips').updateOne(
      { _id: ObjectId.createFromHexString(id) },
      { $set: { ...trip, _id: ObjectId.createFromHexString(id), updatedAt: new Date() } }
    );

    trip._id = id;
    res.json({ trip });
  } catch (err) {
    if (err instanceof AIError) return res.status(400).json({ error: err.message, code: err.type, details: err.details });
    next(err);
  }
});

app.post('/api/trips/:id/regenerate-day', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { id } = req.params;
    const { dayNumber } = req.body;

    if (!dayNumber || dayNumber < 1) {
      return res.status(400).json({ error: 'Valid dayNumber is required', code: 'VALIDATION_ERROR' });
    }

    const db = await getDb();
    const existing = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    if (!existing) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    const context = buildAgentContext(
      {
        destination: existing.enrichedDestination?.fullName || existing.destination,
        budget: existing.budget,
        currency: existing.currency,
        duration: existing.duration,
        travelStyle: existing.travelStyle,
        interests: existing.interests,
        companion: existing.companion,
        additionalNotes: existing.additionalNotes,
      },
      existing.enrichedDestination
    );

    const days = await plannerAgent(context, userId, id);

    const newDay = days.find((d) => d.dayNumber === dayNumber);
    if (!newDay) {
      return res.status(400).json({ error: `Day ${dayNumber} not found in generated output`, code: 'VALIDATION_ERROR' });
    }

    const updatedDays = (existing.days || []).map((d) =>
      d.dayNumber === dayNumber ? { ...newDay, dayNumber } : d
    );

    await db.collection('trips').updateOne(
      { _id: ObjectId.createFromHexString(id) },
      { $set: { days: updatedDays, updatedAt: new Date() } }
    );

    const updated = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    res.json({ trip: updated });
  } catch (err) {
    if (err instanceof AIError) return res.status(400).json({ error: err.message, code: err.type, details: err.details });
    next(err);
  }
});

app.patch('/api/trips/:id/favorite', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { id } = req.params;
    const { favorite } = req.body;

    if (typeof favorite !== 'boolean') {
      return res.status(400).json({ error: 'favorite must be a boolean', code: 'VALIDATION_ERROR' });
    }

    const db = await getDb();
    const existing = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    if (!existing) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    await db.collection('trips').updateOne(
      { _id: ObjectId.createFromHexString(id) },
      { $set: { favorite, updatedAt: new Date() } }
    );

    res.json({ success: true, favorite });
  } catch (err) {
    next(err);
  }
});

app.get('/api/trips/favorites', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (!userId) return res.json({ trips: [], total: 0 });

    const db = await getDb();
    const trips = await db.collection('trips')
      .find({ userId, favorite: true })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json({ trips, total: trips.length });
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.get('/api/trips/autosuggest', async (req, res, next) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query || query.length < 2) {
      return res.json({ suggestions: [] });
    }

    const prompt = AUTOSUGGEST(query);
    const result = await callWithRetry(
      prompt,
      (parsed) => {
        if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) {
          return { valid: false, error: 'Missing suggestions array' };
        }
        return { valid: true };
      },
      { maxRetries: 1, featureType: 'autosuggest' }
    );

    const unique = [...new Set(result.suggestions)].slice(0, 5);
    res.json({ suggestions: unique });
  } catch (err) {
    logger.warn('Autosuggest error', { error: err.message });
    res.json({ suggestions: [] });
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
  generateTrip,
  enrichDestination,
  plannerAgent,
  budgeterAgent,
  curatorAgent,
  reviewerAgent,
  callWithRetry,
  buildAgentContext,
  AIError,
  AIErrorTypes,
  logAICall,
};

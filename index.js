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

const SESSION_TTL = 30 * 60 * 1000;

const sessionStore = {
  _map: new Map(),
  _cleanupTimer: null,

  _startCleanup() {
    if (!this._cleanupTimer) {
      this._cleanupTimer = setInterval(() => this._cleanup(), 60 * 1000);
    }
  },

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._map.entries()) {
      if (now - entry.lastActivity > SESSION_TTL) {
        this._map.delete(key);
        logger.debug('Session expired', { key });
      }
    }
  },

  key(tripId, userId) {
    return `${tripId}:${userId}`;
  },

  get(tripId, userId) {
    this._startCleanup();
    const k = this.key(tripId, userId);
    const entry = this._map.get(k);
    return entry || null;
  },

  set(tripId, userId, data) {
    this._startCleanup();
    const k = this.key(tripId, userId);
    const existing = this._map.get(k) || { messages: [], learnedPreferences: { likes: [], dislikes: [], constraints: [] } };
    this._map.set(k, {
      messages: data.messages || existing.messages,
      learnedPreferences: data.learnedPreferences || existing.learnedPreferences,
      lastActivity: Date.now(),
    });
  },

  delete(tripId, userId) {
    this._map.delete(this.key(tripId, userId));
  },
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

const { ENRICH_DESTINATION, PLANNER, BUDGETER, CURATOR, REVIEWER, AUTOSUGGEST, COPILOT } = require('./prompts');

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

async function buildCopilotContext(tripId, userId) {
  const db = await getDb();
  const trip = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(tripId) });
  if (!trip) throw new Error('Trip not found');

  const generations = await db.collection('ai_generations')
    .find({ tripId, featureType: 'copilot' })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  const mergedMemory = { likes: [], dislikes: [], constraints: [] };
  for (const gen of generations.reverse()) {
    if (gen.memorySummary) {
      mergedMemory.likes.push(...(gen.memorySummary.likes || []));
      mergedMemory.dislikes.push(...(gen.memorySummary.dislikes || []));
      mergedMemory.constraints.push(...(gen.memorySummary.constraints || []));
    }
  }

  mergedMemory.likes = [...new Set(mergedMemory.likes)];
  mergedMemory.dislikes = [...new Set(mergedMemory.dislikes)];
  mergedMemory.constraints = [...new Set(mergedMemory.constraints)];

  const session = sessionStore.get(tripId, userId);
  const history = session ? session.messages.slice(-20) : [];

  const preferences = {
    destination: trip.enrichedDestination?.fullName || trip.destination,
    budget: trip.budget,
    currency: trip.currency,
    duration: trip.duration,
    travelStyle: trip.travelStyle,
    interests: trip.interests,
    companion: trip.companion,
    additionalNotes: trip.additionalNotes,
  };

  return { trip, preferences, memory: mergedMemory, history };
}

async function copilotAgent(trip, preferences, memory, history, userMessage, userId = null, tripId = null) {
  const prompt = COPILOT(trip, memory, history, userMessage);

  const result = await callWithRetry(
    prompt,
    (parsed) => {
      if (!parsed.reply) return { valid: false, error: 'Missing reply text' };
      if (typeof parsed.reply !== 'string') return { valid: false, error: 'Reply must be a string' };
      return { valid: true };
    },
    { maxRetries: 1, userId, tripId, featureType: 'copilot' }
  );

  const reply = result.reply;
  const updatedDays = result.updatedDays || null;
  const memorySummary = result.memorySummary || { likes: [], dislikes: [], constraints: [] };

  if (updatedDays && Array.isArray(updatedDays)) {
    const db = await getDb();
    for (const updatedDay of updatedDays) {
      await db.collection('trips').updateOne(
        { _id: ObjectId.createFromHexString(tripId), 'days.dayNumber': updatedDay.dayNumber },
        { $set: { 'days.$': updatedDay, updatedAt: new Date() } }
      );
    }
  }

  const session = sessionStore.get(tripId, userId) || { messages: [], learnedPreferences: { likes: [], dislikes: [], constraints: [] } };
  session.messages.push({ role: 'user', content: userMessage });
  session.messages.push({ role: 'assistant', content: reply });

  const merged = session.learnedPreferences;
  merged.likes = [...new Set([...merged.likes, ...(memorySummary.likes || [])])];
  merged.dislikes = [...new Set([...merged.dislikes, ...(memorySummary.dislikes || [])])];
  merged.constraints = [...new Set([...merged.constraints, ...(memorySummary.constraints || [])])];
  sessionStore.set(tripId, userId, { messages: session.messages.slice(-40), learnedPreferences: merged });

  const db = await getDb();
  await db.collection('ai_generations').insertOne({
    userId,
    tripId,
    featureType: 'copilot',
    prompt,
    response: JSON.stringify(result),
    model: 'gemini-2.0-flash',
    responseTimeMs: 0,
    success: true,
    memorySummary,
    createdAt: new Date(),
  });

  return { reply, updatedDays };
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

async function attachUser(req, res, next) {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (userId) {
      const db = await getDb();
      const user = await db.collection('users').findOne(
        { _id: ObjectId.createFromHexString(userId) },
        { projection: { password: 0 } }
      );
      req.user = user || null;
    } else {
      req.user = null;
    }
    next();
  } catch {
    req.user = null;
    next();
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
  next();
}

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

app.get('/api/analytics/summary', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const db = await getDb();

    const monthlyTrips = await db.collection('trips').aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]).toArray();

    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const found = monthlyTrips.find((m) => m._id.year === d.getFullYear() && m._id.month === d.getMonth() + 1);
      months.push({ month: key, trips: found ? found.count : 0 });
    }

    const durationBuckets = await db.collection('trips').aggregate([
      { $match: { userId } },
      {
        $bucket: {
          groupBy: '$duration',
          boundaries: [0, 3, 7, 14, 31],
          default: '15+',
          output: { count: { $sum: 1 } },
        },
      },
    ]).toArray();

    const bucketLabels = { '0': '1-3 days', '3': '4-7 days', '7': '8-14 days', '15+': '15+ days' };
    const durationDistribution = durationBuckets.map((b) => ({
      range: bucketLabels[b._id] || String(b._id),
      count: b.count,
    }));

    const travelStyleDistribution = await db.collection('trips').aggregate([
      { $match: { userId } },
      { $group: { _id: '$travelStyle', count: { $sum: 1 } } },
    ]).toArray();

    const aiUsage = await db.collection('ai_generations').aggregate([
      { $match: { userId } },
      { $group: { _id: '$featureType', count: { $sum: 1 } } },
    ]).toArray();

    res.json({
      monthlyTrips: months,
      durationDistribution,
      travelStyleDistribution: travelStyleDistribution.map((t) => ({ style: t._id, count: t.count })),
      aiUsage: aiUsage.map((a) => ({ feature: a._id, count: a.count })),
    });
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

app.post('/api/trips/:id/copilot', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { id } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required', code: 'VALIDATION_ERROR' });
    }

    const db = await getDb();
    const tripDoc = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    if (!tripDoc) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (tripDoc.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    const { trip, preferences, memory, history } = await buildCopilotContext(id, userId);
    const result = await copilotAgent(trip, preferences, memory, history, message.trim(), userId, id);

    let updatedTrip = null;
    if (result.updatedDays) {
      updatedTrip = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    }

    res.json({ reply: result.reply, updatedTrip });
  } catch (err) {
    if (err instanceof AIError) return res.status(400).json({ error: err.message, code: err.type });
    next(err);
  }
});

app.get('/api/conversations', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (!userId) return res.json({ conversations: [] });

    const db = await getDb();
    const generations = await db.collection('ai_generations')
      .find({ userId, featureType: 'copilot' })
      .sort({ createdAt: -1 })
      .toArray();

    const tripIds = [...new Set(generations.map((g) => g.tripId).filter(Boolean))];
    const trips = await db.collection('trips')
      .find({ _id: { $in: tripIds.map((id) => ObjectId.createFromHexString(id)) } })
      .project({ title: 1, destination: 1 })
      .toArray();

    const tripMap = {};
    for (const t of trips) tripMap[t._id.toString()] = t;

    const tripGroups = {};
    for (const gen of generations) {
      const tid = gen.tripId;
      if (!tid) continue;
      if (!tripGroups[tid]) {
        tripGroups[tid] = { tripId: tid, messages: [], trip: tripMap[tid] || null };
      }
      tripGroups[tid].messages.push({
        role: gen.prompt?.includes('"role":"user"') ? 'user' : 'assistant',
        content: gen.response || gen.prompt || '',
        createdAt: gen.createdAt,
      });
    }

    const conversations = Object.values(tripGroups).map((g) => ({
      tripId: g.tripId,
      tripTitle: g.trip?.title || g.trip?.destination || 'Unknown Trip',
      destination: g.trip?.destination || '',
      lastMessage: g.messages[0]?.createdAt || null,
      messageCount: g.messages.length,
    }));

    const search = (req.query.search || '').toLowerCase();
    const filtered = search
      ? conversations.filter((c) => c.tripTitle.toLowerCase().includes(search) || c.destination.toLowerCase().includes(search))
      : conversations;

    res.json({ conversations: filtered });
  } catch (err) {
    next(err);
  }
});

app.get('/api/conversations/:tripId/messages', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { tripId } = req.params;

    const db = await getDb();
    const trip = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(tripId) });
    if (!trip) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (trip.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    const generations = await db.collection('ai_generations')
      .find({ tripId, userId, featureType: 'copilot' })
      .sort({ createdAt: 1 })
      .toArray();

    const messages = generations.map((g) => ({
      role: 'assistant',
      content: g.response || '',
      createdAt: g.createdAt,
    }));

    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/conversations/:tripId', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { tripId } = req.params;

    const db = await getDb();
    const trip = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(tripId) });
    if (!trip) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (trip.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    await db.collection('ai_generations').deleteMany({ tripId, userId, featureType: 'copilot' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/user/stats', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (!userId) return res.json({ totalTrips: 0, totalConversations: 0, totalCountries: 0 });

    const db = await getDb();

    const totalTrips = await db.collection('trips').countDocuments({ userId });

    const totalConversations = await db.collection('ai_generations').countDocuments({ userId, featureType: 'copilot' });

    const countries = await db.collection('trips').distinct('enrichedDestination.country', { userId });
    const totalCountries = countries.filter(Boolean).length;

    res.json({ totalTrips, totalConversations, totalCountries });
  } catch (err) {
    next(err);
  }
});

app.get('/api/user/profile', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

    const db = await getDb();
    const user = await db.collection('users').findOne(
      { _id: ObjectId.createFromHexString(userId) },
      { projection: { password: 0 } }
    );

    if (!user) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/user/profile', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

    const { name, defaultCurrency, preferredLanguage, emailNotifications, tripReminders } = req.body;

    const update = {};
    if (name !== undefined) update.name = name;
    if (defaultCurrency !== undefined) update.defaultCurrency = defaultCurrency;
    if (preferredLanguage !== undefined) update.preferredLanguage = preferredLanguage;
    if (emailNotifications !== undefined) update.emailNotifications = emailNotifications;
    if (tripReminders !== undefined) update.tripReminders = tripReminders;
    update.updatedAt = new Date();

    const db = await getDb();
    await db.collection('users').updateOne(
      { _id: ObjectId.createFromHexString(userId) },
      { $set: update }
    );

    const user = await db.collection('users').findOne({ _id: ObjectId.createFromHexString(userId) });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/user/account', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

    const db = await getDb();
    await db.collection('trips').deleteMany({ userId });
    await db.collection('ai_generations').deleteMany({ userId });
    await db.collection('users').deleteOne({ _id: ObjectId.createFromHexString(userId) });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/trips/:id/export', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { id } = req.params;

    const db = await getDb();
    const trip = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });
    if (!trip) return res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' });
    if (trip.userId !== userId) return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

    await db.collection('trips').updateOne(
      { _id: ObjectId.createFromHexString(id) },
      { $set: { isPublic: true, updatedAt: new Date() } }
    );

    const shareUrl = `${req.protocol}://${req.get('host')}/shared/${id}`;
    res.json({ shareUrl, isPublic: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/trips/shared/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const db = await getDb();
    const trip = await db.collection('trips').findOne({ _id: ObjectId.createFromHexString(id) });

    if (!trip || !trip.isPublic) {
      return res.status(404).json({ error: 'Trip not found or not public', code: 'NOT_FOUND' });
    }

    const { userId, ...publicTrip } = trip;
    res.json({ trip: publicTrip });
  } catch (err) {
    next(err);
  }
});

app.get('/api/trips/explore', async (req, res, next) => {
  try {
    const db = await getDb();
    const { search, budgetMin, budgetMax, duration, travelStyle, interests, companion, sort, page = '1', limit = '12' } = req.query;

    const filter = { isPublic: true };

    if (search) filter.destination = { $regex: search, $options: 'i' };
    if (budgetMin || budgetMax) {
      filter.budget = {};
      if (budgetMin) filter.budget.$gte = Number(budgetMin);
      if (budgetMax) filter.budget.$lte = Number(budgetMax);
    }
    if (duration) {
      const ranges = duration.split(',').map((d) => {
        const [min, max] = d.split('-').map(Number);
        return max ? { $gte: min, $lte: max } : { $gte: min };
      });
      filter.$or = ranges.map((r) => ({ duration: r }));
    }
    if (travelStyle) filter.travelStyle = { $in: travelStyle.split(',') };
    if (interests) filter.interests = { $in: interests.split(',') };
    if (companion && companion !== 'All') filter.companion = companion;

    let sortObj = { createdAt: -1 };
    if (sort === 'budget_asc') sortObj = { budget: 1 };
    else if (sort === 'budget_desc') sortObj = { budget: -1 };
    else if (sort === 'duration') sortObj = { duration: -1 };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [trips, total] = await Promise.all([
      db.collection('trips').find(filter)
        .project({ userId: 0 })
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      db.collection('trips').countDocuments(filter),
    ]);

    res.json({ trips, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) });
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

app.get('/api/admin/me', attachUser, requireAdmin, async (req, res) => {
  const { password, ...safe } = req.user;
  res.json({ user: safe });
});

app.get('/api/admin/stats', attachUser, requireAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const [totalUsers, totalTrips, totalGenerations] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('trips').countDocuments(),
      db.collection('ai_generations').countDocuments(),
    ]);
    res.json({ totalUsers, totalTrips, totalGenerations });
  } catch (err) {
    next(err);
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
  buildCopilotContext,
  copilotAgent,
  sessionStore,
  callWithRetry,
  buildAgentContext,
  AIError,
  AIErrorTypes,
  logAICall,
};

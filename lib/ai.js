const Groq = require('groq-sdk');
const logger = require('./logger');

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

let groqClient = null;

function getClient() {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not set');
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

function getModel() {
  return getClient();
}

function parseErrorDetails(err) {
  const info = {
    retryDelay: null,
    isDailyQuota: false,
    isMinuteQuota: false,
    isInvalidKey: false,
    isBillingDisabled: false,
    isModelUnavailable: false,
    isNetworkFailure: false,
    upstreamMessage: err.message || '',
  };

  if (!err.message) return info;

  const msg = err.message;
  info.isNetworkFailure = err.code === 'ERR_NETWORK' || msg.includes('fetch') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('getaddrinfo');
  info.isInvalidKey = err.status === 401 || msg.includes('invalid') && msg.includes('key') || msg.includes('auth') || msg.includes('unauthorized');
  info.isBillingDisabled = msg.includes('billing') || msg.includes('payment') || msg.includes('quota');
  info.isModelUnavailable = err.status === 404 || msg.includes('not found') || msg.includes('not supported') || msg.includes('not available') || msg.includes('NOT_FOUND');
  info.isMinuteQuota = err.status === 429;

  return info;
}

const SUPPORTED_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama-guard-3-8b',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

async function generateContent(prompt, { modelName = DEFAULT_MODEL, fallbackOnTimeout = true } = {}) {
  const client = getClient();
  const start = Date.now();

  try {
    const result = await client.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: modelName,
      temperature: 0.5,
    });

    const duration = Date.now() - start;
    const text = result.choices?.[0]?.message?.content || '';

    if (!text) {
      throw new Error('Empty response from Groq API');
    }

    return {
      text,
      model: modelName,
      duration,
      candidates: result.choices,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const isTimeout = err.message?.includes('timeout') || err.message?.includes('deadline') || err.code === 'ETIMEDOUT';
    const isRateLimit = err.status === 429;
    const upstream = parseErrorDetails(err);

    if (isTimeout && fallbackOnTimeout && modelName !== FALLBACK_MODEL) {
      logger.warn('Groq timeout, falling back to fast model', { model: modelName, duration });
      return generateContent(prompt, { modelName: FALLBACK_MODEL, fallbackOnTimeout: false });
    }

    if (isRateLimit && fallbackOnTimeout && modelName !== FALLBACK_MODEL) {
      logger.warn('Groq rate limit, falling back to fast model', { model: modelName, duration });
      return generateContent(prompt, { modelName: FALLBACK_MODEL, fallbackOnTimeout: false });
    }

    const error = new Error(err.message);
    error.model = modelName;
    error.duration = duration;
    error.isTimeout = isTimeout;
    error.isSafety = false;
    error.isRateLimit = isRateLimit;
    error.upstream = upstream;
    throw error;
  }
}

module.exports = {
  getClient,
  getModel,
  generateContent,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  SUPPORTED_MODELS,
};

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const logger = require('./logger');

const DEFAULT_MODEL = 'gemini-2.0-flash';
const FALLBACK_MODEL = 'gemini-2.0-pro';

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

let genAI = null;

function getClient() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

function getModel(modelName = DEFAULT_MODEL) {
  const client = getClient();
  return client.getGenerativeModel({
    model: modelName,
    safetySettings: SAFETY_SETTINGS,
  });
}

async function generateContent(prompt, { modelName = DEFAULT_MODEL, fallbackOnTimeout = true } = {}) {
  let model = getModel(modelName);
  const start = Date.now();

  try {
    const result = await model.generateContent(prompt);
    const duration = Date.now() - start;
    const response = result.response;
    const text = response.text();

    return {
      text,
      model: modelName,
      duration,
      candidates: response.candidates,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const isTimeout = err.message?.includes('timeout') || err.message?.includes('deadline');
    const isSafety = err.message?.includes('SAFETY');
    const isRateLimit = err.message?.includes('RATE_LIMIT') || err.status === 429;

    if (isTimeout && fallbackOnTimeout && modelName !== FALLBACK_MODEL) {
      logger.warn('Gemini timeout, falling back to pro model', { model: modelName, duration });
      return generateContent(prompt, { modelName: FALLBACK_MODEL, fallbackOnTimeout: false });
    }

    const error = new Error(err.message);
    error.model = modelName;
    error.duration = duration;
    error.isTimeout = isTimeout;
    error.isSafety = isSafety;
    error.isRateLimit = isRateLimit;
    throw error;
  }
}

module.exports = {
  getClient,
  getModel,
  generateContent,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
};

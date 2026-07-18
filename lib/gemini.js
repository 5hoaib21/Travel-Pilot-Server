const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;

function getClient() {
  if (genAI) return genAI;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  genAI = new GoogleGenerativeAI(apiKey);
  return genAI;
}

function getModel(modelName) {
  const client = getClient();
  return client.getGenerativeModel({
    model: modelName || process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  });
}

module.exports = { getClient, getModel };

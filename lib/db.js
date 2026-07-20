const { MongoClient } = require('mongodb');
const logger = require('./logger');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/travel-pilot';
const DB_NAME = 'travel-pilot';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

let client = null;
let db = null;

async function connectToDatabase() {
  if (db) return db;

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      client = new MongoClient(MONGO_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
      });
      // await client.connect();
      db = client.db(DB_NAME);
      await createIndexes(db);
      logger.info('Connected to MongoDB');
      return db;
    } catch (err) {
      lastError = err;
      logger.error(`MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  logger.error(`MongoDB connection failed after ${MAX_RETRIES} attempts`);
  throw lastError;
}

async function createIndexes(database) {
  try {
    await database.collection('trips').createIndex({ userId: 1, createdAt: -1 });
    await database.collection('trips').createIndex({ userId: 1, favorite: 1 });
    await database.collection('ai_generations').createIndex({ userId: 1, createdAt: -1 });
    await database.collection('ai_generations').createIndex({ tripId: 1, createdAt: -1 });
    await database.collection('ai_generations').createIndex({ featureType: 1, createdAt: -1 });
    await database.collection('ai_generations').createIndex({ success: 1 });
  } catch (err) {
    logger.warn('Index creation failed (non-fatal):', { error: err.message });
  }
}

async function getDb() {
  if (!db) return connectToDatabase();
  return db;
}

async function close() {
  if (client) await client.close();
}

module.exports = { connectToDatabase, getDb, close };

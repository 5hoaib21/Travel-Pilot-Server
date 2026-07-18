const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/travel-pilot';
const DB_NAME = 'travel-pilot';

let client = null;
let db = null;

async function connect() {
  if (db) return db;
  client = new MongoClient(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  await createIndexes(db);
  return db;
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
    console.warn('Index creation failed (non-fatal):', err.message);
  }
}

async function getDb() {
  if (!db) return connect();
  return db;
}

async function close() {
  if (client) await client.close();
}

module.exports = { connect, getDb, close };

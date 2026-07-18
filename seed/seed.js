require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { MongoClient } = require('mongodb');

async function seedAdmin() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/travel-pilot';
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('travel-pilot');
    const users = db.collection('users');
    await users.updateOne(
      { email: 'admin@travelpilot.app' },
      {
        $setOnInsert: {
          name: 'Admin',
          email: 'admin@travelpilot.app',
          role: 'admin',
          emailVerified: true,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log('Admin user seeded: admin@travelpilot.app');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seedAdmin();

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/travel-pilot';
const DB_NAME = 'travel-pilot';
const PASSWORD = 'Demo123!';
let force = process.argv.includes('--force');

const demoUsers = [
  {
    name: 'Admin',
    email: 'admin@travelpilot.app',
    role: 'admin',
  },
  {
    name: 'Alice Johnson',
    email: 'alice@example.com',
    role: 'user',
  },
  {
    name: 'Bob Chen',
    email: 'bob@example.com',
    role: 'user',
  },
];

const demoDestinations = [
  {
    destination: 'Tokyo',
    enrichedDestination: { fullName: 'Tokyo, Japan', country: 'Japan', continent: 'Asia', currency: 'JPY', language: 'Japanese', timezone: 'Asia/Tokyo' },
  },
  {
    destination: 'Paris',
    enrichedDestination: { fullName: 'Paris, France', country: 'France', continent: 'Europe', currency: 'EUR', language: 'French', timezone: 'Europe/Paris' },
  },
  {
    destination: 'Bangkok',
    enrichedDestination: { fullName: 'Bangkok, Thailand', country: 'Thailand', continent: 'Asia', currency: 'THB', language: 'Thai', timezone: 'Asia/Bangkok' },
  },
  {
    destination: 'New York',
    enrichedDestination: { fullName: 'New York, USA', country: 'United States', continent: 'North America', currency: 'USD', language: 'English', timezone: 'America/New_York' },
  },
  {
    destination: 'Bali',
    enrichedDestination: { fullName: 'Bali, Indonesia', country: 'Indonesia', continent: 'Asia', currency: 'IDR', language: 'Indonesian', timezone: 'Asia/Makassar' },
  },
  {
    destination: 'London',
    enrichedDestination: { fullName: 'London, UK', country: 'United Kingdom', continent: 'Europe', currency: 'GBP', language: 'English', timezone: 'Europe/London' },
  },
];

function buildDay(dayNumber, destination) {
  const activities = [
    { morning: { activity: `Visit ${destination} landmark`, category: 'attraction', duration: '3h', cost: 15 }, afternoon: { activity: `Local food tour`, category: 'meal', duration: '2h', cost: 25 }, evening: { activity: `City walk`, category: 'rest', duration: '1h', cost: 0 }, accommodation: { name: `Downtown Hotel ${destination}`, costPerNight: 120, rating: 4.2, type: 'Hotel' } },
    { morning: { activity: `Museum visit`, category: 'attraction', duration: '3h', cost: 20 }, afternoon: { activity: `Street food lunch`, category: 'meal', duration: '1.5h', cost: 10 }, evening: { activity: `Sunset viewpoint`, category: 'attraction', duration: '2h', cost: 5 }, accommodation: { name: `Central Stay ${destination}`, costPerNight: 95, rating: 4.0, type: 'Hotel' } },
    { morning: { activity: `Nature park exploration`, category: 'attraction', duration: '4h', cost: 12 }, afternoon: { activity: `Cooking class`, category: 'meal', duration: '3h', cost: 35 }, evening: { activity: `Night market`, category: 'rest', duration: '2h', cost: 0 }, accommodation: { name: `Garden Resort ${destination}`, costPerNight: 150, rating: 4.5, type: 'Resort' } },
    { morning: { activity: `Temple tour`, category: 'attraction', duration: '2.5h', cost: 8 }, afternoon: { activity: `River cruise lunch`, category: 'meal', duration: '2h', cost: 30 }, evening: { activity: `Cultural show`, category: 'attraction', duration: '2h', cost: 25 }, accommodation: { name: `Heritage Inn ${destination}`, costPerNight: 110, rating: 4.3, type: 'Hotel' } },
    { morning: { activity: `Shopping district`, category: 'rest', duration: '3h', cost: 0 }, afternoon: { activity: `Seafood lunch`, category: 'meal', duration: '1.5h', cost: 20 }, evening: { activity: `Rooftop bar`, category: 'rest', duration: '2h', cost: 15 }, accommodation: { name: `Bay View Hotel ${destination}`, costPerNight: 130, rating: 4.4, type: 'Hotel' } },
  ];
  return { ...activities[dayNumber % activities.length], dayNumber };
}

const demoConfigs = [
  { destIdx: 0, style: 'Adventure', budget: 2500, duration: 5, companion: 'Solo', interests: ['Culture', 'Food', 'History'], favorite: true, isPublic: true },
  { destIdx: 1, style: 'Relaxed', budget: 3500, duration: 7, companion: 'Couple', interests: ['Food', 'Shopping', 'Culture'], favorite: true, isPublic: true },
  { destIdx: 2, style: 'Balanced', budget: 1500, duration: 4, companion: 'Friends', interests: ['Food', 'Nightlife', 'Adventure'], favorite: false, isPublic: true },
  { destIdx: 3, style: 'Adventure', budget: 4000, duration: 6, companion: 'Family', interests: ['Nature', 'Shopping', 'Culture'], favorite: false, isPublic: false },
  { destIdx: 4, style: 'Relaxed', budget: 2000, duration: 5, companion: 'Couple', interests: ['Nature', 'Culture', 'Food'], favorite: true, isPublic: true },
  { destIdx: 5, style: 'Balanced', budget: 3000, duration: 4, companion: 'Solo', interests: ['History', 'Culture', 'Food'], favorite: false, isPublic: true },
];

const featureTypes = ['planner', 'budgeter', 'curator', 'reviewer', 'enrich_destination', 'copilot', 'autosuggest'];

async function seed() {
  console.log('=== Travel Pilot Seed Script ===');
  console.log(`Force mode: ${force}`);

  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    console.log('Connected to MongoDB\n');

    const usersCol = db.collection('users');
    const tripsCol = db.collection('trips');
    const aiCol = db.collection('ai_generations');

    if (force) {
      console.log('Clearing existing data...');
      const [delUsers, delTrips, delAi] = await Promise.all([
        usersCol.deleteMany({}),
        tripsCol.deleteMany({}),
        aiCol.deleteMany({}),
      ]);
      console.log(`  Deleted ${delUsers.deletedCount} users, ${delTrips.deletedCount} trips, ${delAi.deletedCount} AI records`);
      const accountCol = db.collection('account');
      const sessionCol = db.collection('session');
      await Promise.all([
        accountCol.deleteMany({}),
        sessionCol.deleteMany({}),
      ]);
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const createdUsers = [];

    for (const u of demoUsers) {
      const existing = await usersCol.findOne({ email: u.email });
      if (existing) {
        console.log(`  User exists: ${u.email} (${existing._id})`);
        createdUsers.push(existing);
        continue;
      }
      const doc = {
        _id: new ObjectId(),
        name: u.name,
        email: u.email,
        role: u.role,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await usersCol.insertOne(doc);
      console.log(`  Created user: ${u.email} (${doc._id})`);
      createdUsers.push(doc);

      const accountCol = db.collection('account');
      await accountCol.updateOne(
        { providerId: 'email', accountId: u.email },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            userId: doc._id.toString(),
            providerId: 'email',
            accountId: u.email,
            password: passwordHash,
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    console.log(`\n--- Creating Trips ---`);
    let tripCount = 0;

    for (const cfg of demoConfigs) {
      const user = createdUsers[cfg.destIdx % createdUsers.length];
      const dest = demoDestinations[cfg.destIdx];
      const days = Array.from({ length: cfg.duration }, (_, i) => buildDay(i + 1, dest.enrichedDestination.fullName));
      const totalBudget = days.reduce((sum, d) => sum + (d.accommodation?.costPerNight || 0) + (d.morning?.cost || 0) + (d.afternoon?.cost || 0) + (d.evening?.cost || 0), 0);

      const tripDoc = {
        userId: user._id.toString(),
        destination: dest.destination,
        enrichedDestination: dest.enrichedDestination,
        budget: cfg.budget,
        currency: dest.enrichedDestination.currency,
        duration: cfg.duration,
        travelStyle: cfg.style,
        interests: cfg.interests,
        companion: cfg.companion,
        title: `${cfg.style} ${dest.destination} Getaway`,
        days,
        budgetBreakdown: [
          { category: 'Accommodation', amount: Math.round(totalBudget * 0.35), percentage: 35 },
          { category: 'Food', amount: Math.round(totalBudget * 0.2), percentage: 20 },
          { category: 'Activities', amount: Math.round(totalBudget * 0.25), percentage: 25 },
          { category: 'Transport', amount: Math.round(totalBudget * 0.12), percentage: 12 },
          { category: 'Miscellaneous', amount: Math.round(totalBudget * 0.08), percentage: 8 },
        ],
        tips: [
          { category: 'Weather', content: `Best time to visit ${dest.destination} is during spring and fall.`, priority: 5 },
          { category: 'Culture', content: 'Learn a few basic phrases in the local language.', priority: 4 },
          { category: 'Safety', content: 'Keep your valuables secure and be aware of your surroundings.', priority: 5 },
          { category: 'Packing', content: 'Pack light and bring comfortable walking shoes.', priority: 3 },
          { category: 'Currency', content: `Local currency is ${dest.enrichedDestination.currency}.`, priority: 4 },
          { category: 'Language', content: `The primary language is ${dest.enrichedDestination.language}.`, priority: 3 },
        ],
        favorite: cfg.favorite,
        isPublic: cfg.isPublic,
        status: 'completed',
        createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      };
      const result = await tripsCol.insertOne(tripDoc);
      console.log(`  Created trip: ${tripDoc.title} (${result.insertedId})`);
      tripCount++;

      const conversationMessages = [
        { role: 'user', content: `Can you help me refine my ${dest.destination} itinerary?`, createdAt: new Date() },
        { role: 'assistant', content: `Sure! I'd suggest starting with a relaxed morning to beat jet lag.`, createdAt: new Date() },
        { role: 'user', content: `What restaurants do you recommend in ${dest.destination}?`, createdAt: new Date() },
        { role: 'assistant', content: `There are excellent local food spots near your hotel.`, createdAt: new Date() },
      ];
      for (const msg of conversationMessages) {
        await aiCol.insertOne({
          _id: new ObjectId(),
          userId: user._id.toString(),
          tripId: result.insertedId.toString(),
          featureType: 'copilot',
          prompt: msg.content,
          response: msg.content,
          model: 'llama-3.3-70b-versatile',
          responseTimeMs: Math.floor(Math.random() * 2000) + 500,
          success: true,
          createdAt: msg.createdAt,
        });
      }
    }

    console.log(`\n--- Creating AI Generation Records ---`);
    let aiCount = 0;

    for (const user of createdUsers) {
      for (const featureType of featureTypes) {
        const recordCount = Math.floor(Math.random() * 8) + 3;
        for (let i = 0; i < recordCount; i++) {
          const success = Math.random() > 0.15;
          const responseTimeMs = Math.floor(Math.random() * 4000) + 200;
          await aiCol.insertOne({
            _id: new ObjectId(),
            userId: user._id.toString(),
            featureType,
            prompt: `Demo prompt for ${featureType} #${i + 1}`,
            response: success ? `Demo response for ${featureType}` : null,
            model: Math.random() > 0.3 ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant',
            responseTimeMs,
            success,
            errorMessage: success ? null : 'Simulated demo error',
            createdAt: new Date(Date.now() - Math.random() * 14 * 24 * 60 * 60 * 1000),
          });
          aiCount++;
        }
      }
    }

    const totalUsers = await usersCol.countDocuments();
    const totalTrips = await tripsCol.countDocuments();
    const totalAi = await aiCol.countDocuments();

    console.log(`\n=== Seed Complete ===`);
    console.log(`  Users: ${totalUsers}`);
    console.log(`  Trips: ${totalTrips}`);
    console.log(`  AI Records: ${totalAi}`);
    console.log(`\nDemo Credentials:`);
    console.log(`  Email: admin@travelpilot.app / Password: ${PASSWORD} (Admin)`);
    console.log(`  Email: alice@example.com / Password: ${PASSWORD} (User)`);
    console.log(`  Email: bob@example.com / Password: ${PASSWORD} (User)`);
    console.log(`\nNote: Sign up through the app once per email to activate the Better Auth session,`);
    console.log(`then the seed data will be linked via x-user-id.`);

  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await client.close();
    console.log('MongoDB connection closed.');
  }
}

seed();

const { betterAuth } = require('better-auth');

function createAuth() {
  return betterAuth({
    appName: 'Travel Pilot',
    secret: process.env.BETTER_AUTH_SECRET || 'change-me-in-production',
    url: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
      },
    },
  });
}

module.exports = { createAuth };

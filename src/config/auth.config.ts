import { betterAuth } from 'better-auth';
import { db } from '../db';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const auth = betterAuth({
  // Use default Better Auth cookie naming
  database: drizzleAdapter(db, {
    provider: 'pg'
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60 * 24 * 7 // 7 days
    }
  },
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:8080',
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? 'http://localhost:8080',
    'http://localhost:8080', // Fallback for HTTP
    'https://localhost:8080', // HTTPS backend
    'http://localhost:3000', // Frontend development HTTP
    'https://localhost:3000' // Frontend development HTTPS
  ]
});

export type AuthContext = typeof auth;

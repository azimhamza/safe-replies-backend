import { betterAuth } from 'better-auth';
import { db } from '../db';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    // Map to your existing users table schema
    schema: {
      user: {
        fields: {
          email: 'email',
          name: 'name',
          // Map passwordHash to better-auth's expected field
          password: 'passwordHash'
        }
      }
    }
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Don't auto-create users - we'll handle that in hooks
    autoSignIn: false
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60 * 24 * 7 // 7 days
    }
  },
  advanced: {
    // Cookie settings for production cross-domain support
    cookieOptions: {
      // SameSite must be 'none' for cross-domain cookies (frontend on Vercel, backend on Railway)
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      // Secure must be true when sameSite is 'none' (HTTPS required)
      secure: process.env.NODE_ENV === 'production',
      // Don't set domain - let browser handle it for cross-domain support
      httpOnly: true,
      path: '/'
    }
  },
  // Add custom user fields to session
  user: {
    additionalFields: {
      accountType: {
        type: 'string',
        required: true,
        defaultValue: 'CREATOR'
      },
      businessName: {
        type: 'string',
        required: false
      }
    }
  },
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:8080',
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? 'http://localhost:8080',
    process.env.FRONTEND_URL ?? '',
    'http://localhost:8080',
    'https://localhost:8080',
    'http://localhost:3000',
    'https://localhost:3000',
    // Production URLs
    'https://safe-replies-backend-production.up.railway.app',
    'https://safe-replies-frontend-go8h-380dnxuc5-azim-hamzas-projects.vercel.app',
    // Allow all Vercel preview deployments
    ...(['https://safe-replies-frontend-go8h.vercel.app'] as const)
  ].filter((origin): origin is string => Boolean(origin))
});

export type AuthContext = typeof auth;

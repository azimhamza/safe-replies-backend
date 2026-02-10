import { db } from '../db';
import { users, clients } from '../db/schema';
import { session } from '../db/better-auth-schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

export interface SignUpUserData {
  email: string;
  password: string;
  name?: string;
  businessName?: string;
  accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  agencyId?: string; // For clients only
}

export interface SignInData {
  email: string;
  password: string;
}

export interface BetterAuthSession {
  user: {
    id: string;
    email: string;
    name: string;
    accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
    businessName?: string;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    token: string;
  };
}

/**
 * Create session for an existing user using better-auth
 * Call this after creating a user in the database
 */
export async function createSessionForUser(
  userId: string,
  _email: string,
  req: {
    headers: Record<string, string | string[] | undefined>;
    get: (name: string) => string | undefined;
  }
): Promise<{ sessionId: string; expiresAt: Date }> {
  try {
    // Convert Express headers to Web API Headers
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, Array.isArray(value) ? value[0] : value);
      }
    });

    // Create session using better-auth internal API
    // Since we've already created the user in the database, we can create a session directly
    const sessionData = await db.insert(session).values({
      id: `session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      ipAddress: req.get('x-forwarded-for') || req.get('x-real-ip') || 'unknown',
      userAgent: req.get('user-agent') || 'unknown'
    }).returning();

    return {
      sessionId: sessionData[0].id,
      expiresAt: sessionData[0].expiresAt
    };
  } catch (error) {
    console.error('[AUTH-HELPER] Error creating session:', error);
    throw error;
  }
}

/**
 * Sign in user and create session
 * Validates credentials and creates a better-auth session
 */
export async function signInUser(
  credentials: SignInData,
  req: {
    headers: Record<string, string | string[] | undefined>;
    get: (name: string) => string | undefined;
  }
): Promise<BetterAuthSession> {
  try {
    // Check users table first
    const user = await db.query.users.findFirst({
      where: eq(users.email, credentials.email)
    });

    if (user) {
      // Verify password
      const validPassword = await bcrypt.compare(credentials.password, user.passwordHash);

      if (!validPassword) {
        throw new Error('Invalid credentials');
      }

      // Create session
      const sessionResult = await createSessionForUser(user.id, user.email, req);

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name || '',
          accountType: user.accountType,
          businessName: user.businessName || undefined
        },
        session: {
          id: sessionResult.sessionId,
          userId: user.id,
          expiresAt: sessionResult.expiresAt,
          token: sessionResult.sessionId // Use session ID as token
        }
      };
    }

    // Check clients table
    const client = await db.query.clients.findFirst({
      where: eq(clients.email, credentials.email)
    });

    if (!client) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const validPassword = await bcrypt.compare(credentials.password, client.passwordHash);

    if (!validPassword) {
      throw new Error('Invalid credentials');
    }

    // Create session
    const sessionResult = await createSessionForUser(client.id, client.email, req);

    return {
      user: {
        id: client.id,
        email: client.email,
        name: client.businessName || '',
        accountType: 'CLIENT'
      },
      session: {
        id: sessionResult.sessionId,
        userId: client.id,
        expiresAt: sessionResult.expiresAt,
        token: sessionResult.sessionId // Use session ID as token
      }
    };
  } catch (error) {
    console.error('[AUTH-HELPER] Error signing in user:', error);
    throw error;
  }
}

/**
 * Set better-auth session cookie in response
 * @param sessionId - The better-auth session ID to set as cookie value
 * @param accountType - The user's account type for the user cookie
 * @param userId - The user's ID for the user cookie
 */
export function setSessionCookies(
  res: any,
  sessionId: string,
  userId: string,
  accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT'
): void {
  const isProduction = !!(
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.USE_HTTPS === 'true'
  );

  const isLocalhost =
    process.env.NODE_ENV === 'development' ||
    process.env.BETTER_AUTH_URL?.includes('localhost') ||
    process.env.BETTER_AUTH_URL?.includes('127.0.0.1');

  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    ...(isLocalhost ? {} : { sameSite: 'none' as const }),
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/'
  };

  // Set session cookie (for API authentication via better-auth middleware)
  res.cookie('better-auth.session_token', sessionId, cookieOptions);

  // Set user cookie (for frontend middleware routing)
  res.cookie('user', JSON.stringify({
    userId,
    accountType
  }), {
    ...cookieOptions,
    httpOnly: false // Frontend needs to read this
  });
}

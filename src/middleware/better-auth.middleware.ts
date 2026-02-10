import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { users, clients } from '../db/schema';
import { session } from '../db/better-auth-schema';
import { eq } from 'drizzle-orm';

export interface BetterAuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
    name?: string;
    businessName?: string;
  };
  session?: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
  // Legacy fields for backward compatibility
  userId?: string;
  accountType?: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
  clientId?: string;
}

/**
 * Better-auth session middleware
 * Validates session from database and attaches user to request
 */
export async function betterAuthMiddleware(
  req: BetterAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    console.log('[BETTER-AUTH] Validating session for:', req.method, req.path);
    console.log('[BETTER-AUTH] Cookie header:', req.headers.cookie);
    console.log('[BETTER-AUTH] Parsed cookies:', req.cookies);

    // Extract session token from cookie
    const cookies = req.cookies || {};
    const sessionToken = cookies['better-auth.session_token'];

    console.log('[BETTER-AUTH] Session token from cookies:', sessionToken);

    if (!sessionToken) {
      console.log('[BETTER-AUTH] No session token found in cookies');
      res.status(401).json({ success: false, error: 'Unauthorized - No valid session' });
      return;
    }

    console.log('[BETTER-AUTH] Session token found:', sessionToken.substring(0, 20) + '...');

    // Get session from database
    const sessionData = await db.query.session.findFirst({
      where: eq(session.id, sessionToken)
    });

    if (!sessionData) {
      console.log('[BETTER-AUTH] Session not found in database');
      res.status(401).json({ success: false, error: 'Unauthorized - Invalid session' });
      return;
    }

    // Check if session has expired
    if (new Date() > sessionData.expiresAt) {
      console.log('[BETTER-AUTH] Session has expired');
      res.status(401).json({ success: false, error: 'Unauthorized - Session expired' });
      return;
    }

    console.log('[BETTER-AUTH] Session validated:', {
      sessionId: sessionData.id,
      userId: sessionData.userId
    });

    // Get user data from database
    const user = await db.query.users.findFirst({
      where: eq(users.id, sessionData.userId)
    });

    if (user) {
      // User found in users table
      req.user = {
        id: user.id,
        email: user.email,
        accountType: user.accountType,
        name: user.name || undefined,
        businessName: user.businessName || undefined
      };

      req.session = {
        id: sessionData.id,
        userId: sessionData.userId,
        expiresAt: sessionData.expiresAt
      };

      // Set legacy fields for backward compatibility
      req.userId = user.id;
      req.accountType = user.accountType;

      console.log('[BETTER-AUTH] User authenticated:', {
        userId: req.user.id,
        accountType: req.user.accountType
      });

      next();
      return;
    }

    // Check clients table
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, sessionData.userId)
    });

    if (!client) {
      console.log('[BETTER-AUTH] User not found in database');
      res.status(401).json({ success: false, error: 'Unauthorized - User not found' });
      return;
    }

    // Client found in clients table
    req.user = {
      id: client.id,
      email: client.email,
      accountType: 'CLIENT',
      businessName: client.businessName || undefined
    };

    req.session = {
      id: sessionData.id,
      userId: sessionData.userId,
      expiresAt: sessionData.expiresAt
    };

    // Set legacy fields for backward compatibility
    req.userId = client.id;
    req.accountType = 'CLIENT';
    req.clientId = client.id;

    console.log('[BETTER-AUTH] Client authenticated:', {
      userId: req.user.id,
      accountType: req.user.accountType
    });

    next();
  } catch (error) {
    console.error('[BETTER-AUTH] Session validation error:', error);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
}

/**
 * Require specific account type(s) - works with better-auth middleware
 */
export function requireAccountType(...types: Array<'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT'>) {
  return async (req: BetterAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user?.accountType) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    if (!types.includes(req.user.accountType)) {
      res.status(403).json({
        success: false,
        error: `This endpoint requires ${types.join(' or ')} account`
      });
      return;
    }

    next();
  };
}

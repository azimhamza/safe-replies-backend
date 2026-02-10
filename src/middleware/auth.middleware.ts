import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    accountType?: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
  };
  userId?: string;
  clientId?: string;
  accountType?: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
}

interface JWTPayload {
  userId: string;
  email: string;
  accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
  agencyId?: string;
}

/**
 * Verify JWT session token and attach user info to request
 */
export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Debug logging - show actual cookies
    console.log('[AUTH] Applying auth middleware for:', req.method, req.path);

    // Extract token from cookies
    const cookieName = 'better-auth.session_token';
    const cookies = req.headers.cookie?.split(';').reduce((acc: Record<string, string>, cookie) => {
      const [key, value] = cookie.trim().split('=');
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const token = cookies?.[cookieName];

    if (!token) {
      console.log('[AUTH] No session token found in cookies');
      console.log('[AUTH] Available cookies:', Object.keys(cookies || {}));
      res.status(401).json({ success: false, error: 'Unauthorized - No session token' });
      return;
    }

    // Verify JWT token
    const secret = process.env.BETTER_AUTH_SECRET || 'fallback-secret-key';

    try {
      const decoded = jwt.verify(token, secret) as JWTPayload;
      console.log('[AUTH] Token verified successfully for user:', decoded.userId);

      req.userId = decoded.userId;
      req.accountType = decoded.accountType;

      console.log('[AUTH] User authenticated:', {
        userId: decoded.userId,
        accountType: decoded.accountType
      });

      next();
      return;
    } catch (jwtError) {
      console.error('[AUTH] JWT verification failed:', jwtError);
      res.status(401).json({ success: false, error: 'Invalid or expired session' });
      return;
    }
  } catch (error) {
    console.error('[AUTH] Auth middleware error:', error);
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
}

/**
 * Require specific account type(s)
 */
export function requireAccountType(...types: Array<'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT'>) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.accountType) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    if (!types.includes(req.accountType)) {
      res.status(403).json({ 
        success: false, 
        error: `This endpoint requires ${types.join(' or ')} account`
      });
      return;
    }

    next();
  };
}

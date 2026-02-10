import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Rate limiter for authentication endpoints
 * Prevents brute force attacks on login/signup
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again in 15 minutes.'
  },
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  // Key generator: combine IP + email to prevent bypassing with different IPs
  keyGenerator: (req: Request): string => {
    const email = req.body?.email || '';
    const ip = ipKeyGenerator(req.ip || ''); // Properly handles IPv6 addresses
    return `${ip}:${email}`;
  }
});

/**
 * Rate limiter for general API endpoints
 * Prevents DoS attacks and abuse
 */
export const apiRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute (increased for authenticated users with polling/real-time updates)
  message: {
    success: false,
    error: 'Too many requests. Please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful responses from count (only count errors/failures)
  skip: (req: Request): boolean => {
    // Don't rate limit OPTIONS requests (CORS preflight)
    if (req.method === 'OPTIONS') return true;

    // Skip sync-status endpoint (has its own more permissive rate limiter)
    if (req.path === '/api/sync-status') return true;

    return false;
  }
});

/**
 * Strict rate limiter for webhook endpoints
 * Prevents webhook spam
 */
export const webhookRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 webhook calls per minute
  message: {
    success: false,
    error: 'Webhook rate limit exceeded.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Permissive rate limiter for sync-status endpoint
 * Allows frequent polling for real-time updates without hitting rate limits
 */
export const syncStatusRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute - very permissive for lightweight read-only endpoint
  message: {
    success: false,
    error: 'Sync status polling rate limit exceeded. Please reduce polling frequency.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

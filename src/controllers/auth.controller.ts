import { Request, Response } from 'express';
import { db } from '../db';
import { users, clients } from '../db/schema';
import { AgencySignupSchema, CreatorSignupSchema, LoginSchema } from '../validation/schemas';
import { ApiResponse } from '../types';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { isAgency } from '../utils/account-type.utils';
import { autumn } from '../services/autumn.service';

/** Map account type to Autumn product ID */
function getAutumnProductId(accountType: string): string {
  switch (accountType) {
    case 'MAX_AGENCY': return 'super-max';
    case 'BASIC_AGENCY': return 'agency-plan';
    case 'CREATOR': return 'creator-plan';
    default: return 'creator-plan';
  }
}

/** Get frontend base URL for Stripe success redirect */
function getFrontendBaseUrl(): string {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

/**
 * Agency signup
 */
export async function agencySignup(
  req: Request,
  res: Response<ApiResponse<{ userId: string; accountType: string; redirectTo: string; checkoutUrl?: string }>>
): Promise<void> {
  try {
    const validated = AgencySignupSchema.parse(req.body);

    // Hash password
    const passwordHash = await bcrypt.hash(validated.password, 10);

    // Determine account type from request or default to BASIC_AGENCY
    const accountType = validated.agencyType || 'BASIC_AGENCY';

    // Create agency user
    const [user] = await db.insert(users).values({
      email: validated.email,
      passwordHash,
      name: validated.name,
      accountType: accountType,
      plan: 'AGENCY',
      subscriptionStatus: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14 days
    }).returning();

    // Create Autumn billing customer for agency
    const { error: autumnError } = await autumn.customers.create({
      id: user.id,
      name: validated.name || validated.email,
      email: validated.email,
    });
    if (autumnError) {
      console.error('Autumn customer creation failed for agency:', autumnError);
    }

    // Initiate Autumn checkout for the plan
    const productId = getAutumnProductId(accountType);
    const successUrl = `${getFrontendBaseUrl()}/onboarding/branding?billing=success`;
    let checkoutUrl: string | undefined;

    const { data: checkoutData, error: checkoutError } = await autumn.checkout({
      customer_id: user.id,
      product_id: productId,
      success_url: successUrl,
    });
    if (checkoutError) {
      console.error('Autumn checkout failed for agency:', checkoutError);
    } else if (checkoutData?.url) {
      checkoutUrl = checkoutData.url;
    }

    // Create JWT session token
    const secret = process.env.BETTER_AUTH_SECRET || 'fallback-secret-key';
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        accountType: accountType
      },
      secret,
      { expiresIn: '7d' }
    );

    // Set session cookies
    const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

    // Detect if we're in localhost development
    const isLocalhost = process.env.NODE_ENV === 'development' ||
                        process.env.BETTER_AUTH_URL?.includes('localhost') ||
                        process.env.BETTER_AUTH_URL?.includes('127.0.0.1');

    // For production (Railway, Vercel, etc.), always use secure cookies
    // Railway serves over HTTPS by default
    const isProduction = !!(process.env.NODE_ENV === 'production' ||
                            process.env.RAILWAY_ENVIRONMENT ||
                            process.env.USE_HTTPS === 'true');

    const cookieOptions = {
      httpOnly: true,
      secure: isProduction, // Always secure in production
      // For localhost, don't set sameSite to allow cross-origin cookies
      // For production, use 'none' to allow cross-origin requests (frontend on Vercel, backend on Railway)
      ...(isLocalhost ? {} : { sameSite: 'none' as const }),
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
      ...(cookieDomain && { domain: cookieDomain })
    };

    // Set session cookie (JWT for API authentication)
    res.cookie('better-auth.session_token', token, cookieOptions);

    // Set user cookie (for frontend middleware routing)
    res.cookie('user', JSON.stringify({
      userId: user.id,
      accountType: accountType
    }), {
      ...cookieOptions,
      httpOnly: false // Frontend needs to read this
    });

    res.status(201).json({
      success: true,
      data: {
        userId: user.id,
        accountType: accountType,
        redirectTo: checkoutUrl ? '' : '/client/agency/dashboard',
        checkoutUrl,
      }
    });
  } catch (error) {
    console.error('Agency signup error:', error);

    // Handle unique constraint violation
    const dbError = error as { code?: string; constraint?: string };
    if (dbError?.code === '23505' && dbError?.constraint === 'users_email_unique') {
      try {
        const existingUser = await db.query.users.findFirst({
          where: eq(users.email, req.body.email)
        });

        if (existingUser) {
           res.status(409).json({
            success: false,
            error: `You already have a ${existingUser.accountType.toLowerCase().replace('_', ' ')} account. Please log in.`
          });
          return;
        }
      } catch (innerError) {
        console.error('Error checking existing user:', innerError);
      }
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Signup failed'
    });
  }
}

/**
 * Creator signup (direct B2C)
 */
export async function creatorSignup(
  req: Request,
  res: Response<ApiResponse<{ userId: string; accountType: string; redirectTo: string }>>
): Promise<void> {
  try {
    const validated = CreatorSignupSchema.parse(req.body);

    // Hash password
    const passwordHash = await bcrypt.hash(validated.password, 10);

    // Create direct creator user
    const [user] = await db.insert(users).values({
      email: validated.email,
      passwordHash,
      name: validated.name,
      businessName: validated.businessName,
      accountType: 'CREATOR',
      plan: 'FREE',
      subscriptionStatus: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14 days
    }).returning();

    // Create Autumn billing customer for creator
    const { error: autumnError } = await autumn.customers.create({
      id: user.id,
      name: validated.name || validated.email,
      email: validated.email,
    });
    if (autumnError) {
      console.error('Autumn customer creation failed for creator:', autumnError);
    }

    // Initiate Autumn checkout for creator plan
    const productId = getAutumnProductId('CREATOR');
    const successUrl = `${getFrontendBaseUrl()}/client/creator/connect-instagram?billing=success`;
    let checkoutUrl: string | undefined;

    const { data: checkoutData, error: checkoutError } = await autumn.checkout({
      customer_id: user.id,
      product_id: productId,
      success_url: successUrl,
    });
    if (checkoutError) {
      console.error('Autumn checkout failed for creator:', checkoutError);
    } else if (checkoutData?.url) {
      checkoutUrl = checkoutData.url;
    }

    // Create JWT session token
    const secret = process.env.BETTER_AUTH_SECRET || 'fallback-secret-key';
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        accountType: 'CREATOR'
      },
      secret,
      { expiresIn: '7d' }
    );

    // Set session cookies
    const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

    // Detect if we're in localhost development
    const isLocalhost = process.env.NODE_ENV === 'development' ||
                        process.env.BETTER_AUTH_URL?.includes('localhost') ||
                        process.env.BETTER_AUTH_URL?.includes('127.0.0.1');

    // For production (Railway, Vercel, etc.), always use secure cookies
    // Railway serves over HTTPS by default
    const isProduction = !!(process.env.NODE_ENV === 'production' ||
                            process.env.RAILWAY_ENVIRONMENT ||
                            process.env.USE_HTTPS === 'true');

    const cookieOptions = {
      httpOnly: true,
      secure: isProduction, // Always secure in production
      // For localhost, don't set sameSite to allow cross-origin cookies
      // For production, use 'none' to allow cross-origin requests (frontend on Vercel, backend on Railway)
      ...(isLocalhost ? {} : { sameSite: 'none' as const }),
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
      ...(cookieDomain && { domain: cookieDomain })
    };

    // Set session cookie (JWT for API authentication)
    res.cookie('better-auth.session_token', token, cookieOptions);

    // Set user cookie (for frontend middleware routing)
    res.cookie('user', JSON.stringify({
      userId: user.id,
      accountType: 'CREATOR'
    }), {
      ...cookieOptions,
      httpOnly: false // Frontend needs to read this
    });

    res.status(201).json({
      success: true,
      data: {
        userId: user.id,
        accountType: 'CREATOR',
        redirectTo: checkoutUrl || '/client/creator/connect-instagram'
      }
    });
  } catch (error) {
    console.error('Creator signup error:', error);

    // Handle unique constraint violation
    const dbError = error as { code?: string; constraint?: string };
    if (dbError?.code === '23505' && dbError?.constraint === 'users_email_unique') {
      try {
        const existingUser = await db.query.users.findFirst({
          where: eq(users.email, req.body.email)
        });
        
        if (existingUser) {
           res.status(409).json({
            success: false,
            error: `You already have a ${existingUser.accountType.toLowerCase().replace('_', ' ')} account. Please log in.`
          });
          return;
        }
      } catch (innerError) {
        console.error('Error checking existing user:', innerError);
      }
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Signup failed'
    });
  }
}

/**
 * Login
 */
export async function login(
  req: Request,
  res: Response<ApiResponse<{ userId: string; accountType: string; redirectTo: string; agencyId?: string }>>
): Promise<void> {
  try {
    console.log('🔐 [LOGIN] Login request received');
    const validated = LoginSchema.parse(req.body);
    console.log('🔐 [LOGIN] Validated input:', { email: validated.email });

    // Check users table first
    console.log('🔐 [LOGIN] Checking users table for email:', validated.email);
    const user = await db.query.users.findFirst({
      where: eq(users.email, validated.email)
    });

    if (user) {
      console.log('🔐 [LOGIN] User found in users table:', { 
        userId: user.id, 
        accountType: user.accountType,
        email: user.email 
      });

      // Verify password
      console.log('🔐 [LOGIN] Verifying password...');
      const validPassword = await bcrypt.compare(validated.password, user.passwordHash);
      
      if (!validPassword) {
        console.warn('🔐 [LOGIN] Invalid password for user:', validated.email);
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }

      console.log('🔐 [LOGIN] Password verified successfully');
      const redirectTo = isAgency(user.accountType)
        ? '/client/agency/dashboard'
        : '/client/creator/dashboard';

      console.log('🔐 [LOGIN] Creating session token...');

      // Create JWT session token
      const secret = process.env.BETTER_AUTH_SECRET || 'fallback-secret-key';
      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          accountType: user.accountType
        },
        secret,
        { expiresIn: '7d' }
      );

      console.log('🔐 [LOGIN] Session token created');

      // Set session cookie (JWT for API authentication)
      const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

      // Detect if we're in localhost development
      const isLocalhost = process.env.NODE_ENV === 'development' ||
                          process.env.BETTER_AUTH_URL?.includes('localhost') ||
                          process.env.BETTER_AUTH_URL?.includes('127.0.0.1');

      // For production (Railway, Vercel, etc.), always use secure cookies
      const isProduction = !!(process.env.NODE_ENV === 'production' ||
                              process.env.RAILWAY_ENVIRONMENT ||
                              process.env.USE_HTTPS === 'true');

      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        // For localhost, don't set sameSite to allow cross-origin cookies
        // For production, use 'none' to allow cross-origin requests
        ...(isLocalhost ? {} : { sameSite: 'none' as const }),
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/',
        ...(cookieDomain && { domain: cookieDomain })
      };

      res.cookie('better-auth.session_token', token, cookieOptions);

      // Set user cookie (for frontend middleware routing)
      res.cookie('user', JSON.stringify({
        userId: user.id,
        accountType: user.accountType
      }), {
        ...cookieOptions,
        httpOnly: false // Frontend needs to read this
      });

      console.log('🔐 [LOGIN] Session cookies set');
      console.log('🔐 [LOGIN] Login successful for user:', {
        userId: user.id,
        accountType: user.accountType,
        redirectTo
      });

      res.json({
        success: true,
        data: {
          userId: user.id,
          accountType: user.accountType,
          redirectTo
        }
      });
      return;
    }

    console.log('🔐 [LOGIN] User not found in users table, checking clients table...');
    // Check clients table (agency-managed clients)
    const client = await db.query.clients.findFirst({
      where: eq(clients.email, validated.email)
    });

    if (client) {
      console.log('🔐 [LOGIN] Client found in clients table:', { 
        clientId: client.id,
        email: client.email 
      });

      // Verify password
      console.log('🔐 [LOGIN] Verifying client password...');
      const validPassword = await bcrypt.compare(validated.password, client.passwordHash);
      
      if (!validPassword) {
        console.warn('🔐 [LOGIN] Invalid password for client:', validated.email);
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }

      console.log('🔐 [LOGIN] Client password verified successfully');

      // Determine redirect based on whether client is agency-managed
      const redirectTo = client.userId ? `/client/manage/${client.id}/dashboard` : '/client/dashboard';

      console.log('🔐 [LOGIN] Creating session token for client...');

      // Create JWT session token
      const secret = process.env.BETTER_AUTH_SECRET || 'fallback-secret-key';
      const token = jwt.sign(
        {
          userId: client.id,
          email: client.email,
          accountType: client.accountType || 'CLIENT',
          agencyId: client.userId
        },
        secret,
        { expiresIn: '7d' }
      );

      console.log('🔐 [LOGIN] Session token created for client');

      // Set session cookie (JWT for API authentication)
      const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

      // Detect if we're in localhost development
      const isLocalhost = process.env.NODE_ENV === 'development' ||
                          process.env.BETTER_AUTH_URL?.includes('localhost') ||
                          process.env.BETTER_AUTH_URL?.includes('127.0.0.1');

      // For production (Railway, Vercel, etc.), always use secure cookies
      const isProduction = !!(process.env.NODE_ENV === 'production' ||
                              process.env.RAILWAY_ENVIRONMENT ||
                              process.env.USE_HTTPS === 'true');

      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        // For localhost, don't set sameSite to allow cross-origin cookies
        // For production, use 'none' to allow cross-origin requests
        ...(isLocalhost ? {} : { sameSite: 'none' as const }),
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/',
        ...(cookieDomain && { domain: cookieDomain })
      };

      res.cookie('better-auth.session_token', token, cookieOptions);

      // Set user cookie (for frontend middleware routing)
      res.cookie('user', JSON.stringify({
        userId: client.id,
        accountType: client.accountType || 'CLIENT',
        ...(client.userId ? { agencyId: client.userId } : {})
      }), {
        ...cookieOptions,
        httpOnly: false // Frontend needs to read this
      });

      console.log('🔐 [LOGIN] Session cookies set for client');
      console.log('🔐 [LOGIN] Login successful for client:', {
        clientId: client.id,
        agencyId: client.userId,
        redirectTo
      });

      res.json({
        success: true,
        data: {
          userId: client.id,
          accountType: client.accountType || 'CLIENT',
          redirectTo,
          ...(client.userId ? { agencyId: client.userId } : {})
        }
      });
      return;
    }

    console.warn('🔐 [LOGIN] No user or client found with email:', validated.email);
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  } catch (error) {
    console.error('🔐 [LOGIN] Login error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Login failed'
    });
  }
}

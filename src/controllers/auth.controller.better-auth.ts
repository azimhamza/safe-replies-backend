import { Request, Response } from 'express';
import { db } from '../db';
import { users, clients } from '../db/schema';
import { AgencySignupSchema, CreatorSignupSchema, LoginSchema } from '../validation/schemas';
import { ApiResponse } from '../types';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { isAgency } from '../utils/account-type.utils';
import { autumn } from '../services/autumn.service';
import { signInUser, setSessionCookies, createSessionForUser } from '../utils/auth.helpers';

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
 * Login with better-auth
 */
export async function login(
  req: Request,
  res: Response<ApiResponse<{ userId: string; accountType: string; redirectTo: string; agencyId?: string }>>
): Promise<void> {
  try {
    console.log('🔐 [LOGIN] Login request received');
    const validated = LoginSchema.parse(req.body);
    console.log('🔐 [LOGIN] Validated input:', { email: validated.email });

    // Sign in user and create better-auth session
    const authResult = await signInUser(
      {
        email: validated.email,
        password: validated.password
      },
      {
        headers: req.headers,
        get: (name: string) => req.get(name)
      }
    );

    console.log('🔐 [LOGIN] User authenticated:', {
      userId: authResult.user.id,
      accountType: authResult.user.accountType
    });

    // Determine redirect based on account type
    let redirectTo: string;
    if (authResult.user.accountType === 'CLIENT') {
      // Check if client has agencyId
      const client = await db.query.clients.findFirst({
        where: eq(clients.id, authResult.user.id)
      });
      redirectTo = client?.userId
        ? `/client/manage/${authResult.user.id}/dashboard`
        : '/client/dashboard';
    } else {
      redirectTo = isAgency(authResult.user.accountType)
        ? '/client/agency/dashboard'
        : '/client/creator/dashboard';
    }

    // Set session cookies
    setSessionCookies(
      res,
      authResult.session.token,
      authResult.user.id,
      authResult.user.accountType
    );

    console.log('🔐 [LOGIN] Session cookies set');
    console.log('🔐 [LOGIN] Session token:', authResult.session.token);
    console.log('🔐 [LOGIN] Cookie should be: better-auth.session_token=' + authResult.session.token);
    console.log('🔐 [LOGIN] Login successful for user:', {
      userId: authResult.user.id,
      accountType: authResult.user.accountType,
      redirectTo
    });

    // Get agencyId if client
    let agencyId: string | undefined;
    if (authResult.user.accountType === 'CLIENT') {
      const client = await db.query.clients.findFirst({
        where: eq(clients.id, authResult.user.id)
      });
      agencyId = client?.userId;
    }

    res.json({
      success: true,
      data: {
        userId: authResult.user.id,
        accountType: authResult.user.accountType,
        redirectTo,
        ...(agencyId && { agencyId })
      }
    });
  } catch (error) {
    console.error('🔐 [LOGIN] Login error:', error);

    // Check if it's an authentication error
    if (error instanceof Error && error.message === 'Invalid credentials') {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Login failed'
    });
  }
}

/**
 * Agency signup with better-auth
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

    // Create better-auth session
    const sessionResult = await createSessionForUser(user.id, user.email, {
      headers: req.headers,
      get: (name: string) => req.get(name)
    });

    // Set session cookies
    setSessionCookies(res, sessionResult.sessionId, user.id, accountType);

    res.status(201).json({
      success: true,
      data: {
        userId: user.id,
        accountType: accountType,
        redirectTo: checkoutUrl || '/client/agency/onboarding/branding',
        checkoutUrl
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
 * Creator signup with better-auth
 */
export async function creatorSignup(
  req: Request,
  res: Response<ApiResponse<{ userId: string; accountType: string; redirectTo: string; checkoutUrl?: string }>>
): Promise<void> {
  try {
    const validated = CreatorSignupSchema.parse(req.body);

    // Hash password
    const passwordHash = await bcrypt.hash(validated.password, 10);

    // Create creator user
    const [user] = await db.insert(users).values({
      email: validated.email,
      passwordHash,
      name: validated.name,
      accountType: 'CREATOR',
      plan: 'STARTER',
      subscriptionStatus: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14 days
    }).returning();

    // Create Autumn billing customer
    const { error: autumnError } = await autumn.customers.create({
      id: user.id,
      name: validated.name || validated.email,
      email: validated.email,
    });
    if (autumnError) {
      console.error('Autumn customer creation failed:', autumnError);
    }

    // Initiate Autumn checkout
    const productId = getAutumnProductId('CREATOR');
    const successUrl = `${getFrontendBaseUrl()}/client/creator/connect-instagram?billing=success`;
    let checkoutUrl: string | undefined;

    const { data: checkoutData, error: checkoutError } = await autumn.checkout({
      customer_id: user.id,
      product_id: productId,
      success_url: successUrl,
    });
    if (checkoutError) {
      console.error('Autumn checkout failed:', checkoutError);
    } else if (checkoutData?.url) {
      checkoutUrl = checkoutData.url;
    }

    // Create better-auth session
    const sessionResult = await createSessionForUser(user.id, user.email, {
      headers: req.headers,
      get: (name: string) => req.get(name)
    });

    // Set session cookies
    setSessionCookies(res, sessionResult.sessionId, user.id, 'CREATOR');

    res.status(201).json({
      success: true,
      data: {
        userId: user.id,
        accountType: 'CREATOR',
        redirectTo: checkoutUrl || '/client/creator/connect-instagram',
        checkoutUrl
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

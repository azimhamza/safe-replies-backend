import { Autumn } from 'autumn-js';
import { db } from '../db';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';

export const autumn = new Autumn({
  secretKey: process.env.AUTUMN_KEY,
});

/**
 * Resolve the Autumn billing customer ID.
 *
 * - If the owner is a direct user (agency or creator), return their userId.
 * - If the owner is a CLIENT, return their managing agency's userId instead
 *   (clients are not Autumn customers — the agency pays).
 * - Returns null if the billing owner cannot be determined.
 */
export async function resolveBillingCustomerId(params: {
  userId?: string;
  clientId?: string;
  accountType?: string;
}): Promise<string | null> {
  const { userId, clientId, accountType } = params;

  // Direct user (agency or creator) — they are the billing customer
  if (userId && accountType !== 'CLIENT') {
    return userId;
  }

  // Client-owned — look up the managing agency
  const ownerId = clientId || userId;
  if (!ownerId) return null;

  const client = await db.query.clients.findFirst({
    columns: { userId: true },
    where: eq(clients.id, ownerId),
  });

  return client?.userId ?? null;
}

/**
 * Check whether a feature is allowed for the billing customer.
 * Returns { allowed, billingCustomerId } so callers can decide whether to proceed.
 * If the billing customer cannot be resolved, returns allowed = true (fail-open for
 * unlinked accounts — they won't have a subscription anyway).
 */
export async function checkFeatureAllowed(params: {
  userId?: string;
  clientId?: string;
  accountType?: string;
  featureId: string;
}): Promise<{ allowed: boolean; billingCustomerId: string | null }> {
  const billingCustomerId = await resolveBillingCustomerId({
    userId: params.userId,
    clientId: params.clientId,
    accountType: params.accountType,
  });

  if (!billingCustomerId) {
    return { allowed: true, billingCustomerId: null };
  }

  try {
    const { data } = await autumn.check({
      customer_id: billingCustomerId,
      feature_id: params.featureId,
    });

    return {
      allowed: (data as { allowed?: boolean })?.allowed !== false,
      billingCustomerId,
    };
  } catch (err: unknown) {
    console.error(`Autumn check (${params.featureId}) failed:`, err);
    // Fail-open: don't block users if billing service is down
    return { allowed: true, billingCustomerId };
  }
}

import { Response } from 'express';
import { autumn, resolveBillingCustomerId } from '../services/autumn.service';
import { AuthRequest } from '../middleware/auth.middleware';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

interface BillingStatusResponse {
  success: boolean;
  data?: {
    status: string;
    productId: string | null;
    productName: string | null;
    trialEndsAt: number | null;
    currentPeriodEnd: number | null;
    agencyEmail?: string | null;
  };
  error?: string;
}

/**
 * GET /api/billing/status
 *
 * Returns the billing status for the current user.
 * - Agencies/Creators: returns their own subscription status
 * - Clients: returns their managing agency's subscription status
 */
export async function getBillingStatus(
  req: AuthRequest,
  res: Response<BillingStatusResponse>
): Promise<void> {
  try {
    const userId = req.userId;
    const accountType = req.accountType;

    if (!userId || !accountType) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // Resolve the billing customer (for clients, this is their agency)
    const billingCustomerId = await resolveBillingCustomerId({
      userId,
      clientId: accountType === 'CLIENT' ? userId : undefined,
      accountType,
    });

    if (!billingCustomerId) {
      res.json({
        success: true,
        data: {
          status: 'none',
          productId: null,
          productName: null,
          trialEndsAt: null,
          currentPeriodEnd: null,
        },
      });
      return;
    }

    // Fetch customer data from Autumn
    const { data: customer, error: customerError } = await autumn.customers.get(billingCustomerId);

    if (customerError || !customer) {
      console.error('Failed to fetch Autumn customer for billing status:', customerError);
      res.json({
        success: true,
        data: {
          status: 'none',
          productId: null,
          productName: null,
          trialEndsAt: null,
          currentPeriodEnd: null,
        },
      });
      return;
    }

    // Get the active product (first non-default, non-add-on product)
    const activeProduct = customer.products.find(
      (p) => !p.is_default && !p.is_add_on
    );

    // If client, also fetch the agency email so we can show it in the banner
    let agencyEmail: string | null = null;
    if (accountType === 'CLIENT' && billingCustomerId !== userId) {
      const agency = await db.query.users.findFirst({
        columns: { email: true },
        where: eq(users.id, billingCustomerId),
      });
      agencyEmail = agency?.email ?? null;
    }

    res.json({
      success: true,
      data: {
        status: activeProduct?.status ?? 'none',
        productId: activeProduct?.id ?? null,
        productName: activeProduct?.name ?? null,
        trialEndsAt: activeProduct?.trial_ends_at ?? null,
        currentPeriodEnd: activeProduct?.current_period_end ?? null,
        agencyEmail,
      },
    });
  } catch (error) {
    console.error('Billing status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch billing status',
    });
  }
}

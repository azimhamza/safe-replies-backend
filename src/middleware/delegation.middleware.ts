import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { db } from '../db';
import { users, clients } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export interface DelegationRequest extends AuthRequest {
  effectiveClientId?: string;
  effectiveUserId?: string;
  isAgencyDelegation: boolean;
}

/**
 * Middleware that handles agency delegation to client accounts
 * Allows agencies to access client data by passing ?clientId=UUID
 */
export async function delegationMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const delegationReq = req as DelegationRequest;
    const { clientId } = req.query;

    // Handle CLIENT account type (managed clients created by agencies)
    // For CLIENTs, req.userId is actually their client ID from the clients table
    if (req.accountType === 'CLIENT') {
      delegationReq.isAgencyDelegation = false;
      delegationReq.effectiveClientId = req.userId; // CLIENT's userId IS their clientId
      delegationReq.effectiveUserId = undefined;
      return next();
    }

    // If no clientId is provided, proceed normally (for AGENCY or CREATOR users)
    if (!clientId || typeof clientId !== 'string') {
      delegationReq.isAgencyDelegation = false;
      delegationReq.effectiveClientId = undefined;
      delegationReq.effectiveUserId = req.userId;
      return next();
    }

    // Verify the authenticated user is an agency
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
      return;
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.userId)
    });

    if (!user || (user.accountType !== 'BASIC_AGENCY' && user.accountType !== 'MAX_AGENCY')) {
      res.status(403).json({
        success: false,
        error: 'Only agencies can access client data'
      });
      return;
    }

    // Verify the client belongs to this agency
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.userId, req.userId)
      )
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Client not found or does not belong to your agency'
      });
      return;
    }

    // Set delegation context
    delegationReq.isAgencyDelegation = true;
    delegationReq.effectiveClientId = clientId;
    delegationReq.effectiveUserId = undefined;

    console.log(`🔄 [DELEGATION] Agency ${req.userId} accessing client ${clientId} data`);

    next();
  } catch (error) {
    console.error('Delegation middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process delegation'
    });
  }
}

/**
 * Helper function to get the effective owner IDs for database queries
 * Returns { userId, clientId } based on whether it's a delegation or direct access
 */
export function getEffectiveOwner(req: DelegationRequest): {
  userId: string | undefined;
  clientId: string | undefined;
} {
  // If there's an effectiveClientId set (either from agency delegation or CLIENT account type),
  // use that as the clientId
  if (req.effectiveClientId) {
    return {
      userId: undefined,
      clientId: req.effectiveClientId
    };
  }

  // For direct user access (AGENCY or CREATOR without delegation)
  return {
    userId: req.effectiveUserId,
    clientId: undefined
  };
}

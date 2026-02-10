import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { DelegationRequest, getEffectiveOwner } from '../middleware/delegation.middleware';
import { whitelistService } from '../services/whitelist.service';
import { db } from '../db';
import { whitelistedIdentifiers } from '../db/schema';
import { eq, and, SQL } from 'drizzle-orm';

export class WhitelistController {
  /**
   * Get all whitelisted identifiers (including commenters)
   */
  async getWhitelist(req: AuthRequest, res: Response): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const identifiers = await whitelistService.getAll(clientId, userId);

      res.json({
        success: true,
        data: identifiers
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get whitelist error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch whitelist' });
    }
  }

  /**
   * Get whitelisted commenters specifically
   */
  async getWhitelistedCommenters(req: AuthRequest, res: Response): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const instagramAccountId = req.query.instagramAccountId as string | undefined;
      const commenters = await whitelistService.getWhitelistedCommenters(
        clientId,
        userId,
        instagramAccountId === 'null' ? null : instagramAccountId
      );

      // Service already returns enriched data with instagramAccount info
      res.json({
        success: true,
        data: commenters
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get whitelisted commenters error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch whitelisted commenters' });
    }
  }

  /**
   * Add identifier to whitelist
   */
  async addIdentifier(req: AuthRequest, res: Response): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { identifier, identifierType, description } = req.body;

      if (!identifier || !identifierType) {
        res.status(400).json({ success: false, error: 'Identifier and type are required' });
        return;
      }

      await whitelistService.add(identifier, identifierType, description, clientId, userId);

      res.json({
        success: true,
        message: 'Identifier added to whitelist'
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Add identifier to whitelist error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to add identifier to whitelist' });
    }
  }

  /**
   * Add commenter to whitelist (by commenterId or commenterUsername)
   */
  async addCommenter(req: AuthRequest, res: Response): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { commenterId, commenterUsername, description, instagramAccountId } = req.body;

      if (!commenterUsername) {
        res.status(400).json({ success: false, error: 'commenterUsername is required' });
        return;
      }

      // Validate instagramAccountId if provided
      if (instagramAccountId) {
        const { instagramAccounts } = await import('../db/schema');
        const { eq, and } = await import('drizzle-orm');
        const accountOwnershipCondition = clientId
          ? eq(instagramAccounts.clientId, clientId)
          : userId
            ? eq(instagramAccounts.userId, userId)
            : undefined;

        if (accountOwnershipCondition) {
          const accountCheck = await db
            .select()
            .from(instagramAccounts)
            .where(
              and(
                eq(instagramAccounts.id, instagramAccountId),
                accountOwnershipCondition
              )
            )
            .limit(1);

          if (accountCheck.length === 0) {
            res.status(403).json({ success: false, error: 'Instagram account not found or not authorized' });
            return;
          }
        }
      }

      await whitelistService.addCommenter(
        commenterId,
        commenterUsername,
        description,
        instagramAccountId || null,
        clientId,
        userId
      );

      res.json({
        success: true,
        message: 'Commenter added to whitelist'
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Add commenter to whitelist error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to add commenter to whitelist' });
    }
  }

  /**
   * Remove identifier from whitelist
   */
  async removeIdentifier(req: AuthRequest, res: Response): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;

      // Soft delete by setting isActive to false
      const whereConditions = [
        eq(whitelistedIdentifiers.id, id),
        clientId ? eq(whitelistedIdentifiers.clientId, clientId) : undefined,
        !clientId && userId ? eq(whitelistedIdentifiers.userId, userId) : undefined
      ].filter((condition): condition is SQL => condition !== undefined);

      await db
        .update(whitelistedIdentifiers)
        .set({ isActive: false })
        .where(and(...whereConditions));

      res.json({
        success: true,
        message: 'Identifier removed from whitelist'
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Remove identifier from whitelist error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to remove identifier from whitelist' });
    }
  }

  /**
   * Remove commenter from whitelist
   */
  async removeCommenter(req: AuthRequest, res: Response): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { commenterId, commenterUsername } = req.body;

      if (!commenterId && !commenterUsername) {
        res.status(400).json({ success: false, error: 'Either commenterId or commenterUsername is required' });
        return;
      }

      await whitelistService.removeCommenter(
        commenterId || commenterUsername,
        commenterUsername || commenterId,
        clientId,
        userId
      );

      res.json({
        success: true,
        message: 'Commenter removed from whitelist'
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Remove commenter from whitelist error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to remove commenter from whitelist' });
    }
  }
}

export const whitelistController = new WhitelistController();

import { Response } from 'express';
import { db } from '../db';
import {
  suspiciousAccounts,
  customFilters,
  instagramAccounts,
  clients,
  comments,
  posts
} from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { instagramService } from '../services/instagram.service';
import { DelegationRequest } from '../middleware/delegation.middleware';

interface UnderAttackRequest {
  attackType: 'account' | 'content';
  username?: string;
  instagramAccountId?: string;
  contentDescription?: string;
  category?: 'blackmail' | 'threat' | 'defamation' | 'harassment' | 'spam';
}

interface UnderAttackResponse {
  success: boolean;
  action: 'account_blocked' | 'filter_created';
  details: {
    deletedCount?: number;
    postsScanned?: number;
    filterId?: string;
    suspiciousAccountId?: string;
  };
  error?: string;
}

export class UnderAttackController {
  /**
   * Main handler for emergency attack responses
   */
  async handleUnderAttack(
    req: DelegationRequest,
    res: Response<UnderAttackResponse>
  ): Promise<void> {
    try {
      const userId = req.userId;
      const clientId = req.effectiveClientId;

      if (!userId && !clientId) {
        res.status(401).json({
          success: false,
          action: 'account_blocked',
          details: {},
          error: 'Unauthorized'
        });
        return;
      }

      const {
        attackType,
        username,
        instagramAccountId,
        contentDescription,
        category
      } = req.body as UnderAttackRequest;

      // Validate attack type
      if (!attackType || (attackType !== 'account' && attackType !== 'content')) {
        res.status(400).json({
          success: false,
          action: 'account_blocked',
          details: {},
          error: 'Invalid attack type'
        });
        return;
      }

      // Handle account-based attacks
      if (attackType === 'account') {
        await this.handleAccountAttack(req, res, username!, instagramAccountId!, userId, clientId);
        return;
      }

      // Handle content-based attacks
      if (attackType === 'content') {
        await this.handleContentAttack(req, res, contentDescription!, category!, userId, clientId);
        return;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Under attack error:', errorMessage);
      res.status(500).json({
        success: false,
        action: 'account_blocked',
        details: {},
        error: 'Failed to process request'
      });
    }
  }

  /**
   * Handle account-based attacks (mark user as blocked and delete all comments)
   * Note: We mark the user as blocked in our DB and enable auto-delete.
   * Instagram API does not support programmatic blocking.
   */
  private async handleAccountAttack(
    _req: DelegationRequest,
    res: Response<UnderAttackResponse>,
    username: string,
    instagramAccountId: string,
    userId: string | undefined,
    clientId: string | undefined
  ): Promise<void> {
    // Validate required fields
    if (!username || !instagramAccountId) {
      res.status(400).json({
        success: false,
        action: 'account_blocked',
        details: {},
        error: 'Username and Instagram account ID are required'
      });
      return;
    }

    // Normalize username (remove @ prefix)
    const normalizedUsername = username.replace(/^@/, '').toLowerCase().trim();

    // Validate username format
    if (normalizedUsername.length < 3 || !/^[a-z0-9._]+$/.test(normalizedUsername)) {
      res.status(400).json({
        success: false,
        action: 'account_blocked',
        details: {},
        error: 'Invalid username format'
      });
      return;
    }

    // Verify ownership of Instagram account
    const ownershipCondition = clientId
      ? eq(instagramAccounts.clientId, clientId)
      : userId
        ? sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
            SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
          )`
        : undefined;

    if (!ownershipCondition) {
      res.status(401).json({
        success: false,
        action: 'account_blocked',
        details: {},
        error: 'Unauthorized'
      });
      return;
    }

    const accountCheck = await db
      .select({
        id: instagramAccounts.id,
        accessToken: instagramAccounts.accessToken,
        username: instagramAccounts.username
      })
      .from(instagramAccounts)
      .where(and(eq(instagramAccounts.id, instagramAccountId), ownershipCondition))
      .limit(1);

    if (accountCheck.length === 0) {
      res.status(403).json({
        success: false,
        action: 'account_blocked',
        details: {},
        error: 'Instagram account not found or access denied'
      });
      return;
    }

    const account = accountCheck[0];

    // Search for existing suspicious account entry
    let suspiciousAccount = await db.query.suspiciousAccounts.findFirst({
      where: and(
        eq(suspiciousAccounts.instagramAccountId, instagramAccountId),
        eq(suspiciousAccounts.commenterUsername, normalizedUsername)
      )
    });

    // If not found, create a new suspicious account entry
    if (!suspiciousAccount) {
      const [newAccount] = await db
        .insert(suspiciousAccounts)
        .values({
          instagramAccountId,
          commenterId: `manual_${Date.now()}`, // Temporary ID, will be updated if we get real Instagram ID
          commenterUsername: normalizedUsername,
          totalComments: 0,
          flaggedComments: 0,
          deletedComments: 0,
          blackmailCount: 0,
          threatCount: 0,
          harassmentCount: 0,
          spamCount: 0,
          defamationCount: 0,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          isBlocked: false,
          autoDeleteEnabled: false,
          autoHideEnabled: false
        })
        .returning();

      suspiciousAccount = newAccount;
    }

    // Note: We CANNOT actually block users on Instagram via API.
    // We can only mark them as blocked in our database and auto-delete their comments.

    // Enable auto-delete in database (this will auto-delete all future comments)
    await db
      .update(suspiciousAccounts)
      .set({
        autoDeleteEnabled: true,
        isBlocked: true,
        blockedAt: new Date(),
        blockReason: 'Under Attack - Emergency block',
        autoHideEnabled: false, // Turn off auto-hide when enabling auto-delete
        updatedAt: new Date()
      })
      .where(eq(suspiciousAccounts.id, suspiciousAccount.id));

    // Delete all existing comments from this user
    let deletedCount = 0;
    let postsScanned = 0;

    if (account.accessToken) {
      // Find all comments from this commenter by joining with posts
      const commentsToDelete = await db
        .select({
          id: comments.id,
          igCommentId: comments.igCommentId,
          postId: comments.postId
        })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .where(
          and(
            eq(posts.instagramAccountId, instagramAccountId),
            eq(comments.commenterUsername, normalizedUsername),
            eq(comments.isDeleted, false)
          )
        );

      postsScanned = commentsToDelete.length > 0
        ? new Set(commentsToDelete.map((c) => c.postId)).size
        : 0;

      // Delete each comment
      for (const comment of commentsToDelete) {
        if (comment.igCommentId) {
          try {
            await instagramService.deleteComment(
              comment.igCommentId,
              account.accessToken!
            );
          } catch (err) {
            console.warn(
              `[Under Attack] Instagram delete failed for comment ${comment.id}:`,
              err
            );
          }
        }

        // Mark as deleted in database
        await db
          .update(comments)
          .set({ isDeleted: true, deletedAt: new Date() })
          .where(eq(comments.id, comment.id));

        deletedCount++;
      }

      if (deletedCount > 0) {
        console.log(
          `[Under Attack] Deleted ${deletedCount} existing comment(s) for @${normalizedUsername}`
        );
      }
    }

    res.json({
      success: true,
      action: 'account_blocked',
      details: {
        deletedCount,
        postsScanned,
        suspiciousAccountId: suspiciousAccount.id
      }
    });
  }

  /**
   * Handle content-based attacks (create auto-delete filter)
   */
  private async handleContentAttack(
    _req: DelegationRequest,
    res: Response<UnderAttackResponse>,
    contentDescription: string,
    category: 'blackmail' | 'threat' | 'defamation' | 'harassment' | 'spam',
    userId: string | undefined,
    clientId: string | undefined
  ): Promise<void> {
    // Validate required fields
    if (!contentDescription) {
      res.status(400).json({
        success: false,
        action: 'filter_created',
        details: {},
        error: 'Content description is required'
      });
      return;
    }

    if (contentDescription.length < 10) {
      res.status(400).json({
        success: false,
        action: 'filter_created',
        details: {},
        error: 'Content description must be at least 10 characters'
      });
      return;
    }

    // Validate category
    const validCategories = ['blackmail', 'threat', 'defamation', 'harassment', 'spam'];
    const finalCategory = category || 'harassment';

    if (!validCategories.includes(finalCategory)) {
      res.status(400).json({
        success: false,
        action: 'filter_created',
        details: {},
        error: 'Invalid category'
      });
      return;
    }

    // Create filter name (truncate to 50 chars)
    const filterName = contentDescription.length > 50
      ? `${contentDescription.substring(0, 47)}...`
      : contentDescription;

    // Create global custom filter
    const [createdFilter] = await db
      .insert(customFilters)
      .values({
        userId: clientId ? null : userId,
        clientId: clientId || null,
        instagramAccountId: null, // Global filter
        name: filterName,
        prompt: contentDescription, // Use exact text as filter
        category: finalCategory,
        scope: 'GENERAL',
        description: `Auto-created from Under Attack feature - ${finalCategory}`,
        isEnabled: true,
        autoHide: false,
        autoDelete: true, // Auto-delete matching comments
        autoFlag: false
      })
      .returning();

    res.json({
      success: true,
      action: 'filter_created',
      details: {
        filterId: createdFilter.id
      }
    });
  }
}

export const underAttackController = new UnderAttackController();

import { db } from '../db';
import { whitelistedIdentifiers, suspiciousAccounts } from '../db/schema';
import { ExtractedIdentifier, IdentifierType } from '../types';
import { eq, and, or, isNull } from 'drizzle-orm';

export class WhitelistService {
  /**
   * Check if a commenter (by commenterId or commenterUsername) is whitelisted
   * Returns true if the commenter is whitelisted (should skip moderation entirely)
   * Checks both account-specific and global whitelists
   */
  async checkCommenter(
    commenterId: string,
    commenterUsername: string,
    instagramAccountId: string | undefined,
    clientId?: string,
    userId?: string
  ): Promise<boolean> {
    // Determine the effective owner for whitelist checking
    // If both are provided, use the actual Instagram account owner
    let effectiveClientId: string | undefined = clientId;
    let effectiveUserId: string | undefined = userId;

    if (instagramAccountId && clientId && userId) {
      const { instagramAccounts } = await import('../db/schema');
      const { eq } = await import('drizzle-orm');
      const { db } = await import('../db');

      const igAccount = await db.query.instagramAccounts.findFirst({
        where: eq(instagramAccounts.id, instagramAccountId),
        columns: { userId: true, clientId: true }
      });

      if (igAccount) {
        // Use the owner that actually owns this specific Instagram account record
        effectiveClientId = igAccount.clientId ?? undefined;
        effectiveUserId = igAccount.userId ?? undefined;
      }
    }

    const ownershipWhere = effectiveClientId
      ? eq(whitelistedIdentifiers.clientId, effectiveClientId)
      : effectiveUserId
      ? eq(whitelistedIdentifiers.userId, effectiveUserId)
      : undefined;

    if (!ownershipWhere) {
      return false;
    }

    // Normalize username
    const normalizedUsername = commenterUsername.startsWith('@')
      ? commenterUsername.toLowerCase()
      : `@${commenterUsername.toLowerCase()}`;

    // Build account filter: check account-specific first, then global (null)
    const accountFilter = instagramAccountId
      ? or(
          eq(whitelistedIdentifiers.instagramAccountId, instagramAccountId),
          isNull(whitelistedIdentifiers.instagramAccountId)
        )
      : isNull(whitelistedIdentifiers.instagramAccountId); // Only global if no account specified

    // Check by commenterId (stored as USERNAME type with the commenterId as identifier)
    const byId = await db.query.whitelistedIdentifiers.findFirst({
      where: and(
        ownershipWhere,
        accountFilter,
        eq(whitelistedIdentifiers.identifier, commenterId.toLowerCase()),
        eq(whitelistedIdentifiers.identifierType, 'USERNAME'),
        eq(whitelistedIdentifiers.isActive, true)
      )
    });

    if (byId) {
      return true;
    }

    // Check by commenterUsername (with or without @)
    const byUsername = await db.query.whitelistedIdentifiers.findFirst({
      where: and(
        ownershipWhere,
        accountFilter,
        eq(whitelistedIdentifiers.identifier, normalizedUsername),
        eq(whitelistedIdentifiers.identifierType, 'USERNAME'),
        eq(whitelistedIdentifiers.isActive, true)
      )
    });

    return !!byUsername;
  }

  /**
   * Check if any extracted identifiers are whitelisted
   * Returns true if ANY identifier is whitelisted (should skip moderation)
   */
  async check(
    identifiers: ExtractedIdentifier[],
    clientId?: string,
    userId?: string
  ): Promise<boolean> {
    if (identifiers.length === 0) {
      return false;
    }

    // Build where clause based on ownership
    // Use the provided owner (delegation context ensures only one is set)
    const ownershipWhere = clientId
      ? eq(whitelistedIdentifiers.clientId, clientId)
      : userId
      ? eq(whitelistedIdentifiers.userId, userId)
      : undefined;

    if (!ownershipWhere) {
      return false;
    }

    // Check each identifier
    for (const identifier of identifiers) {
      // Skip identifiers with null or undefined values (defensive check - should be filtered at LLM level)
      if (!identifier.value) {
        console.warn(`⚠️  WhitelistService: Skipping identifier with null/undefined value. Type: ${identifier.type}, Platform: ${identifier.platform || 'N/A'}`);
        continue;
      }

      const whitelisted = await db.query.whitelistedIdentifiers.findFirst({
        where: and(
          ownershipWhere,
          eq(whitelistedIdentifiers.identifier, identifier.value.toLowerCase()),
          eq(whitelistedIdentifiers.identifierType, identifier.type),
          eq(whitelistedIdentifiers.isActive, true)
        )
      });

      if (whitelisted) {
        return true; // At least one identifier is whitelisted
      }

      // Check domain whitelist for emails
      if (identifier.type === 'EMAIL') {
        const domain = identifier.value.split('@')[1];
        if (domain) {
          const domainWhitelisted = await db.query.whitelistedIdentifiers.findFirst({
            where: and(
              ownershipWhere,
              eq(whitelistedIdentifiers.identifier, domain.toLowerCase()),
              eq(whitelistedIdentifiers.identifierType, 'DOMAIN'),
              eq(whitelistedIdentifiers.isActive, true)
            )
          });

          if (domainWhitelisted) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Auto-whitelist when Instagram account is connected
   */
  async autoWhitelistInstagramAccount(
    instagramUsername: string,
    clientId?: string,
    userId?: string
  ): Promise<void> {
    await db.insert(whitelistedIdentifiers).values({
      clientId: clientId ?? null,
      userId: userId ?? null,
      identifier: `@${instagramUsername}`.toLowerCase(),
      identifierType: 'USERNAME',
      description: 'Your connected Instagram account (auto-whitelisted)',
      isAutoAdded: true,
      isActive: true
    });
  }

  /**
   * Add identifier to whitelist
   */
  async add(
    identifier: string,
    type: IdentifierType | string,
    description: string | undefined,
    clientId?: string,
    userId?: string
  ): Promise<void> {
    await db.insert(whitelistedIdentifiers).values({
      clientId: clientId ?? null,
      userId: userId ?? null,
      identifier: identifier.toLowerCase(),
      identifierType: type as typeof whitelistedIdentifiers.$inferInsert.identifierType,
      description: description ?? null,
      isAutoAdded: false,
      isActive: true
    });
  }

  /**
   * Add a commenter to the whitelist (by commenterId or commenterUsername)
   * @param instagramAccountId - If provided, creates account-specific whitelist. If null, creates global whitelist.
   */
  async addCommenter(
    commenterId: string | undefined,
    commenterUsername: string,
    description: string | undefined,
    instagramAccountId: string | null | undefined,
    clientId?: string,
    userId?: string
  ): Promise<void> {
    const ownershipWhere = clientId
      ? eq(whitelistedIdentifiers.clientId, clientId)
      : userId
      ? eq(whitelistedIdentifiers.userId, userId)
      : undefined;

    if (!ownershipWhere) {
      throw new Error('Either clientId or userId must be provided');
    }

    // Normalize username (remove @ if present)
    const normalizedUsername = commenterUsername.startsWith('@')
      ? commenterUsername.substring(1).toLowerCase()
      : commenterUsername.toLowerCase();

    // If commenterId not provided, try to find it from suspicious accounts
    let actualCommenterId = commenterId;
    if (!actualCommenterId) {
      const account = await db.query.suspiciousAccounts.findFirst({
        where: eq(suspiciousAccounts.commenterUsername, normalizedUsername),
        orderBy: (accounts, { desc }) => [desc(accounts.lastSeenAt)]
      });
      if (account) {
        actualCommenterId = account.commenterId;
      } else {
        // If not found, use username as fallback
        actualCommenterId = normalizedUsername;
      }
    }

    // Check if already whitelisted
    const existing = await this.checkCommenter(actualCommenterId, normalizedUsername, instagramAccountId || undefined, clientId, userId);
    if (existing) {
      return; // Already whitelisted
    }

    // Add by commenterId (primary method - most reliable)
    await db.insert(whitelistedIdentifiers).values({
      clientId: clientId ?? null,
      userId: userId ?? null,
      instagramAccountId: instagramAccountId ?? null,
      identifier: actualCommenterId.toLowerCase(),
      identifierType: 'USERNAME',
      description: description || `Whitelisted commenter: @${normalizedUsername}`,
      isAutoAdded: false,
      isActive: true
    });

    // Also add by username (if different from commenterId) for redundancy
    if (actualCommenterId.toLowerCase() !== normalizedUsername) {
      await db.insert(whitelistedIdentifiers).values({
        clientId: clientId ?? null,
        userId: userId ?? null,
        instagramAccountId: instagramAccountId ?? null,
        identifier: `@${normalizedUsername}`,
        identifierType: 'USERNAME',
        description: description || `Whitelisted commenter: @${normalizedUsername}`,
        isAutoAdded: false,
        isActive: true
      });
    }
  }

  /**
   * Remove a commenter from the whitelist
   */
  async removeCommenter(
    commenterId: string,
    commenterUsername: string,
    clientId?: string,
    userId?: string
  ): Promise<void> {
    const ownershipWhere = clientId
      ? eq(whitelistedIdentifiers.clientId, clientId)
      : userId
      ? eq(whitelistedIdentifiers.userId, userId)
      : undefined;

    if (!ownershipWhere) {
      throw new Error('Either clientId or userId must be provided');
    }

    const normalizedUsername = commenterUsername.startsWith('@') 
      ? commenterUsername.toLowerCase() 
      : `@${commenterUsername.toLowerCase()}`;

    // Remove by commenterId
    await db
      .update(whitelistedIdentifiers)
      .set({ isActive: false })
      .where(
        and(
          ownershipWhere,
          eq(whitelistedIdentifiers.identifier, commenterId.toLowerCase()),
          eq(whitelistedIdentifiers.identifierType, 'USERNAME')
        )
      );

    // Remove by username (if different)
    await db
      .update(whitelistedIdentifiers)
      .set({ isActive: false })
      .where(
        and(
          ownershipWhere,
          eq(whitelistedIdentifiers.identifier, normalizedUsername),
          eq(whitelistedIdentifiers.identifierType, 'USERNAME')
        )
      );
  }

  /**
   * Get all whitelisted commenters (returns commenters, not just identifiers)
   * @param instagramAccountId - If provided, returns only account-specific whitelists. If null, returns all (global + account-specific).
   */
  async getWhitelistedCommenters(
    clientId?: string,
    userId?: string,
    instagramAccountId?: string | null
  ): Promise<Array<{ commenterId: string; commenterUsername: string; description: string | null; addedAt: Date; instagramAccountId: string | null; instagramAccount?: { id: string; username: string } }>> {
    const all = await this.getAll(clientId, userId, instagramAccountId);
    
    // Filter to get commenter-based whitelist entries
    // These are entries where the identifier looks like a commenterId (long alphanumeric) or username
    const commenters = all
      .filter(item => {
        // CommenterIds are typically long alphanumeric strings (Instagram user IDs)
        // Usernames might start with @ or be plain
        const id = item.identifier.toLowerCase();
        // If it's a long alphanumeric string (likely commenterId) or starts with @, treat as commenter
        return (id.length > 10 && /^[a-z0-9_]+$/.test(id)) || id.startsWith('@');
      })
      .map(item => ({
        commenterId: item.identifier, // May be ID or username
        commenterUsername: item.identifier.startsWith('@') 
          ? item.identifier.substring(1) 
          : item.identifier, // If it's an ID, we don't have username - will need to look it up
        description: item.description,
        addedAt: item.createdAt || new Date(),
        instagramAccountId: item.instagramAccountId
      }));

    // Enrich with usernames from suspicious accounts and Instagram account info
    const { instagramAccounts } = await import('../db/schema');
    const enriched = await Promise.all(
      commenters.map(async (commenter) => {
        // Try to find username from suspicious accounts
        const account = await db.query.suspiciousAccounts.findFirst({
          where: eq(suspiciousAccounts.commenterId, commenter.commenterId),
          orderBy: (accounts, { desc }) => [desc(accounts.lastSeenAt)]
        });

        // Get Instagram account info if account-specific
        let instagramAccount = null;
        if (commenter.instagramAccountId) {
          const igAccount = await db.query.instagramAccounts.findFirst({
            where: eq(instagramAccounts.id, commenter.instagramAccountId)
          });
          if (igAccount) {
            instagramAccount = { id: igAccount.id, username: igAccount.username };
          }
        }

        return {
          ...commenter,
          commenterUsername: account?.commenterUsername || commenter.commenterUsername,
          instagramAccount: instagramAccount ?? undefined
        };
      })
    );

    return enriched;
  }

  /**
   * Get all whitelisted identifiers for a client/user
   * @param instagramAccountId - If provided, returns only account-specific whitelists. If null, returns all (global + account-specific).
   */
  async getAll(clientId?: string, userId?: string, instagramAccountId?: string | null): Promise<typeof whitelistedIdentifiers.$inferSelect[]> {
    const where = clientId
      ? eq(whitelistedIdentifiers.clientId, clientId)
      : userId
      ? eq(whitelistedIdentifiers.userId, userId)
      : undefined;

    if (!where) {
      return [];
    }

    // Build account filter
    const accountFilter = instagramAccountId !== undefined
      ? instagramAccountId === null
        ? isNull(whitelistedIdentifiers.instagramAccountId) // Only global
        : eq(whitelistedIdentifiers.instagramAccountId, instagramAccountId) // Only this account
      : undefined; // All (global + account-specific)

    const conditions = accountFilter
      ? [where, eq(whitelistedIdentifiers.isActive, true), accountFilter]
      : [where, eq(whitelistedIdentifiers.isActive, true)];

    return await db.query.whitelistedIdentifiers.findMany({
      where: and(...conditions)
    });
  }
}

export const whitelistService = new WhitelistService();

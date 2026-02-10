import { db } from '../db';
import { knownThreatsWatchlist, watchlistDetections, globalThreatNetwork, botNetworkMasterminds } from '../db/schema';
import { eq, and, or, sql } from 'drizzle-orm';

interface WatchlistMatch {
  threatId: string;
  threatType: 'watchlist' | 'global_threat' | 'bot_network';
  name: string;
  autoDeleteEnabled: boolean;
  threatLevel: string;
}

interface WatchlistCheckResult {
  isMatch: boolean;
  matches: WatchlistMatch[];
  shouldAutoDelete: boolean;
}

export class WatchlistService {
  /**
   * Check if a commenter matches any watchlist entries for auto-deletion
   */
  async checkCommenterForAutoDelete(
    commenterUsername: string,
    commenterId: string,
    clientId?: string,
    userId?: string
  ): Promise<WatchlistCheckResult> {
    const matches: WatchlistMatch[] = [];

    // Check personal watchlist entries
    if (clientId || userId) {
      // Use the effective owner for watchlist checking
      const ownershipCondition = clientId
        ? eq(knownThreatsWatchlist.clientId, clientId)
        : eq(knownThreatsWatchlist.userId, userId!);

      const orConditions = [
        eq(knownThreatsWatchlist.instagramUsername, commenterUsername)
      ];
      if (commenterId) {
        orConditions.push(eq(knownThreatsWatchlist.instagramId, commenterId));
      }

      const watchlistEntries = await db
        .select()
        .from(knownThreatsWatchlist)
        .where(and(
          ownershipCondition,
          eq(knownThreatsWatchlist.isActive, true),
          eq(knownThreatsWatchlist.autoBlockDirectComments, true),
          or(...orConditions)
        ));

      for (const entry of watchlistEntries) {
        matches.push({
          threatId: entry.id,
          threatType: 'watchlist',
          name: entry.instagramUsername || 'Unknown',
          autoDeleteEnabled: entry.autoBlockDirectComments || false,
          threatLevel: entry.threatLevel
        });
      }
    }

    // Check global threat network
    const globalThreats = await db
      .select()
      .from(globalThreatNetwork)
      .where(and(
        eq(globalThreatNetwork.isGlobalThreat, true),
        or(
          eq(globalThreatNetwork.commenterUsernameHash, this.hashString(commenterUsername)),
          eq(globalThreatNetwork.commenterIdHash, this.hashString(commenterId))
        )
      ));

    for (const threat of globalThreats) {
      matches.push({
        threatId: threat.id,
        threatType: 'global_threat',
        name: 'Global Threat Actor',
        autoDeleteEnabled: true, // Global threats are always auto-deleted
        threatLevel: 'CRITICAL'
      });
    }

    // Check bot network masterminds (direct commenter matches)
    if (clientId || userId) {
      const ownerConditions = [];
      if (clientId) {
        ownerConditions.push(eq(botNetworkMasterminds.clientId, clientId));
      }
      if (userId) {
        ownerConditions.push(eq(botNetworkMasterminds.userId, userId));
      }

      const botNetworks = await db
        .select({
          mastermind: botNetworkMasterminds,
          identifiers: botNetworkMasterminds.knownIdentifiers
        })
        .from(botNetworkMasterminds)
        .where(and(
          or(...ownerConditions),
          eq(botNetworkMasterminds.isActive, true)
        ));

      for (const { mastermind, identifiers } of botNetworks) {
        if (identifiers && this.checkIfIdentifierMatches(identifiers, commenterUsername, commenterId)) {
          matches.push({
            threatId: mastermind.id,
            threatType: 'bot_network',
            name: mastermind.name,
            autoDeleteEnabled: true,
            threatLevel: mastermind.threatLevel
          });
        }
      }
    }

    const shouldAutoDelete = matches.some(match => match.autoDeleteEnabled);

    return {
      isMatch: matches.length > 0,
      matches,
      shouldAutoDelete
    };
  }

  /**
   * Check if a comment contains mentions of watchlist accounts
   */
  async checkCommentForMentions(
    commentText: string,
    clientId?: string,
    userId?: string
  ): Promise<WatchlistCheckResult> {
    const matches: WatchlistMatch[] = [];

    // Get all watchlist usernames to check for mentions
    if (clientId || userId) {
      const conditions = [
        eq(knownThreatsWatchlist.isActive, true),
        eq(knownThreatsWatchlist.monitorUsernameMentions, true)
      ];
      if (clientId) {
        conditions.push(eq(knownThreatsWatchlist.clientId, clientId));
      } else if (userId) {
        conditions.push(eq(knownThreatsWatchlist.userId, userId));
      }

      const watchlistUsernames = await db
        .select({
          id: knownThreatsWatchlist.id,
          username: knownThreatsWatchlist.instagramUsername,
          monitorMentions: knownThreatsWatchlist.autoFlagReferences
        })
        .from(knownThreatsWatchlist)
        .where(and(...conditions));

      for (const entry of watchlistUsernames) {
        if (entry.username && this.containsMention(commentText, entry.username)) {
          matches.push({
            threatId: entry.id,
            threatType: 'watchlist',
            name: entry.username,
            autoDeleteEnabled: entry.monitorMentions || false,
            threatLevel: 'MEDIUM'
          });
        }
      }
    }

    const shouldAutoDelete = matches.some(match => match.autoDeleteEnabled);

    return {
      isMatch: matches.length > 0,
      matches,
      shouldAutoDelete
    };
  }

  /**
   * Record a watchlist detection
   */
  async recordDetection(
    threatId: string,
    commentId: string,
    commenterUsername: string,
    commenterId: string,
    commentText: string,
    detectionType: 'DIRECT_COMMENT' | 'USERNAME_MENTION' = 'DIRECT_COMMENT',
    matchedKeyword?: string
  ): Promise<void> {
    try {
      await db.insert(watchlistDetections).values({
        knownThreatId: threatId,
        commentId: commentId,
        detectionType,
        matchedKeyword,
        commentText,
        commenterUsername,
        commenterId,
        actionTaken: 'DELETED', // Since we're auto-deleting
        autoAction: true
      });

      // Update the threat's last detected timestamp
      await db
        .update(knownThreatsWatchlist)
        .set({
          timesDetected: sql`${knownThreatsWatchlist.timesDetected} + 1`,
          lastDetectedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(knownThreatsWatchlist.id, threatId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to record watchlist detection:', errorMessage);
      // Don't throw - this shouldn't break the moderation flow
    }
  }

  /**
   * Check if bot network identifiers match the commenter
   */
  private checkIfIdentifierMatches(
    identifiers: unknown,
    username: string,
    commenterId: string
  ): boolean {
    if (!identifiers) return false;

    // Check if identifiers is an array of strings or objects
    if (Array.isArray(identifiers)) {
      return identifiers.some((id: unknown) => {
        if (typeof id === 'string') {
          return id === username || id === commenterId;
        }
        if (typeof id === 'object' && id !== null && 'value' in id) {
          const identifierObj = id as { value: unknown };
          if (typeof identifierObj.value === 'string') {
            return identifierObj.value === username || identifierObj.value === commenterId;
          }
        }
        return false;
      });
    }

    return false;
  }

  /**
   * Check if comment text contains a mention of a username
   */
  private containsMention(commentText: string, username: string): boolean {
    const mentionPatterns = [
      `@${username}`,  // @username
      `@${username}\\b`, // @username followed by word boundary
      `\\b${username}\\b`, // username as standalone word
    ];

    return mentionPatterns.some(pattern =>
      new RegExp(pattern, 'i').test(commentText)
    );
  }

  /**
   * Simple hash function for anonymizing usernames/IDs in global threat network
   */
  private hashString(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }
}

export const watchlistService = new WatchlistService();
import { db } from '../db';
import { extractedIdentifiers, suspiciousAccounts, comments, posts, instagramAccounts } from '../db/schema';
import { eq, sql, and, desc, count } from 'drizzle-orm';
import { IdentifierType } from '../types';

interface PatternMatch {
  identifier: string;
  normalizedIdentifier: string;
  identifierType: IdentifierType;
  accountCount: number;
  totalMentions: number;
  accounts: {
    id: string;
    username: string;
    mentionCount: number;
    firstSeen: Date;
    lastSeen: Date;
  }[];
  sampleComments: string[];
}

interface CommentPattern {
  pattern: string;
  accountCount: number;
  totalOccurrences: number;
  accounts: {
    id: string;
    username: string;
    occurrences: number;
  }[];
  sampleComments: string[];
}

export class PatternAnalysisService {
  /**
   * Find shared identifiers across multiple accounts (cross-referencing)
   */
  async findSharedIdentifiers(
    _clientId?: string,
    _userId?: string,
    minAccounts: number = 2,
    daysBack: number = 30
  ): Promise<PatternMatch[]> {
    // Find identifiers that appear in multiple accounts
    const sharedIdentifiers = await db
      .select({
        identifier: extractedIdentifiers.identifier,
        normalizedIdentifier: extractedIdentifiers.normalizedIdentifier,
        identifierType: extractedIdentifiers.identifierType,
        accountId: suspiciousAccounts.id,
        accountUsername: suspiciousAccounts.commenterUsername,
        mentionCount: count(extractedIdentifiers.id),
        firstSeen: sql<Date>`min(${extractedIdentifiers.createdAt})`,
        lastSeen: sql<Date>`max(${extractedIdentifiers.createdAt})`
      })
      .from(extractedIdentifiers)
      .innerJoin(suspiciousAccounts, eq(extractedIdentifiers.suspiciousAccountId, suspiciousAccounts.id))
      .where(sql`
        ${extractedIdentifiers.createdAt} >= now() - interval '${daysBack} days' AND
        ${extractedIdentifiers.isActive} = true
      `)
      .groupBy(
        extractedIdentifiers.identifier,
        extractedIdentifiers.normalizedIdentifier,
        extractedIdentifiers.identifierType,
        suspiciousAccounts.id,
        suspiciousAccounts.commenterUsername
      )
      .orderBy(desc(count(extractedIdentifiers.id)));

    // Group by normalized identifier to find patterns
    const patternMap = new Map<string, PatternMatch>();

    for (const row of sharedIdentifiers) {
      const key = `${row.normalizedIdentifier}-${row.identifierType}`;

      if (!patternMap.has(key)) {
        patternMap.set(key, {
          identifier: row.identifier,
          normalizedIdentifier: row.normalizedIdentifier,
          identifierType: row.identifierType as IdentifierType,
          accountCount: 0,
          totalMentions: 0,
          accounts: [],
          sampleComments: []
        });
      }

      const pattern = patternMap.get(key)!;
      pattern.accounts.push({
        id: row.accountId,
        username: row.accountUsername || 'unknown',
        mentionCount: row.mentionCount,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen
      });
      pattern.totalMentions += row.mentionCount;
    }

    // Filter for patterns with minimum account count and get sample comments
    const results: PatternMatch[] = [];

    for (const pattern of patternMap.values()) {
      if (pattern.accounts.length >= minAccounts) {
        pattern.accountCount = pattern.accounts.length;

        // Get sample comments for this pattern
        const sampleComments = await this.getSampleCommentsForIdentifier(
          pattern.normalizedIdentifier,
          pattern.identifierType,
          3
        );
        pattern.sampleComments = sampleComments;

        results.push(pattern);
      }
    }

    return results.sort((a, b) => b.accountCount - a.accountCount);
  }

  /**
   * Find similar comment patterns across accounts
   */
  async findSimilarCommentPatterns(
    _clientId?: string,
    _userId?: string,
    minAccounts: number = 3,
    daysBack: number = 30
  ): Promise<CommentPattern[]> {
    // Get recent comments and group by similar patterns
    const recentComments = await db
      .select({
        commentText: comments.text,
        commenterId: comments.commenterId,
        commenterUsername: comments.commenterUsername,
        accountId: suspiciousAccounts.id,
        createdAt: comments.createdAt
      })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .innerJoin(suspiciousAccounts, and(
        eq(posts.instagramAccountId, suspiciousAccounts.instagramAccountId),
        eq(comments.commenterId, suspiciousAccounts.commenterId)
      ))
      .where(sql`
        ${comments.commentedAt} >= now() - interval '${daysBack} days' AND
        ${comments.isDeleted} = false
      `)
      .orderBy(desc(comments.commentedAt))
      .limit(10000); // Analyze recent comments

    // Group comments by normalized patterns
    const patternMap = new Map<string, CommentPattern>();

    for (const comment of recentComments) {
      const normalizedPattern = this.normalizeCommentPattern(comment.commentText);

      if (!patternMap.has(normalizedPattern)) {
        patternMap.set(normalizedPattern, {
          pattern: normalizedPattern,
          accountCount: 0,
          totalOccurrences: 0,
          accounts: [],
          sampleComments: []
        });
      }

      const pattern = patternMap.get(normalizedPattern)!;
      const accountKey = comment.accountId;

      // Check if this account already exists in the pattern
      const existingAccount = pattern.accounts.find(a => a.id === accountKey);
      if (existingAccount) {
        existingAccount.occurrences++;
      } else {
        pattern.accounts.push({
          id: accountKey,
          username: comment.commenterUsername || 'unknown',
          occurrences: 1
        });
      }

      pattern.totalOccurrences++;
      pattern.sampleComments.push(comment.commentText);
    }

    // Filter for patterns with minimum account count and limit samples
    const results: CommentPattern[] = [];

    for (const pattern of patternMap.values()) {
      if (pattern.accounts.length >= minAccounts && pattern.totalOccurrences >= minAccounts) {
        pattern.accountCount = pattern.accounts.length;
        pattern.sampleComments = pattern.sampleComments.slice(0, 5); // Limit samples
        results.push(pattern);
      }
    }

    return results.sort((a, b) => b.accountCount - a.accountCount);
  }

  /**
   * Detect coordinated timing patterns (accounts commenting at similar times)
   * Analyzes comment timestamps to identify accounts that comment within a time window,
   * suggesting coordinated attacks or bot networks.
   */
  async findCoordinatedTiming(
    clientId?: string,
    userId?: string,
    timeWindowMinutes: number = 5,
    minAccounts: number = 3,
    daysBack: number = 7
  ): Promise<Array<{
    timeWindow: string;
    accountCount: number;
    accounts: Array<{ id: string; username: string }>;
  }>> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    try {
      // Get recent comments within the time period
      // Filter by clientId/userId through instagramAccounts if provided
      const recentComments = await db
        .select({
          commenterId: comments.commenterId,
          commenterUsername: comments.commenterUsername,
          accountId: suspiciousAccounts.id,
          commentedAt: comments.commentedAt
        })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .innerJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
        .innerJoin(suspiciousAccounts, and(
          eq(posts.instagramAccountId, suspiciousAccounts.instagramAccountId),
          eq(comments.commenterId, suspiciousAccounts.commenterId)
        ))
        .where(and(
          sql`${comments.commentedAt} >= ${startDate}`,
          eq(comments.isDeleted, false),
          ...(clientId ? [eq(instagramAccounts.clientId, clientId)] : []),
          ...(userId ? [eq(instagramAccounts.userId, userId)] : [])
        ))
        .orderBy(comments.commentedAt);

      if (recentComments.length < minAccounts) {
        return [];
      }

      // Group comments by time windows
      const timeWindowMs = timeWindowMinutes * 60 * 1000;
      const coordinatedPatterns: Map<string, {
        timeWindow: string;
        accounts: Map<string, { id: string; username: string }>;
      }> = new Map();

      for (let i = 0; i < recentComments.length; i++) {
        const comment = recentComments[i];
        const commentTime = comment.commentedAt.getTime();

        // Check if other comments fall within the time window
        const windowStart = new Date(commentTime);
        const windowEnd = new Date(commentTime + timeWindowMs);
        const windowKey = `${windowStart.toISOString()}-${windowEnd.toISOString()}`;

        if (!coordinatedPatterns.has(windowKey)) {
          coordinatedPatterns.set(windowKey, {
            timeWindow: `${windowStart.toISOString()} to ${windowEnd.toISOString()}`,
            accounts: new Map()
          });
        }

        const pattern = coordinatedPatterns.get(windowKey)!;
        
        // Find all comments within this time window
        for (let j = i + 1; j < recentComments.length; j++) {
          const otherComment = recentComments[j];
          const otherTime = otherComment.commentedAt.getTime();

          if (otherTime >= commentTime && otherTime <= commentTime + timeWindowMs) {
            const accountKey = otherComment.accountId;
            if (!pattern.accounts.has(accountKey)) {
              pattern.accounts.set(accountKey, {
                id: otherComment.accountId,
                username: otherComment.commenterUsername || 'unknown'
              });
            }
          } else if (otherTime > commentTime + timeWindowMs) {
            // Comments are sorted by time, so we can break early
            break;
          }
        }

        // Add the current comment's account
        const accountKey = comment.accountId;
        if (!pattern.accounts.has(accountKey)) {
          pattern.accounts.set(accountKey, {
            id: comment.accountId,
            username: comment.commenterUsername || 'unknown'
          });
        }
      }

      // Filter patterns that meet the minimum account threshold
      const results: Array<{
        timeWindow: string;
        accountCount: number;
        accounts: Array<{ id: string; username: string }>;
      }> = [];

      for (const pattern of coordinatedPatterns.values()) {
        if (pattern.accounts.size >= minAccounts) {
          results.push({
            timeWindow: pattern.timeWindow,
            accountCount: pattern.accounts.size,
            accounts: Array.from(pattern.accounts.values())
          });
        }
      }

      return results.sort((a, b) => b.accountCount - a.accountCount);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error detecting coordinated timing patterns:', errorMessage);
      return [];
    }
  }

  /**
   * Get sample comments for a specific identifier
   */
  private async getSampleCommentsForIdentifier(
    normalizedIdentifier: string,
    identifierType: IdentifierType,
    limit: number = 3
  ): Promise<string[]> {
    const sampleComments = await db
      .select({
        commentText: comments.text
      })
      .from(extractedIdentifiers)
      .innerJoin(comments, eq(extractedIdentifiers.commentId, comments.id))
      .where(and(
        eq(extractedIdentifiers.normalizedIdentifier, normalizedIdentifier),
        eq(extractedIdentifiers.identifierType, identifierType),
        eq(extractedIdentifiers.isActive, true)
      ))
      .orderBy(desc(extractedIdentifiers.createdAt))
      .limit(limit);

    return sampleComments.map(c => c.commentText || '');
  }

  /**
   * Normalize comment text for pattern matching
   */
  private normalizeCommentPattern(commentText: string): string {
    return commentText
      .toLowerCase()
      .trim()
      // Remove extra whitespace
      .replace(/\s+/g, ' ')
      // Remove common punctuation that doesn't affect meaning
      .replace(/[^\w\s$@.]/g, '')
      // Normalize common payment words
      .replace(/\b(v3nm0|venmo|cashapp|paypal|zelle)\b/g, 'PAYMENT_PLATFORM')
      // Normalize amounts
      .replace(/\$\d+(\.\d{2})?/g, '$AMOUNT')
      // Normalize times
      .replace(/\b\d{1,2}:\d{2}\b/g, '$TIME')
      // Truncate very long comments
      .substring(0, 200);
  }
}

export const patternAnalysisService = new PatternAnalysisService();
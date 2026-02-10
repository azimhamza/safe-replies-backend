import { Response } from 'express';
import { db } from '../db';
import { instagramAccounts, suspiciousAccounts, comments, posts, moderationLogs, legalCases, clients, facebookPages } from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { DelegationRequest } from '../middleware/delegation.middleware';
import { ApiResponse } from '../types';
import { eq, and, or, sql, inArray, notInArray, isNull } from 'drizzle-orm';
import { calculateFollowerGrowth } from '../services/client.service';
import { isAgency } from '../utils/account-type.utils';

interface DashboardStats {
  connectedAccounts: number;
  commentsModerated: number;
  autoDeleted: number;
  flagged: number;
  suspiciousAccounts: number;
  activeCases: number;
  totalFollowers: number;
  followerGrowth: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  commentsPerFollower: number;
  protectionRate: string;
}

/**
 * Calculate follower metrics for a set of account IDs
 */
async function calculateFollowerMetrics(
  accountIds: string[],
  commentsModerated: number
): Promise<{
  totalFollowers: number;
  followerGrowth: { daily: number; weekly: number; monthly: number };
  commentsPerFollower: number;
  protectionRate: string;
}> {
  if (accountIds.length === 0) {
    return {
      totalFollowers: 0,
      followerGrowth: { daily: 0, weekly: 0, monthly: 0 },
      commentsPerFollower: 0,
      protectionRate: '0 comments per 1K followers'
    };
  }

  // Get Instagram accounts with follower counts
  const igAccounts = await db.query.instagramAccounts.findMany({
    where: inArray(instagramAccounts.id, accountIds),
    columns: { id: true, followersCount: true }
  });

  // Calculate total current followers
  const totalFollowers = igAccounts.reduce(
    (sum, acc) => sum + (acc.followersCount ?? 0),
    0
  );

  // Calculate aggregate follower growth
  let totalDailyGrowth = 0;
  let totalWeeklyGrowth = 0;
  let totalMonthlyGrowth = 0;

  for (const account of igAccounts) {
    const growth = await calculateFollowerGrowth(
      account.id,
      'instagram',
      account.followersCount ?? 0
    );
    totalDailyGrowth += growth.daily;
    totalWeeklyGrowth += growth.weekly;
    totalMonthlyGrowth += growth.monthly;
  }

  // Calculate comments per 1000 followers
  const commentsPerFollower =
    totalFollowers > 0 ? (commentsModerated / totalFollowers) * 1000 : 0;

  // Format protection rate
  const protectionRate =
    totalFollowers > 0
      ? `${Math.round(commentsPerFollower)} comments per 1K followers`
      : '0 comments per 1K followers';

  return {
    totalFollowers,
    followerGrowth: {
      daily: totalDailyGrowth,
      weekly: totalWeeklyGrowth,
      monthly: totalMonthlyGrowth
    },
    commentsPerFollower: Math.round(commentsPerFollower * 10) / 10,
    protectionRate
  };
}

/**
 * Get dashboard statistics for current user/client
 * Supports both direct clients (userId) and agency-managed clients (clientId)
 */
export async function getStats(
  req: AuthRequest,
  res: Response<ApiResponse<DashboardStats>>
): Promise<void> {
  try {
    const delegationReq = req as DelegationRequest;
    const effectiveClientId = delegationReq.effectiveClientId;
    const effectiveUserId = delegationReq.effectiveUserId ?? req.userId;

    if (!effectiveUserId && !effectiveClientId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // If effectiveClientId is set, agency is viewing a specific client's dashboard
    // Show only that client's stats, not aggregated stats
    if (effectiveClientId) {
      // Get Instagram accounts for this specific client
      const clientInstagramAccounts = await db
        .select({ id: instagramAccounts.id })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.clientId, effectiveClientId),
            eq(instagramAccounts.isActive, true)
          )
        );

      // Get Facebook pages for this specific client
      const clientFacebookPages = await db
        .select({ id: facebookPages.id })
        .from(facebookPages)
        .where(
          and(
            eq(facebookPages.clientId, effectiveClientId),
            eq(facebookPages.isActive, true)
          )
        );

      const connectedAccounts = clientInstagramAccounts.length + clientFacebookPages.length;
      const accountIds = clientInstagramAccounts.map(acc => acc.id);

      // Initialize stats
      let commentsModerated = 0;
      let autoDeleted = 0;
      let flagged = 0;
      let suspiciousAccountsCount = 0;
      let activeCases = 0;

      // Only fetch stats if client has connected accounts
      if (accountIds.length > 0) {
        // Get comments moderated count
        const moderatedResult = await db
          .select({ count: sql<number>`count(distinct ${comments.id})::int` })
          .from(comments)
          .innerJoin(posts, eq(comments.postId, posts.id))
          .innerJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
          .where(inArray(posts.instagramAccountId, accountIds));

        commentsModerated = moderatedResult[0]?.count || 0;

        // Get auto-deleted count
        const deletedResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(comments)
          .innerJoin(posts, eq(comments.postId, posts.id))
          .where(
            and(
              inArray(posts.instagramAccountId, accountIds),
              eq(comments.isDeleted, true)
            )
          );

        autoDeleted = deletedResult[0]?.count || 0;

        // Get flagged count
        const flaggedResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(moderationLogs)
          .innerJoin(comments, eq(moderationLogs.commentId, comments.id))
          .innerJoin(posts, eq(comments.postId, posts.id))
          .where(
            and(
              inArray(posts.instagramAccountId, accountIds),
              eq(moderationLogs.actionTaken, 'FLAGGED'),
              eq(comments.isDeleted, false),
              eq(comments.isHidden, false),
              or(
                eq(comments.isAllowed, false),
                isNull(comments.isAllowed)
              )
            )
          );

        flagged = flaggedResult[0]?.count || 0;

        // Get suspicious accounts count
        const suspiciousResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(suspiciousAccounts)
          .where(
            and(
              inArray(suspiciousAccounts.instagramAccountId, accountIds),
              or(
                eq(suspiciousAccounts.isHidden, false),
                eq(suspiciousAccounts.isWatchlisted, true),
                eq(suspiciousAccounts.isPublicThreat, true)
              )
            )
          );

        suspiciousAccountsCount = suspiciousResult[0]?.count || 0;

        // Get active legal cases for this client
        const casesResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(legalCases)
          .where(
            and(
              eq(legalCases.clientId, effectiveClientId),
              notInArray(legalCases.status, ['RESOLVED', 'CLOSED'])
            )
          );

        activeCases = casesResult[0]?.count || 0;
      }

      // Calculate follower metrics
      const followerMetrics = await calculateFollowerMetrics(accountIds, commentsModerated);

      res.json({
        success: true,
        data: {
          connectedAccounts,
          commentsModerated,
          autoDeleted,
          flagged,
          suspiciousAccounts: suspiciousAccountsCount,
          activeCases,
          ...followerMetrics
        }
      });
      return;
    }

    // Original logic for non-delegated requests (agency viewing all clients, or direct client)
    // Determine if this is an agency or direct client
    const accountOwnershipCondition = isAgency(req.accountType)
      ? undefined // Agencies see all their clients' accounts - handled separately
      : eq(instagramAccounts.userId, effectiveUserId!);

    // Get connected Instagram accounts count
    let connectedAccountsQuery;
    if (isAgency(req.accountType)) {
      // Agency's own accounts (userId = agency, clientId null) + all their clients' accounts
      const agencyOwnAccounts = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.userId, req.userId!),
            isNull(instagramAccounts.clientId),
            eq(instagramAccounts.isActive, true)
          )
        );
      const agencyClients = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.userId, req.userId!));
      const clientIds = agencyClients.map(c => c.id);
      let clientAccountsCount = 0;
      if (clientIds.length > 0) {
        const clientAccounts = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(instagramAccounts)
          .where(
            and(
              inArray(instagramAccounts.clientId, clientIds),
              eq(instagramAccounts.isActive, true)
            )
          );
        clientAccountsCount = clientAccounts[0]?.count || 0;
      }
      const ownCount = agencyOwnAccounts[0]?.count || 0;
      connectedAccountsQuery = [{ count: ownCount + clientAccountsCount }];
    } else {
      // Direct client - get their own accounts
      connectedAccountsQuery = db
        .select({ count: sql<number>`count(*)::int` })
        .from(instagramAccounts)
        .where(
          and(
            accountOwnershipCondition!,
            eq(instagramAccounts.isActive, true)
          )
        );
    }

    const connectedAccountsResult = await connectedAccountsQuery;
    const connectedAccounts = connectedAccountsResult[0]?.count || 0;

    // Get user's/client's Instagram account IDs (for stats: comments, flagged, etc.)
    let userAccounts: Array<{ id: string }> = [];
    if (isAgency(req.accountType)) {
      const agencyOwn = await db
        .select({ id: instagramAccounts.id })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.userId, req.userId!),
            isNull(instagramAccounts.clientId),
            eq(instagramAccounts.isActive, true)
          )
        );
      const agencyClients = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.userId, req.userId!));
      const clientIds = agencyClients.map(c => c.id);
      let clientAccounts: Array<{ id: string }> = [];
      if (clientIds.length > 0) {
        clientAccounts = await db
          .select({ id: instagramAccounts.id })
          .from(instagramAccounts)
          .where(
            and(
              inArray(instagramAccounts.clientId, clientIds),
              eq(instagramAccounts.isActive, true)
            )
          );
      }
      userAccounts = [...agencyOwn, ...clientAccounts];
    } else {
      userAccounts = await db
        .select({ id: instagramAccounts.id })
        .from(instagramAccounts)
        .where(
          and(
            accountOwnershipCondition!,
            eq(instagramAccounts.isActive, true)
          )
        );
    }
    
    const accountIds = userAccounts.map(acc => acc.id);

    // Initialize stats
    let commentsModerated = 0;
    let autoDeleted = 0;
    let flagged = 0;
    let suspiciousAccountsCount = 0;
    let activeCases = 0;

    // Only fetch stats if user has connected accounts
    if (accountIds.length > 0) {
      // Get comments moderated count (comments that have moderation logs)
      const moderatedResult = await db
        .select({ count: sql<number>`count(distinct ${comments.id})::int` })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .innerJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
        .where(inArray(posts.instagramAccountId, accountIds));

      commentsModerated = moderatedResult[0]?.count || 0;

      // Get auto-deleted count (comments that are deleted)
      const deletedResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .where(
          and(
            inArray(posts.instagramAccountId, accountIds),
            eq(comments.isDeleted, true)
          )
        );

      autoDeleted = deletedResult[0]?.count || 0;

      // Get flagged count (match Review Flagged list: FLAGGED, not deleted/hidden, not yet allowed)
      const flaggedResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(moderationLogs)
        .innerJoin(comments, eq(moderationLogs.commentId, comments.id))
        .innerJoin(posts, eq(comments.postId, posts.id))
        .where(
          and(
            inArray(posts.instagramAccountId, accountIds),
            eq(moderationLogs.actionTaken, 'FLAGGED'),
            eq(comments.isDeleted, false),
            eq(comments.isHidden, false),
            or(
              eq(comments.isAllowed, false),
              isNull(comments.isAllowed)
            )
          )
        );

      flagged = flaggedResult[0]?.count || 0;

      // Get suspicious accounts count (same visibility as list: not hidden, or watchlisted, or public threat)
      const suspiciousResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(suspiciousAccounts)
        .where(
          and(
            inArray(suspiciousAccounts.instagramAccountId, accountIds),
            or(
              eq(suspiciousAccounts.isHidden, false),
              eq(suspiciousAccounts.isWatchlisted, true),
              eq(suspiciousAccounts.isPublicThreat, true)
            )
          )
        );

      suspiciousAccountsCount = suspiciousResult[0]?.count || 0;

      // Get active legal cases count
      // Active cases are those not in RESOLVED or CLOSED status
      if (isAgency(req.accountType)) {
        // For agencies, get cases from all their clients
        const agencyClients = await db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.userId, req.userId!));

        const clientIds = agencyClients.map(c => c.id);
        
        if (clientIds.length > 0) {
          const casesResult = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(legalCases)
            .where(
              and(
                inArray(legalCases.clientId, clientIds),
                notInArray(legalCases.status, ['RESOLVED', 'CLOSED'])
              )
            );

          activeCases = casesResult[0]?.count || 0;
        }
      } else {
        // For direct clients, get their cases
        // First, get clientId from instagramAccounts (if they're a client)
        const userClient = await db
          .select({ clientId: instagramAccounts.clientId })
          .from(instagramAccounts)
          .where(
            and(
              eq(instagramAccounts.userId, req.userId!),
              eq(instagramAccounts.isActive, true)
            )
          )
          .limit(1);

        if (userClient[0]?.clientId) {
          const casesResult = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(legalCases)
            .where(
              and(
                eq(legalCases.clientId, userClient[0].clientId),
                notInArray(legalCases.status, ['RESOLVED', 'CLOSED'])
              )
            );

          activeCases = casesResult[0]?.count || 0;
        }
      }
    }

    // Calculate follower metrics
    const followerMetrics = await calculateFollowerMetrics(accountIds, commentsModerated);

    const stats: DashboardStats = {
      connectedAccounts,
      commentsModerated,
      autoDeleted,
      flagged,
      suspiciousAccounts: suspiciousAccountsCount,
      activeCases,
      ...followerMetrics
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Get dashboard stats error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard statistics'
    });
  }
}

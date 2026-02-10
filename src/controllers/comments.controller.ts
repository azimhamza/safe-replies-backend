import { Response } from 'express';
import { db } from '../db';
import { comments, posts, instagramAccounts, moderationLogs, suspiciousAccounts, knownThreatsWatchlist, globalThreatNetwork, facebookPages } from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { DelegationRequest, getEffectiveOwner } from '../middleware/delegation.middleware';
import { ApiResponse } from '../types';
import { eq, and, desc, inArray, sql, or } from 'drizzle-orm';
import { instagramService } from '../services/instagram.service';
import { facebookService } from '../services/facebook.service';
import { checkFeatureAllowed } from '../services/autumn.service';

/** Normalize username for comparison (lowercase, strip @). */
function normalizeUsername(s: string | null | undefined): string {
  if (!s || typeof s !== 'string') return '';
  return s.toLowerCase().trim().replace(/^@/, '');
}

/**
 * Helper function to get Page access token for an Instagram account
 */
async function getPageAccessTokenForAccount(accountId: string): Promise<string | null> {
  const account = await db.query.instagramAccounts.findFirst({
    where: eq(instagramAccounts.id, accountId)
  });

  if (!account) {
    return null;
  }

  // Prefer Facebook Page token (new method)
  if (account.facebookPageId) {
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, account.facebookPageId)
    });
    if (page?.pageAccessToken) {
      return page.pageAccessToken;
    }
  }

  // Fallback to legacy Instagram token
  return account.accessToken || null;
}

/**
 * Helper function to get Page access token for a Facebook Page
 */
async function getPageAccessTokenForFacebookPage(pageId: string): Promise<string | null> {
  const page = await db.query.facebookPages.findFirst({
    where: eq(facebookPages.id, pageId)
  });

  return page?.pageAccessToken || null;
}

// Type definitions for database query results
interface CommentDataRow {
  id: string;
  source: 'instagram' | 'facebook';
  text: string;
  commenterUsername: string;
  commenterId: string;
  commentedAt: Date;
  postId: string;
  isDeleted: boolean;
  igCommentId: string | null;
  fbCommentId: string | null;
  isHidden: boolean;
  hiddenAt: Date | null;
  parentCommentId: string | null;
  reviewedAt: Date | null;
  reviewAction: string | null;
  isAllowed: boolean | null;
  postSource: 'instagram' | 'facebook';
  postIgPostId: string | null;
  postFbPostId: string | null;
  postCaption: string | null;
  postPermalink: string | null;
  postPostedAt: Date;
  postLikesCount: number | null;
  postCommentsCount: number | null;
  postInstagramAccountId: string | null;
  postFacebookPageId: string | null;
  // Post insights
  postImpressions: number | null;
  postReach: number | null;
  postEngagement: number | null;
  postSaved: number | null;
  postVideoViews: number | null;
  postInsightsLastFetchedAt: Date | null;
  accountUsername: string | null;
  accountName: string | null;
  pageId: string | null;
  pageName: string | null;
}

interface ModerationLogRow {
  id: string;
  commentId: string;
  category: string;
  severity: number;
  confidence: string;
  rationale: string;
  riskScore: number;
  riskFormula: string | null;
  modelName: string;
  modelVersion: string | null;
  actionTaken: string;
  actionTimestamp: Date;
  isDegradedMode: boolean;
  createdAt: Date;
}

interface WatchlistEntryRow {
  id: string;
  clientId: string | null;
  instagramUsername: string | null;
  instagramId: string | null;
  threatType: string;
  threatLevel: string;
  monitorKeywords: unknown;
  monitorUsernameMentions: boolean;
  description: string;
  source: string | null;
  evidenceUrl: string | null;
  addedBy: string | null;
  autoBlockDirectComments: boolean;
  autoFlagReferences: boolean;
  escalateImmediately: boolean;
  timesDetected: number;
  lastDetectedAt: Date | null;
  isActive: boolean;
  resolved: boolean;
  resolvedNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SuspiciousAccountRow {
  id: string;
  instagramAccountId: string;
  commenterId: string;
  commenterUsername: string;
  totalComments: number;
  flaggedComments: number;
  deletedComments: number;
  blackmailCount: number;
  threatCount: number;
  harassmentCount: number;
  spamCount: number;
  defamationCount: number;
  averageRiskScore: string | null;
  highestRiskScore: number | null;
  commentVelocity: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  isBlocked: boolean;
  isSpamBot: boolean;
  blockReason: string | null;
  blockedAt: Date | null;
  isWatchlisted: boolean;
  watchlistedAt: Date | null;
  watchlistReason: string | null;
}

interface BotConnectionRow {
  id: string;
  mastermindId: string;
  suspiciousAccountId: string;
  confidence: string;
  connectionEvidence: string;
  evidenceAttachments: unknown;
  mentionsMastermind: boolean;
  totalMentions: number;
  mentionTypes: unknown;
  sampleMentions: unknown;
  detectedAt: Date;
  detectedBy: string;
  isActive: boolean;
  disconnectedAt: Date | null;
  disconnectionReason: string | null;
  createdAt: Date;
  mastermind: {
    id: string;
    name: string;
    threatLevel: string;
  };
}

interface BotConnectionWithAccountRow {
  id: string;
  mastermindId: string;
  suspiciousAccountId: string;
  confidence: string;
  connectionEvidence: string;
  evidenceAttachments: unknown;
  mentionsMastermind: boolean;
  totalMentions: number;
  mentionTypes: unknown;
  sampleMentions: unknown;
  detectedAt: Date;
  detectedBy: string;
  isActive: boolean;
  disconnectedAt: Date | null;
  disconnectionReason: string | null;
  createdAt: Date;
  mastermind: {
    id: string;
    name: string;
    threatLevel: string;
  };
  suspiciousAccount: {
    commenterUsername: string;
  };
}

interface CommentWithDetails {
  id: string;
  text: string;
  commenterUsername: string;
  commenterId: string;
  commentedAt: string;
  postId: string;
  isDeleted: boolean;
  isHidden: boolean;
  hiddenAt: string | null;
  igCommentId: string;
  parentCommentId: string | null; // null for top-level comments, UUID for replies
  reviewedAt: string | null;
  reviewAction: string | null;
  isAllowed: boolean;
  // Post information
  post: {
    id: string;
    igPostId: string;
    caption: string | null;
    permalink: string | null;
    postedAt: string;
    likesCount: number | null;
    commentsCount: number | null;
    instagramAccount: {
      id: string;
      username: string;
      name: string | null;
    };
    insights?: {
      impressions?: number;
      reach?: number;
      engagement?: number;
      saved?: number;
      videoViews?: number;
      insightsLastFetchedAt?: string;
    };
    moderationStats: {
      totalComments: number;
      deletedCount: number;
      hiddenCount: number;
      flaggedCount: number;
      deletedRatio: number;
      hiddenRatio: number;
      flaggedRatio: number;
    };
  };
  // Watchlist and suspicious account info
  commenter: {
    isOnWatchlist: boolean;
    isSuspicious: boolean;
    suspiciousAccountId?: string;
    watchlistEntry?: {
      id: string;
      threatType: string;
      threatLevel: string;
      description: string;
    };
    connectedBotAccounts?: string[];
    botNetworkMastermind?: {
      id: string;
      name: string;
      threatLevel: string;
    };
    hasBeenReported: boolean; // Whether this account has been reported in the public threat board
    reportedByAgencies: number; // Number of agencies that reported this account
    threatLevel: string | null; // From global threat network
  };
  moderation?: {
    category: string;
    severity: number;
    confidence: string;
    actionTaken: string;
    rationale: string;
  };
}

/**
 * Get comments for user's Instagram accounts (or for a delegated client when agency passes ?clientId=)
 */
export async function getComments(
  req: AuthRequest,
  res: Response<ApiResponse<CommentWithDetails[]>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    const delegationReq = req as DelegationRequest;
    const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
    const ownerUserId = effectiveUserId ?? req.userId;

    console.log('📝 [COMMENTS] Query params:', {
      userId: req.userId,
      accountType: req.accountType,
      queryClientId: req.query.clientId,
      effectiveUserId,
      effectiveClientId,
      ownerUserId,
      isAgencyDelegation: delegationReq.isAgencyDelegation
    });

    // Get Instagram accounts: by clientId when agency delegates, else by userId
    const userAccounts = await db.query.instagramAccounts.findMany({
      where: and(
        effectiveClientId
          ? eq(instagramAccounts.clientId, effectiveClientId)
          : eq(instagramAccounts.userId, ownerUserId!),
        eq(instagramAccounts.isActive, true)
      )
    });

    // Get Facebook Pages: same ownership logic
    const userPages = await db.query.facebookPages.findMany({
      where: and(
        effectiveClientId
          ? eq(facebookPages.clientId, effectiveClientId)
          : eq(facebookPages.userId, ownerUserId!),
        eq(facebookPages.isActive, true)
      )
    });

    // Define accountIds and pageIds BEFORE using them in logs
    const accountIds = userAccounts.map(acc => acc.id);
    const pageIds = userPages.map(page => page.id);

    console.log('📝 [COMMENTS] Found accounts/pages:', {
      instagramAccounts: userAccounts.length,
      facebookPages: userPages.length,
      accountIds,
      pageIds
    });

    if (userAccounts.length === 0 && userPages.length === 0) {
      console.log('📝 [COMMENTS] No accounts/pages found - returning empty array');
      res.json({
        success: true,
        data: []
      });
      return;
    }

    // Get posts for these accounts and pages
    const whereConditions = [];
    if (accountIds.length > 0) {
      whereConditions.push(inArray(posts.instagramAccountId, accountIds));
    }
    if (pageIds.length > 0) {
      whereConditions.push(inArray(posts.facebookPageId, pageIds));
    }

    const userPosts = await db.query.posts.findMany({
      where: whereConditions.length > 1 ? or(...whereConditions) : whereConditions[0]
    });

    console.log('📝 [COMMENTS] Found posts:', userPosts.length);

    if (userPosts.length === 0) {
      console.log('📝 [COMMENTS] No posts found - returning empty array');
      res.json({
        success: true,
        data: []
      });
      return;
    }

    const postIds = userPosts.map(post => post.id);

    // Get comments for these posts. Always return ALL comments (including hidden/deleted)
    // so the UI can show auto-hidden and auto-deleted with badges. Frontend filters by showHidden when needed.
    const filter = req.query.filter as string;
    const watchlistFilter = req.query.watchlistFilter as string;

    const whereCondition = inArray(comments.postId, postIds);

    const commentsData = await db
      .select({
        id: comments.id,
        source: comments.source,
        text: comments.text,
        commenterUsername: comments.commenterUsername,
        commenterId: comments.commenterId,
        commentedAt: comments.commentedAt,
        postId: comments.postId,
        isDeleted: comments.isDeleted,
        igCommentId: comments.igCommentId,
        fbCommentId: comments.fbCommentId,
        isHidden: comments.isHidden,
        hiddenAt: comments.hiddenAt,
        parentCommentId: comments.parentCommentId, // Include parent for replies
        reviewedAt: comments.reviewedAt,
        reviewAction: comments.reviewAction,
        isAllowed: comments.isAllowed,
        // Post information
        postSource: posts.source,
        postIgPostId: posts.igPostId,
        postFbPostId: posts.fbPostId,
        postCaption: posts.caption,
        postPermalink: posts.permalink,
        postPostedAt: posts.postedAt,
        postLikesCount: posts.likesCount,
        postCommentsCount: posts.commentsCount,
        postInstagramAccountId: posts.instagramAccountId,
        postFacebookPageId: posts.facebookPageId,
        // Post insights
        postImpressions: posts.impressions,
        postReach: posts.reach,
        postEngagement: posts.engagement,
        postSaved: posts.saved,
        postVideoViews: posts.videoViews,
        postInsightsLastFetchedAt: posts.insightsLastFetchedAt,
        accountUsername: instagramAccounts.username,
        accountName: instagramAccounts.name,
        pageId: facebookPages.id,
        pageName: facebookPages.pageName
      })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .leftJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
      .leftJoin(facebookPages, eq(posts.facebookPageId, facebookPages.id))
      .where(whereCondition)
      .orderBy(desc(comments.commentedAt))
      .limit(5000); // Increased limit to ensure we get all comments including replies for conversation threads

    // Get moderation logs for these comments (latest per comment for correct rationale e.g. Auto-hidden/Auto-deleted)
    const commentIds = commentsData.map(c => c.id);
    let moderationData: ModerationLogRow[] = commentIds.length > 0
      ? await db.query.moderationLogs.findMany({
          where: inArray(moderationLogs.commentId, commentIds)
        }) as ModerationLogRow[]
      : [];
    // Use latest log per comment so auto-action rationale (Auto-hidden / Auto-deleted) is shown
    moderationData = moderationData.sort((a, b) =>
      new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
    );
    const latestModLogByCommentId = new Map<string, ModerationLogRow>();
    for (const log of moderationData as ModerationLogRow[]) {
      if (log.commentId && !latestModLogByCommentId.has(log.commentId)) {
        latestModLogByCommentId.set(log.commentId, log);
      }
    }

    // Get unique commenter IDs and usernames for watchlist and suspicious account checks
    const commenterIds = Array.from(new Set(commentsData.map(c => c.commenterId)));
    const commenterUsernames = Array.from(new Set(commentsData.map(c => c.commenterUsername).filter(Boolean)));
    const postAccountIds = Array.from(new Set(commentsData.map(c => c.postInstagramAccountId).filter((id): id is string => Boolean(id))));

    // Check if commenters are on watchlist
    const watchlistEntries = commenterIds.length > 0
      ? await db.query.knownThreatsWatchlist.findMany({
          where: and(
            eq(knownThreatsWatchlist.isActive, true),
            inArray(knownThreatsWatchlist.instagramId, commenterIds)
          )
        })
      : [];

    // Load suspicious accounts by commenterId OR commenterUsername (match when Instagram sends ID vs username)
    const suspiciousAccountData = (commenterIds.length > 0 || commenterUsernames.length > 0) && postAccountIds.length > 0
      ? await db.query.suspiciousAccounts.findMany({
          where: and(
            inArray(suspiciousAccounts.instagramAccountId, postAccountIds),
            or(
              commenterIds.length > 0 ? inArray(suspiciousAccounts.commenterId, commenterIds) : sql`1 = 0`,
              commenterUsernames.length > 0 ? inArray(suspiciousAccounts.commenterUsername, commenterUsernames) : sql`1 = 0`
            )
          )
        })
      : [];

    // Check if commenters have been reported in the global threat network
    // We'll check this when building the commenter object by hashing each ID

    // Bot network connections removed for MVP simplification
    const botConnections: BotConnectionRow[] = [];
    const allBotConnections: BotConnectionWithAccountRow[] = [];

    // Use all comments for response (frontend will filter by showHidden if needed)
    const filteredCommentsData = commentsData as CommentDataRow[];

    // Calculate moderation stats per post (using all comments)
    const postModerationStats = new Map<string, {
      totalComments: number;
      deletedCount: number;
      hiddenCount: number;
      flaggedCount: number;
    }>();

    for (const comment of filteredCommentsData) {
      const stats = postModerationStats.get(comment.postId) || {
        totalComments: 0,
        deletedCount: 0,
        hiddenCount: 0,
        flaggedCount: 0
      };
      
      stats.totalComments++;
      if (comment.isDeleted) stats.deletedCount++;
      if (comment.isHidden) stats.hiddenCount++;
      
      const modLogForStats = latestModLogByCommentId.get(comment.id);
      if (modLogForStats && modLogForStats.actionTaken === 'FLAGGED') {
        stats.flaggedCount++;
      }
      
      postModerationStats.set(comment.postId, stats);
    }

    // Combine data
    let commentsWithDetails = (filteredCommentsData as CommentDataRow[]).map((comment: CommentDataRow) => {
      const modLog = latestModLogByCommentId.get(comment.id);
      const watchlistEntry = (watchlistEntries as WatchlistEntryRow[]).find((w: WatchlistEntryRow) =>
        w.instagramId === comment.commenterId || w.instagramUsername === comment.commenterUsername
      );
      const suspiciousAccountMatch = (suspiciousAccountData as SuspiciousAccountRow[]).find(
        (sa: SuspiciousAccountRow) =>
          sa.instagramAccountId === comment.postInstagramAccountId &&
          (sa.commenterId === comment.commenterId || sa.commenterUsername === comment.commenterUsername)
      );
      // Never show SUS for the account owner (they commented on their own post)
      const isAccountOwner = comment.accountUsername != null &&
        normalizeUsername(comment.commenterUsername) === normalizeUsername(comment.accountUsername);
      const suspiciousAccount = isAccountOwner ? null : suspiciousAccountMatch;

      // Find bot network connections
      const accountBotConnections = suspiciousAccount
        ? (botConnections as BotConnectionRow[]).filter((bc: BotConnectionRow) => bc.suspiciousAccountId === suspiciousAccount.id)
        : [];

      const mastermind = accountBotConnections.length > 0 ? accountBotConnections[0].mastermind : null;

      // Get all connected bot accounts for this mastermind
      const connectedBotAccounts: string[] = mastermind
        ? (allBotConnections as BotConnectionWithAccountRow[])
            .filter((bc: BotConnectionWithAccountRow) => bc.mastermindId === mastermind.id)
            .map((bc: BotConnectionWithAccountRow) => bc.suspiciousAccount.commenterUsername)
            .filter((username: string) => username !== comment.commenterUsername) // Exclude current commenter
        : [];

      return {
        id: comment.id,
        text: comment.text,
        commenterUsername: comment.commenterUsername,
        commenterId: comment.commenterId,
        commentedAt: comment.commentedAt.toISOString(),
        postId: comment.postId,
        isDeleted: comment.isDeleted,
        isHidden: comment.isHidden,
        hiddenAt: comment.hiddenAt?.toISOString() ?? null,
        igCommentId: comment.igCommentId,
        parentCommentId: comment.parentCommentId ?? null,
        reviewedAt: comment.reviewedAt?.toISOString() ?? null,
        reviewAction: comment.reviewAction ?? null,
        isAllowed: comment.isAllowed ?? false,
        post: {
          id: comment.postId,
          igPostId: comment.postIgPostId,
          caption: comment.postCaption,
          permalink: comment.postPermalink,
          postedAt: comment.postPostedAt.toISOString(),
          likesCount: comment.postLikesCount,
          commentsCount: comment.postCommentsCount,
          instagramAccount: {
            id: comment.postInstagramAccountId,
            username: comment.accountUsername,
            name: comment.accountName
          },
          // Add insights if available
          insights: (comment.postImpressions !== null || comment.postReach !== null || comment.postEngagement !== null || comment.postSaved !== null || comment.postVideoViews !== null) ? {
            impressions: comment.postImpressions ?? undefined,
            reach: comment.postReach ?? undefined,
            engagement: comment.postEngagement ?? undefined,
            saved: comment.postSaved ?? undefined,
            videoViews: comment.postVideoViews ?? undefined,
            insightsLastFetchedAt: comment.postInsightsLastFetchedAt?.toISOString() ?? undefined
          } : undefined,
          // Add moderation stats
          moderationStats: (() => {
            const stats = postModerationStats.get(comment.postId);
            if (!stats || stats.totalComments === 0) {
              return {
                totalComments: 0,
                deletedCount: 0,
                hiddenCount: 0,
                flaggedCount: 0,
                deletedRatio: 0,
                hiddenRatio: 0,
                flaggedRatio: 0
              };
            }
            return {
              totalComments: stats.totalComments,
              deletedCount: stats.deletedCount,
              hiddenCount: stats.hiddenCount,
              flaggedCount: stats.flaggedCount,
              deletedRatio: Math.round((stats.deletedCount / stats.totalComments) * 100),
              hiddenRatio: Math.round((stats.hiddenCount / stats.totalComments) * 100),
              flaggedRatio: Math.round((stats.flaggedCount / stats.totalComments) * 100)
            };
          })()
        },
        commenter: {
          isOnWatchlist: !!watchlistEntry,
          isSuspicious: suspiciousAccount ? (
            (suspiciousAccount.blackmailCount ?? 0) > 0 ||
            (suspiciousAccount.threatCount ?? 0) > 0 ||
            (suspiciousAccount.harassmentCount ?? 0) > 0 ||
            (suspiciousAccount.defamationCount ?? 0) > 0 ||
            (suspiciousAccount.spamCount ?? 0) > 0 ||
            (suspiciousAccount.flaggedComments ?? 0) > 0 ||
            (suspiciousAccount.deletedComments ?? 0) > 0
          ) : false,
          suspiciousAccountId: suspiciousAccount?.id,
          watchlistEntry: watchlistEntry ? {
            id: watchlistEntry.id,
            threatType: watchlistEntry.threatType,
            threatLevel: watchlistEntry.threatLevel,
            description: watchlistEntry.description
          } : undefined,
          connectedBotAccounts: connectedBotAccounts,
          botNetworkMastermind: mastermind ? {
            id: mastermind.id,
            name: mastermind.name,
            threatLevel: mastermind.threatLevel
          } : undefined,
          hasBeenReported: false, // Will be populated below
          reportedByAgencies: 0,
          threatLevel: null as string | null
        },
        moderation: modLog ? {
          category: modLog.category,
          severity: modLog.severity,
          confidence: modLog.confidence.toString(),
          actionTaken: modLog.actionTaken,
          rationale: modLog.rationale
        } : undefined
      };
    });

    // Populate reported account information
    for (const comment of commentsWithDetails) {
      const reportedAccount = await db.query.globalThreatNetwork.findFirst({
        where: eq(globalThreatNetwork.commenterIdHash, sql`encode(sha256(${comment.commenterId}::text::bytea), 'hex')`)
      });

      if (reportedAccount) {
        comment.commenter.hasBeenReported = true;
        comment.commenter.reportedByAgencies = reportedAccount.totalAgenciesTargeted ?? 0;
        comment.commenter.threatLevel = reportedAccount.isGlobalThreat ? 'GLOBAL' : 'REPORTED';
      }
    }

    // Apply watchlist filtering
    if (watchlistFilter && watchlistFilter !== 'all') {
      commentsWithDetails = commentsWithDetails.filter(comment => {
        switch (watchlistFilter) {
          case 'watchlist':
            return comment.commenter.isOnWatchlist;
          case 'suspicious':
            return comment.commenter.isSuspicious;
          case 'bot-network':
            return !!comment.commenter.botNetworkMastermind;
          case 'reported':
            return comment.commenter.hasBeenReported;
          default:
            return true;
        }
      });
    }

    // Apply filtering based on the filter parameter
    // IMPORTANT: Always preserve reply threads - if a parent comment is visible, include all its replies
    if (filter && filter !== 'all') {
      // First, identify which top-level comments match the filter
      const visibleTopLevelCommentIds = new Set<string>();
      
      for (const comment of commentsWithDetails) {
        if (!comment.parentCommentId) {
          // Top-level comment - check if it matches the filter
          if (!comment.moderation) {
            continue; // No moderation log, skip
          }
          
          const actionTaken = comment.moderation.actionTaken;
          let matchesFilter = false;
          
          switch (filter) {
            case 'deleted':
              matchesFilter = comment.isDeleted || actionTaken === 'DELETED';
              break;
            case 'flagged':
              matchesFilter = actionTaken === 'FLAGGED';
              break;
            case 'benign':
              matchesFilter = actionTaken === 'BENIGN' && !comment.isDeleted;
              break;
            case 'hidden':
              // Show comments we auto-hidden or auto-deleted (suspicious accounts, custom filters)
              matchesFilter = comment.isHidden || comment.isDeleted;
              break;
            default:
              matchesFilter = true;
          }
          
          if (matchesFilter) {
            visibleTopLevelCommentIds.add(comment.id);
          }
        }
      }
      
      // Now filter: include top-level comments that match filter + ALL replies whose parents are visible
      commentsWithDetails = commentsWithDetails.filter(comment => {
        if (comment.parentCommentId) {
          // This is a reply - include it if its parent is in the visible set
          return visibleTopLevelCommentIds.has(comment.parentCommentId);
        } else {
          // This is a top-level comment - include it if it matches the filter
          return visibleTopLevelCommentIds.has(comment.id);
        }
      });
    }

    // Limit to 500 after filtering (increased to preserve conversation threads)
    // This ensures we show complete comment threads, not just top-level comments
    commentsWithDetails = commentsWithDetails.slice(0, 500);

    res.json({
      success: true,
      data: commentsWithDetails as CommentWithDetails[]
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch comments'
    });
  }
}

/**
 * Delete a comment from Instagram (permanently)
 */
export async function deleteComment(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentId } = req.params;

    // Get comment with post and account/page info
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
      with: {
        post: {
          with: {
            instagramAccount: true
          }
        }
      }
    });

    if (!comment) {
      res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
      return;
    }

    // Verify ownership based on source
    const isInstagram = comment.source === 'instagram';
    const isFacebook = comment.source === 'facebook';
    
    if (isInstagram && comment.post.instagramAccount) {
      if (comment.post.instagramAccount.userId !== req.userId) {
        res.status(403).json({
          success: false,
          error: 'Forbidden'
        });
        return;
      }
    } else if (isFacebook && comment.post.facebookPageId) {
      // Facebook ownership check - simplified for now
      // TODO: Implement proper facebookPage relation and ownership check
    } else {
      res.status(400).json({
        success: false,
        error: 'Invalid comment source or missing account/page'
      });
      return;
    }

    // Check if already deleted
    if (comment.isDeleted) {
      res.json({
        success: true,
        data: {
          success: true,
          message: `Comment already deleted from ${isInstagram ? 'Instagram' : 'Facebook'}`
        }
      });
      return;
    }

    // Delete based on source
    let success = false;
    let accessToken: string | null = null;

    if (isInstagram) {
      const igCommentId = comment.igCommentId?.trim();
      const postIgPostId = comment.post?.igPostId?.trim();

      if (!igCommentId) {
        res.status(400).json({
          success: false,
          error: 'Comment has no Instagram comment ID. Cannot delete.'
        });
        return;
      }

      // CRITICAL: Never pass the post/media ID to the delete endpoint – that can remove all comments on the post
      if (postIgPostId && igCommentId === postIgPostId) {
        console.error(`[DELETE COMMENT] Refusing delete: igCommentId equals post igPostId (would delete all comments). commentId=${commentId}, igCommentId=${igCommentId}`);
        res.status(400).json({
          success: false,
          error: 'Invalid comment data: comment ID matches post ID. Please refresh and try again.'
        });
        return;
      }

      // Get Page access token for Instagram
      accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount!.id);
      if (!accessToken) {
        res.status(400).json({
          success: false,
          error: 'No access token available. Please reconnect your account via Facebook Login.'
        });
        return;
      }

      success = await instagramService.deleteComment(
        igCommentId,
        accessToken
      );
    } else if (isFacebook) {
      // Get Page access token for Facebook
      if (!comment.post.facebookPageId) {
        res.status(400).json({
          success: false,
          error: 'Facebook page ID not found'
        });
        return;
      }
      accessToken = await getPageAccessTokenForFacebookPage(comment.post.facebookPageId);
      if (!accessToken) {
        res.status(400).json({
          success: false,
          error: 'No access token available. Please reconnect your page.'
        });
        return;
      }

      success = await facebookService.deleteComment(
        comment.fbCommentId!,
        accessToken
      );
    }

    if (success) {
      // Mark as deleted in database
      await db
        .update(comments)
        .set({
          isDeleted: true,
          deletedAt: new Date()
        })
        .where(eq(comments.id, commentId));

      console.log(`✅ Comment ${commentId} deleted from ${isInstagram ? 'Instagram' : 'Facebook'}`);

      res.json({
        success: true,
        data: {
          success: true,
          message: `Comment deleted from ${isInstagram ? 'Instagram' : 'Facebook'} successfully`
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: `Failed to delete comment from ${isInstagram ? 'Instagram' : 'Facebook'}`
      });
    }
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete comment'
    });
  }
}

/**
 * Hide a comment from view (mark as hidden in DB, don't delete from Instagram)
 */
export async function hideComment(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentId } = req.params;

    // Get comment with post and account/page info
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
      with: {
        post: {
          with: {
            instagramAccount: true
          }
        }
      }
    });

    if (!comment) {
      res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
      return;
    }

    // Verify ownership based on source
    const isInstagram = comment.source === 'instagram';
    const isFacebook = comment.source === 'facebook';
    
    if (isInstagram && comment.post.instagramAccount) {
      if (comment.post.instagramAccount.userId !== req.userId) {
        res.status(403).json({
          success: false,
          error: 'Forbidden'
        });
        return;
      }
    } else if (isFacebook && comment.post.facebookPageId) {
      // Facebook ownership check - simplified for now
      // TODO: Implement proper facebookPage relation and ownership check
    } else {
      res.status(400).json({
        success: false,
        error: 'Invalid comment source or missing account/page'
      });
      return;
    }

    // Hide via platform API first, then mark in DB
    if (isFacebook) {
      const facebookPageId = comment.post.facebookPageId;
      if (!facebookPageId) {
        res.status(400).json({
          success: false,
          error: 'Facebook page ID not found'
        });
        return;
      }
      const accessToken = await getPageAccessTokenForFacebookPage(facebookPageId);
      if (accessToken) {
        await facebookService.hideComment(comment.fbCommentId!, accessToken, true);
      }
    } else if (isInstagram && comment.igCommentId) {
      const accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount!.id);
      if (accessToken) {
        const success = await instagramService.hideComment(comment.igCommentId, accessToken);
        if (!success) {
          console.warn(`[Comments] Instagram hideComment API failed for comment ${commentId} (ig: ${comment.igCommentId})`);
        }
      } else {
        console.warn(`[Comments] No access token for Instagram account ${comment.post.instagramAccount!.id}, hiding in DB only`);
      }
    }

    // Mark as hidden in database
    await db
      .update(comments)
      .set({
        isHidden: true,
        hiddenAt: new Date()
      })
      .where(eq(comments.id, commentId));

    console.log(`✅ Comment ${commentId} hidden from ${isInstagram ? 'Instagram' : 'Facebook'}`);

    res.json({
      success: true,
      data: {
        success: true,
        message: `Comment hidden from ${isInstagram ? 'view' : 'Facebook'}`
      }
    });
  } catch (error) {
    console.error('Hide comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to hide comment'
    });
  }
}

/**
 * Bulk hide multiple comments
 */
export async function bulkHideComments(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: number; failed: number; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentIds } = req.body as { commentIds: string[] };

    if (!Array.isArray(commentIds) || commentIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'commentIds array is required'
      });
      return;
    }

    let successCount = 0;
    let failedCount = 0;

    // Process each comment
    for (const commentId of commentIds) {
      try {
        // Get comment with post and account/page info
        const comment = await db.query.comments.findFirst({
          where: eq(comments.id, commentId),
          with: {
            post: {
              with: {
                instagramAccount: true
              }
            }
          }
        });

        if (!comment) {
          failedCount++;
          continue;
        }

        const isInstagram = comment.source === 'instagram';
        const isFacebook = comment.source === 'facebook';

        // Verify ownership
        if (isInstagram && comment.post.instagramAccount) {
          if (comment.post.instagramAccount.userId !== req.userId) {
            failedCount++;
            continue;
          }
        } else if (isFacebook && comment.post.facebookPageId) {
          // Facebook ownership check - simplified for now
          // TODO: Implement proper facebookPage relation and ownership check
        } else {
          failedCount++;
          continue;
        }

        // Skip if already hidden or deleted
        if (comment.isHidden || comment.isDeleted) {
          successCount++; // Count as success since it's already in desired state
          continue;
        }

        // Hide via platform API
        if (isFacebook && comment.fbCommentId) {
          if (!comment.post.facebookPageId) continue;
      const accessToken = await getPageAccessTokenForFacebookPage(comment.post.facebookPageId);
          if (accessToken) {
            await facebookService.hideComment(comment.fbCommentId, accessToken, true);
          }
        } else if (isInstagram && comment.igCommentId) {
          const accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount!.id);
          if (accessToken) {
            const success = await instagramService.hideComment(comment.igCommentId, accessToken);
            if (!success) {
              console.warn(`[Comments] Bulk hide: Instagram API failed for comment ${commentId}`);
            }
          }
        }

        // Mark as hidden in database
        await db
          .update(comments)
          .set({
            isHidden: true,
            hiddenAt: new Date()
          })
          .where(eq(comments.id, commentId));

        successCount++;
      } catch (error) {
        console.error(`Failed to hide comment ${commentId}:`, error);
        failedCount++;
      }
    }

    res.json({
      success: true,
      data: {
        success: successCount,
        failed: failedCount,
        message: `Successfully hid ${successCount} comment(s), ${failedCount} failed`
      }
    });
  } catch (error) {
    console.error('Bulk hide comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to hide comments'
    });
  }
}

/**
 * Bulk delete multiple comments from Instagram
 */
export async function bulkDeleteComments(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: number; failed: number; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentIds } = req.body as { commentIds: string[] };

    if (!Array.isArray(commentIds) || commentIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'commentIds array is required'
      });
      return;
    }

    let successCount = 0;
    let failedCount = 0;

    // Process each comment
    for (const commentId of commentIds) {
      try {
        // Get comment with post and account info
        const comment = await db.query.comments.findFirst({
          where: eq(comments.id, commentId),
          with: {
            post: {
              with: {
                instagramAccount: true
              }
            }
          }
        });

        if (!comment) {
          failedCount++;
          continue;
        }

        // Verify ownership
        if (!comment.post.instagramAccount || comment.post.instagramAccount.userId !== req.userId) {
          failedCount++;
          continue;
        }

        // Skip if already deleted
        if (comment.isDeleted) {
          successCount++; // Count as success since it's already deleted
          continue;
        }

        const igCommentId = comment.igCommentId?.trim();
        const postIgPostId = comment.post?.igPostId?.trim();

        if (!igCommentId) {
          failedCount++;
          continue;
        }

        // Never pass post/media ID to delete – that would remove all comments on the post
        if (postIgPostId && igCommentId === postIgPostId) {
          console.error(`[BULK DELETE] Skipping comment ${commentId}: igCommentId equals post igPostId`);
          failedCount++;
          continue;
        }

        // Get Page access token
        if (!comment.post.instagramAccount) {
          failedCount++;
          continue;
        }
        if (!comment.post.instagramAccount) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }
    const accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount.id);
        if (!accessToken) {
          failedCount++;
          continue;
        }

        // Delete from Instagram (single comment ID only)
        const success = await instagramService.deleteComment(
          igCommentId,
          accessToken
        );

        if (success) {
          // Mark as deleted in database
          await db
            .update(comments)
            .set({
              isDeleted: true,
              deletedAt: new Date()
            })
            .where(eq(comments.id, commentId));

          successCount++;
        } else {
          failedCount++;
        }
      } catch (error) {
        console.error(`Failed to delete comment ${commentId}:`, error);
        failedCount++;
      }
    }

    res.json({
      success: true,
      data: {
        success: successCount,
        failed: failedCount,
        message: `Successfully deleted ${successCount} comment(s) from Instagram, ${failedCount} failed`
      }
    });
  } catch (error) {
    console.error('Bulk delete comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete comments'
    });
  }
}

export async function blockUser(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentId } = req.params;

    // Get comment with post and account info
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
      with: {
        post: {
          with: {
            instagramAccount: true
          }
        }
      }
    });

    if (!comment) {
      res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
      return;
    }

    // Verify ownership
    if (!comment.post.instagramAccount) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }

    if (comment.post.instagramAccount.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }
    const accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount.id);
    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: 'No access token available. Please reconnect your account via Facebook Login.'
      });
      return;
    }

    // Block user via Instagram API
    const blockSuccess = await instagramService.blockUser(
      comment.commenterId,
      accessToken
    );

    if (!blockSuccess) {
      throw new Error('Failed to block user on Instagram');
    }

    // Mark as blocked in database
    await db
      .update(comments)
      .set({
        isBlocked: true,
        blockedAt: new Date()
      })
      .where(eq(comments.id, commentId));

    console.log(`✅ User ${comment.commenterId} blocked from commenting`);

    res.json({
      success: true,
      data: {
        success: true,
        message: 'User blocked from commenting'
      }
    });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to block user'
    });
  }
}

export async function restrictUser(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentId } = req.params;

    // Get comment with post and account info
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
      with: {
        post: {
          with: {
            instagramAccount: true
          }
        }
      }
    });

    if (!comment) {
      res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
      return;
    }

    // Verify ownership
    if (!comment.post.instagramAccount) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }

    if (comment.post.instagramAccount.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }
    const accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount.id);
    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: 'No access token available. Please reconnect your account via Facebook Login.'
      });
      return;
    }

    // Restrict user via Instagram API
    const restrictSuccess = await instagramService.restrictUser(
      comment.commenterId,
      accessToken
    );

    if (!restrictSuccess) {
      throw new Error('Failed to restrict user on Instagram');
    }

    // Mark as restricted in database
    await db
      .update(comments)
      .set({
        isRestricted: true,
        restrictedAt: new Date()
      })
      .where(eq(comments.id, commentId));

    console.log(`✅ User ${comment.commenterId} restricted`);

    res.json({
      success: true,
      data: {
        success: true,
        message: 'User restricted successfully'
      }
    });
  } catch (error) {
    console.error('Restrict user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to restrict user'
    });
  }
}

export async function reportComment(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean; message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Gate: check comments_moderated limit
    const { allowed } = await checkFeatureAllowed({
      userId: req.userId,
      featureId: "comments_moderated",
    });
    if (!allowed) {
      res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
      return;
    }

    const { commentId } = req.params;

    // Get comment with post and account info
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
      with: {
        post: {
          with: {
            instagramAccount: true
          }
        }
      }
    });

    if (!comment) {
      res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
      return;
    }

    // Verify ownership
    if (!comment.post.instagramAccount) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }

    if (comment.post.instagramAccount.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }
    const accessToken = await getPageAccessTokenForAccount(comment.post.instagramAccount.id);
    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: 'No access token available. Please reconnect your account via Facebook Login.'
      });
      return;
    }

    // Report comment via Instagram API
    if (!comment.igCommentId) {
      res.status(400).json({
        success: false,
        error: 'Comment ID not found'
      });
      return;
    }
    const reportSuccess = await instagramService.reportComment(
      comment.igCommentId,
      accessToken
    );

    if (!reportSuccess) {
      throw new Error('Failed to report comment on Instagram');
    }

    // Mark as reported in database
    await db
      .update(comments)
      .set({
        isReported: true,
        reportedAt: new Date()
      })
      .where(eq(comments.id, commentId));

    console.log(`✅ Comment ${commentId} reported to Instagram`);

    res.json({
      success: true,
      data: {
        success: true,
        message: 'Comment reported to Instagram'
      }
    });
  } catch (error) {
    console.error('Report comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to report comment'
    });
  }
}

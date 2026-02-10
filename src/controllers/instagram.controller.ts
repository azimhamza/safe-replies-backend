import { Response } from 'express';
import { instagramService } from '../services/instagram.service';
import { facebookService } from '../services/facebook.service';
import { deepSyncInstagramAccount } from '../services/polling.service';
import { db } from '../db';
import {
  instagramAccounts,
  comments,
  posts,
  facebookPages,
  pageInstagramConnections,
  moderationLogs,
  evidenceRecords,
  commentReviewActions,
  mastermindMentions,
  extractedIdentifiers,
  accountCommentMap,
  evidenceAttachments,
  caseEvidenceMap,
  watchlistDetections
} from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { DelegationRequest, getEffectiveOwner } from '../middleware/delegation.middleware';
import { ApiResponse } from '../types';
import { eq, and, isNotNull, inArray, ne } from 'drizzle-orm';

/**
 * Helper function to get Page access token for an Instagram account
 */
export async function getPageAccessToken(accountId: string): Promise<string | null> {
  const account = await db.query.instagramAccounts.findFirst({
    where: eq(instagramAccounts.id, accountId)
  });

  if (!account || !account.facebookPageId) {
    // Fallback to legacy accessToken if it exists
    return account?.accessToken || null;
  }

  const page = await db.query.facebookPages.findFirst({
    where: eq(facebookPages.id, account.facebookPageId)
  });

  return page?.pageAccessToken || null;
}

interface InstagramAccountResponse {
  id: string;
  username: string;
  name: string | null;
  accountType: 'BUSINESS' | 'CREATOR';
  followersCount: number | null;
  followingCount: number | null;
  profilePictureUrl: string | null;
  isActive: boolean | null;
  lastSyncAt: Date | null;
  createdAt: Date | null;
}

interface WebhookStatusResponse {
  isSubscribed: boolean;
  subscribedFields: string[];
  error?: string;
}

/**
 * Get Instagram OAuth authorization URL
 * @deprecated Use Facebook OAuth flow instead - see facebook.controller.ts
 */

/**
 * Handle Instagram OAuth callback
 * @deprecated Use Facebook OAuth flow instead - see facebook.controller.ts
 */

/**
 * Get connected Instagram accounts for current user (or for delegated client when agency passes ?clientId=)
 */
export async function getAccounts(
  req: AuthRequest,
  res: Response<ApiResponse<InstagramAccountResponse[]>>
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

    // Return accounts by effective owner: by clientId when agency delegates, else by userId
    const ownerCondition = effectiveClientId
      ? eq(instagramAccounts.clientId, effectiveClientId)
      : eq(instagramAccounts.userId, effectiveUserId!);

    // Only return Instagram accounts connected via Facebook (have facebookPageId) and are active
    const accounts = await db.query.instagramAccounts.findMany({
      where: and(
        ownerCondition,
        eq(instagramAccounts.isActive, true),
        isNotNull(instagramAccounts.facebookPageId)
      ),
      columns: {
        id: true,
        username: true,
        name: true,
        accountType: true,
        followersCount: true,
        followingCount: true,
        profilePictureUrl: true,
        isActive: true,
        lastSyncAt: true,
        createdAt: true
      }
    });
    
    // Map to response type (handle null values)
    const accountResponses: InstagramAccountResponse[] = accounts.map(acc => ({
      id: acc.id,
      username: acc.username,
      name: acc.name,
      accountType: acc.accountType,
      followersCount: acc.followersCount,
      followingCount: acc.followingCount,
      profilePictureUrl: acc.profilePictureUrl,
      isActive: acc.isActive ?? false,
      lastSyncAt: acc.lastSyncAt,
      createdAt: acc.createdAt
    }));
    
    res.json({
      success: true,
      data: accountResponses
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Get Instagram accounts error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Instagram accounts'
    });
  }
}

/**
 * Disconnect an Instagram account
 */
export async function disconnectAccount(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }
    
    const { accountId } = req.params;
    
    // Get account details before deleting
    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });
    
    if (!account) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }
    
    // Verify ownership
    if (account.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }
    
    // Get Page access token
    const accessToken = await getPageAccessToken(accountId);
    
    // Check if any OTHER active instagram account exists with the same instagramId (globally)
    // If so, do NOT unsubscribe, as it would break webhooks for the other user(s)
    const otherAccounts = await db.query.instagramAccounts.findFirst({
      where: and(
        eq(instagramAccounts.instagramId, account.instagramId),
        ne(instagramAccounts.id, accountId), // Not the one we are deleting
        eq(instagramAccounts.isActive, true)
      )
    });
    
    // Unsubscribe from webhooks ONLY if no one else is using this account
    if (accessToken && !otherAccounts) {
      console.log('🔕 Unsubscribing from webhooks...');
      await instagramService.unsubscribeFromWebhooks(account.instagramId, accessToken);
    } else if (otherAccounts) {
      console.log('ℹ️  Not unsubscribing from webhooks because other users are connected to this Instagram account.');
    }

    // Step 1: Delete the Page-Instagram connection record
    if (account.facebookPageId) {
      try {
        await db
          .delete(pageInstagramConnections)
          .where(eq(pageInstagramConnections.instagramAccountId, accountId));
        console.log(`✅ Deleted Page-Instagram connection record for account ${account.username}`);
      } catch (connError) {
        console.warn(`⚠️  Failed to delete connection record:`, connError);
        // Continue with deletion even if connection record deletion fails
      }

      // Step 2: Check if this is the only Instagram account connected to the Page
      const allAccountsOnPage = await db.query.instagramAccounts.findMany({
        where: and(
          eq(instagramAccounts.facebookPageId, account.facebookPageId),
          eq(instagramAccounts.isActive, true)
        )
      });

      // If this is the only account on the Page, note it (but keep Page active for potential reconnection)
      const isOnlyAccount = allAccountsOnPage.length === 1 && allAccountsOnPage[0].id === accountId;
      if (isOnlyAccount) {
        console.log(`ℹ️  This is the only Instagram account on Page ${account.facebookPageId}. Page will remain active for potential reconnection.`);
      }
    }

    // Step 3: Hard delete: Remove the Instagram account from database
    try {
      await db
        .delete(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, accountId),
            eq(instagramAccounts.userId, req.userId)
          )
        );
      
      console.log(`✅ Instagram account ${account.username} (${accountId}) deleted successfully`);
      
      res.json({
        success: true,
        data: { success: true }
      });
    } catch (deleteError: unknown) {
      // If hard delete fails due to foreign key constraints, fall back to soft delete
      const errorMsg = deleteError instanceof Error ? deleteError.message : 'Unknown error';
      if (errorMsg.includes('foreign key') || errorMsg.includes('constraint')) {
        console.log(`⚠️ Hard delete failed due to foreign key constraints, falling back to soft delete...`);
        await db
          .update(instagramAccounts)
          .set({ isActive: false })
          .where(
            and(
              eq(instagramAccounts.id, accountId),
              eq(instagramAccounts.userId, req.userId)
            )
          );
        console.log(`✅ Instagram account ${account.username} (${accountId}) soft deleted (isActive=false)`);
        res.json({
          success: true,
          data: { success: true }
        });
      } else {
        throw deleteError;
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Disconnect Instagram account error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect Instagram account'
    });
  }
}

/**
 * Get webhook subscription status for an Instagram account
 */
export async function getWebhookStatus(
  req: AuthRequest,
  res: Response<ApiResponse<WebhookStatusResponse>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    const { accountId } = req.params;

    // Get account
    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });

    if (!account) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }

    // Verify ownership
    if (account.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }

    // Get Page access token
    const accessToken = await getPageAccessToken(accountId);
    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: 'No access token available. Please reconnect your account via Facebook Login.'
      });
      return;
    }
    
    // Check webhook subscription status
    const status = await instagramService.getWebhookSubscriptions(
      account.instagramId,
      accessToken
    );

    res.json({
      success: true,
      data: status
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Get webhook status error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to get webhook status'
    });
  }
}

/**
 * Delete all comments (and related data) for an Instagram account's posts.
 * Used before re-fetching so comments are re-inserted and re-moderated.
 */
async function deleteCommentsForAccount(accountId: string): Promise<number> {
  const accountCommentIds = await db
    .select({ id: comments.id })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .where(eq(posts.instagramAccountId, accountId));

  const commentIds = accountCommentIds.map((r) => r.id);
  if (commentIds.length === 0) return 0;

  const moderationLogIds = await db
    .select({ id: moderationLogs.id })
    .from(moderationLogs)
    .where(inArray(moderationLogs.commentId, commentIds));

  const logIds = moderationLogIds.map((r) => r.id);

  if (logIds.length > 0) {
    await db.delete(evidenceRecords).where(inArray(evidenceRecords.moderationLogId, logIds));
  }
  await db.delete(moderationLogs).where(inArray(moderationLogs.commentId, commentIds));
  await db.delete(commentReviewActions).where(inArray(commentReviewActions.commentId, commentIds));
  await db.delete(mastermindMentions).where(inArray(mastermindMentions.commentId, commentIds));
  await db.delete(extractedIdentifiers).where(inArray(extractedIdentifiers.commentId, commentIds));
  await db.delete(accountCommentMap).where(inArray(accountCommentMap.commentId, commentIds));
  await db.delete(caseEvidenceMap).where(inArray(caseEvidenceMap.commentId, commentIds));
  await db.delete(evidenceAttachments).where(inArray(evidenceAttachments.commentId, commentIds));
  await db.delete(watchlistDetections).where(inArray(watchlistDetections.commentId, commentIds));
  await db.update(comments).set({ parentCommentId: null }).where(inArray(comments.id, commentIds));
  await db.delete(comments).where(inArray(comments.id, commentIds));

  return commentIds.length;
}

/**
 * Refresh comments: delete existing comments from DB, then re-fetch from Instagram and re-run moderation.
 * 1) Deletes all comments (and moderation logs, evidence, etc.) for this account.
 * 2) Starts sync in background to fetch latest comments from Instagram (re-inserts and enqueues each for moderation).
 */
export async function refreshComments(
  req: AuthRequest,
  res: Response<ApiResponse<{
    message: string;
    syncStarted: boolean;
    syncCompleted: boolean;
    deletedCount: number;
    postsCount: number;
    commentsCount: number;
    newCommentsCount: number;
  }>>
): Promise<void> {
  try {
    console.log('🔄 [REFRESH COMMENTS] Request received');
    console.log('🔄 [REFRESH COMMENTS] User ID:', req.userId);
    console.log('🔄 [REFRESH COMMENTS] Account Type:', req.accountType);

    if (!req.userId) {
      console.error('🔄 [REFRESH COMMENTS] No userId - returning 401');
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    const { accountId } = req.params;
    console.log('🔄 [REFRESH COMMENTS] Account ID from params:', accountId);

    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });

    if (!account) {
      console.error('🔄 [REFRESH COMMENTS] Account not found:', accountId);
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }

    console.log('🔄 [REFRESH COMMENTS] Account found:', {
      username: account.username,
      userId: account.userId,
      clientId: account.clientId
    });

    // Import DelegationRequest and getEffectiveOwner for proper ownership check
    const delegationReq = req as DelegationRequest;
    const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);

    console.log('🔄 [REFRESH COMMENTS] Effective IDs:', {
      effectiveUserId,
      effectiveClientId
    });

    // Verify ownership: check against clientId for CLIENT accounts, userId for CREATOR/AGENCY accounts
    const ownsAccount = effectiveClientId
      ? account.clientId === effectiveClientId
      : account.userId === effectiveUserId;

    console.log('🔄 [REFRESH COMMENTS] Ownership check:', ownsAccount);

    if (!ownsAccount) {
      console.error('🔄 [REFRESH COMMENTS] Ownership check failed');
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }

    const accessToken = await getPageAccessToken(accountId);
    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: 'No access token available. Please reconnect your account via Facebook Login.'
      });
      return;
    }

    // 1) Delete all comments for this account from the database (and related moderation/evidence data)
    const deletedCount = await deleteCommentsForAccount(accountId);
    if (deletedCount > 0) {
      console.log(`🗑️ [REFRESH COMMENTS] Deleted ${deletedCount} comment(s) for account ${account.username}`);
    }

    // 2) Sync and WAIT for completion – re-fetches comments from Instagram, inserts them, and enqueues each for moderation (LLM runs again)
    console.log('🔄 [REFRESH COMMENTS] Starting sync...');
    const syncResults = await syncAccountData(accountId, account.instagramId, accessToken, true, false, true);
    console.log(`🔄 [REFRESH COMMENTS] Sync complete! Posts: ${syncResults.postsCount}, Comments: ${syncResults.commentsCount}`);

    // Build a detailed message about what happened
    let message = '';
    if (deletedCount > 0) {
      message += `Deleted ${deletedCount} old comment(s). `;
    }
    message += `Synced ${syncResults.postsCount} post(s) and ${syncResults.commentsCount} comment(s) from Instagram. `;
    message += 'All comments have been re-moderated with auto-delete/hide rules applied.';

    res.json({
      success: true,
      data: {
        message,
        syncStarted: true,
        syncCompleted: true,
        deletedCount,
        postsCount: syncResults.postsCount,
        commentsCount: syncResults.commentsCount,
        newCommentsCount: syncResults.commentsCount // All comments are "new" since we deleted old ones
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Refresh comments error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh comments'
    });
  }
}

/**
 * Manually trigger a Deep Sync for an Instagram account.
 * This runs in the background and returns immediately.
 */
export async function manualDeepSync(
  req: AuthRequest,
  res: Response<ApiResponse<{ message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { accountId } = req.params;
    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });

    if (!account) {
      res.status(404).json({ success: false, error: 'Account not found' });
      return;
    }

    if (account.userId !== req.userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    // Trigger background job
    deepSyncInstagramAccount(accountId).catch(err => {
      console.error(`[MANUAL SYNC] Failed for account ${account.username}:`, err);
    });

    res.status(202).json({
      success: true,
      data: { message: 'Deep sync started in background' }
    });
  } catch (error) {
    console.error('Manual Deep Sync error:', error);
    res.status(500).json({ success: false, error: 'Failed to start sync' });
  }
}

/**
 * Internal helper: refresh profile info (including profile picture) for one Instagram account.
 * Caller must ensure the account belongs to the current user when used from a user-facing endpoint.
 */
async function refreshSingleAccountProfileInfo(accountId: string): Promise<{ success: boolean; error?: string }> {
  const account = await db.query.instagramAccounts.findFirst({
    where: eq(instagramAccounts.id, accountId)
  });
  if (!account) {
    return { success: false, error: 'Account not found' };
  }
  const accessToken = await getPageAccessToken(accountId);
  if (!accessToken) {
    return { success: false, error: 'No access token. Reconnect via Facebook Login.' };
  }
  const accountInfo = await facebookService.getInstagramAccountDetails(account.instagramId, accessToken);
  if (!accountInfo) {
    return { success: false, error: 'Could not fetch account details from Facebook.' };
  }
  let profilePictureUrl: string | null = accountInfo.profile_picture_url || null;
  if (!profilePictureUrl && account.facebookPageId) {
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, account.facebookPageId)
    });
    if (page) {
      const igFromPage = await facebookService.getInstagramBusinessAccount(page.facebookPageId, accessToken);
      if (igFromPage?.id === account.instagramId && igFromPage.profile_picture_url) {
        profilePictureUrl = igFromPage.profile_picture_url;
      }
    }
  }
  if (!profilePictureUrl && account.profilePictureUrl) {
    profilePictureUrl = account.profilePictureUrl;
  }
  await db
    .update(instagramAccounts)
    .set({
      name: accountInfo.name ?? null,
      followersCount: accountInfo.followers_count ?? 0,
      followingCount: accountInfo.follows_count ?? 0,
      profilePictureUrl,
      username: accountInfo.username
    })
    .where(eq(instagramAccounts.id, accountId));
  return { success: true };
}

/**
 * Refresh Instagram account information (profile data) for one account
 */
export async function refreshAccountInfo(
  req: AuthRequest,
  res: Response<ApiResponse<{ message: string }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }
    const { accountId } = req.params;
    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });
    if (!account) {
      res.status(404).json({ success: false, error: 'Instagram account not found' });
      return;
    }
    if (account.userId !== req.userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    console.log(`🔄 Refreshing account info for ${account.username}...`);
    const result = await refreshSingleAccountProfileInfo(accountId);
    if (!result.success) {
      res.status(502).json({
        success: false,
        error: result.error ?? 'Failed to refresh account information'
      });
      return;
    }
    console.log(`✅ Account info refreshed for ${account.username}`);
    res.json({
      success: true,
      data: { message: 'Account information refreshed successfully' }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Refresh account info error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh account information'
    });
  }
}

/**
 * Refresh profile info (including profile picture) for all of the user's Instagram accounts.
 */
export async function refreshAllAccountsInfo(
  req: AuthRequest,
  res: Response<ApiResponse<{ refreshed: number; failed: number; total: number; errors?: string[] }>>
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
    const ownerCondition = effectiveClientId
      ? eq(instagramAccounts.clientId, effectiveClientId)
      : eq(instagramAccounts.userId, effectiveUserId!);
    const accounts = await db.query.instagramAccounts.findMany({
      where: and(
        ownerCondition,
        eq(instagramAccounts.isActive, true),
        isNotNull(instagramAccounts.facebookPageId)
      ),
      columns: { id: true, username: true }
    });
    if (accounts.length === 0) {
      res.json({
        success: true,
        data: { refreshed: 0, failed: 0, total: 0 }
      });
      return;
    }
    let refreshed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const acc of accounts) {
      const result = await refreshSingleAccountProfileInfo(acc.id);
      if (result.success) {
        refreshed++;
        console.log(`✅ Refreshed profile for ${acc.username}`);
      } else {
        failed++;
        errors.push(`${acc.username}: ${result.error ?? 'Unknown error'}`);
      }
    }
    console.log(`🔄 Refresh all: ${refreshed}/${accounts.length} accounts updated`);
    res.json({
      success: true,
      data: {
        refreshed,
        failed,
        total: accounts.length,
        ...(errors.length > 0 && { errors })
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Refresh all accounts info error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh accounts'
    });
  }
}

/**
 * Get comprehensive account stats including insights, comments, and sentiment
 */
export async function getAccountStats(
  req: AuthRequest,
  res: Response<ApiResponse<{
    account: {
      id: string;
      username: string;
      name?: string;
      followersCount?: number;
      followingCount?: number;
      profilePictureUrl?: string;
    };
    insights: Array<{ name: string; value: number; period?: string; end_time?: string }>;
    comments: {
      total: number;
      flagged: number;
      hidden: number;
      positive: number;
      negative: number;
      sentimentRatio: number; // percentage of positive comments
    };
        posts: Array<{
          id: string;
          igPostId: string;
          caption?: string;
          postedAt: string;
          likesCount?: number;
          commentsCount?: number;
          impressions?: number;
          reach?: number;
          engagement?: number;
          saved?: number;
          videoViews?: number;
          commentStats: {
            total: number;
            flagged: number;
            hidden: number;
            deleted: number;
            positive: number;
            negative: number;
            sentimentRatio: number;
          };
        }>;
        overall: {
          totalPosts: number;
          totalComments: number;
          totalFlagged: number;
          totalHidden: number;
          totalDeleted: number;
          totalPositive: number;
          totalNegative: number;
          overallSentimentRatio: number;
          averageEngagement?: number;
          totalImpressions?: number;
          totalReach?: number;
        };
        followerGrowth: {
          hourly: number;
          daily: number;
          weekly: number;
          monthly: number;
          yearly: number;
        };
  }>>
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }
    
    const { accountId } = req.params;
    
    // Verify ownership
    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });
    
    if (!account) {
      res.status(404).json({
        success: false,
        error: 'Instagram account not found'
      });
      return;
    }
    
    if (account.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden'
      });
      return;
    }
    
    // Get Page access token
    const accessToken = await getPageAccessToken(accountId);
    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: 'No access token available. Please reconnect your account via Facebook Login.'
      });
      return;
    }
    
    // Fetch account insights from Instagram API
    let insights: Array<{ name: string; value: number; period?: string; end_time?: string }> = [];
    try {
      insights = await instagramService.getAccountInsights(
        account.instagramId,
        accessToken,
        ['follower_count', 'email_contacts', 'phone_call_clicks', 'text_message_clicks', 'get_directions_clicks', 'website_clicks', 'profile_views'],
        'day'
      );
    } catch (insightsError: unknown) {
      // Silently fail if insights permission is not available
      console.log('Insights not available:', insightsError instanceof Error ? insightsError.message : 'Unknown error');
    }
    
    // Get all posts for this account
    const allPosts = await db.query.posts.findMany({
      where: eq(posts.instagramAccountId, accountId),
      orderBy: (posts, { desc }) => [desc(posts.postedAt)]
    });
    
    // Get all comments for these posts
    const postIds = allPosts.map(p => p.id);
    const allComments = postIds.length > 0
      ? await db.query.comments.findMany({
          where: inArray(comments.postId, postIds)
        })
      : [];
    
    // Get moderation logs for sentiment analysis
    const commentIds = allComments.map(c => c.id);
    const moderationLogsData = commentIds.length > 0
      ? await db.query.moderationLogs.findMany({
          where: inArray(moderationLogs.commentId, commentIds)
        })
      : [];
    
    // Create a map of commentId -> moderation log
    const moderationMap = new Map(
      moderationLogsData.map(log => [log.commentId, log])
    );
    
    // Calculate overall comment stats
    let totalComments = allComments.length;
    let flaggedComments = 0;
    let hiddenComments = 0;
    let deletedComments = 0;
    let positiveComments = 0;
    let negativeComments = 0;
    
    for (const comment of allComments) {
      if (comment.isHidden) hiddenComments++;
      if (comment.isDeleted) deletedComments++;
      
      const modLog = moderationMap.get(comment.id);
      if (modLog) {
        if (modLog.actionTaken === 'FLAGGED') flaggedComments++;
        if (modLog.category === 'benign') {
          positiveComments++;
        } else {
          negativeComments++;
        }
      } else {
        // If no moderation log, assume benign (positive)
        positiveComments++;
      }
    }
    
    const sentimentRatio = totalComments > 0 
      ? Math.round((positiveComments / totalComments) * 100) 
      : 0;
    
    // Calculate per-post stats
    const postsWithStats = await Promise.all(
      allPosts.map(async (post) => {
        const postComments = allComments.filter(c => c.postId === post.id);
        const postCommentIds = postComments.map(c => c.id);
        const postModerationLogs = postCommentIds.length > 0
          ? moderationLogsData.filter(log => postCommentIds.includes(log.commentId))
          : [];
        
        const postModerationMap = new Map(
          postModerationLogs.map(log => [log.commentId, log])
        );
        
        let postTotal = postComments.length;
        let postFlagged = 0;
        let postHidden = 0;
        let postDeleted = 0;
        let postPositive = 0;
        let postNegative = 0;
        
        for (const comment of postComments) {
          if (comment.isHidden) postHidden++;
          if (comment.isDeleted) postDeleted++;
          
          const modLog = postModerationMap.get(comment.id);
          if (modLog) {
            if (modLog.actionTaken === 'FLAGGED') postFlagged++;
            if (modLog.category === 'benign') {
              postPositive++;
            } else {
              postNegative++;
            }
          } else {
            postPositive++;
          }
        }
        
        const postSentimentRatio = postTotal > 0
          ? Math.round((postPositive / postTotal) * 100)
          : 0;
        
        return {
          id: post.id,
          igPostId: post.igPostId ?? '',
          caption: post.caption || undefined,
          postedAt: post.postedAt.toISOString(),
          likesCount: post.likesCount || undefined,
          commentsCount: post.commentsCount || undefined,
          impressions: post.impressions || undefined,
          reach: post.reach || undefined,
          engagement: post.engagement || undefined,
          saved: post.saved || undefined,
          videoViews: post.videoViews || undefined,
          commentStats: {
            total: postTotal,
            flagged: postFlagged,
            hidden: postHidden,
            deleted: postDeleted,
            positive: postPositive,
            negative: postNegative,
            sentimentRatio: postSentimentRatio
          }
        };
      })
    );
    
    // Calculate overall stats
    const totalImpressions = allPosts.reduce((sum, p) => sum + (p.impressions || 0), 0);
    const totalReach = allPosts.reduce((sum, p) => sum + (p.reach || 0), 0);
    const totalEngagement = allPosts.reduce((sum, p) => sum + (p.engagement || 0), 0);
    const avgEngagement = allPosts.length > 0 ? Math.round(totalEngagement / allPosts.length) : undefined;
    
    res.json({
      success: true,
      data: {
        account: {
          id: account.id,
          username: account.username,
          name: account.name || undefined,
          followersCount: account.followersCount || undefined,
          followingCount: account.followingCount || undefined,
          profilePictureUrl: account.profilePictureUrl || undefined
        },
        insights,
        comments: {
          total: totalComments,
          flagged: flaggedComments,
          hidden: hiddenComments,
          positive: positiveComments,
          negative: negativeComments,
          sentimentRatio
        },
        posts: postsWithStats,
        overall: {
          totalPosts: allPosts.length,
          totalComments,
          totalFlagged: flaggedComments,
          totalHidden: hiddenComments,
          totalDeleted: deletedComments,
          totalPositive: positiveComments,
          totalNegative: negativeComments,
          overallSentimentRatio: sentimentRatio,
          averageEngagement: avgEngagement,
          totalImpressions: totalImpressions > 0 ? totalImpressions : undefined,
          totalReach: totalReach > 0 ? totalReach : undefined
        },
        followerGrowth: {
          hourly: 0,
          daily: 0,
          weekly: 0,
          monthly: 0,
          yearly: 0
        }
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Get account stats error:', errorMessage);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch account stats'
    });
  }
}

/**
 * Background function to sync posts (and optionally comments for testing)
 * @param includeComments - Set to true for testing without webhooks (Advanced Access not yet approved)
 * @param isRefreshRun - When true, comments were just cleared for this account; all fetched comments will be inserted and enqueued for moderation (LLM re-run).
 */
export async function syncAccountData(
  accountId: string,
  instagramUserId: string,
  accessToken: string,
  includeComments: boolean = false,
  commentIdsOnly: boolean = false,
  isRefreshRun: boolean = false
): Promise<{ postsCount: number; commentsCount: number }> {
  try {
    if (isRefreshRun && includeComments) {
      const account = await db.query.instagramAccounts.findFirst({ where: eq(instagramAccounts.id, accountId), columns: { username: true } });
      console.log(`🔄 [REFRESH] Re-fetching comments and re-running moderation (LLM) for account: ${account?.username ?? accountId}`);
    }
    // Fetch all media/posts
    const mediaPosts = await instagramService.getMedia(instagramUserId, accessToken);
    
    let newPostsCount = 0;
    let newCommentsCount = 0;
    let totalComments = 0;
    
    // Store posts in database
    // IMPORTANT: We process ALL posts, not just the first one
    let postIndex = 0;
    for (const post of mediaPosts) {
      postIndex++;
      try {
        
        // Check if post already exists for this account
        const existingPost = await db.query.posts.findFirst({
          where: and(
            eq(posts.igPostId, post.id),
            eq(posts.instagramAccountId, accountId)
          )
        });
        
        let dbPost;
        if (existingPost) {
          // Update existing post with latest data (especially likes/comments count)
          await db.update(posts)
            .set({
              caption: post.caption,
              likesCount: post.like_count || null,
              commentsCount: post.comments_count || null
            })
            .where(eq(posts.id, existingPost.id));
          dbPost = { ...existingPost, caption: post.caption, likesCount: post.like_count || null, commentsCount: post.comments_count || null };
        } else {
          // Store media in database
          // Handle Instagram API returning CAROUSEL_ALBUM (map to CAROUSEL)
          // Schema only supports: IMAGE, VIDEO, CAROUSEL
          // Instagram API returns: IMAGE, VIDEO, CAROUSEL_ALBUM
          let mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL' = 'IMAGE';
          const postMediaType = post.media_type;
          if (postMediaType === 'VIDEO') {
            mediaType = 'VIDEO';
          } else if (postMediaType === 'CAROUSEL_ALBUM') {
            // Instagram API returns CAROUSEL_ALBUM, but our schema uses CAROUSEL
            mediaType = 'CAROUSEL';
          }
          // Default to IMAGE for IMAGE type or any other type
          
          const [newPost] = await db.insert(posts).values({
            instagramAccountId: accountId,
            igPostId: post.id,
            caption: post.caption,
            mediaType: mediaType,
            permalink: post.permalink,
            postedAt: new Date(post.timestamp),
            likesCount: post.like_count || null,
            commentsCount: post.comments_count || null
          }).returning();
          
          dbPost = newPost;
          newPostsCount++;
        }

        // Fetch and store insights for this post (if permission is available)
        // Determine media type from the post data (used in both try and catch blocks)
        let postMediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL' = 'IMAGE';
        if (post.media_type === 'VIDEO') {
          postMediaType = 'VIDEO';
        } else if (post.media_type === 'CAROUSEL_ALBUM') {
          postMediaType = 'CAROUSEL';
        }

        try {

          // Use different metrics based on media type
          // Note: likes, comments, shares are NOT insights metrics (already available from media endpoint)
          // IMPORTANT: From API v22.0+, 'impressions' is NO LONGER supported for media insights
          // IMAGE/VIDEO: engagement, reach, saved (impressions deprecated)
          // CAROUSEL: carousel_album_engagement, carousel_album_reach, carousel_album_saved
          let metrics: string[];
          if (postMediaType === 'VIDEO') {
            metrics = ['engagement', 'reach', 'saved', 'video_views'];
          } else if (postMediaType === 'CAROUSEL') {
            metrics = ['carousel_album_engagement', 'carousel_album_reach', 'carousel_album_saved'];
          } else {
            // IMAGE
            metrics = ['engagement', 'reach', 'saved'];
          }

          const insights = await instagramService.getMediaInsights(post.id, accessToken, metrics);

          // Map insights to our schema
          const insightsData: {
            impressions?: number;
            reach?: number;
            engagement?: number;
            saved?: number;
            videoViews?: number;
            insightsLastFetchedAt?: Date;
          } = {
            insightsLastFetchedAt: new Date()
          };

          for (const insight of insights) {
            switch (insight.name) {
              case 'reach':
              case 'carousel_album_reach':
                insightsData.reach = insight.value;
                break;
              case 'saved':
              case 'carousel_album_saved':
                insightsData.saved = insight.value;
                break;
              case 'video_views':
                insightsData.videoViews = insight.value;
                break;
              case 'engagement':
              case 'carousel_album_engagement':
                insightsData.engagement = insight.value;
                break;
            }
          }
          
          // Update post with insights
          await db.update(posts)
            .set(insightsData)
            .where(eq(posts.id, dbPost.id));
          
          console.log(`  📊 Fetched insights for post ${post.id}`);
        } catch (insightsError: unknown) {
          // Try fallback with minimal metrics if the initial request failed
          const errorMessage = insightsError instanceof Error ? insightsError.message : 'Unknown error';

          if (errorMessage.includes('Metric not available')) {
            // Try with just the basic metrics that are most commonly available
            // Note: impressions is deprecated from v22.0+, so we only use reach
            console.log(`  ⚠️  Some metrics not available for post ${post.id}, trying basic metrics...`);
            try {
              const fallbackMetrics = postMediaType === 'VIDEO'
                ? ['reach', 'video_views']
                : ['reach'];
              const fallbackInsights = await instagramService.getMediaInsights(post.id, accessToken, fallbackMetrics);

              const insightsData: {
                reach?: number;
                videoViews?: number;
                insightsLastFetchedAt?: Date;
              } = {
                insightsLastFetchedAt: new Date()
              };

              for (const insight of fallbackInsights) {
                if (insight.name === 'reach') insightsData.reach = insight.value;
                if (insight.name === 'video_views') insightsData.videoViews = insight.value;
              }

              await db.update(posts)
                .set(insightsData)
                .where(eq(posts.id, dbPost.id));

              console.log(`  📊 Fetched basic insights for post ${post.id}`);
            } catch (fallbackError: unknown) {
              const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
              console.log(`  ⚠️  Failed to fetch insights for post ${post.id}: ${fallbackErrorMessage}`);
            }
          } else if (errorMessage.includes('permission') || errorMessage.includes('Permission')) {
            console.log(`  ⚠️  Insights not available for post ${post.id} (permission may not be approved)`);
          } else {
            console.log(`  ⚠️  Failed to fetch insights for post ${post.id}: ${errorMessage}`);
          }
        }
        
        // TESTING MODE ONLY: Fetch comments via polling
        // IMPORTANT: This runs for EACH post in the loop
        if (includeComments) {
          if (commentIdsOnly) {
            // Simplified: Just get comment IDs
            const commentIds = await instagramService.getCommentIds(post.id, accessToken);
            totalComments += commentIds.length;
          } else {
            // Full comment data
            const postComments = await instagramService.getComments(post.id, accessToken);
            
            // Separate top-level comments from replies
            const topLevelComments = postComments.filter(c => !c.parentCommentId);
            const replies = postComments.filter(c => c.parentCommentId);
            
            console.log(`  💬 Breakdown: ${topLevelComments.length} top-level comments, ${replies.length} replies`);
            
            // Store top-level comments first (replies need parent IDs)
            const commentIdMap = new Map<string, string>(); // Maps Instagram comment ID to database UUID
            
            for (const comment of topLevelComments) {
              try {
              // Check if comment already exists for this post
              const existingComment = await db.query.comments.findFirst({
                where: and(
                  eq(comments.igCommentId, comment.id),
                  eq(comments.postId, dbPost.id)
                )
              });
              
              if (existingComment) {
                console.log(`    📝 Top-level comment ${comment.id} already exists`);
                commentIdMap.set(comment.id, existingComment.id);
                totalComments++;
                continue;
              }
              
              // Store comment
              if (!comment.from) {
                console.error('Comment missing from field', comment.id);
                continue;
              }
              const commenterId = comment.from.id; // Instagram always provides this
              const commenterUsername = comment.from.username || comment.username || 'unknown';

              // Map Instagram's 'hidden' field to our 'isHidden' field
              const isHidden = comment.hidden === true;
              
              const [newComment] = await db.insert(comments).values({
                postId: dbPost.id,
                igCommentId: comment.id,
                text: comment.text,
                commenterUsername: commenterUsername,
                commenterId: commenterId,
                commentedAt: new Date(comment.timestamp),
                isHidden: isHidden, // Store hidden status from Instagram API
                parentCommentId: null // Top-level comment
              }).returning();
              
              commentIdMap.set(comment.id, newComment.id);
              newCommentsCount++;
              totalComments++;
              console.log(`    ✅ Stored top-level comment ${comment.id}${isHidden ? ' (hidden)' : ''}`);
              
              // Enqueue for moderation
              const { commentQueue } = await import('../queue/commentQueue');
              await commentQueue.enqueue('CLASSIFY_COMMENT', {
                commentId: newComment.id,
                commentText: comment.text,
                commenterId: commenterId,
                commenterUsername: commenterUsername,
                postId: dbPost.id,
                instagramAccountId: accountId,
                igCommentId: comment.id,
                accessToken: accessToken
              });
              
              console.log(isRefreshRun ? `    🔄 Enqueued comment ${comment.id} for re-moderation (refresh)` : `    🔄 Enqueued comment ${comment.id} for moderation`);
              } catch (commentError: unknown) {
                const errorMessage = commentError instanceof Error ? commentError.message : 'Unknown error';
                console.error(`    ❌ Error storing top-level comment ${comment.id}:`, errorMessage);
              }
            }
          
          // Now store replies (they need parent comment database IDs)
          for (const reply of replies) {
            try {
              // Check if reply already exists for this post
              const existingReply = await db.query.comments.findFirst({
                where: and(
                  eq(comments.igCommentId, reply.id),
                  eq(comments.postId, dbPost.id)
                )
              });
              
              if (existingReply) {
                console.log(`    📝 Reply ${reply.id} already exists`);
                totalComments++;
                continue;
              }
              
              // Find parent comment's database ID
              const parentDbId = commentIdMap.get(reply.parentCommentId!);
              if (!parentDbId) {
                // Parent not found - might not have been stored yet, try to find it in DB
                const parentComment = await db.query.comments.findFirst({
                  where: eq(comments.igCommentId, reply.parentCommentId!)
                });
                if (parentComment) {
                  commentIdMap.set(reply.parentCommentId!, parentComment.id);
                  // Use parent's database ID
                  const parentDbIdFromDb = parentComment.id;

                  // Store reply
                  if (!reply.from) {
                    console.error('Reply missing from field', reply.id);
                    continue;
                  }
                  const commenterId = reply.from.id; // Instagram always provides this
                  const commenterUsername = reply.from.username || reply.username || 'unknown';
                  const isHidden = reply.hidden === true;
                  
                  const [newReply] = await db.insert(comments).values({
                    postId: dbPost.id,
                    parentCommentId: parentDbIdFromDb,
                    igCommentId: reply.id,
                    text: reply.text,
                    commenterUsername: commenterUsername,
                    commenterId: commenterId,
                    commentedAt: new Date(reply.timestamp),
                    isHidden: isHidden
                  }).returning();
                  
                  newCommentsCount++;
                  totalComments++;
                  console.log(`    ✅ Stored reply ${reply.id} to comment ${reply.parentCommentId}${isHidden ? ' (hidden)' : ''}`);
                  
                  // Enqueue for moderation
                  const { commentQueue } = await import('../queue/commentQueue');
                await commentQueue.enqueue('CLASSIFY_COMMENT', {
                  commentId: newReply.id,
                  commentText: reply.text,
                  commenterId: commenterId,
                  commenterUsername: commenterUsername,
                  postId: dbPost.id,
                  instagramAccountId: accountId,
                  igCommentId: reply.id,
                  accessToken: accessToken
                });
                if (isRefreshRun) console.log(`    🔄 Enqueued reply ${reply.id} for re-moderation (refresh)`);
              } else {
                console.warn(`    ⚠️  Parent comment ${reply.parentCommentId} not found for reply ${reply.id}, storing as top-level`);
                  // Store as top-level if parent not found (shouldn't happen, but handle gracefully)
                  if (!reply.from) {
                    console.error('Reply missing from field', reply.id);
                    continue;
                  }
                  const commenterId = reply.from.id; // Instagram always provides this
                  const commenterUsername = reply.from.username || reply.username || 'unknown';
                  const isHidden = reply.hidden === true;

                  await db.insert(comments).values({
                    postId: dbPost.id,
                    igCommentId: reply.id,
                    text: reply.text,
                    commenterUsername: commenterUsername,
                    commenterId: commenterId,
                    commentedAt: new Date(reply.timestamp),
                    isHidden: isHidden,
                    parentCommentId: null
                  }).returning();
                  
                  newCommentsCount++;
                  totalComments++;
                }
              } else {
                // Parent found in map, store reply
                if (!reply.from) {
                  console.error('Reply missing from field', reply.id);
                  continue;
                }
                const commenterId = reply.from.id; // Instagram always provides this
                const commenterUsername = reply.from.username || reply.username || 'unknown';
                const isHidden = reply.hidden === true;
                
                const [newReply] = await db.insert(comments).values({
                  postId: dbPost.id,
                  parentCommentId: parentDbId,
                  igCommentId: reply.id,
                  text: reply.text,
                  commenterUsername: commenterUsername,
                  commenterId: commenterId,
                  commentedAt: new Date(reply.timestamp),
                  isHidden: isHidden
                }).returning();
                
                newCommentsCount++;
                totalComments++;
                console.log(`    ✅ Stored reply ${reply.id} to comment ${reply.parentCommentId}${isHidden ? ' (hidden)' : ''}`);
                
                // Enqueue reply for LLM moderation - REPLIES GO THROUGH THE SAME MODERATION PIPELINE AS TOP-LEVEL COMMENTS
                // This ensures all replies are properly classified, risk-scored, and actioned (delete/hide/flag)
                const { commentQueue } = await import('../queue/commentQueue');
                await commentQueue.enqueue('CLASSIFY_COMMENT', {
                  commentId: newReply.id,
                  commentText: reply.text,
                  commenterId: commenterId,
                  commenterUsername: commenterUsername,
                  postId: dbPost.id,
                  instagramAccountId: accountId,
                  igCommentId: reply.id,
                  accessToken: accessToken
                });
                if (isRefreshRun) console.log(`    🔄 Enqueued reply ${reply.id} for re-moderation (refresh)`);
              }
            } catch (replyError: unknown) {
              const errorMessage = replyError instanceof Error ? replyError.message : 'Unknown error';
              console.error(`    ❌ Error storing reply ${reply.id}:`, errorMessage);
            }
          }
          }
        }
        
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, includeComments ? 200 : 100));
      } catch (postError: unknown) {
        // Continue with next post
      }
    }
    
    // Update last sync timestamp
    await db
      .update(instagramAccounts)
      .set({ lastSyncAt: new Date() })
      .where(eq(instagramAccounts.id, accountId));
    
    if (includeComments) {
      console.log(`✅ Sync complete: ${newPostsCount} new posts, ${newCommentsCount} new comments (${totalComments} total comments processed)`);
    } else {
      console.log(`✅ Sync complete: ${newPostsCount} new posts`);
      console.log(`💬 Comments will be received via webhooks when users post them`);
    }
    
    return {
      postsCount: newPostsCount,
      commentsCount: newCommentsCount
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Sync error:', errorMessage);
    throw error;
  }
}

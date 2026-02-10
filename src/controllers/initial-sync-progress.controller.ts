import { Response } from 'express';
import { db } from '../db';
import { instagramAccounts, facebookPages, posts } from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { DelegationRequest, getEffectiveOwner } from '../middleware/delegation.middleware';
import { ApiResponse } from '../types';
import { and, eq, gte, or } from 'drizzle-orm';

interface InitialSyncProgressData {
  inProgress: boolean;
  totalPosts: number;
  processedPosts: number;
  totalComments: number;
  processedComments: number;
  accounts: Array<{
    id: string;
    username: string;
    platform: 'instagram' | 'facebook';
    totalPosts: number;
    processedPosts: number;
  }>;
}

type InitialSyncProgressResponse = ApiResponse<InitialSyncProgressData>;

/**
 * Get initial sync progress for recently connected accounts/pages.
 * An account is considered "recently connected" if connected within the last 10 minutes.
 * A post is considered "processed" if it has at least one comment that has been moderated
 * (isReported is not null, meaning moderation has been run).
 */
export async function getInitialSyncProgress(
  req: AuthRequest & DelegationRequest,
  res: Response<InitialSyncProgressResponse>
): Promise<void> {
  try {
    const owner = getEffectiveOwner(req);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // Query recently connected/synced Instagram accounts
    // Check both connectedAt (for new connections) and lastSyncAt (for reconnections and recent syncs)
    const igOwnerCondition = owner.clientId
      ? eq(instagramAccounts.clientId, owner.clientId)
      : eq(instagramAccounts.userId, owner.userId!);

    const recentIgAccounts = await db.query.instagramAccounts.findMany({
      where: and(
        igOwnerCondition,
        eq(instagramAccounts.isActive, true),
        or(
          gte(instagramAccounts.connectedAt, tenMinutesAgo),
          gte(instagramAccounts.lastSyncAt, tenMinutesAgo)
        )
      ),
      columns: {
        id: true,
        username: true,
        connectedAt: true,
        lastSyncAt: true
      }
    });

    // Query recently connected/synced Facebook pages
    // Check createdAt (new), updatedAt (reconnection), and lastSyncAt (recent sync)
    const fbOwnerCondition = owner.clientId
      ? eq(facebookPages.clientId, owner.clientId)
      : eq(facebookPages.userId, owner.userId!);

    const recentFbPages = await db.query.facebookPages.findMany({
      where: and(
        fbOwnerCondition,
        eq(facebookPages.isActive, true),
        or(
          gte(facebookPages.createdAt, tenMinutesAgo),
          gte(facebookPages.updatedAt, tenMinutesAgo),
          gte(facebookPages.lastSyncAt, tenMinutesAgo)
        )
      ),
      columns: {
        id: true,
        pageName: true,
        createdAt: true,
        updatedAt: true,
        lastSyncAt: true
      }
    });

    // If no recently connected accounts, return early
    if (recentIgAccounts.length === 0 && recentFbPages.length === 0) {
      res.json({
        success: true,
        data: {
          inProgress: false,
          totalPosts: 0,
          processedPosts: 0,
          totalComments: 0,
          processedComments: 0,
          accounts: []
        }
      });
      return;
    }

    const accountsProgress: Array<{
      id: string;
      username: string;
      platform: 'instagram' | 'facebook';
      totalPosts: number;
      processedPosts: number;
    }> = [];

    let totalPosts = 0;
    let processedPosts = 0;
    let totalComments = 0;
    let processedComments = 0;

    // Process Instagram accounts
    for (const igAccount of recentIgAccounts) {
      // Get all posts for this account
      const igPosts = await db.query.posts.findMany({
        where: eq(posts.instagramAccountId, igAccount.id),
        columns: { id: true }
      });

      const accountTotalPosts = igPosts.length;
      totalPosts += accountTotalPosts;

      // Get comments for these posts and count processed ones
      if (igPosts.length > 0) {
        const postIds = igPosts.map(p => p.id);

        // Count total comments
        const accountComments = await db.query.comments.findMany({
          where: (comments, { inArray }) => inArray(comments.postId, postIds),
          columns: { id: true, isReported: true, postId: true }
        });

        totalComments += accountComments.length;

        // Count processed comments (where isReported is not null, meaning moderation ran)
        const accountProcessedComments = accountComments.filter(c => c.isReported !== null).length;
        processedComments += accountProcessedComments;

        // Count processed posts: a post is processed if it has no comments OR all its comments are moderated
        const accountProcessedPosts = igPosts.filter(post => {
          const postComments = accountComments.filter(c => c.postId === post.id);

          if (postComments.length === 0) {
            // No comments = automatically processed
            return true;
          }

          // Has comments - check if ALL are moderated
          return postComments.every(c => c.isReported !== null);
        }).length;
        processedPosts += accountProcessedPosts;

        accountsProgress.push({
          id: igAccount.id,
          username: igAccount.username,
          platform: 'instagram',
          totalPosts: accountTotalPosts,
          processedPosts: accountProcessedPosts
        });
      } else if (accountTotalPosts === 0) {
        // No posts at all - show as complete
        accountsProgress.push({
          id: igAccount.id,
          username: igAccount.username,
          platform: 'instagram',
          totalPosts: 0,
          processedPosts: 0
        });
      }
    }

    // Process Facebook pages
    for (const fbPage of recentFbPages) {
      // Get all posts for this page
      const fbPosts = await db.query.posts.findMany({
        where: eq(posts.facebookPageId, fbPage.id),
        columns: { id: true }
      });

      const accountTotalPosts = fbPosts.length;
      totalPosts += accountTotalPosts;

      // Get comments for these posts and count processed ones
      if (fbPosts.length > 0) {
        const postIds = fbPosts.map(p => p.id);

        // Count total comments
        const accountComments = await db.query.comments.findMany({
          where: (comments, { inArray }) => inArray(comments.postId, postIds),
          columns: { id: true, isReported: true, postId: true }
        });

        totalComments += accountComments.length;

        // Count processed comments (where isReported is not null, meaning moderation ran)
        const accountProcessedComments = accountComments.filter(c => c.isReported !== null).length;
        processedComments += accountProcessedComments;

        // Count processed posts: a post is processed if it has no comments OR all its comments are moderated
        const accountProcessedPosts = fbPosts.filter(post => {
          const postComments = accountComments.filter(c => c.postId === post.id);

          if (postComments.length === 0) {
            // No comments = automatically processed
            return true;
          }

          // Has comments - check if ALL are moderated
          return postComments.every(c => c.isReported !== null);
        }).length;
        processedPosts += accountProcessedPosts;

        accountsProgress.push({
          id: fbPage.id,
          username: fbPage.pageName,
          platform: 'facebook',
          totalPosts: accountTotalPosts,
          processedPosts: accountProcessedPosts
        });
      } else if (accountTotalPosts === 0) {
        // No posts at all - show as complete
        accountsProgress.push({
          id: fbPage.id,
          username: fbPage.pageName,
          platform: 'facebook',
          totalPosts: 0,
          processedPosts: 0
        });
      }
    }

    // Determine if sync is still in progress
    // Sync is in progress if:
    // 1. There are posts that haven't been fully processed, OR
    // 2. There are comments that haven't been moderated yet
    const inProgress = (totalPosts > 0 && processedPosts < totalPosts) ||
                       (totalComments > 0 && processedComments < totalComments);

    res.json({
      success: true,
      data: {
        inProgress,
        totalPosts,
        processedPosts,
        totalComments,
        processedComments,
        accounts: accountsProgress
      }
    });
  } catch (error) {
    console.error('[INITIAL SYNC PROGRESS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch initial sync progress'
    });
  }
}

const initialSyncProgressController = {
  getInitialSyncProgress
};

export default initialSyncProgressController;

import { Response } from 'express';
import { commentReviewService } from '../services/commentReview.service';
import { instagramService } from '../services/instagram.service';
import { checkFeatureAllowed } from '../services/autumn.service';
import { db } from '../db';
import { comments, facebookPages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AuthRequest } from '../middleware/auth.middleware';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class CommentReviewController {
  /**
   * Get flagged comments for review
   */
  async getFlaggedComments(
    req: AuthRequest,
    res: Response<ApiResponse<any>>
  ): Promise<void> {
    try {
      const { userId, clientId } = req;

      if (!userId && !clientId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
        return;
      }

      const filter = req.query.filter as string || 'all';
      const accountId = req.query.accountId as string | undefined;
      const limit = parseInt(req.query.limit as string || '50');
      const offset = parseInt(req.query.offset as string || '0');

      const flaggedComments = await commentReviewService.getFlaggedCommentsForReview(
        clientId,
        userId,
        {
          filter: filter as any,
          accountId,
          limit,
          offset
        }
      );

      res.json({
        success: true,
        data: flaggedComments
      });
    } catch (error) {
      console.error('Get flagged comments error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch flagged comments'
      });
    }
  }

  /**
   * Get similar comments using embeddings
   */
  async getSimilarComments(
    req: AuthRequest,
    res: Response<ApiResponse<any>>
  ): Promise<void> {
    try {
      const { userId, clientId } = req;

      if (!userId && !clientId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
        return;
      }

      const { commentId } = req.params;
      const threshold = parseFloat(req.query.threshold as string || '0.6');
      const limit = parseInt(req.query.limit as string || '20');

      const similarComments = await commentReviewService.findSimilarComments(
        commentId,
        threshold,
        limit
      );

      res.json({
        success: true,
        data: similarComments
      });
    } catch (error) {
      console.error('Get similar comments error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch similar comments'
      });
    }
  }

  /**
   * Submit review action for a comment
   */
  async reviewComment(
    req: AuthRequest,
    res: Response<ApiResponse<any>>
  ): Promise<void> {
    try {
      const { userId, clientId } = req;

      if (!userId && !clientId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
        return;
      }

      // Gate: check comments_moderated limit
      const { allowed } = await checkFeatureAllowed({
        userId: userId,
        clientId: clientId,
        featureId: "comments_moderated",
      });
      if (!allowed) {
        res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
        return;
      }

      const { commentId } = req.params;
      const { action, similarityThreshold, notes, category } = req.body;

      // Validate action
      const validActions = [
        'ALLOW_THIS',
        'ALLOW_SIMILAR',
        'HIDE_THIS',
        'AUTO_HIDE_SIMILAR',
        'DELETE_THIS',
        'AUTO_DELETE_SIMILAR'
      ];

      if (!validActions.includes(action)) {
        res.status(400).json({
          success: false,
          error: `Invalid action. Must be one of: ${validActions.join(', ')}`
        });
        return;
      }

      // Get comment to verify ownership
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
      const account = comment.post.instagramAccount;
      if (!account) {
        res.status(404).json({
          success: false,
          error: 'Instagram account not found'
        });
        return;
      }

      const ownsComment = clientId
        ? account.clientId === clientId
        : account.userId === userId;

      if (!ownsComment) {
        res.status(403).json({
          success: false,
          error: 'Forbidden'
        });
        return;
      }

      // Process review action
      const result = await commentReviewService.reviewComment(
        commentId,
        action,
        { userId, clientId },
        { similarityThreshold, notes, category }
      );

      // If action requires deletion, delete from Instagram
      if (result.requiresDeletion && comment.igCommentId && account.accessToken) {
        try {
          await instagramService.deleteComment(
            comment.igCommentId,
            account.accessToken
          );
          
          // Mark as deleted in database
          await db
            .update(comments)
            .set({
              isDeleted: true,
              deletedAt: new Date()
            })
            .where(eq(comments.id, commentId as string));
        } catch (deleteError) {
          console.error('Failed to delete comment from Instagram:', deleteError);
          // Mark deletion as failed
          await db
            .update(comments)
            .set({
              deletionFailed: true,
              deletionError: deleteError instanceof Error ? deleteError.message : 'Unknown error'
            })
            .where(eq(comments.id, commentId as string));
        }
      }

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      console.error('Review comment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to review comment'
      });
    }
  }

  /**
   * Allow a comment (unhide/unflag)
   */
  async allowComment(
    req: AuthRequest,
    res: Response<ApiResponse<any>>
  ): Promise<void> {
    try {
      const { userId, clientId } = req;

      if (!userId && !clientId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
        return;
      }

      // Gate: check comments_moderated limit
      const { allowed } = await checkFeatureAllowed({
        userId: userId,
        clientId: clientId,
        featureId: "comments_moderated",
      });
      if (!allowed) {
        res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
        return;
      }

      const { commentId } = req.params;
      const { allowSimilar, similarityThreshold, notes } = req.body;

      // Get comment to verify ownership
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
      const account = comment.post.instagramAccount;
      if (!account) {
        res.status(404).json({
          success: false,
          error: 'Instagram account not found'
        });
        return;
      }

      const ownsComment = clientId
        ? account.clientId === clientId
        : account.userId === userId;

      if (!ownsComment) {
        res.status(403).json({
          success: false,
          error: 'Forbidden'
        });
        return;
      }

      // Allow comment (updates DB: isAllowed, isHidden=false)
      const result = await commentReviewService.allowComment(
        commentId,
        allowSimilar || false,
        similarityThreshold || 0.6,
        { userId, clientId },
        notes
      );

      // Unhide on Instagram so the comment is visible again in the app
      if (comment.source === 'instagram' && comment.igCommentId && comment.post.instagramAccount) {
        const account = comment.post.instagramAccount;
        let accessToken: string | null = account.accessToken ?? null;
        if (account.facebookPageId) {
          const page = await db.query.facebookPages.findFirst({
            where: eq(facebookPages.id, account.facebookPageId)
          });
          if (page?.pageAccessToken) accessToken = page.pageAccessToken;
        }
        if (accessToken) {
          const success = await instagramService.unhideComment(comment.igCommentId, accessToken);
          if (!success) {
            console.warn(`[CommentReview] Instagram unhideComment API failed for comment ${commentId}`);
          }
        }
      }

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      console.error('Allow comment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to allow comment'
      });
    }
  }

  /**
   * Bulk review multiple comments
   */
  async bulkReview(
    req: AuthRequest,
    res: Response<ApiResponse<any>>
  ): Promise<void> {
    try {
      const { userId, clientId } = req;

      if (!userId && !clientId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
        return;
      }

      // Gate: check comments_moderated limit
      const { allowed } = await checkFeatureAllowed({
        userId: userId,
        clientId: clientId,
        featureId: "comments_moderated",
      });
      if (!allowed) {
        res.status(403).json({ success: false, error: "Comment moderation limit reached. Please upgrade your plan." });
        return;
      }

      const { commentIds, action, similarityThreshold, category } = req.body;

      if (!Array.isArray(commentIds) || commentIds.length === 0) {
        res.status(400).json({
          success: false,
          error: 'commentIds array is required'
        });
        return;
      }

      // Validate action
      const validActions = [
        'ALLOW_THIS',
        'ALLOW_SIMILAR',
        'HIDE_THIS',
        'AUTO_HIDE_SIMILAR',
        'DELETE_THIS',
        'AUTO_DELETE_SIMILAR'
      ];

      if (!validActions.includes(action)) {
        res.status(400).json({
          success: false,
          error: `Invalid action. Must be one of: ${validActions.join(', ')}`
        });
        return;
      }

      let successCount = 0;
      let failedCount = 0;
      const results: any[] = [];

      // Process each comment
      for (const commentId of commentIds) {
        try {
          // Get comment to verify ownership
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
            results.push({ commentId, success: false, error: 'Comment not found' });
            continue;
          }

          // Verify ownership
          const account = comment.post.instagramAccount;
          if (!account) {
            failedCount++;
            results.push({ commentId, success: false, error: 'Instagram account not found' });
            continue;
          }

          const ownsComment = clientId
            ? account.clientId === clientId
            : account.userId === userId;

          if (!ownsComment) {
            failedCount++;
            results.push({ commentId, success: false, error: 'Forbidden' });
            continue;
          }

          // Process review action
          const result = await commentReviewService.reviewComment(
            commentId,
            action,
            { userId, clientId },
            { similarityThreshold, category }
          );

          // If action requires deletion, delete from Instagram
          if (result.requiresDeletion && comment.igCommentId && account.accessToken) {
            try {
              await instagramService.deleteComment(
                comment.igCommentId,
                account.accessToken
              );
              
              // Mark as deleted in database
              await db
                .update(comments)
                .set({
                  isDeleted: true,
                  deletedAt: new Date()
                })
                .where(eq(comments.id, commentId));
            } catch (deleteError) {
              console.error('Failed to delete comment from Instagram:', deleteError);
            }
          }

          successCount++;
          results.push({ commentId, success: true, data: result });
        } catch (error) {
          failedCount++;
          results.push({ 
            commentId, 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      }

      res.json({
        success: true,
        data: {
          successCount,
          failedCount,
          results
        }
      });
    } catch (error) {
      console.error('Bulk review error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process bulk review'
      });
    }
  }
}

export const commentReviewController = new CommentReviewController();

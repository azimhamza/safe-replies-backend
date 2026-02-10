import { db } from '../db';
import { comments, commentReviewActions, customFilters, moderationLogs, posts, instagramAccounts } from '../db/schema';
import { embeddingsService } from './embeddings.service';
import { llmService } from './llm.service';
import { eq, and, or, desc, isNull, inArray } from 'drizzle-orm';

interface ReviewFilter {
  filter?: 'all' | 'flagged' | 'hidden' | 'deleted' | 'unreviewed';
  accountId?: string;
  limit?: number;
  offset?: number;
}

interface SimilarCommentMatch {
  commentId: string;
  commenterId: string;
  commenterUsername: string;
  similarity: number;
  text: string;
  score: number;
  commentText: string;
  category?: string;
}

export class CommentReviewService {
  /**
   * Get flagged comments for review
   */
  async getFlaggedCommentsForReview(
    clientId: string | undefined,
    userId: string | undefined,
    filters: ReviewFilter
  ) {
    // Build ownership condition
    const ownershipCondition = clientId
      ? eq(instagramAccounts.clientId, clientId)
      : userId
        ? eq(instagramAccounts.userId, userId)
        : undefined;

    if (!ownershipCondition) {
      throw new Error('Either clientId or userId must be provided');
    }

    // Get user's Instagram accounts
    const userAccounts = await db.query.instagramAccounts.findMany({
      where: and(
        ownershipCondition,
        eq(instagramAccounts.isActive, true)
      )
    });

    if (userAccounts.length === 0) {
      return [];
    }

    const accountIds = userAccounts.map(acc => acc.id);

    // Build where condition based on filter
    let whereConditions: any[] = [];

    // Filter by account if specified
    if (filters.accountId) {
      whereConditions.push(eq(posts.instagramAccountId, filters.accountId));
    } else {
      whereConditions.push(inArray(posts.instagramAccountId, accountIds));
    }

    // Apply filter type
    switch (filters.filter) {
      case 'flagged':
      case 'all':
      default:
        // Get comments with FLAGGED action in moderation logs
        // These are "meh" comments that need human review - NOT deleted, NOT hidden
        // They don't match custom filters or similar patterns, just flagged by LLM
        // Exclude comments that were auto-allowed (isAllowed = true)
        const flaggedComments = await db
          .select({
            comment: comments,
            moderation: moderationLogs,
            post: posts,
            account: instagramAccounts
          })
          .from(comments)
          .innerJoin(posts, eq(comments.postId, posts.id))
          .innerJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
          .innerJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
          .where(
            and(
              ...whereConditions,
              eq(moderationLogs.actionTaken, 'FLAGGED'),
              // Exclude deleted comments
              eq(comments.isDeleted, false),
              // Exclude hidden comments (these were auto-hidden by custom filters)
              eq(comments.isHidden, false),
              // Exclude comments that were already allowed
              or(
                eq(comments.isAllowed, false),
                isNull(comments.isAllowed)
              )
            )
          )
          .orderBy(desc(comments.commentedAt))
          .limit(filters.limit || 50)
          .offset(filters.offset || 0);

        return flaggedComments;

      case 'hidden':
        whereConditions.push(eq(comments.isHidden, true));
        whereConditions.push(eq(comments.isDeleted, false)); // Don't show deleted
        break;

      case 'deleted':
        whereConditions.push(eq(comments.isDeleted, true));
        break;

      case 'unreviewed':
        // Unreviewed flagged comments (not deleted, not hidden)
        whereConditions.push(isNull(comments.reviewedAt));
        whereConditions.push(eq(comments.isDeleted, false));
        whereConditions.push(eq(comments.isHidden, false));
        // Must have FLAGGED action
        const unreviewedComments = await db
          .select({
            comment: comments,
            moderation: moderationLogs,
            post: posts,
            account: instagramAccounts
          })
          .from(comments)
          .innerJoin(posts, eq(comments.postId, posts.id))
          .innerJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
          .innerJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
          .where(
            and(
              ...whereConditions,
              eq(moderationLogs.actionTaken, 'FLAGGED')
            )
          )
          .orderBy(desc(comments.commentedAt))
          .limit(filters.limit || 50)
          .offset(filters.offset || 0);

        return unreviewedComments;
    }

    // Get comments with moderation details (for hidden/deleted filters)
    const reviewComments = await db
      .select({
        comment: comments,
        moderation: moderationLogs,
        post: posts,
        account: instagramAccounts
      })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .innerJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
      .leftJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
      .where(and(...whereConditions))
      .orderBy(desc(comments.commentedAt))
      .limit(filters.limit || 50)
      .offset(filters.offset || 0);

    return reviewComments;
  }

  /**
   * Find similar comments using Jina embeddings
   */
  async findSimilarComments(
    commentId: string,
    threshold: number = 0.6,
    limit: number = 20
  ): Promise<SimilarCommentMatch[]> {
    try {
      const similarComments = await embeddingsService.findSimilarCommentsEfficient(
        commentId,
        limit,
        threshold
      );

      return similarComments.map(comment => ({
        ...comment,
        score: comment.similarity,
        commentText: comment.text,
        category: undefined
      }));
    } catch (error) {
      console.error('Error finding similar comments:', error);
      return [];
    }
  }

  /**
   * Allow a comment (unhide/unflag)
   */
  async allowComment(
    commentId: string,
    allowSimilar: boolean,
    similarityThreshold: number = 0.6,
    reviewedBy: { userId?: string; clientId?: string },
    notes?: string
  ) {
    // Update comment to mark as allowed and unhide
    await db
      .update(comments)
      .set({
        isAllowed: true,
        isHidden: false,
        reviewedAt: new Date(),
        reviewAction: allowSimilar ? 'ALLOW_SIMILAR' : 'ALLOW_THIS'
      })
      .where(eq(comments.id, commentId));

    // Create review action record
    await db.insert(commentReviewActions).values({
      commentId,
      action: allowSimilar ? 'ALLOW_SIMILAR' : 'ALLOW_THIS',
      reviewedByUserId: reviewedBy.userId || null,
      reviewedByClientId: reviewedBy.clientId || null,
      similarityThreshold: allowSimilar ? similarityThreshold.toString() : null,
      notes
    });

    return { success: true };
  }

  /**
   * Review a comment with specified action
   */
  async reviewComment(
    commentId: string,
    action: 'ALLOW_THIS' | 'ALLOW_SIMILAR' | 'HIDE_THIS' | 'AUTO_HIDE_SIMILAR' | 'DELETE_THIS' | 'AUTO_DELETE_SIMILAR',
    reviewedBy: { userId?: string; clientId?: string },
    options?: {
      similarityThreshold?: number;
      notes?: string;
      category?: string;
    }
  ) {
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId)
    });

    if (!comment) {
      throw new Error('Comment not found');
    }

    let customFilterId: string | null = null;

    // Process action
    switch (action) {
      case 'ALLOW_THIS':
      case 'ALLOW_SIMILAR':
        await db
          .update(comments)
          .set({
            isAllowed: true,
            isHidden: false,
            reviewedAt: new Date(),
            reviewAction: action
          })
          .where(eq(comments.id, commentId));
        break;

      case 'HIDE_THIS':
        await db
          .update(comments)
          .set({
            isHidden: true,
            hiddenAt: new Date(),
            reviewedAt: new Date(),
            reviewAction: action
          })
          .where(eq(comments.id, commentId));
        break;

      case 'AUTO_HIDE_SIMILAR':
        // Hide this comment
        await db
          .update(comments)
          .set({
            isHidden: true,
            hiddenAt: new Date(),
            reviewedAt: new Date(),
            reviewAction: action
          })
          .where(eq(comments.id, commentId));

        // Create custom filter with autoHide
        customFilterId = await this.createAutoFilterFromReview(
          commentId,
          comment.text,
          options?.category || 'spam',
          'hide',
          reviewedBy
        );
        break;

      case 'DELETE_THIS':
        // Mark as deleted (actual deletion happens via Instagram API in controller)
        await db
          .update(comments)
          .set({
            reviewedAt: new Date(),
            reviewAction: action
          })
          .where(eq(comments.id, commentId));
        break;

      case 'AUTO_DELETE_SIMILAR':
        // Mark this comment (actual deletion happens via Instagram API in controller)
        await db
          .update(comments)
          .set({
            reviewedAt: new Date(),
            reviewAction: action
          })
          .where(eq(comments.id, commentId));

        // Create custom filter with autoDelete
        customFilterId = await this.createAutoFilterFromReview(
          commentId,
          comment.text,
          options?.category || 'spam',
          'delete',
          reviewedBy
        );
        break;
    }

    // Create review action record
    await db.insert(commentReviewActions).values({
      commentId,
      action,
      reviewedByUserId: reviewedBy.userId || null,
      reviewedByClientId: reviewedBy.clientId || null,
      similarityThreshold: options?.similarityThreshold?.toString() || null,
      customFilterId,
      notes: options?.notes
    });

    return { 
      success: true, 
      customFilterId,
      requiresDeletion: action === 'DELETE_THIS' || action === 'AUTO_DELETE_SIMILAR'
    };
  }

  /**
   * Create a custom filter from review action
   */
  private async createAutoFilterFromReview(
    commentId: string,
    commentText: string,
    category: string,
    actionType: 'hide' | 'delete',
    reviewedBy: { userId?: string; clientId?: string }
  ): Promise<string> {
    // Generate filter prompt using LLM
    const filterPrompt = await llmService.generateCustomFilterPrompt(
      commentText,
      category,
      actionType
    );

    // Create custom filter
    const [filter] = await db
      .insert(customFilters)
      .values({
        clientId: reviewedBy.clientId || null,
        userId: reviewedBy.userId || null,
        name: `Auto-${actionType} similar to: "${commentText.substring(0, 50)}..."`,
        prompt: filterPrompt,
        category: category as any,
        scope: 'GENERAL',
        isEnabled: true,
        description: `Created from review of comment: ${commentId}`,
        autoHide: actionType === 'hide',
        autoDelete: actionType === 'delete',
        autoFlag: false
      })
      .returning();

    return filter.id;
  }

  /**
   * Check if a comment embedding matches any allowed similar patterns
   */
  async checkAllowedSimilarComments(
    embedding: number[],
    clientId: string | undefined,
    userId: string | undefined,
    threshold: number = 0.6
  ): Promise<SimilarCommentMatch | null> {
    // Build ownership condition
    const ownershipCondition = clientId
      ? eq(commentReviewActions.reviewedByClientId, clientId)
      : userId
        ? eq(commentReviewActions.reviewedByUserId, userId)
        : undefined;

    if (!ownershipCondition) {
      return null;
    }

    // Get all ALLOW_SIMILAR review actions
    const allowedActions = await db
      .select({
        commentId: commentReviewActions.commentId,
        similarityThreshold: commentReviewActions.similarityThreshold
      })
      .from(commentReviewActions)
      .where(
        and(
          ownershipCondition,
          eq(commentReviewActions.action, 'ALLOW_SIMILAR')
        )
      );

    if (allowedActions.length === 0) {
      return null;
    }

    // Check similarity against each allowed comment
    for (const action of allowedActions) {
      const allowedComment = await db.query.comments.findFirst({
        where: eq(comments.id, action.commentId)
      });

      if (!allowedComment || !allowedComment.embedding) {
        continue;
      }

      // Calculate cosine similarity
      const similarity = this.calculateCosineSimilarity(
        embedding,
        allowedComment.embedding as number[]
      );

      const usedThreshold = action.similarityThreshold 
        ? parseFloat(action.similarityThreshold) 
        : threshold;

      if (similarity >= usedThreshold) {
        // Get moderation info for context
        const moderation = await db.query.moderationLogs.findFirst({
          where: eq(moderationLogs.commentId, action.commentId),
          orderBy: desc(moderationLogs.createdAt)
        });

        return {
          commentId: allowedComment.id,
          commenterId: allowedComment.commenterId,
          commenterUsername: allowedComment.commenterUsername,
          similarity,
          text: allowedComment.text,
          score: similarity,
          commentText: allowedComment.text,
          category: moderation?.category
        };
      }
    }

    return null;
  }

  /**
   * Check if a comment embedding matches any auto-action patterns
   */
  async checkAutoActionSimilarComments(
    embedding: number[],
    clientId: string | undefined,
    userId: string | undefined,
    threshold: number = 0.6
  ): Promise<{ action: 'AUTO_HIDE_SIMILAR' | 'AUTO_DELETE_SIMILAR'; match: SimilarCommentMatch } | null> {
    // Build ownership condition
    const ownershipCondition = clientId
      ? eq(commentReviewActions.reviewedByClientId, clientId)
      : userId
        ? eq(commentReviewActions.reviewedByUserId, userId)
        : undefined;

    if (!ownershipCondition) {
      return null;
    }

    // Get all AUTO_HIDE_SIMILAR and AUTO_DELETE_SIMILAR review actions
    const autoActions = await db
      .select({
        commentId: commentReviewActions.commentId,
        action: commentReviewActions.action,
        similarityThreshold: commentReviewActions.similarityThreshold
      })
      .from(commentReviewActions)
      .where(
        and(
          ownershipCondition,
          or(
            eq(commentReviewActions.action, 'AUTO_HIDE_SIMILAR'),
            eq(commentReviewActions.action, 'AUTO_DELETE_SIMILAR')
          )
        )
      );

    if (autoActions.length === 0) {
      return null;
    }

    // Check similarity against each auto-action comment (prioritize AUTO_DELETE)
    for (const action of autoActions) {
      const actionComment = await db.query.comments.findFirst({
        where: eq(comments.id, action.commentId)
      });

      if (!actionComment || !actionComment.embedding) {
        continue;
      }

      // Calculate cosine similarity
      const similarity = this.calculateCosineSimilarity(
        embedding,
        actionComment.embedding as number[]
      );

      const usedThreshold = action.similarityThreshold 
        ? parseFloat(action.similarityThreshold) 
        : threshold;

      if (similarity >= usedThreshold) {
        // Get moderation info for context
        const moderation = await db.query.moderationLogs.findFirst({
          where: eq(moderationLogs.commentId, action.commentId),
          orderBy: desc(moderationLogs.createdAt)
        });

        return {
          action: action.action as 'AUTO_HIDE_SIMILAR' | 'AUTO_DELETE_SIMILAR',
          match: {
            commentId: actionComment.id,
            commenterId: actionComment.commenterId,
            commenterUsername: actionComment.commenterUsername,
            similarity,
            text: actionComment.text,
            score: similarity,
            commentText: actionComment.text,
            category: moderation?.category
          }
        };
      }
    }

    return null;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  private calculateCosineSimilarity(embedding1: number[], embedding2: number[]): number {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimensions');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }
}

export const commentReviewService = new CommentReviewService();

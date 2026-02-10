import { Request, Response } from 'express';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { customFilters, customFilterAccounts, instagramAccounts, comments, posts } from '../db/schema';
import { NewCustomFilter } from '../db/schema';
import { llmService } from '../services/llm.service';

interface AuthenticatedRequest extends Request {
  userId?: string;
  clientId?: string;
}

export class CustomFiltersController {
  /**
   * Get all custom filters for the authenticated user (global + account-specific)
   * Global filters apply to all accounts by default
   * Account-specific filters override global for specific accounts
   */
  async getCustomFilters(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Build ownership condition
      const ownershipCondition = clientId
        ? eq(customFilters.clientId, clientId)
        : userId
          ? eq(customFilters.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get global filters (instagramAccountId is null) - these apply to all accounts
      // Return ALL filters (enabled and disabled) so UI can show toggle state
      const globalFilters = await db
        .select()
        .from(customFilters)
        .where(
          and(
            isNull(customFilters.instagramAccountId),
            ownershipCondition
          )
        )
        .orderBy(customFilters.createdAt);

      // Get account-specific filters (instagramAccountId is not null)
      // Return ALL filters (enabled and disabled) so UI can show toggle state
      const accountSpecificFilters = await db
        .select({
          id: customFilters.id,
          clientId: customFilters.clientId,
          userId: customFilters.userId,
          instagramAccountId: customFilters.instagramAccountId,
          name: customFilters.name,
          prompt: customFilters.prompt,
          category: customFilters.category,
          scope: customFilters.scope,
          isEnabled: customFilters.isEnabled,
          description: customFilters.description,
          autoHide: customFilters.autoHide,
          autoDelete: customFilters.autoDelete,
          autoFlag: customFilters.autoFlag,
          createdAt: customFilters.createdAt,
          updatedAt: customFilters.updatedAt,
          instagramAccount: {
            id: instagramAccounts.id,
            username: instagramAccounts.username,
            name: instagramAccounts.name
          }
        })
        .from(customFilters)
        .innerJoin(instagramAccounts, eq(customFilters.instagramAccountId, instagramAccounts.id))
        .where(
          and(
            sql`${customFilters.instagramAccountId} IS NOT NULL`,
            ownershipCondition
          )
        )
        .orderBy(customFilters.createdAt);

      res.json({
        success: true,
        data: {
          global: globalFilters,
          accountSpecific: accountSpecificFilters.map(filter => ({
            ...filter,
            instagramAccount: filter.instagramAccount
          }))
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching custom filters:', errorMessage);

      // Check if it's a column missing error
      if (error instanceof Error && (error.message.includes('instagramAccountId') || (error as { code?: string }).code === '42703')) {
        console.warn('Database schema needs updating. Returning basic filters.');
        res.json({
          success: true,
          data: {
            global: [],
            accountSpecific: [],
            migrationNeeded: true
          }
        });
      } else {
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    }
  }

  /**
   * Create a custom filter from a comment using LLM analysis
   * Creates a global filter by default, or account-specific if instagramAccountId is provided
   */
  async createCustomFilterFromComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { commentId, action, instagramAccountId } = req.body;

      if (!commentId || !action) {
        res.status(400).json({
          success: false,
          error: 'commentId and action are required'
        });
        return;
      }

      // Validate action
      const validActions = ['delete', 'hide', 'flag'];
      if (!validActions.includes(action)) {
        res.status(400).json({
          success: false,
          error: 'Invalid action. Must be one of: delete, hide, flag'
        });
        return;
      }

      // Get the comment
      const commentResult = await db
        .select({
          text: comments.text
        })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1);

      if (commentResult.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Comment not found'
        });
        return;
      }

      const comment = commentResult[0];

      // Validate instagramAccountId if provided (account-specific filter)
      if (instagramAccountId) {
        const accountOwnershipCondition = clientId
          ? eq(instagramAccounts.clientId, clientId)
          : userId
            ? eq(instagramAccounts.userId, userId)
            : undefined;

        if (!accountOwnershipCondition) {
          res.status(401).json({ success: false, error: 'Unauthorized' });
          return;
        }

        const accountCheck = await db
          .select()
          .from(instagramAccounts)
          .where(
            and(
              eq(instagramAccounts.id, instagramAccountId),
              accountOwnershipCondition
            )
          )
          .limit(1);

        if (accountCheck.length === 0) {
          res.status(400).json({
            success: false,
            error: 'Instagram account not found or not authorized'
          });
          return;
        }
      }

      // Generate custom filter prompt using LLM
      const filterPrompt = await llmService.generateCustomFilterPrompt(
        comment.text,
        'unknown',
        action
      );

      const filterName = `Auto-filter: ${comment.text.substring(0, 50)}${comment.text.length > 50 ? '...' : ''}`;
      const filterDescription = `Automatically created from comment: "${comment.text}". Action: ${action}`;

      // Create the custom filter (global if instagramAccountId is null, account-specific if set)
      const [newFilter] = await db.insert(customFilters).values({
        userId: clientId ? null : userId,
        clientId: clientId || null,
        instagramAccountId: instagramAccountId || null,
        name: filterName,
        prompt: filterPrompt,
        category: 'spam', // Default category
        scope: instagramAccountId ? 'SPECIFIC' : 'GENERAL',
        isEnabled: true,
        description: filterDescription
      }).returning();

      res.json({
        success: true,
        data: {
          id: newFilter.id,
          name: newFilter.name,
          prompt: newFilter.prompt,
          category: newFilter.category,
          description: newFilter.description,
          isEnabled: newFilter.isEnabled,
          instagramAccountId: newFilter.instagramAccountId
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error creating custom filter from comment:', errorMessage);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Create a new custom filter
   * If instagramAccountId is provided, creates an account-specific filter
   * If instagramAccountId is null/undefined, creates a global filter (applies to all accounts)
   */
  async createCustomFilter(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { name, prompt, category, instagramAccountId, description, isEnabled = true, autoHide = false, autoDelete = false, autoFlag = false } = req.body;

      if (!name || !prompt || !category) {
        res.status(400).json({
          success: false,
          error: 'Name, prompt, and category are required'
        });
        return;
      }

      // Validate category
      const validCategories = ['blackmail', 'threat', 'defamation', 'harassment', 'spam', 'benign'];
      if (!validCategories.includes(category)) {
        res.status(400).json({
          success: false,
          error: 'Invalid category'
        });
        return;
      }

      // Validate instagramAccountId if provided (account-specific filter)
      if (instagramAccountId) {
        const accountOwnershipCondition = clientId
          ? eq(instagramAccounts.clientId, clientId)
          : userId
            ? eq(instagramAccounts.userId, userId)
            : undefined;

        if (!accountOwnershipCondition) {
          res.status(401).json({ success: false, error: 'Unauthorized' });
          return;
        }

        const accountCheck = await db
          .select()
          .from(instagramAccounts)
          .where(
            and(
              eq(instagramAccounts.id, instagramAccountId),
              accountOwnershipCondition
            )
          )
          .limit(1);

        if (accountCheck.length === 0) {
          res.status(400).json({
            success: false,
            error: 'Instagram account not found or not authorized'
          });
          return;
        }
      }

      // Create filter: global if instagramAccountId is null, account-specific if set
      const [createdFilter] = await db.insert(customFilters).values({
        userId: clientId ? null : userId,
        clientId: clientId || null,
        instagramAccountId: instagramAccountId || null,
        name,
        prompt,
        category,
        scope: instagramAccountId ? 'SPECIFIC' : 'GENERAL',
        description: description || null,
        isEnabled,
        autoHide,
        autoDelete,
        autoFlag
      }).returning();

      res.status(201).json({
        success: true,
        data: createdFilter
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error creating custom filter:', errorMessage);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Update an existing custom filter
   * Can change between global and account-specific by setting/clearing instagramAccountId
   */
  async updateCustomFilter(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Check if filter exists and belongs to user/client
      const ownershipCondition = clientId
        ? eq(customFilters.clientId, clientId)
        : userId
          ? eq(customFilters.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const existingFilter = await db
        .select()
        .from(customFilters)
        .where(and(
          eq(customFilters.id, id),
          ownershipCondition
        ))
        .limit(1);

      if (existingFilter.length === 0) {
        res.status(404).json({ success: false, error: 'Custom filter not found' });
        return;
      }

      const { name, prompt, category, instagramAccountId, description, isEnabled, autoHide, autoDelete, autoFlag } = req.body;

      const updateData: Partial<NewCustomFilter> = {};
      if (name !== undefined) updateData.name = name;
      if (prompt !== undefined) updateData.prompt = prompt;
      if (category !== undefined) {
        const validCategories = ['blackmail', 'threat', 'defamation', 'harassment', 'spam', 'benign'];
        if (!validCategories.includes(category)) {
          res.status(400).json({ success: false, error: 'Invalid category' });
          return;
        }
        updateData.category = category;
      }
      if (description !== undefined) updateData.description = description;
      if (isEnabled !== undefined) updateData.isEnabled = isEnabled;
      if (autoHide !== undefined) updateData.autoHide = autoHide;
      if (autoDelete !== undefined) updateData.autoDelete = autoDelete;
      if (autoFlag !== undefined) updateData.autoFlag = autoFlag;

      // Handle instagramAccountId change (switching between global and account-specific)
      if (instagramAccountId !== undefined) {
        if (instagramAccountId === null) {
          // Converting to global filter
          updateData.instagramAccountId = null;
          updateData.scope = 'GENERAL';
        } else {
          // Converting to account-specific filter - validate account
          const accountOwnershipCondition = clientId
            ? eq(instagramAccounts.clientId, clientId)
            : userId
              ? eq(instagramAccounts.userId, userId)
              : undefined;

          if (!accountOwnershipCondition) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
          }

          const accountCheck = await db
            .select()
            .from(instagramAccounts)
            .where(
              and(
                eq(instagramAccounts.id, instagramAccountId),
                accountOwnershipCondition
              )
            )
            .limit(1);

          if (accountCheck.length === 0) {
            res.status(400).json({
              success: false,
              error: 'Instagram account not found or not authorized'
            });
            return;
          }

          updateData.instagramAccountId = instagramAccountId;
          updateData.scope = 'SPECIFIC';
        }
      }

      const [updatedFilter] = await db
        .update(customFilters)
        .set(updateData)
        .where(eq(customFilters.id, id))
        .returning();

      res.json({
        success: true,
        data: updatedFilter
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error updating custom filter:', errorMessage);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Delete a custom filter
   */
  async deleteCustomFilter(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Check if filter exists and belongs to user/client
      const ownershipCondition = clientId
        ? eq(customFilters.clientId, clientId)
        : userId
          ? eq(customFilters.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const existingFilter = await db
        .select()
        .from(customFilters)
        .where(and(
          eq(customFilters.id, id),
          ownershipCondition
        ))
        .limit(1);

      if (existingFilter.length === 0) {
        res.status(404).json({ success: false, error: 'Custom filter not found' });
        return;
      }

      // Delete account associations first (if any)
      await db.delete(customFilterAccounts).where(eq(customFilterAccounts.customFilterId, id));

      // Delete the filter
      await db.delete(customFilters).where(eq(customFilters.id, id));

      res.json({ success: true });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error deleting custom filter:', errorMessage);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Apply a custom filter to all existing comments
   * Only makes API calls for comments that need state changes
   */
  async applyFilterToExistingComments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id: filterId } = req.params;
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get the custom filter
      const ownershipCondition = clientId
        ? eq(customFilters.clientId, clientId)
        : userId
          ? eq(customFilters.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const filterResult = await db
        .select()
        .from(customFilters)
        .where(and(
          eq(customFilters.id, filterId),
          ownershipCondition
        ))
        .limit(1);

      if (filterResult.length === 0) {
        res.status(404).json({ success: false, error: 'Custom filter not found' });
        return;
      }

      const filter = filterResult[0];

      // Build ownership condition
      const accountOwnershipCondition = clientId
        ? eq(instagramAccounts.clientId, clientId)
        : userId
          ? eq(instagramAccounts.userId, userId)
          : undefined;

      if (!accountOwnershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get all posts owned by this user/client, optionally filtered by account
      const whereConditions = [accountOwnershipCondition];
      if (filter.instagramAccountId) {
        whereConditions.push(eq(posts.instagramAccountId, filter.instagramAccountId));
      }

      const postsResult = await db
        .select({ id: posts.id })
        .from(posts)
        .innerJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
        .where(and(...whereConditions));
      const postIds = postsResult.map(p => p.id);

      if (postIds.length === 0) {
        res.json({
          success: true,
          data: {
            filterName: filter.name,
            checkedCount: 0,
            matchedCount: 0,
            hiddenCount: 0,
            deletedCount: 0,
            flaggedCount: 0,
            apiCallsMade: 0
          }
        });
        return;
      }

      // Get all comments for these posts that aren't deleted
      const commentsToCheck = await db.query.comments.findMany({
        where: (comments, { inArray, and }) => and(
          inArray(comments.postId, postIds),
          eq(comments.isDeleted, false)
        ),
        with: {
          post: {
            with: {
              instagramAccount: true
            }
          }
        },
        limit: 1000 // Process in batches
      });

      let checkedCount = 0;
      let matchedCount = 0;
      let hiddenCount = 0;
      let deletedCount = 0;
      let flaggedCount = 0;
      let apiCallsMade = 0;
      const errors: string[] = [];

      // Process each comment
      for (const comment of commentsToCheck) {
        checkedCount++;

        try {
          // Run LLM filter check
          const filterResult = await llmService.evaluateCustomFilter(
            comment.text,
            filter.prompt,
            filter.category
          );

          if (filterResult.matches) {
            matchedCount++;

            // Check what actions need to be taken
            const needsHide = filter.autoHide && !comment.isHidden;
            const needsDelete = filter.autoDelete && !comment.isDeleted;
            const needsFlag = filter.autoFlag; // Just flag if enabled, we'll create moderation log

            // Make API calls only if state change is needed
            if (needsHide || needsDelete) {
              const isInstagram = comment.source === 'instagram';
              let accessToken: string | null = null;

              if (isInstagram && comment.post?.instagramAccount) {
                // Get Instagram access token
                const account = comment.post.instagramAccount;
                if (account.facebookPageId) {
                  const page = await db.query.facebookPages.findFirst({
                    where: (facebookPages, { eq }) => eq(facebookPages.id, account.facebookPageId!)
                  });
                  accessToken = page?.pageAccessToken || account.accessToken;
                } else {
                  accessToken = account.accessToken;
                }
              }
              // Note: Facebook comments not supported yet in this function

              if (accessToken) {
                apiCallsMade++;

                if (needsDelete && isInstagram && comment.igCommentId) {
                  const { instagramService } = await import('../services/instagram.service');
                  const success = await instagramService.deleteComment(comment.igCommentId, accessToken);
                  if (success) {
                    await db.update(comments).set({
                      isDeleted: true,
                      deletedAt: new Date()
                    }).where(eq(comments.id, comment.id));
                    deletedCount++;
                  }
                } else if (needsHide && isInstagram && comment.igCommentId) {
                  const { instagramService } = await import('../services/instagram.service');
                  const success = await instagramService.hideComment(comment.igCommentId, accessToken);
                  if (success) {
                    await db.update(comments).set({
                      isHidden: true,
                      hiddenAt: new Date()
                    }).where(eq(comments.id, comment.id));
                    hiddenCount++;
                  }
                }
              }
            }

            // Flag comment if needed (create moderation log)
            if (needsFlag) {
              // We'll just count it, actual flagging is done through moderation logs
              flaggedCount++;
            }
          }
        } catch (error) {
          console.error(`Error processing comment ${comment.id}:`, error);
          errors.push(`Comment ${comment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      res.json({
        success: true,
        data: {
          filterName: filter.name,
          checkedCount,
          matchedCount,
          hiddenCount,
          deletedCount,
          flaggedCount,
          apiCallsMade,
          errors: errors.length > 0 ? errors : undefined
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error applying custom filter:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to apply custom filter' });
    }
  }

  /**
   * Get available Instagram accounts for the authenticated user/client
   */
  async getAvailableAccounts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      const clientId = req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const accountOwnershipCondition = clientId
        ? eq(instagramAccounts.clientId, clientId)
        : userId
          ? eq(instagramAccounts.userId, userId)
          : undefined;

      if (!accountOwnershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const accounts = await db
        .select({
          id: instagramAccounts.id,
          username: instagramAccounts.username,
          name: instagramAccounts.name,
          accountType: instagramAccounts.accountType,
          isActive: instagramAccounts.isActive
        })
        .from(instagramAccounts)
        .where(
          and(
            accountOwnershipCondition,
            eq(instagramAccounts.isActive, true)
          )
        )
        .orderBy(instagramAccounts.username);

      res.json({
        success: true,
        data: accounts
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching available accounts:', errorMessage);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export const customFiltersController = new CustomFiltersController();
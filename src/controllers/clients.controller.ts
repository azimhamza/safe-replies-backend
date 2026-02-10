import { Request, Response } from 'express';
import { db } from '../db';
import { clients, users } from '../db/schema';
import { CreateClientSchema } from '../validation/schemas';
import { ApiResponse } from '../types';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { EmailService } from '../services/email/email.service';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  instagramAccounts,
  facebookPages,
  posts,
  comments,
  moderationLogs,
  moderationSettings,
  keywordFilters,
  customFilters,
  customFilterAccounts,
  legalCases,
  caseEvidenceMap,
  knownThreatsWatchlist,
  watchlistDetections,
  whitelistedIdentifiers,
  botNetworkMasterminds,
  botNetworkConnections,
  mastermindMentions,
  suspiciousAccounts,
  extractedIdentifiers,
  evidenceAttachments,
  commentReviewActions,
  followerHistory,
  accountCommentMap,
  evidenceRecords,
  pageInstagramConnections
} from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { storageService } from '../services/storage.service';

/**
 * Create a new client (agency only) and send invitation email
 */
export async function createClient(
  req: AuthRequest,
  res: Response<ApiResponse<{ clientId: string; invitationSent: boolean }>>
): Promise<void> {
  try {
    // Validate request body
    const validated = CreateClientSchema.parse(req.body);

    // TODO: Get agency user ID from authenticated session
    // For now, assuming it's passed or we'll get it from middleware
    const agencyUserId = req.userId;

    if (!agencyUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized. Agency authentication required.'
      });
      return;
    }

    // Verify the user is an agency
    const agencyUser = await db.query.users.findFirst({
      where: eq(users.id, agencyUserId)
    });

    if (!agencyUser || (agencyUser.accountType !== 'BASIC_AGENCY' && agencyUser.accountType !== 'MAX_AGENCY')) {
      res.status(403).json({
        success: false,
        error: 'Only agencies can create client accounts'
      });
      return;
    }

    // Check client limit for BASIC_AGENCY (5 clients max)
    if (agencyUser.accountType === 'BASIC_AGENCY') {
      const existingClients = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(clients)
        .where(eq(clients.userId, agencyUserId));

      const clientCount = existingClients[0]?.count || 0;

      if (clientCount >= 5) {
        res.status(403).json({
          success: false,
          error: 'Basic Agency plan is limited to 5 clients. Upgrade to Agency Pro Max for unlimited clients.'
        });
        return;
      }
    }
    // MAX_AGENCY has unlimited clients - no check needed

    // Check if client email already exists
    const existingClient = await db.query.clients.findFirst({
      where: eq(clients.email, validated.email)
    });

    if (existingClient) {
      res.status(400).json({
        success: false,
        error: 'A client with this email already exists'
      });
      return;
    }

    // Generate temporary password hash (client will set their own password during onboarding)
    const temporaryPassword = validated.password || crypto.randomBytes(16).toString('hex');
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    // Generate unique invitation token
    const invitationToken = crypto.randomBytes(32).toString('hex');

    // Create client
    const [client] = await db.insert(clients).values({
      userId: agencyUserId,
      businessName: validated.businessName,
      email: validated.email,
      passwordHash,
      invitationToken,
      invitationSentAt: new Date(),
      isInvited: true
    }).returning();

    // Send invitation email
    const emailResult = await EmailService.sendClientInvitation({
      to: validated.email,
      clientName: validated.businessName,
      agencyName: agencyUser.name || 'Your Agency',
      invitationToken
    });

    if (!emailResult.success) {
      console.error('Failed to send invitation email:', emailResult.error);
      // Don't fail the request, just log the error
    }

    res.status(201).json({
      success: true,
      data: {
        clientId: client.id,
        invitationSent: emailResult.success
      }
    });
  } catch (error) {
    console.error('Create client error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create client'
    });
  }
}

/**
 * Validate invitation token and return agency branding info
 */
export async function validateInvitation(
  req: Request,
  res: Response<ApiResponse<{
    valid: boolean;
    clientName: string;
    clientEmail: string;
    agencyId: string;
    agencyName: string | null;
    agencyLogo: string | null;
  }>>
): Promise<void> {
  try {
    const { token } = req.params;

    if (!token) {
      res.status(400).json({
        success: false,
        error: 'Invitation token is required'
      });
      return;
    }

    // Find client by invitation token
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.invitationToken, token),
        eq(clients.isInvited, true)
      )
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Invalid or expired invitation'
      });
      return;
    }

    // Check if invitation has already been accepted
    if (client.invitationAcceptedAt) {
      res.status(400).json({
        success: false,
        error: 'This invitation has already been accepted'
      });
      return;
    }

    // Check if invitation has expired (7 days)
    const invitationAge = Date.now() - new Date(client.invitationSentAt!).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    
    if (invitationAge > sevenDays) {
      res.status(400).json({
        success: false,
        error: 'This invitation has expired. Please contact your agency for a new invitation.'
      });
      return;
    }

    // Fetch agency info for branding
    const agency = await db.query.users.findFirst({
      where: eq(users.id, client.userId)
    });

    // Generate signed URL for agency logo if it's an S3 URL
    let agencyLogoUrl: string | null = agency?.logoUrl || null;
    if (agencyLogoUrl && isS3Url(agencyLogoUrl)) {
      try {
        agencyLogoUrl = await storageService.getSignedUrl(
          storageService.extractKeyFromUrl(agencyLogoUrl),
          86400 // 24 hours
        );
      } catch (error) {
        console.error('Failed to generate signed URL for agency logo:', error);
        // Keep the original URL if signed URL generation fails
        agencyLogoUrl = agency?.logoUrl || null;
      }
    }

    res.json({
      success: true,
      data: {
        valid: true,
        clientName: client.businessName,
        clientEmail: client.email,
        agencyId: client.userId,
        agencyName: agency?.name || null,
        agencyLogo: agencyLogoUrl
      }
    });
  } catch (error) {
    console.error('Validate invitation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate invitation'
    });
  }
}

/**
 * Accept invitation and activate client account (with password)
 */
export async function acceptInvitation(
  req: Request,
  res: Response<ApiResponse<{ clientId: string; redirectTo: string }>>
): Promise<void> {
  try {
    const { token } = req.params;
    const { password, email } = req.body;

    if (!token) {
      res.status(400).json({
        success: false,
        error: 'Invitation token is required'
      });
      return;
    }

    if (!password || password.length < 8) {
      res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters'
      });
      return;
    }

    // Validate email if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        res.status(400).json({
          success: false,
          error: 'Invalid email format'
        });
        return;
      }
    }

    // Find client by invitation token
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.invitationToken, token),
        eq(clients.isInvited, true)
      )
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Invalid or expired invitation'
      });
      return;
    }

    // Check if invitation has already been accepted
    if (client.invitationAcceptedAt) {
      res.status(400).json({
        success: false,
        error: 'This invitation has already been accepted'
      });
      return;
    }

    // Check if invitation has expired (7 days)
    const invitationAge = Date.now() - new Date(client.invitationSentAt!).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    if (invitationAge > sevenDays) {
      res.status(400).json({
        success: false,
        error: 'This invitation has expired. Please contact your agency for a new invitation.'
      });
      return;
    }

    // If email is being changed, check if it's unique
    if (email && email !== client.email) {
      const existingClient = await db.query.clients.findFirst({
        where: eq(clients.email, email)
      });

      if (existingClient) {
        res.status(400).json({
          success: false,
          error: 'This email is already in use'
        });
        return;
      }
    }

    // Hash the new password
    const passwordHash = await bcrypt.hash(password, 10);

    const now = new Date();

    // Mark invitation as accepted, update password, email (if provided), and track onboarding progress
    await db.update(clients)
      .set({
        invitationAcceptedAt: now,
        invitationToken: null, // Clear the token after acceptance
        passwordHash,
        ...(email && email !== client.email ? { email } : {}),
        onboardingStage: 'ACCOUNT_CREATED' as const,
        accountCreatedAt: now,
        updatedAt: now
      })
      .where(eq(clients.id, client.id));

    res.json({
      success: true,
      data: {
        clientId: client.id,
        redirectTo: '/client/creator/connect-instagram'
      }
    });
  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to accept invitation'
    });
  }
}

interface ClientListItem {
  id: string;
  businessName: string;
  email: string;
  createdAt: Date | null;
  invitationAccepted: boolean;
  instagramAccountsCount: number;
  facebookPagesCount: number;
  youtubeAccountsCount: number;
  commentsModerated: number;
  onboardingStage: string;
  onboardingProgress: number; // 0-100 percentage
  invitationToken: string | null;
}

/**
 * Get all clients for the authenticated agency
 */
export async function getClients(
  req: AuthRequest,
  res: Response<ApiResponse<ClientListItem[]>>
): Promise<void> {
  try {
    const agencyUserId = req.userId;

    if (!agencyUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    const clientsList = await db.query.clients.findMany({
      where: eq(clients.userId, agencyUserId)
    });

    const clientIds = clientsList.map(c => c.id);
    const igCounts = clientIds.length > 0
      ? await db
          .select({
            clientId: instagramAccounts.clientId,
            count: sql<number>`count(*)::int`
          })
          .from(instagramAccounts)
          .where(
            and(
              eq(instagramAccounts.isActive, true),
              inArray(instagramAccounts.clientId, clientIds)
            )
          )
          .groupBy(instagramAccounts.clientId)
      : [];
    const fbCounts = clientIds.length > 0
      ? await db
          .select({
            clientId: facebookPages.clientId,
            count: sql<number>`count(*)::int`
          })
          .from(facebookPages)
          .where(
            and(
              eq(facebookPages.isActive, true),
              inArray(facebookPages.clientId, clientIds)
            )
          )
          .groupBy(facebookPages.clientId)
      : [];

    const igByClient = Object.fromEntries(
      igCounts
        .filter((r): r is { clientId: string; count: number } => r.clientId != null)
        .map(r => [r.clientId, r.count])
    );
    const fbByClient = Object.fromEntries(
      fbCounts
        .filter((r): r is { clientId: string; count: number } => r.clientId != null)
        .map(r => [r.clientId, r.count])
    );

    // Count moderated comments per client via IG accounts and FB pages
    const igCommentCounts = clientIds.length > 0
      ? await db
          .select({
            clientId: instagramAccounts.clientId,
            count: sql<number>`count(distinct ${comments.id})::int`
          })
          .from(comments)
          .innerJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
          .innerJoin(posts, eq(comments.postId, posts.id))
          .innerJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
          .where(inArray(instagramAccounts.clientId, clientIds))
          .groupBy(instagramAccounts.clientId)
      : [];

    const fbCommentCounts = clientIds.length > 0
      ? await db
          .select({
            clientId: facebookPages.clientId,
            count: sql<number>`count(distinct ${comments.id})::int`
          })
          .from(comments)
          .innerJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
          .innerJoin(posts, eq(comments.postId, posts.id))
          .innerJoin(facebookPages, eq(posts.facebookPageId, facebookPages.id))
          .where(inArray(facebookPages.clientId, clientIds))
          .groupBy(facebookPages.clientId)
      : [];

    const igCommentsByClient = Object.fromEntries(
      igCommentCounts
        .filter((r): r is { clientId: string; count: number } => r.clientId != null)
        .map(r => [r.clientId, r.count])
    );
    const fbCommentsByClient = Object.fromEntries(
      fbCommentCounts
        .filter((r): r is { clientId: string; count: number } => r.clientId != null)
        .map(r => [r.clientId, r.count])
    );

    // Helper function to calculate onboarding progress
    const calculateProgress = (stage: string | null): number => {
      const stageProgress: Record<string, number> = {
        'INVITATION_SENT': 0,
        'ACCOUNT_CREATED': 20,
        'FACEBOOK_CONNECTED': 40,
        'INSTAGRAM_CONNECTED': 60,
        'COMMENTS_SYNCING': 80,
        'COMPLETED': 100
      };
      return stageProgress[stage ?? 'INVITATION_SENT'] ?? 0;
    };

    const clientsData = clientsList.map(client => ({
      id: client.id,
      businessName: client.businessName,
      email: client.email,
      createdAt: client.createdAt,
      invitationAccepted: !!client.invitationAcceptedAt,
      instagramAccountsCount: igByClient[client.id] ?? 0,
      facebookPagesCount: fbByClient[client.id] ?? 0,
      youtubeAccountsCount: 0,
      commentsModerated: (igCommentsByClient[client.id] ?? 0) + (fbCommentsByClient[client.id] ?? 0),
      onboardingStage: client.onboardingStage ?? 'INVITATION_SENT',
      onboardingProgress: calculateProgress(client.onboardingStage),
      invitationToken: client.invitationToken
    }));

    res.json({
      success: true,
      data: clientsData
    });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch clients'
    });
  }
}

/**
 * Get a single client by ID (agency only or via delegation)
 */
export async function getClientById(
  req: AuthRequest,
  res: Response<ApiResponse<{ id: string; businessName: string; email: string; createdAt: Date | null }>>
): Promise<void> {
  try {
    const { clientId } = req.params;
    const userId = req.userId;
    const accountType = req.accountType;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Find the client with appropriate authorization:
    // - If accountType is CLIENT: they can only access their own info (clients.id === clientId)
    // - If accountType is AGENCY (or undefined): they can access their managed clients (clients.userId === userId)
    const client = await db.query.clients.findFirst({
      where: accountType === 'CLIENT'
        ? eq(clients.id, clientId) // Managed client accessing their own info by clientId
        : and(
            eq(clients.id, clientId),
            eq(clients.userId, userId) // Agency accessing their client
          )
    });

    if (!client) {
      const errorMessage = accountType === 'CLIENT'
        ? 'Client not found'
        : 'Client not found or does not belong to your agency';
      res.status(404).json({
        success: false,
        error: errorMessage
      });
      return;
    }

    res.json({
      success: true,
      data: {
        id: client.id,
        businessName: client.businessName,
        email: client.email,
        createdAt: client.createdAt
      }
    });
  } catch (error) {
    console.error('Get client by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client'
    });
  }
}

/**
 * Delete a client (agency only)
 */
export async function deleteClient(
  req: AuthRequest,
  res: Response<ApiResponse<null>>
): Promise<void> {
  try {
    const { clientId } = req.params;
    const agencyUserId = req.userId;

    if (!agencyUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Verify the client belongs to this agency
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.userId, agencyUserId)
      )
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Client not found or does not belong to your agency'
      });
      return;
    }

    // Delete all related data in a transaction
    await db.transaction(async (tx) => {
      // 1. Get all Instagram accounts for this client
      const clientInstagramAccounts = await tx.query.instagramAccounts.findMany({
        where: eq(instagramAccounts.clientId, clientId)
      });
      const igAccountIds: string[] = clientInstagramAccounts.map((acc: { id: string }) => acc.id);

      if (igAccountIds.length > 0) {
        // 2. Get all posts for these Instagram accounts
        const clientPosts = await tx.query.posts.findMany({
          where: inArray(posts.instagramAccountId, igAccountIds)
        });
        const postIds: string[] = clientPosts.map((post: { id: string }) => post.id);

        if (postIds.length > 0) {
          // 3. Get all comments for these posts
          const clientComments = await tx.query.comments.findMany({
            where: inArray(comments.postId, postIds)
          });
          const commentIds: string[] = clientComments.map((comment: { id: string }) => comment.id);

          if (commentIds.length > 0) {
            // Get moderation log IDs first
            const modLogs = await tx.query.moderationLogs.findMany({
              where: inArray(moderationLogs.commentId, commentIds),
              columns: { id: true }
            });
            const modLogIds: string[] = modLogs.map((log: { id: string }) => log.id);

            // Delete comment-related records
            if (modLogIds.length > 0) {
              await tx.delete(evidenceRecords).where(inArray(evidenceRecords.moderationLogId, modLogIds));
            }
            await tx.delete(moderationLogs).where(inArray(moderationLogs.commentId, commentIds));
            await tx.delete(evidenceAttachments).where(inArray(evidenceAttachments.commentId, commentIds));
            await tx.delete(commentReviewActions).where(inArray(commentReviewActions.commentId, commentIds));
            await tx.delete(accountCommentMap).where(inArray(accountCommentMap.commentId, commentIds));

            // Delete comments themselves
            await tx.delete(comments).where(inArray(comments.id, commentIds));
          }

          // Delete posts
          await tx.delete(posts).where(inArray(posts.id, postIds));
        }

        // Delete follower history for Instagram accounts
        await tx.delete(followerHistory).where(inArray(followerHistory.instagramAccountId, igAccountIds));

        // Delete account-specific settings and associations
        await tx.delete(moderationSettings).where(inArray(moderationSettings.instagramAccountId, igAccountIds));
        await tx.delete(customFilterAccounts).where(inArray(customFilterAccounts.instagramAccountId, igAccountIds));
        await tx.delete(customFilters).where(inArray(customFilters.instagramAccountId, igAccountIds));
        await tx.delete(whitelistedIdentifiers).where(inArray(whitelistedIdentifiers.instagramAccountId, igAccountIds));

        // Delete suspicious accounts for these Instagram accounts
        const suspiciousAccountIds = await tx.select({ id: suspiciousAccounts.id })
          .from(suspiciousAccounts)
          .where(inArray(suspiciousAccounts.instagramAccountId, igAccountIds));

        if (suspiciousAccountIds.length > 0) {
          const suspAccIds: string[] = suspiciousAccountIds.map((sa: { id: string }) => sa.id);

          // Delete extracted identifiers for these suspicious accounts
          await tx.delete(extractedIdentifiers).where(inArray(extractedIdentifiers.suspiciousAccountId, suspAccIds));

          // Get and delete bot network connections and their mentions
          const botConnections = await tx.query.botNetworkConnections.findMany({
            where: inArray(botNetworkConnections.suspiciousAccountId, suspAccIds),
            columns: { id: true }
          });
          const botConnectionIds: string[] = botConnections.map((bc: { id: string }) => bc.id);

          if (botConnectionIds.length > 0) {
            await tx.delete(mastermindMentions).where(inArray(mastermindMentions.botConnectionId, botConnectionIds));
            await tx.delete(botNetworkConnections).where(inArray(botNetworkConnections.id, botConnectionIds));
          }

          // Delete suspicious accounts
          await tx.delete(suspiciousAccounts).where(inArray(suspiciousAccounts.id, suspAccIds));
        }

        // Delete page-Instagram connections
        await tx.delete(pageInstagramConnections).where(
          inArray(pageInstagramConnections.instagramAccountId, igAccountIds)
        );

        // Delete Instagram accounts
        await tx.delete(instagramAccounts).where(inArray(instagramAccounts.id, igAccountIds));
      }

      // Delete Facebook pages and their related data
      const clientFacebookPages = await tx.query.facebookPages.findMany({
        where: eq(facebookPages.clientId, clientId)
      });
      const fbPageIds: string[] = clientFacebookPages.map((page: { id: string }) => page.id);

      if (fbPageIds.length > 0) {
        // Delete follower history for Facebook pages
        await tx.delete(followerHistory).where(inArray(followerHistory.facebookPageId, fbPageIds));

        // Get Facebook posts and their comments
        const fbPosts = await tx.query.posts.findMany({
          where: inArray(posts.facebookPageId, fbPageIds)
        });
        const fbPostIds: string[] = fbPosts.map((post: { id: string }) => post.id);

        if (fbPostIds.length > 0) {
          const fbComments = await tx.query.comments.findMany({
            where: inArray(comments.postId, fbPostIds)
          });
          const fbCommentIds: string[] = fbComments.map((comment: { id: string }) => comment.id);

          if (fbCommentIds.length > 0) {
            // Get moderation log IDs first
            const fbModLogs = await tx.query.moderationLogs.findMany({
              where: inArray(moderationLogs.commentId, fbCommentIds),
              columns: { id: true }
            });
            const fbModLogIds: string[] = fbModLogs.map((log: { id: string }) => log.id);

            // Delete comment-related records
            if (fbModLogIds.length > 0) {
              await tx.delete(evidenceRecords).where(inArray(evidenceRecords.moderationLogId, fbModLogIds));
            }
            await tx.delete(moderationLogs).where(inArray(moderationLogs.commentId, fbCommentIds));
            await tx.delete(evidenceAttachments).where(inArray(evidenceAttachments.commentId, fbCommentIds));
            await tx.delete(commentReviewActions).where(inArray(commentReviewActions.commentId, fbCommentIds));
            await tx.delete(accountCommentMap).where(inArray(accountCommentMap.commentId, fbCommentIds));
            await tx.delete(comments).where(inArray(comments.id, fbCommentIds));
          }

          await tx.delete(posts).where(inArray(posts.id, fbPostIds));
        }

        // Delete page-Instagram connections for these Facebook pages
        await tx.delete(pageInstagramConnections).where(
          inArray(pageInstagramConnections.facebookPageId, fbPageIds)
        );

        // Nullify facebookPageId in any Instagram accounts that reference these pages
        // (to avoid foreign key constraint violations)
        await tx.update(instagramAccounts)
          .set({ facebookPageId: null })
          .where(inArray(instagramAccounts.facebookPageId, fbPageIds));

        // Delete Facebook pages
        await tx.delete(facebookPages).where(inArray(facebookPages.id, fbPageIds));
      }

      // Delete other client-related records
      await tx.delete(moderationSettings).where(eq(moderationSettings.clientId, clientId));
      await tx.delete(keywordFilters).where(eq(keywordFilters.clientId, clientId));
      await tx.delete(customFilters).where(eq(customFilters.clientId, clientId));
      await tx.delete(whitelistedIdentifiers).where(eq(whitelistedIdentifiers.clientId, clientId));

      // Get and delete legal cases and their evidence maps
      const clientLegalCases = await tx.query.legalCases.findMany({
        where: eq(legalCases.clientId, clientId),
        columns: { id: true }
      });
      const legalCaseIds: string[] = clientLegalCases.map((lc: { id: string }) => lc.id);

      if (legalCaseIds.length > 0) {
        await tx.delete(caseEvidenceMap).where(inArray(caseEvidenceMap.legalCaseId, legalCaseIds));
        await tx.delete(legalCases).where(inArray(legalCases.id, legalCaseIds));
      }

      // Get and delete known threats watchlist and their detections
      const clientKnownThreats = await tx.query.knownThreatsWatchlist.findMany({
        where: eq(knownThreatsWatchlist.clientId, clientId),
        columns: { id: true }
      });
      const knownThreatIds: string[] = clientKnownThreats.map((kt: { id: string }) => kt.id);

      if (knownThreatIds.length > 0) {
        await tx.delete(watchlistDetections).where(inArray(watchlistDetections.knownThreatId, knownThreatIds));
        await tx.delete(knownThreatsWatchlist).where(inArray(knownThreatsWatchlist.id, knownThreatIds));
      }

      // Get and delete bot network masterminds and their connections
      const clientMasterminds = await tx.query.botNetworkMasterminds.findMany({
        where: eq(botNetworkMasterminds.clientId, clientId),
        columns: { id: true }
      });
      const mastermindIds: string[] = clientMasterminds.map((m: { id: string }) => m.id);

      if (mastermindIds.length > 0) {
        // Get bot connections for these masterminds
        const mastermindBotConnections = await tx.query.botNetworkConnections.findMany({
          where: inArray(botNetworkConnections.mastermindId, mastermindIds),
          columns: { id: true }
        });
        const mastermindBotConnectionIds: string[] = mastermindBotConnections.map((bc: { id: string }) => bc.id);

        if (mastermindBotConnectionIds.length > 0) {
          await tx.delete(mastermindMentions).where(inArray(mastermindMentions.botConnectionId, mastermindBotConnectionIds));
        }

        // Delete mastermind mentions by mastermindId
        await tx.delete(mastermindMentions).where(inArray(mastermindMentions.mastermindId, mastermindIds));
        // Delete bot connections
        await tx.delete(botNetworkConnections).where(inArray(botNetworkConnections.mastermindId, mastermindIds));
        // Delete masterminds
        await tx.delete(botNetworkMasterminds).where(inArray(botNetworkMasterminds.id, mastermindIds));
      }

      // Finally, delete the client
      await tx.delete(clients).where(eq(clients.id, clientId));
    });

    res.json({
      success: true,
      data: null
    });
  } catch (error) {
    console.error('Delete client error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete client'
    });
  }
}

/**
 * Refresh comments for a client (agency only)
 * Triggers a deep sync for all the client's Instagram accounts
 */
export async function refreshClientComments(
  req: AuthRequest,
  res: Response<ApiResponse<{ message: string }>>
): Promise<void> {
  try {
    const { clientId } = req.params;
    const agencyUserId = req.userId;

    if (!agencyUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Verify the client belongs to this agency
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.userId, agencyUserId)
      )
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Client not found or does not belong to your agency'
      });
      return;
    }

    // Get all Instagram accounts for this client
    const { instagramAccounts: igAccounts } = await import('../db/schema');
    const accounts = await db.query.instagramAccounts.findMany({
      where: eq(igAccounts.clientId, clientId)
    });

    if (accounts.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Client has no connected Instagram accounts'
      });
      return;
    }

    // Trigger comment sync for all accounts (this will be handled by the polling/sync cron)
    // For now, just update the lastSyncAt to null to trigger a resync
    for (const account of accounts) {
      await db.update(igAccounts)
        .set({ lastSyncAt: null })
        .where(eq(igAccounts.id, account.id));
    }

    res.json({
      success: true,
      data: {
        message: `Comment refresh initiated for ${accounts.length} account${accounts.length > 1 ? 's' : ''}`
      }
    });
  } catch (error) {
    console.error('Refresh client comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh comments'
    });
  }
}

/**
 * Get comprehensive client details (for client details page)
 * Includes connected accounts with follower growth, moderation settings, custom filters, and suspicious accounts
 */
export async function getClientDetails(
  req: AuthRequest,
  res: Response<ApiResponse<unknown>>
): Promise<void> {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      res.status(400).json({
        success: false,
        error: 'Client ID is required'
      });
      return;
    }

    // Verify user has access to this client
    const userId = req.userId;
    const accountType = req.accountType;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Verify user has access to this client
    // - If accountType is CLIENT: they can only access their own details (clients.id === userId)
    // - If accountType is AGENCY: they can access their managed clients (clients.userId === userId)
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, clientId)
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Client not found'
      });
      return;
    }

    // Check authorization
    const hasAccess = accountType === 'CLIENT'
      ? client.id === userId // Managed client accessing their own details
      : client.userId === userId; // Agency accessing their client

    if (!hasAccess) {
      res.status(403).json({
        success: false,
        error: 'Access denied'
      });
      return;
    }

    // Parse pagination parameters from query string
    // const _limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    // const _offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const accountsLimit = req.query.accountsLimit
      ? parseInt(req.query.accountsLimit as string, 10)
      : undefined;
    const accountsOffset = req.query.accountsOffset
      ? parseInt(req.query.accountsOffset as string, 10)
      : undefined;

    // Import client service dynamically to avoid circular deps
    const { getClientDetails: getDetails } = await import('../services/client.service');

    // Get comprehensive client data with pagination
    const data = await getDetails(clientId, {
      accountsPagination: accountsLimit
        ? { limit: accountsLimit, offset: accountsOffset }
        : undefined
    });

    res.json({
      success: true,
      data
    });
  } catch (error: unknown) {
    console.error('Get client details error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client details'
    });
  }
}

/**
 * Helper function to check if a URL is an S3 URL
 */
function isS3Url(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.amazonaws.com') || u.hostname.includes('s3.');
  } catch {
    return false;
  }
}

import { Response } from 'express';
import { eq, and, or, desc, sql, inArray, ne } from 'drizzle-orm';
import { db } from '../db';
import {
  suspiciousAccounts,
  extractedIdentifiers,
  instagramAccounts,
  clients,
  evidenceAttachments,
  accountCommentMap,
  comments,
  moderationLogs,
  posts
} from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { isAgency } from '../utils/account-type.utils';
import { DelegationRequest, getEffectiveOwner } from '../middleware/delegation.middleware';
import { ApiResponse, IdentifierType, CommentCategory, ThreatLevel } from '../types';
import { llmService } from '../services/llm.service';
import { embeddingsService } from '../services/embeddings.service';
import { storageService } from '../services/storage.service';
import { exportService } from '../services/export.service';
import { crossReferenceService } from '../services/crossReference.service';
import { patternAnalysisService } from '../services/patternAnalysis.service';
import { mastermindConnectionService } from '../services/mastermindConnection.service';
import { instagramService } from '../services/instagram.service';

interface PaymentHandle {
  type: IdentifierType;
  value: string;
  confidence: number;
  commentId: string;
  createdAt: string;
  platform?: string;
}

interface ContactInfo {
  type: 'EMAIL' | 'PHONE';
  value: string;
  confidence: number;
  commentId: string;
  createdAt: string;
}

interface ScamLink {
  url: string;
  domain: string;
  confidence: number;
  commentId: string;
  createdAt: string;
  isPhishing: boolean;
  isScam: boolean;
  containsPaymentSolicitation: boolean;
  linkType: string;
  llmRationale: string;
}

interface ExtractedIdentifiersResponse {
  paymentHandles: PaymentHandle[];
  contactInfo: ContactInfo[];
  scamLinks: ScamLink[];
}

interface NetworkActivityResponse {
  flaggedByCreatorsCount: number;
  creatorUsernames: string[];
  totalViolationsAcrossNetwork: number;
  totalCommentsAcrossNetwork: number;
  networkRiskLevel: ThreatLevel;
}

interface BehaviorPattern {
  patternCategory: CommentCategory;
  similarityScore: number;
  accountCount: number;
  exampleFromThisAccount: string;
}

interface SimilarBehaviorsResponse {
  similarBehaviorCount: number;
  behaviorPatterns: BehaviorPattern[];
  networkRiskLevel: ThreatLevel;
}

interface EvidenceItem {
  id: string;
  fileType: 'IMAGE' | 'SCREENSHOT' | 'URL' | 'VIDEO';
  fileUrl?: string;
  fileSize?: number;
  screenshotTimestamp?: string;
  screenshotContext?: string;
  uploadNotes?: string;
  uploadedAt: string;
}

interface CommentWithEvidence {
  id: string;
  text: string;
  commentedAt: Date;
  category: string | null;
  riskScore: number | null;
  actionTaken: string | null;
  isDeleted: boolean;
  isHidden: boolean;
  postId: string | null;
  postPermalink: string | null;
  evidence: EvidenceItem[];
}

interface SuspiciousAccountResponse {
  id: string;
  instagramUsername: string;
  instagramId: string;
  totalViolations: number;
  blackmailCount: number;
  threatCount: number;
  harassmentCount: number;
  defamationCount: number;
  spamCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  isBlocked: boolean;
  blockReason?: string;
  blockedAt?: string;
  autoHideEnabled?: boolean;
  autoDeleteEnabled?: boolean;
  riskLevel: ThreatLevel;
  isWatchlisted: boolean;
  watchlistedAt?: string;
  watchlistReason?: string;
  isPublicThreat: boolean;
  publicThreatAt?: string;
  publicThreatDescription?: string;
  isHidden: boolean;
}

interface BotNetworkMember {
  accountId: string;
  username: string;
  sharedIdentifiers: Array<{
    type: IdentifierType;
    value: string;
  }>;
  connectionStrength: 'STRONG' | 'MODERATE' | 'WEAK';
}

interface BotNetworkDetection {
  networkId: string;
  confidence: 'CONFIRMED' | 'HIGHLY_LIKELY' | 'SUSPECTED';
  memberCount: number;
  members: BotNetworkMember[];
  sharedIdentifiers: Array<{
    type: IdentifierType;
    value: string;
    accountCount: number;
  }>;
  coordinatedTiming?: {
    timeWindow: string;
    accountCount: number;
  };
  riskLevel: ThreatLevel;
  evidence: string[];
}

export class SuspiciousAccountsController {
  /**
   * Create a new suspicious account manually
   */
  async createSuspiciousAccount(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const ownerUserId = effectiveUserId ?? userId;

      const { instagramUsername, reason, initialRiskLevel } = req.body;

      if (!instagramUsername || !reason) {
        res.status(400).json({ success: false, error: 'Instagram username and reason are required' });
        return;
      }

      // Get Instagram accounts: by clientId when agency delegates, else by userId
      const userAccounts = await db.query.instagramAccounts.findMany({
        where: and(
          effectiveClientId
            ? eq(instagramAccounts.clientId, effectiveClientId)
            : eq(instagramAccounts.userId, ownerUserId),
          eq(instagramAccounts.isActive, true)
        )
      });

      if (userAccounts.length === 0) {
        res.status(400).json({ success: false, error: 'No active Instagram accounts found' });
        return;
      }

      // Use the first Instagram account for now (can be improved later)
      const instagramAccountId = userAccounts[0].id;

      // Check if account already exists
      const existingAccount = await db
        .select()
        .from(suspiciousAccounts)
        .where(
          and(
            eq(suspiciousAccounts.instagramAccountId, instagramAccountId),
            eq(suspiciousAccounts.commenterUsername, instagramUsername.replace('@', ''))
          )
        )
        .limit(1);

      if (existingAccount.length > 0) {
        res.status(409).json({ success: false, error: 'Account already exists in suspicious accounts' });
        return;
      }

      // Calculate risk scores based on initial risk level
      const riskScore = initialRiskLevel === 'CRITICAL' ? 85 : initialRiskLevel === 'HIGH' ? 70 : initialRiskLevel === 'MEDIUM' ? 50 : 30;

      // Create the suspicious account
      const [newAccount] = await db
        .insert(suspiciousAccounts)
        .values({
          instagramAccountId,
          commenterId: `manual_${Date.now()}`, // Temporary ID for manual entries
          commenterUsername: instagramUsername.replace('@', ''),
          totalComments: 0,
          flaggedComments: 0,
          deletedComments: 0,
          blackmailCount: 0,
          threatCount: 0,
          harassmentCount: 0,
          spamCount: 0,
          defamationCount: 0,
          averageRiskScore: riskScore.toString(),
          highestRiskScore: riskScore,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          isWatchlisted: false,
          watchlistReason: reason,
          isPublicThreat: false,
          isHidden: false
        })
        .returning();

      res.json({ success: true, data: newAccount });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Create suspicious account error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to create suspicious account' });
    }
  }

  /**
   * Get all suspicious accounts (debug endpoint)
   */
  async getAllSuspiciousAccounts(
    req: AuthRequest,
    res: Response<ApiResponse<Array<{
      id: string;
      commenterUsername: string;
      commenterId: string;
      instagramAccountId: string;
      totalComments: number | null;
      isBlocked: boolean;
      createdAt: Date | null;
    }>>>
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const ownerUserId = effectiveUserId ?? userId;

      // Get Instagram accounts: by clientId when agency delegates, else by userId
      const userAccounts = await db.query.instagramAccounts.findMany({
        where: and(
          effectiveClientId
            ? eq(instagramAccounts.clientId, effectiveClientId)
            : eq(instagramAccounts.userId, ownerUserId),
          eq(instagramAccounts.isActive, true)
        )
      });

      const accountIds = userAccounts.map(acc => acc.id);
      if (accountIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const accounts = await db
        .select({
          id: suspiciousAccounts.id,
          commenterUsername: suspiciousAccounts.commenterUsername,
          commenterId: suspiciousAccounts.commenterId,
          instagramAccountId: suspiciousAccounts.instagramAccountId,
          totalComments: suspiciousAccounts.totalComments,
          isBlocked: suspiciousAccounts.isBlocked,
          autoHideEnabled: suspiciousAccounts.autoHideEnabled,
          autoDeleteEnabled: suspiciousAccounts.autoDeleteEnabled,
          createdAt: suspiciousAccounts.createdAt
        })
        .from(suspiciousAccounts)
        .where(inArray(suspiciousAccounts.instagramAccountId, accountIds))
        .orderBy(desc(suspiciousAccounts.createdAt))
        .limit(50);

      // Map to handle null values
      const formattedAccounts = accounts.map(acc => ({
        id: acc.id,
        commenterUsername: acc.commenterUsername,
        commenterId: acc.commenterId,
        instagramAccountId: acc.instagramAccountId,
        totalComments: acc.totalComments,
        isBlocked: acc.isBlocked ?? false,
        createdAt: acc.createdAt
      }));

      res.json({ success: true, data: formattedAccounts });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get all suspicious accounts error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
    }
  }

  /**
   * Get suspicious accounts for authenticated user
   */
  async getSuspiciousAccounts(
    req: AuthRequest,
    res: Response<ApiResponse<SuspiciousAccountResponse[]>>
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const ownerUserId = effectiveUserId ?? userId;

      const sortBy = req.query.sort === 'recent' ? 'lastSeenAt' : 'totalComments';

      // Get Instagram accounts: by clientId when agency delegates, else by userId
      const userAccounts = await db.query.instagramAccounts.findMany({
        where: and(
          effectiveClientId
            ? eq(instagramAccounts.clientId, effectiveClientId)
            : eq(instagramAccounts.userId, ownerUserId),
          eq(instagramAccounts.isActive, true)
        )
      });

      const accountIds = userAccounts.map(acc => acc.id);
      if (accountIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      // Get suspicious accounts
      const accountsRaw = await db
        .select({
          // Base suspicious account data
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId,
          commenterUsername: suspiciousAccounts.commenterUsername,
          commenterId: suspiciousAccounts.commenterId,
          totalComments: suspiciousAccounts.totalComments,
          flaggedComments: suspiciousAccounts.flaggedComments,
          deletedComments: suspiciousAccounts.deletedComments,
          blackmailCount: suspiciousAccounts.blackmailCount,
          threatCount: suspiciousAccounts.threatCount,
          harassmentCount: suspiciousAccounts.harassmentCount,
          spamCount: suspiciousAccounts.spamCount,
          defamationCount: suspiciousAccounts.defamationCount,
          averageRiskScore: suspiciousAccounts.averageRiskScore,
          highestRiskScore: suspiciousAccounts.highestRiskScore,
          firstSeenAt: suspiciousAccounts.firstSeenAt,
          lastSeenAt: suspiciousAccounts.lastSeenAt,
          isBlocked: suspiciousAccounts.isBlocked,
          blockReason: suspiciousAccounts.blockReason,
          blockedAt: suspiciousAccounts.blockedAt,
          autoHideEnabled: suspiciousAccounts.autoHideEnabled,
          autoDeleteEnabled: suspiciousAccounts.autoDeleteEnabled,
          // New watchlist fields
          isWatchlisted: suspiciousAccounts.isWatchlisted,
          watchlistedAt: suspiciousAccounts.watchlistedAt,
          watchlistReason: suspiciousAccounts.watchlistReason,
          isPublicThreat: suspiciousAccounts.isPublicThreat,
          publicThreatAt: suspiciousAccounts.publicThreatAt,
          publicThreatDescription: suspiciousAccounts.publicThreatDescription,
          isHidden: suspiciousAccounts.isHidden
        })
        .from(suspiciousAccounts)
        .where(
          and(
            inArray(suspiciousAccounts.instagramAccountId, accountIds),
            // Only show accounts that are not hidden, OR are watchlisted, OR are public threats
            or(
              eq(suspiciousAccounts.isHidden, false),
              eq(suspiciousAccounts.isWatchlisted, true),
              eq(suspiciousAccounts.isPublicThreat, true)
            )
          )
        )
        .orderBy(sortBy === 'lastSeenAt' ? desc(suspiciousAccounts.lastSeenAt) : desc(suspiciousAccounts.totalComments));

      // Exclude account owners (never show the Instagram account owner as a suspicious account)
      const igAccountIds = [...new Set(accountsRaw.map((a: { instagramAccountId: string }) => a.instagramAccountId))];
      const igAccountsList = igAccountIds.length > 0
        ? await db.query.instagramAccounts.findMany({
            where: inArray(instagramAccounts.id, igAccountIds),
            columns: { id: true, username: true, instagramId: true }
          })
        : [];
      const igByAccountId = new Map(igAccountsList.map(ig => [ig.id, ig]));
      const normalizeUsername = (s: string | null | undefined): string =>
        (s ?? '').toString().toLowerCase().trim().replace(/^@/, '');
      const isOwnerRecord = (sa: { instagramAccountId: string; commenterUsername: string; commenterId: string }) => {
        const ig = igByAccountId.get(sa.instagramAccountId);
        if (!ig) return false;
        const commenterNorm = normalizeUsername(sa.commenterUsername);
        const ownerNorm = normalizeUsername(ig.username);
        if (commenterNorm && ownerNorm && commenterNorm === ownerNorm) return true;
        if (sa.commenterId && ig.instagramId && sa.commenterId === ig.instagramId) return true;
        return false;
      };
      const accounts = accountsRaw.filter((sa: { instagramAccountId: string; commenterUsername: string; commenterId: string }) => !isOwnerRecord(sa));
      // Hide existing owner records in DB so they stop counting on dashboard and never reappear
      const ownerRecordIds = accountsRaw.filter((sa: { instagramAccountId: string; commenterUsername: string; commenterId: string }) => isOwnerRecord(sa)).map((sa: { id: string }) => sa.id);
      if (ownerRecordIds.length > 0) {
        await db.update(suspiciousAccounts).set({ isHidden: true }).where(inArray(suspiciousAccounts.id, ownerRecordIds));
      }

      // Calculate risk levels and format response
      const formattedAccounts: SuspiciousAccountResponse[] = accounts.map(account => {
        const blackmailCount = account.blackmailCount ?? 0;
        const threatCount = account.threatCount ?? 0;
        const harassmentCount = account.harassmentCount ?? 0;
        const defamationCount = account.defamationCount ?? 0;
        const spamCount = account.spamCount ?? 0;
        const highestRiskScore = account.highestRiskScore ?? 0;
        
        const totalViolations = blackmailCount + threatCount + harassmentCount + defamationCount + spamCount;

        let riskLevel: ThreatLevel = ThreatLevel.LOW;

        // Calculate risk level based on violations and patterns
        if (blackmailCount >= 1 || threatCount >= 2 || highestRiskScore >= 85) {
          riskLevel = ThreatLevel.CRITICAL;
        } else if (highestRiskScore >= 70 || totalViolations >= 5) {
          riskLevel = ThreatLevel.HIGH;
        } else if (highestRiskScore >= 50 || totalViolations >= 3) {
          riskLevel = ThreatLevel.MEDIUM;
        }

        return {
          id: account.id,
          instagramUsername: account.commenterUsername,
          instagramId: account.commenterId,
          totalViolations,
          blackmailCount,
          threatCount,
          harassmentCount,
          defamationCount,
          spamCount,
          firstSeenAt: account.firstSeenAt.toISOString(),
          lastSeenAt: account.lastSeenAt.toISOString(),
          isBlocked: account.isBlocked ?? false,
          blockReason: account.blockReason || undefined,
          blockedAt: account.blockedAt?.toISOString(),
          autoHideEnabled: account.autoHideEnabled ?? false,
          autoDeleteEnabled: account.autoDeleteEnabled ?? (account.isBlocked ?? false),
          riskLevel,
          isWatchlisted: account.isWatchlisted ?? false,
          watchlistedAt: account.watchlistedAt?.toISOString(),
          watchlistReason: account.watchlistReason || undefined,
          isPublicThreat: account.isPublicThreat ?? false,
          publicThreatAt: account.publicThreatAt?.toISOString(),
          publicThreatDescription: account.publicThreatDescription || undefined,
          isHidden: account.isHidden ?? false
        };
      });

      res.json({ success: true, data: formattedAccounts });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get suspicious accounts error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch suspicious accounts' });
    }
  }

  /**
   * Watchlist a suspicious account
   */
  async watchlistAccount(
    req: AuthRequest,
    res: Response<ApiResponse<{ success: boolean }>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const { reason } = req.body as { reason?: string };

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get the suspicious account to verify ownership
      const account = await db
        .select({
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId
        })
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (account.length === 0) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Verify ownership
      const ownershipCheck = await db
        .select()
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, account[0].instagramAccountId),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        )
        .limit(1);

      if (ownershipCheck.length === 0) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      await db
        .update(suspiciousAccounts)
        .set({
          isWatchlisted: true,
          watchlistedAt: new Date(),
          watchlistReason: reason || null,
          isHidden: false // Show watchlisted accounts
        })
        .where(eq(suspiciousAccounts.id, id));

      res.json({ success: true, data: { success: true } });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Watchlist account error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to watchlist account' });
    }
  }

  /**
   * Hide a suspicious account (mark as hidden, doesn't block on Instagram)
   */
  async hideAccount(
    req: AuthRequest,
    res: Response<ApiResponse<{ success: boolean }>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get the suspicious account to verify ownership
      const account = await db
        .select({
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId
        })
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (account.length === 0) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Verify ownership
      const ownershipCheck = await db
        .select()
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, account[0].instagramAccountId),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        )
        .limit(1);

      if (ownershipCheck.length === 0) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      await db
        .update(suspiciousAccounts)
        .set({
          isHidden: true
        })
        .where(eq(suspiciousAccounts.id, id));

      res.json({ success: true, data: { success: true } });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Hide account error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to hide account' });
    }
  }

  /**
   * Block a suspicious account (auto-delete future comments)
   */
  async blockAccount(
    req: AuthRequest,
    res: Response<ApiResponse<{ success: boolean }>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get the suspicious account to verify ownership
      const account = await db
        .select({
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId,
          commenterId: suspiciousAccounts.commenterId
        })
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (account.length === 0) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Verify ownership
      const ownershipCheck = await db
        .select({
          id: instagramAccounts.id,
          accessToken: instagramAccounts.accessToken
        })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, account[0].instagramAccountId),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        )
        .limit(1);

      if (ownershipCheck.length === 0) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      // Optionally block user on Instagram if access token is available
      // This requires the instagram_business_manage_comments permission
      if (ownershipCheck[0].accessToken) {
        try {
          const blockSuccess = await instagramService.blockUser(
            account[0].commenterId,
            ownershipCheck[0].accessToken
          );
          if (blockSuccess) {
            console.log(`✅ User ${account[0].commenterId} blocked on Instagram`);
          } else {
            console.warn(`⚠️ Failed to block user ${account[0].commenterId} on Instagram, but marking as blocked in database`);
          }
        } catch (instagramError) {
          console.error('Failed to block user on Instagram:', instagramError);
          // Continue with database update even if Instagram API call fails
        }
      }

      // Mark as blocked in database (this enables auto-delete for future comments)
      await db
        .update(suspiciousAccounts)
        .set({
          isBlocked: true,
          autoDeleteEnabled: true, // Keep in sync with isBlocked
          blockedAt: new Date(),
          blockReason: 'Manual block from suspicious accounts',
          updatedAt: new Date()
        })
        .where(eq(suspiciousAccounts.id, id));

      res.json({ success: true, data: { success: true } });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Block account error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to block account' });
    }
  }

  /**
   * Update auto-hide setting for a suspicious account.
   * When enabling: hide all existing comments from this commenter (Instagram API + DB), then hide new ones as they arrive.
   * When disabling: we do not unhide any previously hidden comments; from the next post onwards, new comments are no longer auto-hidden.
   */
  async updateAutoHide(
    req: AuthRequest,
    res: Response<ApiResponse<{ success: boolean; hiddenCount?: number; postsScanned?: number }>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const { enabled } = req.body as { enabled: boolean };

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Load full suspicious account for commenter matching
      const account = await db
        .select({
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId,
          commenterId: suspiciousAccounts.commenterId,
          commenterUsername: suspiciousAccounts.commenterUsername
        })
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (account.length === 0) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      const ownershipCheck = await db
        .select({
          id: instagramAccounts.id,
          accessToken: instagramAccounts.accessToken
        })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, account[0].instagramAccountId),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        )
        .limit(1);

      if (ownershipCheck.length === 0) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      // Only one of auto-hide or auto-delete at a time: when enabling auto-hide, turn off auto-delete
      await db
        .update(suspiciousAccounts)
        .set({
          autoHideEnabled: enabled,
          ...(enabled ? { autoDeleteEnabled: false, isBlocked: false, blockedAt: null, blockReason: null } : {}),
          updatedAt: new Date()
        })
        .where(eq(suspiciousAccounts.id, id));

      let hiddenCount = 0;
      let postsScanned: number | undefined;
      if (enabled && ownershipCheck[0].accessToken) {
        const commentsToHide = await this.getCommentsByCommenterForAccount(
          account[0].instagramAccountId,
          account[0].commenterId,
          account[0].commenterUsername,
          'instagram',
          { onlyNotHidden: true }
        );
        postsScanned = commentsToHide.length > 0 ? new Set(commentsToHide.map((c) => c.postId)).size : 0;
        for (const comment of commentsToHide) {
          if (comment.igCommentId) {
            try {
              const success = await instagramService.hideComment(comment.igCommentId, ownershipCheck[0].accessToken!);
              if (!success) {
                console.warn(`[Auto-hide] Instagram hide failed for comment ${comment.id} (ig: ${comment.igCommentId})`);
              }
            } catch (err) {
              console.warn(`[Auto-hide] Instagram hide error for comment ${comment.id}:`, err);
            }
          }
          await db
            .update(comments)
            .set({ isHidden: true, hiddenAt: new Date() })
            .where(eq(comments.id, comment.id));
          hiddenCount++;
        }
        if (hiddenCount > 0) {
          console.log(`[Auto-hide] Hid ${hiddenCount} existing comment(s) for @${account[0].commenterUsername ?? account[0].commenterId}`);
        }
      }

      res.json({ success: true, data: { success: true, hiddenCount, postsScanned } });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Update auto-hide error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to update auto-hide' });
    }
  }

  /**
   * Update auto-delete setting for a suspicious account.
   * When enabling: also delete all existing comments from this commenter on this account's posts (Instagram API + DB).
   */
  async updateAutoDelete(
    req: AuthRequest,
    res: Response<ApiResponse<{ success: boolean; deletedCount?: number; postsScanned?: number }>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const { enabled } = req.body as { enabled: boolean };

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Load full suspicious account for commenter matching
      const account = await db
        .select({
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId,
          commenterId: suspiciousAccounts.commenterId,
          commenterUsername: suspiciousAccounts.commenterUsername
        })
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (account.length === 0) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      const ownershipCheck = await db
        .select({
          id: instagramAccounts.id,
          accessToken: instagramAccounts.accessToken
        })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, account[0].instagramAccountId),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        )
        .limit(1);

      if (ownershipCheck.length === 0) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      // If enabling auto-delete, also block on Instagram if possible
      if (enabled && ownershipCheck[0].accessToken) {
        try {
          await instagramService.blockUser(
            account[0].commenterId,
            ownershipCheck[0].accessToken
          );
        } catch (instagramError) {
          console.error('Failed to block user on Instagram:', instagramError);
          // Continue with database update even if Instagram API call fails
        }
      }

      // Only one of auto-hide or auto-delete at a time: when enabling auto-delete, turn off auto-hide
      await db
        .update(suspiciousAccounts)
        .set({
          autoDeleteEnabled: enabled,
          isBlocked: enabled, // Keep isBlocked in sync for backward compatibility
          blockedAt: enabled ? new Date() : null,
          blockReason: enabled ? 'Auto-delete enabled' : null,
          ...(enabled ? { autoHideEnabled: false } : {}),
          updatedAt: new Date()
        })
        .where(eq(suspiciousAccounts.id, id));

      // When enabling: delete all existing comments from this commenter (including already-hidden ones)
      let deletedCount = 0;
      let postsScanned: number | undefined;
      if (enabled && ownershipCheck[0].accessToken) {
        const commentsToDelete = await this.getCommentsByCommenterForAccount(
          account[0].instagramAccountId,
          account[0].commenterId,
          account[0].commenterUsername,
          'instagram',
          { onlyNotDeleted: true } // includes hidden comments — only skip already-deleted
        );
        postsScanned = commentsToDelete.length > 0 ? new Set(commentsToDelete.map((c) => c.postId)).size : 0;
        for (const comment of commentsToDelete) {
          if (comment.igCommentId) {
            try {
              const success = await instagramService.deleteComment(comment.igCommentId, ownershipCheck[0].accessToken!);
              if (!success) {
                console.warn(`[Auto-delete] Instagram delete failed for comment ${comment.id} (ig: ${comment.igCommentId})`);
              }
            } catch (err) {
              console.warn(`[Auto-delete] Instagram delete error for comment ${comment.id}:`, err);
            }
          }
          await db
            .update(comments)
            .set({ isDeleted: true, deletedAt: new Date() })
            .where(eq(comments.id, comment.id));
          deletedCount++;
        }
        if (deletedCount > 0) {
          console.log(`[Auto-delete] Deleted ${deletedCount} existing comment(s) for @${account[0].commenterUsername ?? account[0].commenterId}`);
        }
      }

      res.json({ success: true, data: { success: true, deletedCount, postsScanned } });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Update auto-delete error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to update auto-delete' });
    }
  }

  /**
   * Get a specific suspicious account by ID
   */
  async getSuspiciousAccountById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      console.log(`🔍 [DEBUG] Getting suspicious account ${id} for user ${userId}`);

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Verify the account belongs to user's Instagram accounts
      const account = await db
        .select({
          // Base suspicious account data
          id: suspiciousAccounts.id,
          commenterUsername: suspiciousAccounts.commenterUsername,
          commenterId: suspiciousAccounts.commenterId,
          totalComments: suspiciousAccounts.totalComments,
          flaggedComments: suspiciousAccounts.flaggedComments,
          deletedComments: suspiciousAccounts.deletedComments,
          blackmailCount: suspiciousAccounts.blackmailCount,
          threatCount: suspiciousAccounts.threatCount,
          harassmentCount: suspiciousAccounts.harassmentCount,
          spamCount: suspiciousAccounts.spamCount,
          defamationCount: suspiciousAccounts.defamationCount,
          averageRiskScore: suspiciousAccounts.averageRiskScore,
          highestRiskScore: suspiciousAccounts.highestRiskScore,
          firstSeenAt: suspiciousAccounts.firstSeenAt,
          lastSeenAt: suspiciousAccounts.lastSeenAt,
          isBlocked: suspiciousAccounts.isBlocked,
          blockReason: suspiciousAccounts.blockReason,
          blockedAt: suspiciousAccounts.blockedAt,
          autoHideEnabled: suspiciousAccounts.autoHideEnabled,
          autoDeleteEnabled: suspiciousAccounts.autoDeleteEnabled,
          isWatchlisted: suspiciousAccounts.isWatchlisted,
          watchlistedAt: suspiciousAccounts.watchlistedAt,
          watchlistReason: suspiciousAccounts.watchlistReason,
          isPublicThreat: suspiciousAccounts.isPublicThreat,
          publicThreatAt: suspiciousAccounts.publicThreatAt,
          publicThreatDescription: suspiciousAccounts.publicThreatDescription,
          isHidden: suspiciousAccounts.isHidden,
          // Check ownership
          instagramAccountId: suspiciousAccounts.instagramAccountId
        })
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      console.log(`🔍 [DEBUG] Found ${account.length} accounts with ID ${id}`);

      if (account.length === 0) {
        console.log(`❌ [DEBUG] Account ${id} not found in database`);
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      const accountData = account[0];
      console.log(`🔍 [DEBUG] Account data:`, {
        id: accountData.id,
        username: accountData.commenterUsername,
        instagramAccountId: accountData.instagramAccountId
      });

      // Verify ownership
      const ownershipCheck = await db
        .select()
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, accountData.instagramAccountId),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        )
        .limit(1);

      console.log(`🔍 [DEBUG] Ownership check: found ${ownershipCheck.length} matching Instagram accounts for user ${userId}`);

      if (ownershipCheck.length === 0) {
        console.log(`❌ [DEBUG] Access denied: account belongs to Instagram account ${accountData.instagramAccountId} but user ${userId} doesn't have access`);
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }

      // Format response
      const blackmailCount = accountData.blackmailCount ?? 0;
      const threatCount = accountData.threatCount ?? 0;
      const harassmentCount = accountData.harassmentCount ?? 0;
      const defamationCount = accountData.defamationCount ?? 0;
      const spamCount = accountData.spamCount ?? 0;
      const highestRiskScore = accountData.highestRiskScore ?? 0;
      
      const totalViolations = blackmailCount + threatCount + harassmentCount + defamationCount + spamCount;

      let riskLevel: ThreatLevel = ThreatLevel.LOW;
      if (blackmailCount >= 1 || threatCount >= 2 || highestRiskScore >= 85) {
        riskLevel = ThreatLevel.CRITICAL;
      } else if (highestRiskScore >= 70 || totalViolations >= 5) {
        riskLevel = ThreatLevel.HIGH;
      } else if (highestRiskScore >= 50 || totalViolations >= 3) {
        riskLevel = ThreatLevel.MEDIUM;
      }

      const formattedAccount: SuspiciousAccountResponse = {
        id: accountData.id,
        instagramUsername: accountData.commenterUsername,
        instagramId: accountData.commenterId,
        totalViolations,
        blackmailCount,
        threatCount,
        harassmentCount,
        defamationCount,
        spamCount,
        firstSeenAt: accountData.firstSeenAt.toISOString(),
        lastSeenAt: accountData.lastSeenAt.toISOString(),
        isBlocked: accountData.isBlocked ?? false,
        blockReason: accountData.blockReason || undefined,
        blockedAt: accountData.blockedAt?.toISOString(),
        autoHideEnabled: accountData.autoHideEnabled ?? false,
        autoDeleteEnabled: accountData.autoDeleteEnabled ?? (accountData.isBlocked ?? false),
        riskLevel,
        isWatchlisted: accountData.isWatchlisted ?? false,
        watchlistedAt: accountData.watchlistedAt?.toISOString(),
        watchlistReason: accountData.watchlistReason || undefined,
        isPublicThreat: accountData.isPublicThreat ?? false,
        publicThreatAt: accountData.publicThreatAt?.toISOString(),
        publicThreatDescription: accountData.publicThreatDescription || undefined,
        isHidden: accountData.isHidden ?? false
      };

      res.json({ success: true, data: formattedAccount });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get suspicious account by ID error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch account' });
    }
  }

  /**
   * Get extracted identifiers for a suspicious account (payment handles, links, contact info)
   * Links are analyzed by LLM to determine if they're phishing/scam/payment solicitation
   */
  async getExtractedIdentifiers(
    req: AuthRequest,
    res: Response<ApiResponse<ExtractedIdentifiersResponse>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get extracted identifiers for this account
      const identifiers = await db
        .select({
          id: extractedIdentifiers.id,
          identifier: extractedIdentifiers.identifier,
          identifierType: extractedIdentifiers.identifierType,
          platform: extractedIdentifiers.platform,
          confidence: extractedIdentifiers.confidence,
          commentId: extractedIdentifiers.commentId,
          createdAt: extractedIdentifiers.createdAt
        })
        .from(extractedIdentifiers)
        .where(eq(extractedIdentifiers.suspiciousAccountId, id))
        .orderBy(desc(extractedIdentifiers.createdAt));

      // Group by type
      const paymentHandles: PaymentHandle[] = [];
      const contactInfo: ContactInfo[] = [];
      const urls: Array<{ url: string; confidence: number; commentId: string; createdAt: string }> = [];

      for (const item of identifiers) {
        const createdAt = item.createdAt?.toISOString() || new Date().toISOString();
        const baseItem = {
          value: item.identifier,
          confidence: parseFloat(item.confidence as string),
          commentId: item.commentId,
          createdAt
        };

        // Payment methods
        if (['VENMO', 'CASHAPP', 'PAYPAL', 'ZELLE', 'BITCOIN', 'ETHEREUM', 'CRYPTO'].includes(item.identifierType)) {
          paymentHandles.push({
            type: item.identifierType as IdentifierType,
            ...baseItem,
            platform: item.platform || undefined
          });
        }
        // Contact info
        else if (['EMAIL', 'PHONE'].includes(item.identifierType)) {
          contactInfo.push({
            type: item.identifierType as 'EMAIL' | 'PHONE',
            ...baseItem
          });
        }
        // URLs - need LLM analysis
        else if (item.identifierType === 'DOMAIN' || item.identifier.startsWith('http')) {
          urls.push({
            url: item.identifier,
            confidence: baseItem.confidence,
            commentId: baseItem.commentId,
            createdAt: baseItem.createdAt
          });
        }
      }

      // Analyze URLs with LLM to determine if suspicious
      const scamLinks: ScamLink[] = [];
      
      for (const urlItem of urls) {
        try {
          const analysis = await llmService.analyzeUrl(urlItem.url);
          
          // Only include suspicious links or links with payment solicitation
          if (analysis.isSuspicious || analysis.containsPaymentSolicitation) {
            let domain = 'unknown';
            try {
              domain = new URL(urlItem.url).hostname;
            } catch {
              // Invalid URL, use the identifier as-is
              domain = urlItem.url.split('/')[0];
            }

            scamLinks.push({
              url: urlItem.url,
              domain,
              confidence: urlItem.confidence,
              commentId: urlItem.commentId,
              createdAt: urlItem.createdAt,
              isPhishing: analysis.linkType === 'phishing',
              isScam: analysis.linkType === 'shopping_scam' || analysis.linkType === 'spam_offer' || analysis.linkType === 'fake_giveaway',
              containsPaymentSolicitation: analysis.containsPaymentSolicitation,
              linkType: analysis.linkType,
              llmRationale: analysis.rationale
            });
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Failed to analyze URL ${urlItem.url}:`, errorMessage);
          // Continue processing other URLs even if one fails
        }
      }

      res.json({
        success: true,
        data: {
          paymentHandles,
          contactInfo,
          scamLinks
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get extracted identifiers error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch identifiers' });
    }
  }

  /**
   * Get network-wide activity for a suspicious account
   * Shows which creators have flagged this account and aggregate stats
   */
  async getNetworkActivity(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get the current account to find its commenterId
      const account = await db.query.suspiciousAccounts.findFirst({
        where: eq(suspiciousAccounts.id, id)
      });

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Find all suspicious account records with same commenterId (across different Instagram accounts)
      const crossAccountRecords = await db
        .select({
          id: suspiciousAccounts.id,
          instagramAccountId: suspiciousAccounts.instagramAccountId,
          totalComments: suspiciousAccounts.totalComments,
          flaggedComments: suspiciousAccounts.flaggedComments,
          blackmailCount: suspiciousAccounts.blackmailCount,
          threatCount: suspiciousAccounts.threatCount,
          harassmentCount: suspiciousAccounts.harassmentCount,
          defamationCount: suspiciousAccounts.defamationCount,
          spamCount: suspiciousAccounts.spamCount,
          instagramUsername: instagramAccounts.username
        })
        .from(suspiciousAccounts)
        .innerJoin(instagramAccounts, eq(suspiciousAccounts.instagramAccountId, instagramAccounts.id))
        .where(
          and(
            eq(suspiciousAccounts.commenterId, account.commenterId),
            sql`${suspiciousAccounts.id} != ${id}` // Exclude current account
          )
        );

      const flaggedByCreatorsCount = crossAccountRecords.length;
      const creatorUsernames = crossAccountRecords.map(r => r.instagramUsername);
      
      const totalViolationsAcrossNetwork = crossAccountRecords.reduce((sum, r) => 
        sum + ((r.blackmailCount ?? 0) + (r.threatCount ?? 0) + (r.harassmentCount ?? 0) + (r.defamationCount ?? 0) + (r.spamCount ?? 0)), 0
      );
      
      const totalCommentsAcrossNetwork = crossAccountRecords.reduce((sum, r) => sum + (r.totalComments ?? 0), 0);

      // Calculate network risk level
      let networkRiskLevel: ThreatLevel = ThreatLevel.LOW;
      if (flaggedByCreatorsCount >= 5 || totalViolationsAcrossNetwork >= 20) {
        networkRiskLevel = ThreatLevel.CRITICAL;
      } else if (flaggedByCreatorsCount >= 3 || totalViolationsAcrossNetwork >= 10) {
        networkRiskLevel = ThreatLevel.HIGH;
      } else if (flaggedByCreatorsCount >= 2 || totalViolationsAcrossNetwork >= 5) {
        networkRiskLevel = ThreatLevel.MEDIUM;
      }

      const response: NetworkActivityResponse = {
        flaggedByCreatorsCount,
        creatorUsernames,
        totalViolationsAcrossNetwork,
        totalCommentsAcrossNetwork,
        networkRiskLevel
      };

      res.json({
        success: true,
        data: response
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get network activity error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch network activity' });
    }
  }

  /**
   * Get similar behavior patterns using embeddings/similarity search
   * Does NOT expose other creators' comment content
   */
  async getSimilarBehaviors(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get the suspicious account
      const account = await db.query.suspiciousAccounts.findFirst({
        where: eq(suspiciousAccounts.id, id)
      });

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Get all comments for this suspicious account with embeddings
      // Note: category and riskScore are in moderationLogs, not comments
      const accountComments = await db
        .select({
          id: comments.id,
          text: comments.text,
          embedding: comments.embedding,
          commentId: comments.id
        })
        .from(comments)
        .innerJoin(accountCommentMap, eq(comments.id, accountCommentMap.commentId))
        .where(
          and(
            eq(accountCommentMap.suspiciousAccountId, id),
            sql`${comments.embedding} IS NOT NULL`
          )
        );

      // If no comments with embeddings, return empty results
      if (accountComments.length === 0) {
        res.json({
          success: true,
          data: {
            similarBehaviorCount: 0,
            behaviorPatterns: [],
            networkRiskLevel: 'LOW',
            message: 'No comments with embeddings found for this account'
          }
        });
        return;
      }

      // Track unique accounts per category
      const categoryStats = new Map<CommentCategory, Set<string>>();
      const categorySimilarities = new Map<CommentCategory, number[]>();
      const categoryExamples = new Map<CommentCategory, string>();

      for (const comment of accountComments) {
        if (!comment.embedding) continue;

        try {
          // Find similar comments from OTHER accounts
          const similarComments = await embeddingsService.findSimilarCommentsEfficient(
            comment.commentId,
            30, // limit
            0.75 // min similarity threshold
          );

          // Get category from moderation logs for this comment
          const moderationLog = await db
            .select({ category: moderationLogs.category })
            .from(moderationLogs)
            .where(eq(moderationLogs.commentId, comment.commentId))
            .limit(1);

          const category = (moderationLog[0]?.category as CommentCategory) || CommentCategory.BENIGN;

          // Group by category
          for (const similar of similarComments) {
            // Track unique accounts per category
            if (!categoryStats.has(category)) {
              categoryStats.set(category, new Set());
              categorySimilarities.set(category, []);
              categoryExamples.set(category, comment.text);
            }
            
            categoryStats.get(category)!.add(similar.commenterId);
            categorySimilarities.get(category)!.push(similar.similarity);
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Failed to find similar comments for ${comment.commentId}:`, errorMessage);
          // Continue processing other comments
        }
      }

      // Build behavior patterns response
      const behaviorPatterns: BehaviorPattern[] = Array.from(categoryStats.entries()).map(([category, accounts]) => {
        const similarities = categorySimilarities.get(category) || [];
        const avgSimilarity = similarities.length > 0
          ? similarities.reduce((sum, s) => sum + s, 0) / similarities.length
          : 0;

        return {
          patternCategory: category,
          similarityScore: avgSimilarity,
          accountCount: accounts.size,
          exampleFromThisAccount: categoryExamples.get(category) || ''
        };
      });

      // Calculate network risk level
      const totalUniqueAccounts = new Set(
        Array.from(categoryStats.values()).flatMap(set => Array.from(set))
      ).size;

      let networkRiskLevel: ThreatLevel = ThreatLevel.LOW;
      if (totalUniqueAccounts >= 10 || behaviorPatterns.some(p => p.patternCategory === CommentCategory.BLACKMAIL)) {
        networkRiskLevel = ThreatLevel.CRITICAL;
      } else if (totalUniqueAccounts >= 5 || behaviorPatterns.some(p => p.patternCategory === CommentCategory.THREAT)) {
        networkRiskLevel = ThreatLevel.HIGH;
      } else if (totalUniqueAccounts >= 2) {
        networkRiskLevel = ThreatLevel.MEDIUM;
      }

      const response: SimilarBehaviorsResponse = {
        similarBehaviorCount: totalUniqueAccounts,
        behaviorPatterns,
        networkRiskLevel
      };

      res.json({
        success: true,
        data: response
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get similar behaviors error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch similar behaviors' });
    }
  }

  /**
   * Get evidence for a suspicious account
   */
  async getAccountEvidence(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get evidence attachments for this account's comments
      const evidence = await db
        .select({
          id: evidenceAttachments.id,
          commentId: evidenceAttachments.commentId,
          fileType: evidenceAttachments.fileType,
          fileUrl: evidenceAttachments.fileUrl,
          fileSize: evidenceAttachments.fileSize,
          mimeType: evidenceAttachments.mimeType,
          screenshotTimestamp: evidenceAttachments.screenshotTimestamp,
          screenshotContext: evidenceAttachments.screenshotContext,
          uploadedBy: evidenceAttachments.uploadedBy,
          uploadNotes: evidenceAttachments.uploadNotes,
          createdAt: evidenceAttachments.createdAt
        })
        .from(evidenceAttachments)
        .innerJoin(
          accountCommentMap,
          eq(evidenceAttachments.commentId, accountCommentMap.commentId)
        )
        .where(eq(accountCommentMap.suspiciousAccountId, id))
        .orderBy(desc(evidenceAttachments.createdAt));

      // Generate signed URLs for S3 images
      const formattedEvidence: EvidenceItem[] = await Promise.all(
        evidence.map(async (item) => {
          let fileUrl = item.fileUrl || undefined;
          
          // If it's an S3 URL, generate a signed URL
          if (fileUrl && fileUrl.includes('s3.us-east-1.amazonaws.com')) {
            try {
              const key = storageService.extractKeyFromUrl(fileUrl);
              fileUrl = await storageService.getSignedUrl(key, 3600); // 1 hour expiration
            } catch (error) {
              console.error('Failed to generate signed URL for evidence:', error);
              // Keep original URL if signing fails
            }
          }
          
          return {
            id: item.id,
            fileType: item.fileType,
            fileUrl,
            fileSize: item.fileSize || undefined,
            screenshotTimestamp: item.screenshotTimestamp?.toISOString(),
            screenshotContext: item.screenshotContext || undefined,
            uploadNotes: item.uploadNotes || undefined,
            uploadedAt: (item.createdAt || new Date()).toISOString()
          };
        })
      );

      res.json({ success: true, data: formattedEvidence });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get account evidence error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch evidence' });
    }
  }

  /**
   * Upload evidence for a suspicious account
   */
  async uploadAccountEvidence(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const { notes } = req.body;
      const file = req.file;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      if (!file) {
        res.status(400).json({ success: false, error: 'No file provided' });
        return;
      }

      // Verify account exists and user has access
      const [account] = await db
        .select()
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Validate file size (10MB for images, 50MB for videos)
      const maxSize = file.mimetype?.startsWith('image/') ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
      if (file.size > maxSize) {
        res.status(400).json({ 
          success: false, 
          error: `File too large. Maximum size is ${maxSize / (1024 * 1024)}MB` 
        });
        return;
      }

      // Upload file to S3
      const folder = `${id}/evidence`;
      const fileUrl = await storageService.uploadFile(file, folder);

      // Get the first comment for this account to link evidence
      const [firstComment] = await db
        .select({ commentId: accountCommentMap.commentId })
        .from(accountCommentMap)
        .where(eq(accountCommentMap.suspiciousAccountId, id))
        .limit(1);

      if (!firstComment) {
        res.status(400).json({ 
          success: false, 
          error: 'Cannot upload evidence: No comments found for this account. Evidence must be linked to a comment.' 
        });
        return;
      }

      // Create evidence entry in database
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const [evidence] = await db
        .insert(evidenceAttachments)
        .values({
          commentId: firstComment.commentId,
          fileType: file.mimetype?.startsWith('image/') ? 'IMAGE' : file.mimetype?.startsWith('video/') ? 'VIDEO' : 'IMAGE',
          fileUrl: fileUrl,
          fileSize: file.size,
          mimeType: file.mimetype || null,
          uploadedBy: userId,
          uploadNotes: notes || null,
          screenshotTimestamp: notes?.includes('screenshot') ? new Date() : undefined,
          screenshotContext: notes || null
        })
        .returning();

      res.json({ success: true, data: evidence });
    } catch (error) {
      console.error('Upload evidence error:', error);
      res.status(500).json({ success: false, error: 'Failed to upload evidence' });
    }
  }

  /**
   * Delete evidence for a suspicious account
   */
  async deleteAccountEvidence(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id, evidenceId } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Verify account exists and user has access
      const [account] = await db
        .select()
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Get the evidence record and verify it belongs to this account
      const evidenceList = await db
        .select({
          id: evidenceAttachments.id,
          commentId: evidenceAttachments.commentId,
          fileType: evidenceAttachments.fileType,
          fileUrl: evidenceAttachments.fileUrl,
          fileSize: evidenceAttachments.fileSize,
          mimeType: evidenceAttachments.mimeType,
          uploadedBy: evidenceAttachments.uploadedBy,
          uploadNotes: evidenceAttachments.uploadNotes,
          createdAt: evidenceAttachments.createdAt
        })
        .from(evidenceAttachments)
        .innerJoin(
          accountCommentMap,
          eq(evidenceAttachments.commentId, accountCommentMap.commentId)
        )
        .where(
          and(
            eq(evidenceAttachments.id, evidenceId),
            eq(accountCommentMap.suspiciousAccountId, id)
          )
        )
        .limit(1);

      if (!evidenceList || evidenceList.length === 0) {
        res.status(404).json({ success: false, error: 'Evidence not found' });
        return;
      }

      const evidenceRecord = evidenceList[0];

      // Verify user has permission (either uploaded by them or they own the account)
      if (evidenceRecord.uploadedBy !== userId) {
        // Check if user owns the Instagram account
        const [instagramAccount] = await db
          .select()
          .from(instagramAccounts)
          .where(eq(instagramAccounts.id, account.instagramAccountId))
          .limit(1);

        if (!instagramAccount || instagramAccount.userId !== userId) {
          res.status(403).json({ success: false, error: 'Permission denied' });
          return;
        }
      }

      // Delete file from S3 if URL exists
      if (evidenceRecord.fileUrl) {
        try {
          const key = storageService.extractKeyFromUrl(evidenceRecord.fileUrl);
          await storageService.deleteFile(key);
        } catch (error) {
          console.error('Failed to delete file from S3:', error);
          // Continue with database deletion even if S3 deletion fails
        }
      }

      // Delete evidence record from database
      await db
        .delete(evidenceAttachments)
        .where(eq(evidenceAttachments.id, evidenceId));

      res.json({ success: true, message: 'Evidence deleted successfully' });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Delete account evidence error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to delete evidence' });
    }
  }

  /**
   * Get all comments linked to a suspicious account
   */
  async getAccountComments(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get user's Instagram accounts
      const userAccounts = await db
        .select({ id: instagramAccounts.id })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.isActive, true),
            sql`${instagramAccounts.userId} = ${userId} OR EXISTS (
              SELECT 1 FROM ${clients} WHERE ${clients.id} = ${instagramAccounts.clientId} AND ${clients.userId} = ${userId}
            )`
          )
        );

      if (userAccounts.length === 0) {
        res.status(400).json({ success: false, error: 'No active Instagram accounts found' });
        return;
      }

      const userAccountIds = userAccounts.map(acc => acc.id);

      // Verify account exists and user has access (must belong to user's Instagram accounts)
      const [account] = await db
        .select()
        .from(suspiciousAccounts)
        .where(
          and(
            eq(suspiciousAccounts.id, id),
            inArray(suspiciousAccounts.instagramAccountId, userAccountIds)
          )
        )
        .limit(1);

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Find all suspicious accounts with the same commenterId that belong to user's Instagram accounts
      // This ensures we show all comments from this commenter across all the user's pages/accounts
      const relatedAccounts = await db
        .select({ id: suspiciousAccounts.id })
        .from(suspiciousAccounts)
        .where(
          and(
            eq(suspiciousAccounts.commenterId, account.commenterId),
            inArray(suspiciousAccounts.instagramAccountId, userAccountIds)
          )
        );

      const relatedAccountIds = relatedAccounts.map(a => a.id);

      if (relatedAccountIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      // Get all comments linked to any suspicious account with the same commenterId
      // Also ensure comments are from posts that belong to user's Instagram accounts
      const accountCommentsData = await db
        .select({
          commentId: comments.id,
          text: comments.text,
          commentedAt: comments.commentedAt,
          isDeleted: comments.isDeleted,
          isHidden: comments.isHidden,
          postId: posts.id,
          postPermalink: posts.permalink,
          category: moderationLogs.category,
          riskScore: moderationLogs.riskScore,
          actionTaken: moderationLogs.actionTaken,
          evidenceId: evidenceAttachments.id,
          evidenceFileUrl: evidenceAttachments.fileUrl,
          evidenceFileType: evidenceAttachments.fileType,
          evidenceUploadNotes: evidenceAttachments.uploadNotes,
          evidenceCreatedAt: evidenceAttachments.createdAt
        })
        .from(accountCommentMap)
        .innerJoin(comments, eq(accountCommentMap.commentId, comments.id))
        .leftJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
        .leftJoin(posts, eq(comments.postId, posts.id))
        .leftJoin(evidenceAttachments, eq(comments.id, evidenceAttachments.commentId))
        .where(
          and(
            inArray(accountCommentMap.suspiciousAccountId, relatedAccountIds),
            inArray(posts.instagramAccountId, userAccountIds)
          )
        )
        .orderBy(desc(comments.commentedAt));

      // Group evidence by comment
      const commentsMap = new Map<string, CommentWithEvidence>();
      
      for (const row of accountCommentsData) {
        if (!commentsMap.has(row.commentId)) {
          commentsMap.set(row.commentId, {
            id: row.commentId,
            text: row.text,
            commentedAt: row.commentedAt,
            category: row.category,
            riskScore: row.riskScore,
            actionTaken: row.actionTaken,
            isDeleted: row.isDeleted ?? false,
            isHidden: row.isHidden ?? false,
            postId: row.postId,
            postPermalink: row.postPermalink,
            evidence: []
          });
        }

        // Add evidence if exists
        if (row.evidenceId) {
          const comment = commentsMap.get(row.commentId);
          if (comment) {
            // Avoid duplicates
            if (!comment.evidence.some(e => e.id === row.evidenceId)) {
              comment.evidence.push({
                id: row.evidenceId,
                fileUrl: row.evidenceFileUrl || undefined,
                fileType: (row.evidenceFileType || 'IMAGE') as 'IMAGE' | 'SCREENSHOT' | 'URL' | 'VIDEO',
                uploadNotes: row.evidenceUploadNotes || undefined,
                uploadedAt: (row.evidenceCreatedAt || new Date()).toISOString()
              });
            }
          }
        }
      }

      const commentsList = Array.from(commentsMap.values());

      res.json({ success: true, data: commentsList });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get account comments error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to get account comments' });
    }
  }

  /**
   * Export account report as ZIP file
   */
  async exportAccountReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Verify account exists and user has access
      const [account] = await db
        .select()
        .from(suspiciousAccounts)
        .where(eq(suspiciousAccounts.id, id))
        .limit(1);

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Generate export
      const zipBuffer = await exportService.exportSuspiciousAccount(id, userId);

      // Set response headers
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${account.commenterUsername}_${timestamp}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', zipBuffer.length);

      // Send ZIP file
      res.send(zipBuffer);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Export account error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to export account' });
    }
  }

  /**
   * Create a test suspicious account for debugging
   */
  async createTestAccount(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const ownerUserId = effectiveUserId ?? userId;

      // Get Instagram accounts: by clientId when agency delegates, else by userId
      const userAccounts = await db.query.instagramAccounts.findMany({
        where: and(
          effectiveClientId
            ? eq(instagramAccounts.clientId, effectiveClientId)
            : eq(instagramAccounts.userId, ownerUserId),
          eq(instagramAccounts.isActive, true)
        ),
        limit: 1
      });

      if (userAccounts.length === 0) {
        res.status(400).json({ success: false, error: 'No active Instagram accounts found' });
        return;
      }

      // Create a test suspicious account
      const [newAccount] = await db
        .insert(suspiciousAccounts)
        .values({
          instagramAccountId: userAccounts[0].id,
          commenterId: `test_${Date.now()}`,
          commenterUsername: 'test_user',
          totalComments: 1,
          flaggedComments: 1,
          deletedComments: 0,
          blackmailCount: 0,
          threatCount: 1,
          harassmentCount: 0,
          spamCount: 0,
          defamationCount: 0,
          averageRiskScore: '75.0',
          highestRiskScore: 75,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          isWatchlisted: false,
          isPublicThreat: false,
          isHidden: false
        })
        .returning();

      console.log(`✅ [DEBUG] Created test suspicious account:`, newAccount);
      res.json({ success: true, data: newAccount });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Create test account error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to create test account' });
    }
  }

  /**
   * Detect bot networks for a specific suspicious account
   * Uses identifier clustering and coordinated timing to find connected accounts
   */
  async detectBotNetwork(
    req: AuthRequest,
    res: Response<ApiResponse<BotNetworkDetection | null>>
  ): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get clientId if user is an agency managing clients
      let clientId: string | undefined;
      if (isAgency(req.accountType)) {
        // For agencies, we need to get clientId from the request or query
        // For now, we'll check all accounts the agency manages
        clientId = undefined; // Will query all clients managed by this agency
      }

      // Get the suspicious account
      const account = await db.query.suspiciousAccounts.findFirst({
        where: eq(suspiciousAccounts.id, id)
      });

      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }

      // Get user's Instagram accounts for filtering
      const userAccounts = await db
        .select({ id: instagramAccounts.id })
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.isActive, true),
            clientId ? eq(instagramAccounts.clientId, clientId) : undefined,
            userId ? eq(instagramAccounts.userId, userId) : undefined
          )
        );

      const accountIds = userAccounts.map(acc => acc.id);
      if (accountIds.length === 0) {
        res.status(403).json({ success: false, error: 'No access to Instagram accounts' });
        return;
      }

      // 1. Find accounts sharing identifiers with this account
      const identifierClusters = await crossReferenceService.buildIdentifierClusters(
        clientId || undefined,
        userId || undefined,
        90, // daysBack
        2   // minSharedIdentifiers
      );

      // Find clusters that include this account
      const accountIdentifiers = await db
        .select({
          identifier: extractedIdentifiers.identifier,
          normalizedIdentifier: extractedIdentifiers.normalizedIdentifier,
          identifierType: extractedIdentifiers.identifierType
        })
        .from(extractedIdentifiers)
        .where(eq(extractedIdentifiers.suspiciousAccountId, id));

      const accountIdentifierSet = new Set(
        accountIdentifiers.map(i => `${i.normalizedIdentifier}-${i.identifierType}`)
      );

      // Find clusters containing this account's identifiers
      const relevantClusters = identifierClusters.clusters.filter(cluster =>
        cluster.identifiers.some(identifier =>
          accountIdentifierSet.has(`${identifier.normalizedValue}-${identifier.type}`)
        )
      );

      if (relevantClusters.length === 0) {
        res.json({
          success: true,
          data: null // No bot network detected
        });
        return;
      }

      // Get the largest/most relevant cluster
      const mainCluster = relevantClusters.sort((a, b) => b.accountCount - a.accountCount)[0];

      // 2. Get all suspicious accounts in this cluster
      const clusterIdentifiers = mainCluster.identifiers.map(i => i.normalizedValue);
      
      // Ensure we have identifiers to search for
      if (clusterIdentifiers.length === 0) {
        res.json({
          success: true,
          data: null // No bot network detected
        });
        return;
      }
      
      const connectedAccounts = await db
        .select({
          accountId: suspiciousAccounts.id,
          username: suspiciousAccounts.commenterUsername,
          commenterId: suspiciousAccounts.commenterId
        })
        .from(suspiciousAccounts)
        .innerJoin(extractedIdentifiers, eq(extractedIdentifiers.suspiciousAccountId, suspiciousAccounts.id))
        .innerJoin(instagramAccounts, eq(suspiciousAccounts.instagramAccountId, instagramAccounts.id))
        .where(
          and(
            inArray(suspiciousAccounts.instagramAccountId, accountIds),
            inArray(extractedIdentifiers.normalizedIdentifier, clusterIdentifiers),
            ne(suspiciousAccounts.id, id) // Exclude the current account
          )
        )
        .groupBy(suspiciousAccounts.id, suspiciousAccounts.commenterUsername, suspiciousAccounts.commenterId);

      // 3. For each connected account, find shared identifiers
      const members: BotNetworkMember[] = [];
      for (const connectedAccount of connectedAccounts) {
        const sharedIds = await db
          .select({
            identifier: extractedIdentifiers.identifier,
            identifierType: extractedIdentifiers.identifierType
          })
          .from(extractedIdentifiers)
          .where(
            and(
              eq(extractedIdentifiers.suspiciousAccountId, connectedAccount.accountId),
              inArray(extractedIdentifiers.normalizedIdentifier, clusterIdentifiers)
            )
          )
          .groupBy(extractedIdentifiers.identifier, extractedIdentifiers.identifierType);

        const sharedCount = sharedIds.length;
        let connectionStrength: 'STRONG' | 'MODERATE' | 'WEAK' = 'WEAK';
        if (sharedCount >= 3) connectionStrength = 'STRONG';
        else if (sharedCount >= 2) connectionStrength = 'MODERATE';

        members.push({
          accountId: connectedAccount.accountId,
          username: connectedAccount.username,
          sharedIdentifiers: sharedIds.map(id => ({
            type: id.identifierType as IdentifierType,
            value: id.identifier
          })),
          connectionStrength
        });
      }

      // 4. Check for coordinated timing
      const coordinatedTiming = await patternAnalysisService.findCoordinatedTiming(
        clientId || undefined,
        userId || undefined,
        5, // 5 minute window
        3, // min 3 accounts
        7  // last 7 days
      );

      const timingMatch = coordinatedTiming.find(timing =>
        timing.accounts.some(acc => acc.id === account.commenterId)
      );

      // 5. Build evidence list
      const evidence: string[] = [];
      if (mainCluster.accountCount >= 3) {
        evidence.push(`${mainCluster.accountCount} accounts share ${mainCluster.identifiers.length} identifiers`);
      }
      if (mainCluster.paymentMethods.length > 0) {
        evidence.push(`Shared payment methods: ${mainCluster.paymentMethods.join(', ')}`);
      }
      if (timingMatch) {
        evidence.push(`Coordinated timing detected: ${timingMatch.accountCount} accounts commented within ${timingMatch.timeWindow}`);
      }
      if (mainCluster.riskScore >= 70) {
        evidence.push(`High risk cluster score: ${mainCluster.riskScore}`);
      }

      // 6. Determine confidence and risk level
      let confidence: 'CONFIRMED' | 'HIGHLY_LIKELY' | 'SUSPECTED' = 'SUSPECTED';
      if (mainCluster.accountCount >= 5 && mainCluster.identifiers.length >= 3 && timingMatch) {
        confidence = 'CONFIRMED';
      } else if (mainCluster.accountCount >= 3 && mainCluster.identifiers.length >= 2) {
        confidence = 'HIGHLY_LIKELY';
      }

      let riskLevel: ThreatLevel = ThreatLevel.MEDIUM;
      if (mainCluster.riskScore >= 80 || mainCluster.accountCount >= 5) {
        riskLevel = ThreatLevel.CRITICAL;
      } else if (mainCluster.riskScore >= 60 || mainCluster.accountCount >= 3) {
        riskLevel = ThreatLevel.HIGH;
      }

      const detection: BotNetworkDetection = {
        networkId: `network_${id}_${Date.now()}`,
        confidence,
        memberCount: members.length + 1, // +1 for the current account
        members,
        sharedIdentifiers: mainCluster.identifiers.map(i => ({
          type: i.type,
          value: i.value,
          accountCount: i.accounts.length
        })),
        coordinatedTiming: timingMatch ? {
          timeWindow: timingMatch.timeWindow,
          accountCount: timingMatch.accountCount
        } : undefined,
        riskLevel,
        evidence
      };

      res.json({
        success: true,
        data: detection
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('Detect bot network error:', errorMessage);
      console.error('Stack trace:', errorStack);
      res.status(500).json({
        success: false,
        error: 'Failed to detect bot network',
        details: process.env.NODE_ENV === 'development' ? { message: errorMessage } : undefined
      });
    }
  }

  /**
   * Get all detected bot networks for the user
   */
  async getAllBotNetworks(
    req: AuthRequest,
    res: Response<ApiResponse<BotNetworkDetection[]>>
  ): Promise<void> {
    try {
      const userId = req.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get clientId if user is an agency managing clients
      let clientId: string | undefined;
      if (isAgency(req.accountType)) {
        // For agencies, we need to get clientId from the request or query
        // For now, we'll check all accounts the agency manages
        clientId = undefined; // Will query all clients managed by this agency
      }

      // Get all identifier clusters
      const clusters = await crossReferenceService.buildIdentifierClusters(
        clientId || undefined,
        userId || undefined,
        90,
        2
      );

      // Filter to only high-risk clusters (potential bot networks)
      const botNetworks: BotNetworkDetection[] = [];

      for (const cluster of clusters.clusters) {
        if (cluster.accountCount >= 3 && cluster.riskScore >= 50) {
          // Get accounts in this cluster
          const clusterIdentifiers = cluster.identifiers.map(i => i.normalizedValue);
          
          // Skip if no identifiers
          if (clusterIdentifiers.length === 0) continue;
          
          const accounts = await db
            .select({
              accountId: suspiciousAccounts.id,
              username: suspiciousAccounts.commenterUsername
            })
            .from(suspiciousAccounts)
            .innerJoin(extractedIdentifiers, eq(extractedIdentifiers.suspiciousAccountId, suspiciousAccounts.id))
            .innerJoin(instagramAccounts, eq(suspiciousAccounts.instagramAccountId, instagramAccounts.id))
            .where(
              and(
                clientId ? eq(instagramAccounts.clientId, clientId) : undefined,
                userId ? eq(instagramAccounts.userId, userId) : undefined,
                inArray(extractedIdentifiers.normalizedIdentifier, clusterIdentifiers)
              )
            )
            .groupBy(suspiciousAccounts.id, suspiciousAccounts.commenterUsername)
            .limit(20); // Limit to prevent huge responses

          if (accounts.length >= 3) {
            const members: BotNetworkMember[] = accounts.map(acc => ({
              accountId: acc.accountId,
              username: acc.username,
              sharedIdentifiers: cluster.identifiers.map(i => ({
                type: i.type,
                value: i.value
              })),
              connectionStrength: cluster.identifiers.length >= 3 ? 'STRONG' : 'MODERATE'
            }));

            let confidence: 'CONFIRMED' | 'HIGHLY_LIKELY' | 'SUSPECTED' = 'SUSPECTED';
            if (cluster.accountCount >= 5 && cluster.identifiers.length >= 3) {
              confidence = 'CONFIRMED';
            } else if (cluster.accountCount >= 3 && cluster.identifiers.length >= 2) {
              confidence = 'HIGHLY_LIKELY';
            }

            let riskLevel: ThreatLevel = ThreatLevel.MEDIUM;
            if (cluster.riskScore >= 80 || cluster.accountCount >= 5) {
              riskLevel = ThreatLevel.CRITICAL;
            } else if (cluster.riskScore >= 60 || cluster.accountCount >= 3) {
              riskLevel = ThreatLevel.HIGH;
            }

            botNetworks.push({
              networkId: `network_${cluster.clusterId}`,
              confidence,
              memberCount: accounts.length,
              members,
              sharedIdentifiers: cluster.identifiers.map(i => ({
                type: i.type,
                value: i.value,
                accountCount: i.accounts.length
              })),
              riskLevel,
              evidence: [
                `${cluster.accountCount} accounts share ${cluster.identifiers.length} identifiers`,
                cluster.paymentMethods.length > 0 ? `Payment methods: ${cluster.paymentMethods.join(', ')}` : undefined,
                `Risk score: ${cluster.riskScore}`
              ].filter(Boolean) as string[]
            });
          }
        }
      }

      res.json({
        success: true,
        data: botNetworks
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get all bot networks error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch bot networks' });
    }
  }

  /**
   * Get mastermind connections for a suspicious account
   */
  async getMastermindConnections(req: DelegationRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { userId, clientId } = getEffectiveOwner(req);

      if (!id) {
        res.status(400).json({ success: false, error: 'Account ID is required' });
        return;
      }

      const connections = await mastermindConnectionService.getConnectionsForAccount(
        id,
        clientId,
        userId
      );

      res.json({
        success: true,
        data: {
          connections: connections.map(conn => ({
            connectionId: conn.connectionId,
            mastermindId: conn.mastermindId,
            mastermindName: conn.mastermindName,
            threatLevel: conn.threatLevel,
            networkType: conn.networkType,
            confidence: conn.confidence,
            connectedAt: conn.connectedAt.toISOString(),
            connectionEvidence: conn.connectionEvidence,
            mentionsByConnectedAccounts: conn.mentionsByConnectedAccounts.map(mention => ({
              mentioningAccountId: mention.mentioningAccountId,
              mentioningAccountUsername: mention.mentioningAccountUsername,
              mentionCount: mention.mentionCount,
              mentionedIdentifier: mention.mentionedIdentifier,
              mentionType: mention.mentionType,
              sampleComments: mention.sampleComments.map(comment => ({
                commentId: comment.commentId,
                commentText: comment.commentText,
                commentedAt: comment.commentedAt.toISOString()
              }))
            })),
            networkAccounts: conn.networkAccounts
          }))
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get mastermind connections error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch mastermind connections' });
    }
  }

  /**
   * Create a mastermind connection for a suspicious account
   */
  async createMastermindConnection(req: DelegationRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { userId, clientId } = getEffectiveOwner(req);
      const {
        mastermindId,
        mastermindName,
        knownIdentifiers,
        evidenceDescription,
        confidence,
        connectionEvidence,
        evidenceAttachments
      } = req.body;

      if (!id) {
        res.status(400).json({ success: false, error: 'Account ID is required' });
        return;
      }

      if (!mastermindId && !mastermindName) {
        res.status(400).json({ success: false, error: 'Either mastermindId or mastermindName is required' });
        return;
      }

      if (!evidenceDescription || !confidence || !connectionEvidence) {
        res.status(400).json({ success: false, error: 'evidenceDescription, confidence, and connectionEvidence are required' });
        return;
      }

      const result = await mastermindConnectionService.createConnection({
        suspiciousAccountId: id,
        mastermindId,
        mastermindName,
        knownIdentifiers,
        evidenceDescription,
        confidence,
        connectionEvidence,
        evidenceAttachments,
        clientId,
        userId,
        detectedBy: 'MANUAL_INVESTIGATION'
      });

      res.json({
        success: true,
        data: result
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Create mastermind connection error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to create mastermind connection' });
    }
  }

  /**
   * Get mentions by connected accounts
   */
  async getMentionsByConnected(req: DelegationRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { userId, clientId } = getEffectiveOwner(req);

      if (!id) {
        res.status(400).json({ success: false, error: 'Account ID is required' });
        return;
      }

      const mentions = await mastermindConnectionService.findMentionsByConnectedAccounts(
        id,
        clientId,
        userId
      );

      res.json({
        success: true,
        data: {
          mentions: mentions.map(group => ({
            mastermindId: group.mastermindId,
            mastermindName: group.mastermindName,
            mentions: group.mentions.map(mention => ({
              mentioningAccountId: mention.mentioningAccountId,
              mentioningAccountUsername: mention.mentioningAccountUsername,
              mentionCount: mention.mentionCount,
              mentionedIdentifier: mention.mentionedIdentifier,
              mentionType: mention.mentionType,
              sampleComments: mention.sampleComments.map(comment => ({
                commentId: comment.commentId,
                commentText: comment.commentText,
                commentedAt: comment.commentedAt.toISOString()
              }))
            }))
          }))
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Get mentions by connected error:', errorMessage);
      res.status(500).json({ success: false, error: 'Failed to fetch mentions by connected accounts' });
    }
  }

  /**
   * Get all comments from a given commenter on an Instagram account's posts.
   * Matches by commenterId/commenterUsername with same normalization as moderation (case-insensitive, @-stripped).
   */
  private async getCommentsByCommenterForAccount(
    instagramAccountId: string,
    commenterId: string | null,
    commenterUsername: string | null,
    source: 'instagram' | 'facebook',
    options: { onlyNotHidden?: boolean; onlyNotDeleted?: boolean }
  ): Promise<Array<{ id: string; postId: string; igCommentId: string | null }>> {
    const rows = await db
      .select({
        id: comments.id,
        postId: comments.postId,
        igCommentId: comments.igCommentId,
        isHidden: comments.isHidden,
        isDeleted: comments.isDeleted,
        commenterId: comments.commenterId,
        commenterUsername: comments.commenterUsername
      })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(
        and(
          eq(posts.instagramAccountId, instagramAccountId),
          eq(comments.source, source)
        )
      );

    const normalize = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/^@/, '').trim();
    const saUsernameNorm = normalize(commenterUsername);
    const saIdNorm = normalize(commenterId);

    const matched = rows.filter((row) => {
      const un = normalize(row.commenterUsername);
      const uid = normalize(row.commenterId);
      const match =
        (saUsernameNorm && (un === saUsernameNorm || uid === saUsernameNorm)) ||
        (saIdNorm && (uid === saIdNorm || un === saIdNorm));
      if (!match) return false;
      if (options.onlyNotHidden && row.isHidden) return false;
      if (options.onlyNotDeleted && row.isDeleted) return false;
      return true;
    });

    return matched.map((r) => ({ id: r.id, postId: r.postId, igCommentId: r.igCommentId }));
  }
}

export const suspiciousAccountsController = new SuspiciousAccountsController();
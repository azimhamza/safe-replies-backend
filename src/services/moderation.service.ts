import { db } from '../db';
import { comments, moderationLogs, evidenceRecords, customFilters, extractedIdentifiers, suspiciousAccounts, moderationSettings, CustomFilter, botNetworkMasterminds, botNetworkConnections, mastermindMentions, instagramAccounts, clients } from '../db/schema';
import { llmService } from './llm.service';
import { riskScoringService } from './riskScoring.service';
import { whitelistService } from './whitelist.service';
import { suspiciousAccountService } from './suspiciousAccount.service';
import { instagramService } from './instagram.service';
import { facebookService } from './facebook.service';
import { watchlistService } from './watchlist.service';
import { mastermindConnectionService } from './mastermindConnection.service';
import { commentReviewService } from './commentReview.service';
import { embeddingsService } from './embeddings.service';
import {
  ModerationResult,
  ActionTaken,
  CommentCategory,
  LLMClassificationResult,
  ModerationSettingsResult,
  LLMClassificationInput,
  EmbeddingSimilarityContext,
  EmbeddingAutoActionMatch,
  SuspiciousAccountMatch,
  WatchlistCheckResult
} from '../types';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { autumn, resolveBillingCustomerId, checkFeatureAllowed } from './autumn.service';

interface ModerateCommentInput {
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterUsername: string;
  instagramAccountId?: string;
  facebookPageId?: string;
  postId: string;
  igCommentId?: string;
  fbCommentId?: string;
  accessToken: string;
  clientId?: string;
  userId?: string;
}

export class ModerationService {
  private testMode: boolean = false;

  /**
   * Enable/disable test mode (skips actual API calls)
   */
  setTestMode(enabled: boolean): void {
    this.testMode = enabled;
  }

  /**
   * Main moderation pipeline — parallelized, confidence-aware, embedding-first.
   *
   * Phase 1 (parallel): whitelist, owner, suspicious account, watchlist,
   *                       custom filters, embeddings, moderation settings
   * Phase 2 (sequential): evaluate early-exits from Phase 1 results
   * Phase 3: LLM classification (using custom filters + embedding context)
   * Phase 4: post-LLM decisions (risk score, thresholds, actions)
   */
  async moderateComment(input: ModerateCommentInput): Promise<ModerationResult> {
    const startTime = Date.now();

    try {
      // Gate: check comments_moderated limit before running the pipeline
      const { allowed } = await checkFeatureAllowed({
        userId: input.userId,
        clientId: input.clientId,
        featureId: "comments_moderated",
      });
      if (!allowed) {
        console.warn(`[MODERATION] Skipping — comments_moderated limit reached for userId=${input.userId} clientId=${input.clientId}`);
        return {
          action: ActionTaken.BENIGN,
          reason: 'BILLING_LIMIT_REACHED',
          llmClassification: {
            category: CommentCategory.BENIGN,
            severity: 0,
            confidence: 0,
            rationale: 'Moderation skipped: comment moderation limit reached',
            extractedIdentifiers: [],
          },
          riskScore: 0,
        };
      }

      // ── PHASE 1: Parallel pre-LLM checks ──────────────────────────────
      const [
        isCommenterWhitelisted,
        isPostOwner,
        suspiciousAccount,
        watchlistCheck,
        userCustomFilters,
        embeddingResult,
        settings
      ] = await Promise.all([
        this.checkWhitelist(input),
        this.checkPostOwner(input),
        this.findSuspiciousAccount(input),
        this.checkWatchlist(input),
        this.loadCustomFilters(input),
        this.loadEmbeddingAndSimilarity(input),
        this.getModerationSettings(input.clientId, input.userId, input.instagramAccountId)
      ]);

      const { embeddingSimilarityContext, autoActionMatch } = embeddingResult;

      // ── PHASE 2: Evaluate early-exit conditions (order = priority) ─────

      // 2a: Whitelisted commenter → bypass all
      if (isCommenterWhitelisted) {
        return this.earlyReturn(input, 'COMMENTER_WHITELISTED', CommentCategory.BENIGN,
          'Commenter is whitelisted - moderation bypassed');
      }

      // 2b: Post owner → don't moderate own comments
      if (isPostOwner) {
        return this.earlyReturn(input, 'POST_OWNER', CommentCategory.BENIGN,
          'Commenter is the post owner (own account) – not moderated');
      }

      // 2c: Auto-delete for known suspicious accounts
      const autoDeleteEnabled = suspiciousAccount?.autoDeleteEnabled === true;
      if (autoDeleteEnabled) {
        console.log(`🔧 Suspicious account auto-delete: ${suspiciousAccount?.commenterUsername ?? input.commenterUsername} (commenterId: ${input.commenterId})`);
        await this.executeDelete(input);
        await this.logModeration(input, {
          category: CommentCategory.BENIGN,
          severity: 100,
          confidence: 1.0,
          rationale: 'Auto-deleted: Commenter has auto-delete enabled',
          extractedIdentifiers: []
        }, 100, ActionTaken.DELETED);
        return {
          action: ActionTaken.DELETED,
          reason: 'AUTO_DELETE_ENABLED',
          llmClassification: {
            category: CommentCategory.BENIGN,
            severity: 100,
            confidence: 1.0,
            rationale: 'Auto-deleted: Commenter has auto-delete enabled',
            extractedIdentifiers: []
          },
          riskScore: 100
        };
      }

      const autoHideEnabled = suspiciousAccount?.autoHideEnabled ?? false;

      // 2d: High-confidence embedding auto-action (similarity ≥ configurable threshold)
      // When similarity is very high, skip the expensive LLM call entirely
      const simThreshold = (settings.similarityThreshold ?? 85) / 100;
      const similarityAutoModEnabled = settings.similarityAutoModEnabled !== false;

      if (similarityAutoModEnabled && autoActionMatch) {
        const matchSimilarity = autoActionMatch.match.similarity;
        if (matchSimilarity >= simThreshold) {
          if (autoActionMatch.action === 'AUTO_DELETE_SIMILAR') {
            await this.executeDelete(input);
            const classification: LLMClassificationResult = {
              category: CommentCategory.BENIGN,
              severity: 80,
              confidence: matchSimilarity,
              rationale: `Auto-deleted: ${Math.round(matchSimilarity * 100)}% similarity to reviewed pattern (threshold ${Math.round(simThreshold * 100)}%). LLM skipped.`,
              extractedIdentifiers: []
            };
            await this.logModeration(input, classification, 80, ActionTaken.DELETED);
            return {
              action: ActionTaken.DELETED,
              reason: 'AUTO_DELETE_SIMILAR_HIGH_CONFIDENCE',
              llmClassification: classification,
              riskScore: 80
            };
          } else if (autoActionMatch.action === 'AUTO_HIDE_SIMILAR') {
            await this.executeHide(input);
            const classification: LLMClassificationResult = {
              category: CommentCategory.BENIGN,
              severity: 65,
              confidence: matchSimilarity,
              rationale: `Auto-hidden: ${Math.round(matchSimilarity * 100)}% similarity to reviewed pattern (threshold ${Math.round(simThreshold * 100)}%). LLM skipped.`,
              extractedIdentifiers: []
            };
            await this.logModeration(input, classification, 65, ActionTaken.FLAGGED);
            return {
              action: ActionTaken.FLAGGED,
              reason: 'AUTO_HIDE_SIMILAR_HIGH_CONFIDENCE',
              llmClassification: classification,
              riskScore: 65
            };
          }
        }
      }

      // ── PHASE 3: Pattern detection + LLM classification ────────────────

      // 3a: Regex-based pattern detection (cheap, runs in-process)
      const patternResult = this.detectPatterns(input.commentText);

      // 3b: LLM classification
      let llmResult = await llmService.classifyComment(
        input.commentText,
        userCustomFilters,
        0,
        embeddingSimilarityContext
      );

      // 3c: Two-tier re-evaluation when pattern detection disagrees with LLM
      llmResult = await this.reEvaluateIfNeeded(llmResult, patternResult, input.commentText);

      // 3d: Validate LLM category
      llmResult = await this.validateLLMCategory(llmResult, input, userCustomFilters);

      // ── PHASE 4: Post-LLM decisions ───────────────────────────────────

      // 4a: Watchlist auto-delete (use LLM category for proper classification)
      if (watchlistCheck.shouldAutoDelete) {
        for (const match of watchlistCheck.matches) {
          await watchlistService.recordDetection(
            match.threatId, input.commentId, input.commenterUsername,
            input.commenterId, input.commentText, 'DIRECT_COMMENT'
          );
        }
        await this.executeDelete(input);
        const combinedRationale = `Auto-deleted: Commenter matches watchlist entry (${watchlistCheck.matches.map(m => m.name).join(', ')}). ${llmResult.rationale}`;
        const watchlistClassification: LLMClassificationResult = {
          category: llmResult.category,
          severity: Math.max(llmResult.severity, 100),
          confidence: Math.max(llmResult.confidence, 0.95),
          rationale: combinedRationale,
          extractedIdentifiers: llmResult.extractedIdentifiers
        };
        await this.logModeration(input, watchlistClassification, 100, ActionTaken.DELETED);
        return {
          action: ActionTaken.DELETED,
          reason: 'WATCHLIST_MATCH',
          llmClassification: watchlistClassification,
          riskScore: 100
        };
      }

      // 4b: Whitelist identifier check
      const isWhitelisted = await whitelistService.check(
        llmResult.extractedIdentifiers, input.clientId, input.userId
      );
      if (isWhitelisted) {
        await this.logModeration(input, llmResult, 0, ActionTaken.BENIGN);
        return { action: ActionTaken.BENIGN, llmClassification: llmResult, reason: 'WHITELISTED' };
      }

      // 4c: Check for watchlist mentions in comment text
      const mentionCheck = await watchlistService.checkCommentForMentions(
        input.commentText, input.clientId, input.userId
      );
      if (mentionCheck.shouldAutoDelete) {
        for (const match of mentionCheck.matches) {
          await watchlistService.recordDetection(
            match.threatId, input.commentId, input.commenterUsername,
            input.commenterId, input.commentText, 'USERNAME_MENTION', match.name
          );
        }
        await this.logModeration(input, {
          ...llmResult,
          rationale: `Auto-deleted: Comment mentions watchlist account(s): ${mentionCheck.matches.map(m => m.name).join(', ')}`
        }, 100, ActionTaken.DELETED);
        await this.executeDelete(input);
        return { action: ActionTaken.DELETED, llmClassification: llmResult, reason: 'WATCHLIST_MENTION' };
      }

      // 4d: Risk scoring
      let repeatOffenderCount = 0;
      if (input.instagramAccountId) {
        repeatOffenderCount = await suspiciousAccountService.getRepeatOffenderCount(
          input.instagramAccountId, input.commenterId
        );
      }

      const riskResult = riskScoringService.calculateRiskScore({
        severity: llmResult.severity,
        confidence: llmResult.confidence,
        repeatOffenderCount,
        commentVelocity: 0,
        accountAgeDays: 0
      });

      // 4e: Custom filter auto-actions (MUST run BEFORE confidence thresholds)
      // User-defined custom filters override general confidence-based rules
      const customFilterAction = await this.evaluateCustomFilters(
        input, llmResult, userCustomFilters, riskResult.riskScore
      );
      if (customFilterAction) {
        await this.postModerationTracking(input, llmResult, customFilterAction.riskScore ?? riskResult.riskScore, customFilterAction.action);
        return customFilterAction;
      }

      // 4f: ──── Confidence-based thresholds ────
      // These act as a fast-path for high-confidence classifications.
      // If LLM confidence is very high (>= configurable %), auto-delete or auto-hide.
      const confDeletePct = (settings.confidenceDeleteThreshold ?? 90) / 100;
      const confHidePct = (settings.confidenceHideThreshold ?? 70) / 100;

      if (
        llmResult.category !== CommentCategory.BENIGN &&
        llmResult.confidence >= confDeletePct
      ) {
        await this.executeDelete(input);
        llmResult.rationale = `[CONFIDENCE AUTO-DELETE] LLM confidence ${Math.round(llmResult.confidence * 100)}% >= ${Math.round(confDeletePct * 100)}% threshold. ${llmResult.rationale}`;
        await this.logModeration(input, llmResult, riskResult.riskScore, ActionTaken.DELETED);
        await this.postModerationTracking(input, llmResult, riskResult.riskScore, ActionTaken.DELETED);
        return {
          action: ActionTaken.DELETED,
          reason: 'CONFIDENCE_AUTO_DELETE',
          identifiers: llmResult.extractedIdentifiers,
          llmClassification: llmResult,
          riskScore: riskResult.riskScore
        };
      }

      if (
        llmResult.category !== CommentCategory.BENIGN &&
        llmResult.confidence >= confHidePct &&
        llmResult.confidence < confDeletePct
      ) {
        await this.executeHide(input);
        llmResult.rationale = `[CONFIDENCE AUTO-HIDE] LLM confidence ${Math.round(llmResult.confidence * 100)}% >= ${Math.round(confHidePct * 100)}% threshold. ${llmResult.rationale}`;
        await this.logModeration(input, llmResult, riskResult.riskScore, ActionTaken.FLAGGED);
        await this.postModerationTracking(input, llmResult, riskResult.riskScore, ActionTaken.FLAGGED);
        return {
          action: ActionTaken.FLAGGED,
          reason: 'CONFIDENCE_AUTO_HIDE',
          identifiers: llmResult.extractedIdentifiers,
          llmClassification: llmResult,
          riskScore: riskResult.riskScore
        };
      }

      // 4g: Embedding auto-actions (lower-confidence matches that didn't early-exit)
      if (autoActionMatch) {
        if (autoActionMatch.action === 'AUTO_DELETE_SIMILAR') {
          await this.executeDelete(input);
          llmResult.rationale = `Auto-deleted based on similarity to reviewed pattern (${Math.round(autoActionMatch.match.similarity * 100)}% similarity). ${llmResult.rationale}`;
          await this.logModeration(input, llmResult, riskResult.riskScore, ActionTaken.DELETED);
          await this.postModerationTracking(input, llmResult, riskResult.riskScore, ActionTaken.DELETED);
          return {
            action: ActionTaken.DELETED,
            reason: 'AUTO_DELETE_SIMILAR_MATCH',
            llmClassification: llmResult,
            riskScore: riskResult.riskScore
          };
        } else if (autoActionMatch.action === 'AUTO_HIDE_SIMILAR') {
          await this.executeHide(input);
          llmResult.rationale = `Auto-hidden based on similarity to reviewed pattern (${Math.round(autoActionMatch.match.similarity * 100)}% similarity). ${llmResult.rationale}`;
          await this.logModeration(input, llmResult, riskResult.riskScore, ActionTaken.FLAGGED);
          await this.postModerationTracking(input, llmResult, riskResult.riskScore, ActionTaken.FLAGGED);
          return {
            action: ActionTaken.FLAGGED,
            reason: 'AUTO_HIDE_SIMILAR_MATCH',
            llmClassification: llmResult,
            riskScore: riskResult.riskScore
          };
        }
      }

      // 4h: Embedding allowed-similar + LLM benign agreement
      if (embeddingSimilarityContext?.isSimilarToAllowed && llmResult.category === CommentCategory.BENIGN) {
        llmResult.rationale = `Similar to allowed pattern (${Math.round((embeddingSimilarityContext.similarityScore ?? 0) * 100)}% similarity) and validated independently as benign. ${llmResult.rationale}`;
        await this.logModeration(input, llmResult, 0, ActionTaken.BENIGN);
        return {
          action: ActionTaken.BENIGN,
          reason: 'ALLOWED_SIMILAR_CONFIRMED',
          llmClassification: llmResult,
          riskScore: 0
        };
      } else if (embeddingSimilarityContext?.isSimilarToAllowed && llmResult.category !== CommentCategory.BENIGN) {
        llmResult.rationale = `Similar to allowed pattern (${Math.round((embeddingSimilarityContext.similarityScore ?? 0) * 100)}% similarity) but validated independently as ${llmResult.category}. Embeddings false positive. ${llmResult.rationale}`;
        console.warn(`⚠️  Embeddings suggested allowing but LLM flagged as ${llmResult.category}. Trusting LLM.`);
      }

      // 4i: Category-specific thresholds (existing risk-score-based system)
      const categoryThreshold = riskScoringService.getCategoryThreshold(llmResult.category, settings);
      const categoryAutoDeleteEnabled = riskScoringService.isCategoryAutoDeleteEnabled(llmResult.category, settings);
      const categoryFlagHideEnabled = riskScoringService.isCategoryFlagHideEnabled(llmResult.category, settings);
      const categoryFlagDeleteEnabled = riskScoringService.isCategoryFlagDeleteEnabled(llmResult.category, settings);
      const categoryFlagHideThreshold = riskScoringService.getCategoryFlagHideThreshold(llmResult.category, settings);
      const categoryFlagDeleteThreshold = riskScoringService.getCategoryFlagDeleteThreshold(llmResult.category, settings);

      let action: ActionTaken;

      if (autoHideEnabled) {
        console.log(`🔧 Suspicious account auto-hide: ${suspiciousAccount?.commenterUsername ?? input.commenterUsername}`);
        await this.executeHide(input);
        action = ActionTaken.FLAGGED;
        llmResult.rationale = `Auto-hidden: Commenter has auto-hide enabled. ${llmResult.rationale}`;
      } else if (categoryAutoDeleteEnabled && riskResult.riskScore >= categoryThreshold) {
        await this.executeDelete(input);
        action = ActionTaken.DELETED;
      } else if (categoryFlagDeleteEnabled && riskResult.riskScore >= categoryFlagDeleteThreshold) {
        await this.executeDelete(input);
        action = ActionTaken.DELETED;
      } else if (categoryFlagHideEnabled && riskResult.riskScore >= categoryFlagHideThreshold) {
        await this.executeHide(input);
        action = ActionTaken.FLAGGED;
      } else if (llmResult.category !== CommentCategory.BENIGN && riskResult.riskScore >= 50) {
        action = ActionTaken.FLAGGED;
      } else {
        action = ActionTaken.BENIGN;
      }

      // ── PHASE 5: Logging + post-moderation tracking ────────────────────
      await this.logModeration(input, llmResult, riskResult.riskScore, action);
      await this.postModerationTracking(input, llmResult, riskResult.riskScore, action);

      const processingTime = Date.now() - startTime;
      console.log(`Moderation completed in ${processingTime}ms: ${action}`);

      return {
        action,
        identifiers: llmResult.extractedIdentifiers,
        llmClassification: llmResult,
        riskScore: riskResult.riskScore
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      console.error('Moderation failed:', errorMessage);
      if (errorStack) console.error('Error stack:', errorStack);

      console.error('Moderation input:', {
        commentId: input.commentId,
        commentText: input.commentText?.substring(0, 50),
        commenterId: input.commenterId,
        commenterUsername: input.commenterUsername,
        instagramAccountId: input.instagramAccountId,
        facebookPageId: input.facebookPageId,
        userId: input.userId,
        clientId: input.clientId
      });

      try {
        await this.logModeration(input, {
          category: CommentCategory.BENIGN,
          severity: 0,
          confidence: 0,
          rationale: `Moderation system error - flagged for manual review. Error: ${errorMessage}`,
          extractedIdentifiers: []
        }, 0, ActionTaken.FLAGGED);
      } catch (logError) {
        console.error('Failed to log moderation error:', logError);
      }

      return {
        action: ActionTaken.FLAGGED,
        reason: 'SYSTEM_ERROR',
        llmClassification: {
          category: CommentCategory.BENIGN,
          severity: 0,
          confidence: 0,
          rationale: `Moderation system error: ${errorMessage}`,
          extractedIdentifiers: []
        }
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 1 helpers — run in parallel
  // ═══════════════════════════════════════════════════════════════════════

  private async checkWhitelist(input: ModerateCommentInput): Promise<boolean> {
    return whitelistService.checkCommenter(
      input.commenterId, input.commenterUsername,
      input.instagramAccountId, input.clientId, input.userId
    );
  }

  private async checkPostOwner(input: ModerateCommentInput): Promise<boolean> {
    if (input.instagramAccountId) {
      const postOwnerAccount = await db.query.instagramAccounts.findFirst({
        where: eq(instagramAccounts.id, input.instagramAccountId),
        columns: { username: true, instagramId: true }
      });
      if (postOwnerAccount) {
        const commenterUserNorm = (input.commenterUsername || '').replace(/^@/, '').trim().toLowerCase();
        const ownerUserNorm = (postOwnerAccount.username || '').replace(/^@/, '').trim().toLowerCase();
        return commenterUserNorm === ownerUserNorm ||
          (!!input.commenterId && input.commenterId === postOwnerAccount.instagramId);
      }
    }
    return false;
  }

  private async findSuspiciousAccount(input: ModerateCommentInput): Promise<SuspiciousAccountMatch | null> {
    if (!input.instagramAccountId) return null;

    const normalizeUsername = (s: string | null | undefined): string =>
      (s ?? '').toLowerCase().replace(/^@/, '').trim();
    const inputUsernameNorm = normalizeUsername(input.commenterUsername);
    const inputIdNorm = normalizeUsername(input.commenterId);

    // Try exact matches first (fastest)
    let account = await db.query.suspiciousAccounts.findFirst({
      where: and(
        eq(suspiciousAccounts.instagramAccountId, input.instagramAccountId),
        eq(suspiciousAccounts.commenterId, input.commenterId)
      )
    }) as SuspiciousAccountMatch | undefined;

    if (!account && input.commenterUsername) {
      account = await db.query.suspiciousAccounts.findFirst({
        where: and(
          eq(suspiciousAccounts.instagramAccountId, input.instagramAccountId),
          eq(suspiciousAccounts.commenterUsername, input.commenterUsername)
        )
      }) as SuspiciousAccountMatch | undefined;
    }

    if (!account && input.commenterUsername) {
      const altUsername = input.commenterUsername.startsWith('@')
        ? input.commenterUsername.slice(1)
        : `@${input.commenterUsername}`;
      account = await db.query.suspiciousAccounts.findFirst({
        where: and(
          eq(suspiciousAccounts.instagramAccountId, input.instagramAccountId),
          eq(suspiciousAccounts.commenterUsername, altUsername)
        )
      }) as SuspiciousAccountMatch | undefined;
    }

    // Case-insensitive fallback
    if (!account && (inputUsernameNorm || inputIdNorm)) {
      const candidates = await db.query.suspiciousAccounts.findMany({
        where: eq(suspiciousAccounts.instagramAccountId, input.instagramAccountId)
      });
      const found = candidates.find((sa) => {
        const saUsernameNorm = normalizeUsername(sa.commenterUsername);
        const saIdNorm = normalizeUsername(sa.commenterId);
        return (
          (inputUsernameNorm && (saUsernameNorm === inputUsernameNorm || saIdNorm === inputUsernameNorm)) ||
          (inputIdNorm && (saIdNorm === inputIdNorm || saUsernameNorm === inputIdNorm))
        );
      });
      account = found ? found as SuspiciousAccountMatch : undefined;
    }

    return account ?? null;
  }

  private async checkWatchlist(input: ModerateCommentInput): Promise<WatchlistCheckResult> {
    return watchlistService.checkCommenterForAutoDelete(
      input.commenterUsername, input.commenterId, input.clientId, input.userId
    );
  }

  private async loadCustomFilters(input: ModerateCommentInput): Promise<CustomFilter[]> {
    const ownershipCondition = (() => {
      if (input.clientId && input.userId) {
        return or(eq(customFilters.clientId, input.clientId), eq(customFilters.userId, input.userId));
      }
      if (input.clientId) return eq(customFilters.clientId, input.clientId);
      if (input.userId) return eq(customFilters.userId, input.userId);
      return undefined;
    })();

    if (!ownershipCondition) {
      console.warn('⚠️ No userId or clientId for moderation – custom filters will not be applied.');
      return [];
    }

    try {
      const accountConditions = [
        isNull(customFilters.instagramAccountId)
      ];
      if (input.instagramAccountId) {
        accountConditions.push(eq(customFilters.instagramAccountId, input.instagramAccountId));
      }

      const filters = await db
        .select()
        .from(customFilters)
        .where(
          and(
            ownershipCondition,
            eq(customFilters.isEnabled, true),
            or(...accountConditions)
          )
        );
      if (filters.length > 0) {
        const withActions = filters.filter(f => f.autoHide || f.autoDelete || f.autoFlag);
        if (withActions.length > 0) {
          console.log(`📋 Loaded ${filters.length} custom filter(s), ${withActions.length} with auto-actions`);
        }
      }
      return filters;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.warn('Account-specific filters not available, using global filters only:', errorMessage);
      return db
        .select()
        .from(customFilters)
        .where(and(ownershipCondition, eq(customFilters.isEnabled, true)));
    }
  }

  private async loadEmbeddingAndSimilarity(input: ModerateCommentInput): Promise<{
    embeddingSimilarityContext: EmbeddingSimilarityContext | undefined;
    autoActionMatch: EmbeddingAutoActionMatch | null;
    commentEmbedding: number[] | null;
  }> {
    let embeddingSimilarityContext: EmbeddingSimilarityContext | undefined;
    let autoActionMatch: EmbeddingAutoActionMatch | null = null;
    let commentEmbedding: number[] | null = null;

    try {
      const existingComment = await db.query.comments.findFirst({
        where: eq(comments.id, input.commentId)
      });

      if (existingComment?.embedding) {
        commentEmbedding = existingComment.embedding as number[];
      } else {
        const embeddings = await embeddingsService.generateJinaEmbeddings([input.commentText]);
        if (embeddings && embeddings.length > 0) {
          commentEmbedding = embeddings[0];
          await db
            .update(comments)
            .set({ embedding: commentEmbedding as unknown as number[] })
            .where(eq(comments.id, input.commentId));
        }
      }
    } catch (embeddingError) {
      console.error('Error generating embedding for comment:', embeddingError);
    }

    if (commentEmbedding) {
      const [allowedSimilar, autoAction] = await Promise.all([
        commentReviewService.checkAllowedSimilarComments(
          commentEmbedding, input.clientId, input.userId, 0.6
        ),
        commentReviewService.checkAutoActionSimilarComments(
          commentEmbedding, input.clientId, input.userId, 0.6
        )
      ]);

      if (allowedSimilar) {
        console.log(`✓ Comment similar to allowed pattern (${Math.round(allowedSimilar.similarity * 100)}% similarity)`);
        embeddingSimilarityContext = {
          isSimilarToAllowed: true,
          similarityScore: allowedSimilar.similarity,
          similarCommentText: allowedSimilar.commentText,
          similarCommentCategory: allowedSimilar.category
        };
      }

      if (autoAction) {
        console.log(`✓ Comment matches auto-action pattern: ${autoAction.action} (${Math.round(autoAction.match.similarity * 100)}% similarity)`);
        autoActionMatch = autoAction as EmbeddingAutoActionMatch;
      }
    }

    return { embeddingSimilarityContext, autoActionMatch, commentEmbedding };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pattern detection (in-process, no I/O)
  // ═══════════════════════════════════════════════════════════════════════

  private detectPatterns(commentText: string): { category: CommentCategory | null; details: string } {
    const commentLower = (commentText || '').toLowerCase();

    // Blackmail: payment + conditional threat
    const traditionalPayment = /(?:venmo|cashapp|paypal|zelle|pay\s+me|send\s+me|give\s+me|transfer|deposit|wire|money\s+order)/i;
    const cryptoPayment = /(?:bitcoin|btc|eth|ethereum|crypto|wallet|usdt|usdc|tether|stablecoin)/i;
    const addressPattern = /(?:bc1[a-z0-9]{25,}|1[a-km-zA-HJ-NP-Z1-9]{25,}|3[a-km-zA-HJ-NP-Z1-9]{25,}|0x[a-fA-F0-9]{40}|\$\w+|@\w+|[\w.-]+@[\w.-]+\.\w+)/i;
    const amountPattern = /(?:\$?\d+\.?\d*\s*(?:btc|eth|usd|dollar|dollars?|bucks?)|send\s+\d+|pay\s+\d+|give\s+\d+|transfer\s+\d+)/i;
    const hasPaymentRequest = traditionalPayment.test(commentLower) ||
      cryptoPayment.test(commentLower) ||
      (addressPattern.test(commentText) && amountPattern.test(commentLower)) ||
      amountPattern.test(commentLower);
    const conditionalConnectors = /\b(?:or|or\s+else|or\s+I'll|or\s+you'll|or\s+your|or\s+everyone|otherwise|if\s+not|unless)\b/i;
    const threatVerbs = /\b(?:expose|ruin|destroy|release|reveal|tell|harm|hurt|damage|wreck|sabotage|leak|publish|share|spread|broadcast)\b/i;
    const consequencePhrases = /\b(?:reputation|secrets|photos|videos|information|everyone\s+will\s+know|everyone\s+finds\s+out|I'll\s+tell|I'll\s+expose|you'll\s+regret|you'll\s+be\s+sorry|consequences|regret|sorry)\b/i;
    const hasThreat = conditionalConnectors.test(commentLower) &&
      (threatVerbs.test(commentLower) || consequencePhrases.test(commentLower));
    const implicitThreat = threatVerbs.test(commentLower) && consequencePhrases.test(commentLower);
    const hasBlackmailPattern = hasPaymentRequest && (hasThreat || implicitThreat);

    // Threat: harm intent without payment
    const harmIntent = /\b(?:kill|murder|die|death|hurt|harm|attack|beat|stab|shoot|violence|violent|threaten|threat|I'll\s+get\s+you|watch\s+your\s+back|coming\s+for\s+you|you'll\s+regret|you'll\s+pay|revenge)\b/i;
    const hasThreatPattern = (harmIntent.test(commentLower) || threatVerbs.test(commentLower)) && !hasPaymentRequest;

    // Harassment: targeted personal attacks
    const targetedAttack = /(?:@\w+|you're\s+a|you\s+are\s+a|nobody\s+likes|everyone\s+hates|you\s+should|just\s+leave|go\s+away|fuck\s+off|shut\s+up|loser|idiot|stupid|ugly|fat|worthless|pathetic)/i;
    const derogatoryTerms = /\b(?:slut|whore|bitch|asshole|dickhead|retard|fag|nigger|kike|chink|spic|tranny)\b/i;
    const hasHarassmentPattern = (targetedAttack.test(commentLower) || derogatoryTerms.test(commentLower)) && !hasPaymentRequest;

    // Spam: promotional content
    const promotionalKeywords = /(?:link\s+in\s+bio|check\s+my\s+bio|dm\s+me|click\s+here|buy\s+now|limited\s+time|act\s+now|exclusive\s+offer|follow\s+for\s+follow|f4f|s4s|promo|discount|sale|giveaway|win|free\s+money)/i;
    const linkPattern = /(?:https?:\/\/|www\.|bit\.ly|tinyurl|short\.link)/i;
    const hasSpamPattern = (promotionalKeywords.test(commentLower) || linkPattern.test(commentText)) && !hasThreat && !hasPaymentRequest;

    // Defamation: false damaging claims
    const accusationPattern = /\b(?:is\s+a\s+thief|is\s+a\s+liar|stole|scammed|fraud|cheat|lied|fake|fraudulent|illegal|stole\s+from|scammed\s+people)\b/i;
    const falseClaimIndicators = /\b(?:everyone\s+knows|it's\s+true\s+that|fact\s+is|the\s+truth\s+is|allegedly|supposedly)\b/i;
    const hasDefamationPattern = accusationPattern.test(commentLower) || (falseClaimIndicators.test(commentLower) && accusationPattern.test(commentLower));

    if (hasBlackmailPattern) {
      return { category: CommentCategory.BLACKMAIL, details: `Payment demand + conditional threat` };
    } else if (hasThreatPattern) {
      return { category: CommentCategory.THREAT, details: `Harm intent detected` };
    } else if (hasHarassmentPattern) {
      return { category: CommentCategory.HARASSMENT, details: `Targeted personal attacks or derogatory terms` };
    } else if (hasSpamPattern) {
      return { category: CommentCategory.SPAM, details: `Promotional content, links, or spam keywords` };
    } else if (hasDefamationPattern) {
      return { category: CommentCategory.DEFAMATION, details: `False damaging claims or accusations` };
    }

    return { category: null, details: '' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Two-tier re-evaluation
  // ═══════════════════════════════════════════════════════════════════════

  private async reEvaluateIfNeeded(
    llmResult: LLMClassificationResult,
    patternResult: { category: CommentCategory | null; details: string },
    commentText: string
  ): Promise<LLMClassificationResult> {
    const { category: detectedCategory, details: patternDetails } = patternResult;

    if (!detectedCategory || llmResult.category === detectedCategory) {
      return llmResult;
    }

    const shouldReEvaluate = llmResult.category === CommentCategory.BENIGN ||
      (detectedCategory === CommentCategory.BLACKMAIL && llmResult.category !== CommentCategory.BLACKMAIL);

    if (!shouldReEvaluate) {
      console.log(`   ℹ️  Pattern suggests ${detectedCategory} but LLM classified as ${llmResult.category}. Trusting LLM.`);
      return llmResult;
    }

    console.warn(`⚠️  PATTERN MISMATCH: Detected "${detectedCategory}" but LLM says "${llmResult.category}". Re-evaluating...`);

    try {
      const reEvaluation = await llmService.reEvaluateForCategory(commentText, detectedCategory, patternDetails);

      if (reEvaluation.category === detectedCategory) {
        console.warn(`   ✅ LLM re-evaluation confirmed ${detectedCategory}.`);
        return {
          ...reEvaluation,
          rationale: `[RE-EVALUATION] Confirmed ${detectedCategory}. Original: ${llmResult.rationale}`
        };
      }

      // Blackmail override: trust pattern detection for most critical category
      if (detectedCategory === CommentCategory.BLACKMAIL) {
        console.warn(`   ⚠️  Override to BLACKMAIL based on pattern detection.`);
        return {
          ...llmResult,
          category: CommentCategory.BLACKMAIL,
          severity: Math.max(reEvaluation.severity, 85),
          confidence: Math.max(reEvaluation.confidence, 0.9),
          rationale: `[PATTERN OVERRIDE] Blackmail pattern detected. Re-eval: ${reEvaluation.category}. Original: ${llmResult.rationale}`
        };
      }

      return {
        ...reEvaluation,
        rationale: `[RE-EVALUATION] LLM: ${reEvaluation.category}. Pattern suggested ${detectedCategory}. Original: ${llmResult.rationale}`
      };
    } catch (reEvalError) {
      console.error(`   ❌ Re-evaluation failed:`, reEvalError);
      if (detectedCategory === CommentCategory.BLACKMAIL) {
        return {
          ...llmResult,
          category: CommentCategory.BLACKMAIL,
          severity: 85,
          confidence: 0.9,
          rationale: `[PATTERN OVERRIDE] Blackmail pattern detected. Re-evaluation failed. Original: ${llmResult.rationale}`
        };
      }
      return llmResult;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LLM category validation
  // ═══════════════════════════════════════════════════════════════════════

  private async validateLLMCategory(
    llmResult: LLMClassificationResult,
    input: ModerateCommentInput,
    customFilters: CustomFilter[]
  ): Promise<LLMClassificationResult> {
    const validCategories = Object.values(CommentCategory);
    if (llmResult.category && typeof llmResult.category === 'string' && validCategories.includes(llmResult.category)) {
      return llmResult;
    }

    console.error(`⚠️  LLM returned invalid category: "${llmResult.category}". Re-running...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const retry = await llmService.classifyComment(input.commentText, customFilters);

    if (!retry.category || typeof retry.category !== 'string' || !validCategories.includes(retry.category)) {
      console.error(`❌ Still invalid after retry: "${retry.category}". Defaulting to BENIGN.`);
      retry.category = CommentCategory.BENIGN;
      retry.rationale = `Invalid category from LLM - defaulted to benign. Original: ${retry.rationale}`;
    }
    return retry;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Custom filter evaluation
  // ═══════════════════════════════════════════════════════════════════════

  private async evaluateCustomFilters(
    input: ModerateCommentInput,
    llmResult: LLMClassificationResult,
    userCustomFilters: CustomFilter[],
    _riskScore: number
  ): Promise<ModerationResult | null> {
    const commentLower = (input.commentText || '').toLowerCase();
    const llmCategoryNorm = (llmResult.category || '').toLowerCase();

    const commentMatchesFilterPrompt = (filter: CustomFilter): boolean => {
      const prompt = (filter.prompt || '').trim();
      if (!prompt) return false;
      const promptLower = prompt.toLowerCase();
      if (prompt.length <= 120) {
        return commentLower.includes(promptLower);
      }
      const phrases = promptLower
        .split(/\s+or\s+|[,;]|\./)
        .map(p => p.trim().replace(/^["']|["']$/g, ''))
        .filter(p => p.length >= 3);
      return phrases.some(phrase => commentLower.includes(phrase));
    };

    const filtersWithActions = userCustomFilters.filter(f =>
      f.isEnabled && (f.autoHide || f.autoDelete || f.autoFlag)
    );

    let matchingCustomFilters = filtersWithActions.filter(filter => {
      const categoryMatch = (filter.category || '').toLowerCase() === llmCategoryNorm;
      const textMatch = commentMatchesFilterPrompt(filter);
      return categoryMatch || textMatch;
    });

    // Semantic match for descriptive prompts
    const alreadyMatchedIds = new Set(matchingCustomFilters.map(f => f.id));
    const filtersNeedingSemanticCheck = filtersWithActions.filter(f => !alreadyMatchedIds.has(f.id));
    if (filtersNeedingSemanticCheck.length > 0) {
      const semanticMatchIds = await llmService.matchCommentToFilterDescriptions(
        input.commentText,
        filtersNeedingSemanticCheck.map(f => ({ id: f.id, name: f.name, prompt: f.prompt || '' }))
      );
      if (semanticMatchIds.length > 0) {
        const semanticMatches = filtersWithActions.filter(f => semanticMatchIds.includes(f.id));
        matchingCustomFilters = [...matchingCustomFilters, ...semanticMatches];
        console.log(`🔧 Custom filter(s) matched by description: ${semanticMatches.map(f => f.name).join(', ')}`);
      }
    }

    if (matchingCustomFilters.length === 0) return null;

    const filterWithDelete = matchingCustomFilters.find(f => f.autoDelete);
    const filterWithHide = matchingCustomFilters.find(f => f.autoHide);
    const filterWithFlag = matchingCustomFilters.find(f => f.autoFlag);

    const customFilterRiskScore = this.getRiskScoreForCustomFilterMatch(
      matchingCustomFilters,
      filterWithDelete ? 'delete' : filterWithHide ? 'hide' : 'flag'
    );

    if (filterWithDelete) {
      const filterNames = matchingCustomFilters.filter(f => f.autoDelete).map(f => f.name).join(', ');
      console.log(`🔧 Custom filter(s) applying auto-delete: ${filterNames}`);
      await this.executeDelete(input);
      llmResult.rationale = `Auto-deleted by custom filter(s): ${filterNames}. ${llmResult.rationale}`;
      await this.logModeration(input, llmResult, customFilterRiskScore, ActionTaken.DELETED);
      return {
        action: ActionTaken.DELETED,
        reason: 'CUSTOM_FILTER_AUTO_DELETE',
        llmClassification: llmResult,
        riskScore: customFilterRiskScore
      };
    } else if (filterWithHide) {
      const filterNames = matchingCustomFilters.filter(f => f.autoHide).map(f => f.name).join(', ');
      console.log(`🔧 Custom filter(s) applying auto-hide: ${filterNames}`);
      await this.executeHide(input);
      llmResult.rationale = `Auto-hidden by custom filter(s): ${filterNames}. ${llmResult.rationale}`;
      await this.logModeration(input, llmResult, customFilterRiskScore, ActionTaken.FLAGGED);
      return {
        action: ActionTaken.FLAGGED,
        reason: 'CUSTOM_FILTER_AUTO_HIDE',
        llmClassification: llmResult,
        riskScore: customFilterRiskScore
      };
    } else if (filterWithFlag) {
      const filterNames = matchingCustomFilters.filter(f => f.autoFlag).map(f => f.name).join(', ');
      llmResult.rationale = `Auto-flagged by custom filter(s): ${filterNames}. ${llmResult.rationale}`;
      // Continue to normal flow with updated rationale — return null
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Post-moderation tracking (runs after action is determined)
  // ═══════════════════════════════════════════════════════════════════════

  private async postModerationTracking(
    input: ModerateCommentInput,
    llmResult: LLMClassificationResult,
    riskScore: number,
    action: ActionTaken
  ): Promise<void> {
    const isOwner = await this.isCommenterAccountOwner(input);
    if (!isOwner && input.instagramAccountId) {
      await suspiciousAccountService.trackAccount({
        instagramAccountId: input.instagramAccountId,
        commenterId: input.commenterId,
        commenterUsername: input.commenterUsername,
        commentId: input.commentId,
        category: llmResult.category,
        riskScore,
        wasDeleted: action === ActionTaken.DELETED
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Early return helper
  // ═══════════════════════════════════════════════════════════════════════

  private async earlyReturn(
    input: ModerateCommentInput,
    reason: string,
    category: CommentCategory,
    rationale: string
  ): Promise<ModerationResult> {
    const classification: LLMClassificationResult = {
      category,
      severity: 0,
      confidence: 1.0,
      rationale,
      extractedIdentifiers: []
    };
    await this.logModeration(input, classification, 0, ActionTaken.BENIGN);
    return {
      action: ActionTaken.BENIGN,
      reason,
      llmClassification: classification,
      riskScore: 0
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Utility methods
  // ═══════════════════════════════════════════════════════════════════════

  private normalizeUsername(s: string): string {
    if (!s || typeof s !== 'string') return '';
    return s.toLowerCase().trim().replace(/^@/, '');
  }

  private async isCommenterAccountOwner(input: ModerateCommentInput): Promise<boolean> {
    if (!input.instagramAccountId) return false;

    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, input.instagramAccountId),
      columns: { username: true, instagramId: true }
    });
    if (!account) return false;
    const commenterNorm = this.normalizeUsername(input.commenterUsername);
    const ownerNorm = this.normalizeUsername(account.username);
    if (commenterNorm && ownerNorm && commenterNorm === ownerNorm) return true;
    if (input.commenterId && account.instagramId && input.commenterId === account.instagramId) return true;
    return false;
  }

  private normalizeIdentifier(identifier: string): string {
    if (!identifier || typeof identifier !== 'string') return '';
    return identifier
      .toLowerCase()
      .trim()
      .replace(/[@.\-_\s]/g, '')
      .replace(/[()[\]{}]/g, '');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Action executors
  // ═══════════════════════════════════════════════════════════════════════

  private async executeHide(input: ModerateCommentInput): Promise<void> {
    try {
      if (!this.testMode) {
        if (input.igCommentId && input.accessToken) {
          const success = await instagramService.hideComment(input.igCommentId, input.accessToken);
          if (!success) {
            console.warn(`[Moderation] Instagram hideComment failed for comment ${input.commentId}`);
          }
        } else if (input.fbCommentId && input.accessToken) {
          const success = await facebookService.hideComment(input.fbCommentId, input.accessToken);
          if (!success) {
            console.warn(`[Moderation] Facebook hideComment failed for comment ${input.commentId}`);
          }
        }
      }
      await db
        .update(comments)
        .set({ isHidden: true, hiddenAt: new Date() })
        .where(eq(comments.id, input.commentId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to hide comment:', errorMessage);
      try {
        await db.update(comments).set({ isHidden: true, hiddenAt: new Date() }).where(eq(comments.id, input.commentId));
      } catch (_) { /* best-effort DB update */ }
    }
  }

  private async executeDelete(input: ModerateCommentInput): Promise<void> {
    try {
      if (this.testMode) {
        console.log(`[TEST MODE] Would delete comment ${input.igCommentId || input.fbCommentId} from platform`);
      } else {
        if (input.igCommentId && input.accessToken) {
          const success = await instagramService.deleteComment(input.igCommentId, input.accessToken);
          if (!success) throw new Error('Instagram API deletion failed');
        } else if (input.fbCommentId && input.accessToken) {
          const success = await facebookService.deleteComment(input.fbCommentId, input.accessToken);
          if (!success) throw new Error('Facebook API deletion failed');
        }
      }
      await db
        .update(comments)
        .set({ isDeleted: true, deletedAt: new Date() })
        .where(eq(comments.id, input.commentId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to delete comment:', errorMessage);
      await db
        .update(comments)
        .set({ deletionFailed: true, deletionError: errorMessage })
        .where(eq(comments.id, input.commentId));
    }
  }

  // @ts-ignore - Unused for now, kept for future implementation
  private async _executeBlock(input: ModerateCommentInput): Promise<void> {
    try {
      if (input.facebookPageId) {
        console.warn('Block user not supported for Facebook via this API yet');
        return;
      }
      if (this.testMode) {
        console.log(`[TEST MODE] Would block user ${input.commenterId} on Instagram`);
      } else if (input.instagramAccountId && input.accessToken) {
        const success = await instagramService.blockUser(input.commenterId, input.accessToken);
        if (!success) throw new Error('Instagram API block user failed');
      }
      await db.update(comments).set({ isBlocked: true, blockedAt: new Date() }).where(eq(comments.id, input.commentId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to block user:', errorMessage);
      await db.update(comments).set({ blockFailed: true, blockError: errorMessage }).where(eq(comments.id, input.commentId));
    }
  }

  // @ts-ignore - Unused for now, kept for future implementation
  private async _executeRestrict(input: ModerateCommentInput): Promise<void> {
    try {
      if (input.facebookPageId) {
        console.warn('Restrict user not supported for Facebook via this API yet');
        return;
      }
      if (this.testMode) {
        console.log(`[TEST MODE] Would restrict user ${input.commenterId} on Instagram`);
      } else if (input.instagramAccountId && input.accessToken) {
        const success = await instagramService.restrictUser(input.commenterId, input.accessToken);
        if (!success) throw new Error('Instagram API restrict user failed');
      }
      await db.update(comments).set({ isRestricted: true, restrictedAt: new Date() }).where(eq(comments.id, input.commentId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to restrict user:', errorMessage);
      await db.update(comments).set({ restrictFailed: true, restrictError: errorMessage }).where(eq(comments.id, input.commentId));
    }
  }

  // @ts-ignore - Unused for now, kept for future implementation
  private async _executeReport(input: ModerateCommentInput): Promise<void> {
    try {
      if (input.facebookPageId) {
        console.warn('Report comment not supported for Facebook via this API yet');
        return;
      }
      if (this.testMode) {
        console.log(`[TEST MODE] Would report comment ${input.igCommentId} on Instagram`);
      } else if (input.igCommentId && input.accessToken) {
        const success = await instagramService.reportComment(input.igCommentId, input.accessToken);
        if (!success) throw new Error('Instagram API report comment failed');
      }
      await db.update(comments).set({ isReported: true, reportedAt: new Date() }).where(eq(comments.id, input.commentId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to report comment:', errorMessage);
      await db.update(comments).set({ reportFailed: true, reportError: errorMessage }).where(eq(comments.id, input.commentId));
    }
  }

  // @ts-ignore - Unused for now, kept for future implementation
  private async _executeApprove(input: ModerateCommentInput): Promise<void> {
    try {
      if (input.facebookPageId) {
        console.warn('Approve comment not supported for Facebook via this API yet');
        return;
      }
      if (this.testMode) {
        console.log(`[TEST MODE] Would approve comment ${input.igCommentId} on Instagram`);
      } else if (input.igCommentId && input.accessToken) {
        const success = await instagramService.approveComment(input.igCommentId, input.accessToken);
        if (!success) throw new Error('Instagram API approve comment failed');
      }
      await db.update(comments).set({ isApproved: true, approvedAt: new Date() }).where(eq(comments.id, input.commentId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to approve comment:', errorMessage);
      await db.update(comments).set({ approveFailed: true, approveError: errorMessage }).where(eq(comments.id, input.commentId));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Risk score helpers
  // ═══════════════════════════════════════════════════════════════════════

  private getRiskScoreForCustomFilterMatch(
    matchingFilters: CustomFilter[],
    action: 'delete' | 'hide' | 'flag'
  ): number {
    const baseByAction = { delete: 80, hide: 65, flag: 50 };
    let score = baseByAction[action];
    const highSeverityCategories = ['blackmail', 'threat', 'harassment', 'defamation'];
    const hasHighSeverityFilter = matchingFilters.some(
      f => highSeverityCategories.includes((f.category || '').toLowerCase())
    );
    if (hasHighSeverityFilter) score = Math.min(100, score + 10);
    return Math.round(score);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Logging
  // ═══════════════════════════════════════════════════════════════════════

  private async logModeration(
    input: ModerateCommentInput,
    llmResult: LLMClassificationResult | LLMClassificationInput,
    riskScore: number,
    action: ActionTaken
  ): Promise<void> {
    if (this.testMode) {
      if (!input.commentId) {
        console.warn('⚠️  Test mode: Skipping moderation log (no commentId provided)');
        return;
      }
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(input.commentId)) {
        console.warn(`⚠️  Test mode: Skipping moderation log (invalid UUID: ${input.commentId})`);
        return;
      }
    }

    const [moderationLog] = await db
      .insert(moderationLogs)
      .values({
        commentId: input.commentId,
        category: llmResult.category,
        severity: llmResult.severity,
        confidence: llmResult.confidence.toString(),
        rationale: llmResult.rationale,
        riskScore,
        riskFormula: null,
        modelName: 'llama-3.1-70b-versatile',
        modelVersion: null,
        actionTaken: (action === ActionTaken.DELETED ? 'DELETED' :
          action === ActionTaken.FLAGGED ? 'FLAGGED' : 'BENIGN') as 'DELETED' | 'FLAGGED' | 'BENIGN',
        actionTimestamp: new Date(),
        isDegradedMode: false
      })
      .returning();

    await db.insert(evidenceRecords).values({
      moderationLogId: moderationLog.id,
      rawComment: input.commentText,
      rawCommenterUsername: input.commenterUsername,
      rawCommenterId: input.commenterId,
      llmRequestJson: null,
      llmResponseJson: JSON.stringify(llmResult),
      formulaUsed: `risk_score = ${riskScore}`,
      riskVariables: null,
      instagramApiResponse: null,
      deletionConfirmed: action === ActionTaken.DELETED
    });

    // Check + track comment moderation usage for Autumn billing (only non-benign actions)
    if (action !== ActionTaken.BENIGN) {
      resolveBillingCustomerId({
        userId: input.userId,
        clientId: input.clientId,
      }).then((billingCustomerId) => {
        if (billingCustomerId) {
          autumn.check({
            customer_id: billingCustomerId,
            feature_id: "comments_moderated",
            send_event: true,
          }).catch((err: unknown) => console.error("Autumn check+track (comment moderated) failed:", err));
        }
      }).catch((err: unknown) => console.error("Autumn resolve billing customer failed:", err));
    }

    // Store extracted identifiers for bot network analysis
    const isCommenterOwner = await this.isCommenterAccountOwner(input);
    if (!isCommenterOwner && llmResult.extractedIdentifiers && llmResult.extractedIdentifiers.length > 0) {
      console.log(`🔍 Extracting ${llmResult.extractedIdentifiers.length} identifiers from comment:`, llmResult.extractedIdentifiers);

      const accountId = input.instagramAccountId ?? input.facebookPageId;

      // Skip identifier extraction if no valid account ID is available
      if (!accountId) {
        console.warn('⚠️ No accountId available for identifier extraction, skipping');
        return;
      }

      let account = await db.query.suspiciousAccounts.findFirst({
        where: and(
          eq(suspiciousAccounts.instagramAccountId, accountId),
          eq(suspiciousAccounts.commenterId, input.commenterId)
        )
      });

      if (!account) {
        const [newAccount] = await db.insert(suspiciousAccounts).values({
          instagramAccountId: accountId,
          commenterId: input.commenterId,
          commenterUsername: input.commenterUsername,
          totalComments: 1,
          flaggedComments: riskScore > 30 ? 1 : 0,
          deletedComments: action === ActionTaken.DELETED ? 1 : 0,
          blackmailCount: llmResult.category === CommentCategory.BLACKMAIL ? 1 : 0,
          threatCount: llmResult.category === CommentCategory.THREAT ? 1 : 0,
          harassmentCount: llmResult.category === CommentCategory.HARASSMENT ? 1 : 0,
          spamCount: llmResult.category === CommentCategory.SPAM ? 1 : 0,
          defamationCount: llmResult.category === CommentCategory.DEFAMATION ? 1 : 0,
          highestRiskScore: riskScore,
          averageRiskScore: riskScore.toString(),
          firstSeenAt: new Date(),
          lastSeenAt: new Date()
        }).returning();
        account = newAccount;
      }

      const identifierInserts = llmResult.extractedIdentifiers
        .filter(identifier => identifier.value != null && identifier.value.trim() !== '')
        .map(identifier => ({
          commentId: input.commentId,
          suspiciousAccountId: account!.id,
          identifier: identifier.value,
          identifierType: identifier.type,
          platform: identifier.platform,
          normalizedIdentifier: this.normalizeIdentifier(identifier.value),
          confidence: llmResult.confidence.toString(),
          source: 'llm_extraction'
        }));

      if (identifierInserts.length > 0) {
        console.log(`✅ Storing ${identifierInserts.length} identifiers for account ${account.id}`);
        await db.insert(extractedIdentifiers).values(identifierInserts);
      }

      // Detect mastermind mentions
      await this.detectMastermindMentions(
        input, account.id, llmResult.extractedIdentifiers, action, input.clientId, input.userId
      );
    }
  }

  /**
   * Detect if comment mentions any mastermind identifiers
   */
  private async detectMastermindMentions(
    input: ModerateCommentInput,
    suspiciousAccountId: string,
    extractedIds: Array<{ type: string; value: string; platform?: string }>,
    action: ActionTaken,
    clientId?: string,
    userId?: string
  ): Promise<void> {
    try {
      const connections = await mastermindConnectionService.getConnectionsForAccount(
        suspiciousAccountId, clientId, userId
      );
      if (connections.length === 0) return;

      for (const connection of connections) {
        const [mastermind] = await db
          .select()
          .from(botNetworkMasterminds)
          .where(eq(botNetworkMasterminds.id, connection.mastermindId))
          .limit(1);

        if (!mastermind || !mastermind.knownIdentifiers) continue;

        const knownIdentifiers = Array.isArray(mastermind.knownIdentifiers)
          ? mastermind.knownIdentifiers as Array<{ type?: string; value?: string }>
          : [];

        for (const extracted of extractedIds) {
          if (!extracted.value) continue;
          const normalizedExtracted = this.normalizeIdentifier(extracted.value);

          for (const known of knownIdentifiers) {
            if (!known.value) continue;
            const normalizedKnown = this.normalizeIdentifier(known.value);

            if (normalizedExtracted && normalizedKnown &&
              (normalizedExtracted === normalizedKnown ||
                normalizedExtracted.includes(normalizedKnown) ||
                normalizedKnown.includes(normalizedExtracted))) {

              const [botConnection] = await db
                .select()
                .from(botNetworkConnections)
                .where(
                  and(
                    eq(botNetworkConnections.mastermindId, connection.mastermindId),
                    eq(botNetworkConnections.suspiciousAccountId, suspiciousAccountId),
                    eq(botNetworkConnections.isActive, true)
                  )
                )
                .limit(1);

              if (botConnection) {
                const extractedValue = extracted.value || '';
                const mentionPosition = extractedValue && input.commentText
                  ? input.commentText.toLowerCase().indexOf(extractedValue.toLowerCase())
                  : -1;

                await db.insert(mastermindMentions).values({
                  mastermindId: connection.mastermindId,
                  commentId: input.commentId,
                  botConnectionId: botConnection.id,
                  mentionedIdentifier: extractedValue,
                  mentionType: extracted.type || 'UNKNOWN',
                  fullCommentText: input.commentText,
                  mentionPosition,
                  actionTaken: (action === ActionTaken.DELETED ? 'DELETED' :
                    action === ActionTaken.FLAGGED ? 'FLAGGED' : 'BENIGN') as 'DELETED' | 'FLAGGED' | 'BENIGN'
                });

                await db
                  .update(botNetworkConnections)
                  .set({
                    mentionsMastermind: true,
                    totalMentions: sql`${botNetworkConnections.totalMentions} + 1`
                  })
                  .where(eq(botNetworkConnections.id, botConnection.id));

                await db
                  .update(botNetworkMasterminds)
                  .set({
                    lastActivity: new Date(),
                    totalViolations: sql`${botNetworkMasterminds.totalViolations} + 1`
                  })
                  .where(eq(botNetworkMasterminds.id, connection.mastermindId));
              }
            }
          }
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Mastermind mention detection failed:', errorMessage);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Moderation settings resolution
  // ═══════════════════════════════════════════════════════════════════════

  private async getModerationSettings(
    clientId?: string,
    userId?: string,
    instagramAccountId?: string
  ): Promise<ModerationSettingsResult> {
    try {
      let settingsQuery: typeof moderationSettings.$inferSelect[] | undefined;

      // When both clientId and userId are provided (shared account scenario),
      // determine which owner actually owns THIS specific Instagram account record
      let effectiveClientId: string | undefined = clientId;
      let effectiveUserId: string | undefined = userId;

      if (instagramAccountId && clientId && userId) {
        const igAccount = await db.query.instagramAccounts.findFirst({
          where: eq(instagramAccounts.id, instagramAccountId),
          columns: { userId: true, clientId: true }
        });

        if (igAccount) {
          // Use the owner that actually owns this specific Instagram account record
          effectiveClientId = igAccount.clientId ?? undefined;
          effectiveUserId = igAccount.userId ?? undefined;
          console.log(`🔍 Shared account detected - using owner settings: ${effectiveClientId ? `clientId=${effectiveClientId}` : `userId=${effectiveUserId}`}`);
        }
      }

      // 1) Account-specific
      if (instagramAccountId) {
        settingsQuery = await db
          .select()
          .from(moderationSettings)
          .where(
            and(
              eq(moderationSettings.instagramAccountId, instagramAccountId),
              isNull(moderationSettings.managedClientId),
              effectiveClientId
                ? eq(moderationSettings.clientId, effectiveClientId)
                : eq(moderationSettings.userId, effectiveUserId!)
            )
          )
          .limit(1);
      }

      // 2) Agency client rule
      if (effectiveClientId && (!settingsQuery || settingsQuery.length === 0)) {
        const clientRow = await db
          .select({ userId: clients.userId })
          .from(clients)
          .where(eq(clients.id, effectiveClientId))
          .limit(1);
        const agencyId = clientRow[0]?.userId;
        if (agencyId) {
          settingsQuery = await db
            .select()
            .from(moderationSettings)
            .where(
              and(
                eq(moderationSettings.userId, agencyId),
                eq(moderationSettings.managedClientId, effectiveClientId),
                isNull(moderationSettings.instagramAccountId)
              )
            )
            .limit(1);
        }
      }

      // 3) Global
      if (!settingsQuery || settingsQuery.length === 0) {
        settingsQuery = await db
          .select()
          .from(moderationSettings)
          .where(
            and(
              isNull(moderationSettings.instagramAccountId),
              isNull(moderationSettings.managedClientId),
              effectiveClientId
                ? eq(moderationSettings.clientId, effectiveClientId)
                : eq(moderationSettings.userId, effectiveUserId!)
            )
          )
          .limit(1);
      }

      if (settingsQuery && settingsQuery.length > 0) {
        const settings = settingsQuery[0];
        const globalThreshold = settings.globalThreshold ?? 50;
        return {
          globalThreshold,
          blackmailThreshold: settings.blackmailThreshold ?? globalThreshold,
          threatThreshold: settings.threatThreshold ?? globalThreshold,
          harassmentThreshold: settings.harassmentThreshold ?? globalThreshold,
          defamationThreshold: settings.defamationThreshold ?? globalThreshold,
          spamThreshold: settings.spamThreshold ?? globalThreshold,
          autoDeleteBlackmail: settings.autoDeleteBlackmail ?? true,
          autoDeleteThreat: settings.autoDeleteThreat ?? true,
          autoDeleteHarassment: settings.autoDeleteHarassment ?? true,
          autoDeleteDefamation: settings.autoDeleteDefamation ?? true,
          autoDeleteSpam: settings.autoDeleteSpam ?? false,
          flagHideBlackmail: settings.flagHideBlackmail ?? false,
          flagHideThreat: settings.flagHideThreat ?? false,
          flagHideHarassment: settings.flagHideHarassment ?? false,
          flagHideDefamation: settings.flagHideDefamation ?? false,
          flagHideSpam: settings.flagHideSpam ?? false,
          flagDeleteBlackmail: settings.flagDeleteBlackmail ?? false,
          flagDeleteThreat: settings.flagDeleteThreat ?? false,
          flagDeleteHarassment: settings.flagDeleteHarassment ?? false,
          flagDeleteDefamation: settings.flagDeleteDefamation ?? false,
          flagDeleteSpam: settings.flagDeleteSpam ?? false,
          flagHideBlackmailThreshold: settings.flagHideBlackmailThreshold ?? 60,
          flagHideThreatThreshold: settings.flagHideThreatThreshold ?? 60,
          flagHideHarassmentThreshold: settings.flagHideHarassmentThreshold ?? 65,
          flagHideDefamationThreshold: settings.flagHideDefamationThreshold ?? 65,
          flagHideSpamThreshold: settings.flagHideSpamThreshold ?? 75,
          flagDeleteBlackmailThreshold: settings.flagDeleteBlackmailThreshold ?? 50,
          flagDeleteThreatThreshold: settings.flagDeleteThreatThreshold ?? 50,
          flagDeleteHarassmentThreshold: settings.flagDeleteHarassmentThreshold ?? 55,
          flagDeleteDefamationThreshold: settings.flagDeleteDefamationThreshold ?? 55,
          flagDeleteSpamThreshold: settings.flagDeleteSpamThreshold ?? 65,
          confidenceDeleteThreshold: settings.confidenceDeleteThreshold ?? 90,
          confidenceHideThreshold: settings.confidenceHideThreshold ?? 70,
          similarityAutoModEnabled: settings.similarityAutoModEnabled ?? true,
          similarityThreshold: settings.similarityThreshold ?? 85
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching moderation settings:', errorMessage);
    }

    // Defaults
    return {
      globalThreshold: 70,
      blackmailThreshold: 70,
      threatThreshold: 70,
      harassmentThreshold: 75,
      defamationThreshold: 75,
      spamThreshold: 85,
      autoDeleteBlackmail: true,
      autoDeleteThreat: true,
      autoDeleteHarassment: true,
      autoDeleteDefamation: true,
      autoDeleteSpam: false,
      flagHideBlackmail: false,
      flagHideThreat: false,
      flagHideHarassment: false,
      flagHideDefamation: false,
      flagHideSpam: false,
      flagDeleteBlackmail: false,
      flagDeleteThreat: false,
      flagDeleteHarassment: false,
      flagDeleteDefamation: false,
      flagDeleteSpam: false,
      flagHideBlackmailThreshold: 60,
      flagHideThreatThreshold: 60,
      flagHideHarassmentThreshold: 65,
      flagHideDefamationThreshold: 65,
      flagHideSpamThreshold: 75,
      flagDeleteBlackmailThreshold: 50,
      flagDeleteThreatThreshold: 50,
      flagDeleteHarassmentThreshold: 55,
      flagDeleteDefamationThreshold: 55,
      flagDeleteSpamThreshold: 65,
      confidenceDeleteThreshold: 90,
      confidenceHideThreshold: 70,
      similarityAutoModEnabled: true,
      similarityThreshold: 85
    };
  }
}

export const moderationService = new ModerationService();

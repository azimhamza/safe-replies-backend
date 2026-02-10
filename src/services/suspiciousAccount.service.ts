import { db } from '../db';
import { suspiciousAccounts, accountCommentMap, instagramAccounts } from '../db/schema';
import { eq, and, or } from 'drizzle-orm';
import { CommentCategory } from '../types';

function normalizeUsername(s: string): string {
  if (!s || typeof s !== 'string') return '';
  return s.toLowerCase().trim().replace(/^@/, '');
}

interface TrackAccountInput {
  instagramAccountId: string;
  commenterId: string;
  commenterUsername: string;
  commentId: string;
  category: CommentCategory;
  riskScore: number;
  wasDeleted: boolean;
}

export class SuspiciousAccountService {
  /**
   * Track suspicious account activity and update metrics
   */
  async trackAccount(input: TrackAccountInput): Promise<void> {
    // Never track the account owner as a suspicious account
    const igAccount = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, input.instagramAccountId),
      columns: { username: true, instagramId: true }
    });
    if (igAccount) {
      const commenterNorm = normalizeUsername(input.commenterUsername);
      const ownerNorm = normalizeUsername(igAccount.username);
      if (commenterNorm && ownerNorm && commenterNorm === ownerNorm) return;
      if (input.commenterId && igAccount.instagramId && input.commenterId === igAccount.instagramId) return;
    }

    // Find or create suspicious account
    let account = await db.query.suspiciousAccounts.findFirst({
      where: and(
        eq(suspiciousAccounts.instagramAccountId, input.instagramAccountId),
        eq(suspiciousAccounts.commenterId, input.commenterId)
      )
    });

    const now = new Date();

    if (!account) {
      // Determine if this account has actual violations (not just benign comments)
      const hasViolations = input.category !== CommentCategory.BENIGN && 
                           (input.riskScore > 30 || input.wasDeleted);
      
      // Create new suspicious account record
      const [newAccount] = await db.insert(suspiciousAccounts).values({
        instagramAccountId: input.instagramAccountId,
        commenterId: input.commenterId,
        commenterUsername: input.commenterUsername,
        totalComments: 1,
        flaggedComments: input.riskScore > 30 ? 1 : 0,
        deletedComments: input.wasDeleted ? 1 : 0,
        blackmailCount: input.category === CommentCategory.BLACKMAIL ? 1 : 0,
        threatCount: input.category === CommentCategory.THREAT ? 1 : 0,
        harassmentCount: input.category === CommentCategory.HARASSMENT ? 1 : 0,
        spamCount: input.category === CommentCategory.SPAM ? 1 : 0,
        defamationCount: input.category === CommentCategory.DEFAMATION ? 1 : 0,
        highestRiskScore: input.riskScore,
        averageRiskScore: input.riskScore.toString(),
        firstSeenAt: now,
        lastSeenAt: now,
        // Only show in suspicious accounts list if there are actual violations
        isHidden: !hasViolations
      }).returning();

      account = newAccount;
    } else {
      // Update existing account
      const updatedValues: Record<string, number | string | Date | boolean> = {
        totalComments: (account.totalComments ?? 0) + 1,
        lastSeenAt: now
      };

      if (input.riskScore > 30) {
        updatedValues.flaggedComments = (account.flaggedComments ?? 0) + 1;
      }

      if (input.wasDeleted) {
        updatedValues.deletedComments = (account.deletedComments ?? 0) + 1;
      }

      // Update category counts
      if (input.category === CommentCategory.BLACKMAIL) {
        updatedValues.blackmailCount = (account.blackmailCount ?? 0) + 1;
      } else if (input.category === CommentCategory.THREAT) {
        updatedValues.threatCount = (account.threatCount ?? 0) + 1;
      } else if (input.category === CommentCategory.HARASSMENT) {
        updatedValues.harassmentCount = (account.harassmentCount ?? 0) + 1;
      } else if (input.category === CommentCategory.SPAM) {
        updatedValues.spamCount = (account.spamCount ?? 0) + 1;
      } else if (input.category === CommentCategory.DEFAMATION) {
        updatedValues.defamationCount = (account.defamationCount ?? 0) + 1;
      }

      // Update highest risk score
      if (input.riskScore > (account.highestRiskScore ?? 0)) {
        updatedValues.highestRiskScore = input.riskScore;
      }

      // Calculate new average risk score
      const currentAvg = parseFloat(account.averageRiskScore ?? '0');
      const totalComments = account.totalComments ?? 0;
      const newAvg = (currentAvg * totalComments + input.riskScore) / (totalComments + 1);
      updatedValues.averageRiskScore = newAvg.toFixed(2);

      // Update isHidden: show account if it has actual violations (not just benign comments)
      // Calculate violations AFTER this update
      const currentBlackmail = account.blackmailCount ?? 0;
      const currentThreat = account.threatCount ?? 0;
      const currentHarassment = account.harassmentCount ?? 0;
      const currentDefamation = account.defamationCount ?? 0;
      const currentSpam = account.spamCount ?? 0;
      
      // Calculate what the counts will be after this update
      const newBlackmail = currentBlackmail + (input.category === CommentCategory.BLACKMAIL ? 1 : 0);
      const newThreat = currentThreat + (input.category === CommentCategory.THREAT ? 1 : 0);
      const newHarassment = currentHarassment + (input.category === CommentCategory.HARASSMENT ? 1 : 0);
      const newDefamation = currentDefamation + (input.category === CommentCategory.DEFAMATION ? 1 : 0);
      const newSpam = currentSpam + (input.category === CommentCategory.SPAM ? 1 : 0);
      
      // Total violations after this update (includes both existing and new violations)
      const totalViolationsAfterUpdate = newBlackmail + newThreat + newHarassment + newDefamation + newSpam;
      
      // Show account if it has ANY violations (even if it also has benign comments)
      // But don't change isHidden if already watchlisted or isPublicThreat (they should always be visible)
      if (totalViolationsAfterUpdate > 0 && !account.isWatchlisted && !account.isPublicThreat) {
        updatedValues.isHidden = false;
      }
      // Note: We don't set isHidden = true here even if totalViolationsAfterUpdate is 0,
      // because the account might have been manually unhidden or watchlisted in the past

      await db
        .update(suspiciousAccounts)
        .set(updatedValues)
        .where(eq(suspiciousAccounts.id, account.id));

      // Check auto-block conditions
      await this.checkAutoBlock(account.id);
    }

    // Link comment to suspicious account
    await db.insert(accountCommentMap).values({
      suspiciousAccountId: account!.id,
      commentId: input.commentId
    });
  }

  /**
   * Check if account should be auto-blocked
   */
  private async checkAutoBlock(accountId: string): Promise<void> {
    const account = await db.query.suspiciousAccounts.findFirst({
      where: eq(suspiciousAccounts.id, accountId)
    });

    if (!account || account.isBlocked) {
      return;
    }

    let shouldBlock = false;
    let blockReason = '';

    // Auto-block spam bots (velocity > 10 AND spam count > 5)
    if ((account.spamCount ?? 0) > 5) {
      // Calculate velocity (this is simplified - in production you'd check actual time window)
      const accountAgeDays = Math.max(
        1,
        Math.floor((Date.now() - account.firstSeenAt.getTime()) / (1000 * 60 * 60 * 24))
      );
      const totalComments = account.totalComments ?? 0;
      const commentsPerDay = totalComments / accountAgeDays;

      if (commentsPerDay > 10) {
        shouldBlock = true;
        blockReason = `Auto-blocked: spam bot detected (${account.spamCount ?? 0} spam comments, ${commentsPerDay.toFixed(1)} per day)`;
      }
    }

    // Auto-block serial blackmailers
    if ((account.blackmailCount ?? 0) >= 2) {
      shouldBlock = true;
      blockReason = `Auto-blocked: ${account.blackmailCount ?? 0} blackmail attempts`;
    }

    // Auto-block repeat threats
    if ((account.threatCount ?? 0) >= 2) {
      shouldBlock = true;
      blockReason = `Auto-blocked: ${account.threatCount ?? 0} threats detected`;
    }

    // Auto-block high-risk repeat offenders
    const deletedComments = account.deletedComments ?? 0;
    if (deletedComments >= 5 && parseFloat(account.averageRiskScore ?? '0') > 80) {
      shouldBlock = true;
      blockReason = `Auto-blocked: ${deletedComments} violations, average risk ${account.averageRiskScore}`;
    }

    if (shouldBlock) {
      await db
        .update(suspiciousAccounts)
        .set({
          isBlocked: true,
          blockReason,
          blockedAt: new Date()
        })
        .where(eq(suspiciousAccounts.id, accountId));
    }
  }

  /**
   * Check if account is blocked (auto-delete enabled)
   */
  async isBlocked(
    instagramAccountId: string,
    commenterId: string
  ): Promise<boolean> {
    const account = await db.query.suspiciousAccounts.findFirst({
      where: and(
        eq(suspiciousAccounts.instagramAccountId, instagramAccountId),
        eq(suspiciousAccounts.commenterId, commenterId),
        or(
          eq(suspiciousAccounts.isBlocked, true),
          eq(suspiciousAccounts.autoDeleteEnabled, true)
        )
      )
    });

    return !!account;
  }

  /**
   * Get repeat offender count for risk scoring
   */
  async getRepeatOffenderCount(
    instagramAccountId: string,
    commenterId: string
  ): Promise<number> {
    const account = await db.query.suspiciousAccounts.findFirst({
      where: and(
        eq(suspiciousAccounts.instagramAccountId, instagramAccountId),
        eq(suspiciousAccounts.commenterId, commenterId)
      )
    });

    return account?.deletedComments ?? 0;
  }
}

export const suspiciousAccountService = new SuspiciousAccountService();

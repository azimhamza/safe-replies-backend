import { RiskScoringInput, RiskScoringResult } from '../types';

export class RiskScoringService {
  /**
   * Calculate risk score based on LLM output and account history
   * This is deterministic math - NOT AI
   */
  calculateRiskScore(input: RiskScoringInput): RiskScoringResult {
    // Base score from LLM (severity 0-100 * confidence 0-1)
    const baseScore = input.severity * input.confidence;

    // Repeat offender bonus (up to +30)
    const repeatOffenderBonus = Math.min(input.repeatOffenderCount * 10, 30);

    // Velocity bonus (spam bot detection)
    const velocityBonus = input.commentVelocity > 5 ? 20 : 0;

    // Account age penalty (older accounts = -10, less risky)
    const accountAgePenalty = input.accountAgeDays > 365 ? -10 : 0;

    // Final risk score
    const riskScore = Math.max(
      0,
      Math.min(
        100,
        baseScore + repeatOffenderBonus + velocityBonus + accountAgePenalty
      )
    );

    return {
      riskScore: Math.round(riskScore),
      baseScore: Math.round(baseScore),
      repeatOffenderBonus,
      velocityBonus,
      accountAgePenalty,
      shouldDelete: riskScore > 70,
      shouldEscalate: riskScore > 85
    };
  }

  /**
   * Get formula explanation as string (for evidence logging)
   */
  getFormulaExplanation(input: RiskScoringInput, result: RiskScoringResult): string {
    return `risk_score = ${result.riskScore}
base_score = severity(${input.severity}) * confidence(${input.confidence}) = ${result.baseScore}
repeat_offender_bonus = min(${input.repeatOffenderCount} * 10, 30) = ${result.repeatOffenderBonus}
velocity_bonus = (${input.commentVelocity} > 5) ? 20 : 0 = ${result.velocityBonus}
account_age_penalty = (${input.accountAgeDays} > 365) ? -10 : 0 = ${result.accountAgePenalty}

Final: ${result.baseScore} + ${result.repeatOffenderBonus} + ${result.velocityBonus} + ${result.accountAgePenalty} = ${result.riskScore}`;
  }

  /**
   * Get category-specific threshold
   */
  getCategoryThreshold(
    category: string,
    settings: {
      blackmailThreshold?: number;
      threatThreshold?: number;
      harassmentThreshold?: number;
      defamationThreshold?: number;
      spamThreshold?: number;
      globalThreshold: number;
    }
  ): number {
    if (!category || typeof category !== 'string') {
      return settings.globalThreshold;
    }
    
    switch (category.toLowerCase()) {
      case 'blackmail':
        return settings.blackmailThreshold ?? settings.globalThreshold;
      case 'threat':
        return settings.threatThreshold ?? settings.globalThreshold;
      case 'harassment':
        return settings.harassmentThreshold ?? settings.globalThreshold;
      case 'defamation':
        return settings.defamationThreshold ?? settings.globalThreshold;
      case 'spam':
        return settings.spamThreshold ?? settings.globalThreshold;
      default:
        return settings.globalThreshold;
    }
  }

  /**
   * Check if category auto-delete is enabled
   */
  isCategoryAutoDeleteEnabled(
    category: string,
    settings: {
      autoDeleteBlackmail?: boolean;
      autoDeleteThreat?: boolean;
      autoDeleteHarassment?: boolean;
      autoDeleteDefamation?: boolean;
      autoDeleteSpam?: boolean;
    }
  ): boolean {
    if (!category || typeof category !== 'string') {
      return false;
    }
    
    switch (category.toLowerCase()) {
      case 'blackmail':
        return settings.autoDeleteBlackmail ?? true;
      case 'threat':
        return settings.autoDeleteThreat ?? true;
      case 'harassment':
        return settings.autoDeleteHarassment ?? true;
      case 'defamation':
        return settings.autoDeleteDefamation ?? true;
      case 'spam':
        return settings.autoDeleteSpam ?? false;
      default:
        return false;
    }
  }

  /**
   * Check if category flag and hide is enabled
   */
  isCategoryFlagHideEnabled(
    category: string,
    settings: {
      flagHideBlackmail?: boolean;
      flagHideThreat?: boolean;
      flagHideHarassment?: boolean;
      flagHideDefamation?: boolean;
      flagHideSpam?: boolean;
    }
  ): boolean {
    if (!category || typeof category !== 'string') {
      return false;
    }
    
    switch (category.toLowerCase()) {
      case 'blackmail':
        return settings.flagHideBlackmail ?? false;
      case 'threat':
        return settings.flagHideThreat ?? false;
      case 'harassment':
        return settings.flagHideHarassment ?? false;
      case 'defamation':
        return settings.flagHideDefamation ?? false;
      case 'spam':
        return settings.flagHideSpam ?? false;
      default:
        return false;
    }
  }

  /**
   * Check if category flag and delete is enabled
   */
  isCategoryFlagDeleteEnabled(
    category: string,
    settings: {
      flagDeleteBlackmail?: boolean;
      flagDeleteThreat?: boolean;
      flagDeleteHarassment?: boolean;
      flagDeleteDefamation?: boolean;
      flagDeleteSpam?: boolean;
    }
  ): boolean {
    if (!category || typeof category !== 'string') {
      return false;
    }
    
    switch (category.toLowerCase()) {
      case 'blackmail':
        return settings.flagDeleteBlackmail ?? false;
      case 'threat':
        return settings.flagDeleteThreat ?? false;
      case 'harassment':
        return settings.flagDeleteHarassment ?? false;
      case 'defamation':
        return settings.flagDeleteDefamation ?? false;
      case 'spam':
        return settings.flagDeleteSpam ?? false;
      default:
        return false;
    }
  }

  /**
   * Get flag and hide threshold for category
   */
  getCategoryFlagHideThreshold(
    category: string,
    settings: {
      flagHideBlackmailThreshold?: number;
      flagHideThreatThreshold?: number;
      flagHideHarassmentThreshold?: number;
      flagHideDefamationThreshold?: number;
      flagHideSpamThreshold?: number;
      globalThreshold: number;
    }
  ): number {
    if (!category || typeof category !== 'string') {
      return settings.globalThreshold;
    }
    
    switch (category.toLowerCase()) {
      case 'blackmail':
        return settings.flagHideBlackmailThreshold ?? settings.globalThreshold;
      case 'threat':
        return settings.flagHideThreatThreshold ?? settings.globalThreshold;
      case 'harassment':
        return settings.flagHideHarassmentThreshold ?? settings.globalThreshold;
      case 'defamation':
        return settings.flagHideDefamationThreshold ?? settings.globalThreshold;
      case 'spam':
        return settings.flagHideSpamThreshold ?? settings.globalThreshold;
      default:
        return settings.globalThreshold;
    }
  }

  /**
   * Get flag and delete threshold for category
   */
  getCategoryFlagDeleteThreshold(
    category: string,
    settings: {
      flagDeleteBlackmailThreshold?: number;
      flagDeleteThreatThreshold?: number;
      flagDeleteHarassmentThreshold?: number;
      flagDeleteDefamationThreshold?: number;
      flagDeleteSpamThreshold?: number;
      globalThreshold: number;
    }
  ): number {
    if (!category || typeof category !== 'string') {
      return settings.globalThreshold;
    }
    
    switch (category.toLowerCase()) {
      case 'blackmail':
        return settings.flagDeleteBlackmailThreshold ?? settings.globalThreshold;
      case 'threat':
        return settings.flagDeleteThreatThreshold ?? settings.globalThreshold;
      case 'harassment':
        return settings.flagDeleteHarassmentThreshold ?? settings.globalThreshold;
      case 'defamation':
        return settings.flagDeleteDefamationThreshold ?? settings.globalThreshold;
      case 'spam':
        return settings.flagDeleteSpamThreshold ?? settings.globalThreshold;
      default:
        return settings.globalThreshold;
    }
  }
}

export const riskScoringService = new RiskScoringService();

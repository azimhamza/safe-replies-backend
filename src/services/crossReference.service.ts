import { db } from '../db';
import { extractedIdentifiers, suspiciousAccounts, instagramAccounts } from '../db/schema';
import { eq, desc, and, gte } from 'drizzle-orm';
import { IdentifierType } from '../types';

interface IdentifierData {
  type: IdentifierType;
  value: string;
  normalizedValue: string;
  confidence: number;
  createdAt: Date;
}

interface IdentifierDataWithAccounts extends IdentifierData {
  accounts: string[];
}

interface ClusterIdentifier {
  type: IdentifierType;
  value: string;
  normalizedValue: string;
  accounts: string[];
  confidence: number;
}

interface IdentifierCluster {
  clusterId: string;
  identifiers: ClusterIdentifier[];
  accountCount: number;
  totalMentions: number;
  likelyRealName?: string;
  likelyEmail?: string;
  likelyPhone?: string;
  paymentMethods: string[];
  riskScore: number;
}

interface CrossReferenceResult {
  clusters: IdentifierCluster[];
  totalClusters: number;
  highRiskClusters: number;
}

export class CrossReferenceService {
  /**
   * Build identifier clusters by linking accounts that share multiple identifiers
   */
  async buildIdentifierClusters(
    clientId?: string,
    userId?: string,
    daysBack: number = 90,
    minSharedIdentifiers: number = 2
  ): Promise<CrossReferenceResult> {
    // Build where conditions, filtering out undefined values
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    
    const whereConditions = [
      gte(extractedIdentifiers.createdAt, cutoffDate),
      eq(extractedIdentifiers.isActive, true)
    ];

    if (clientId) {
      whereConditions.push(eq(instagramAccounts.clientId, clientId));
    }

    if (userId) {
      whereConditions.push(eq(instagramAccounts.userId, userId));
    }

    // Get all identifiers from recent activity
    const recentIdentifiers = await db
      .select({
        identifier: extractedIdentifiers.identifier,
        normalizedIdentifier: extractedIdentifiers.normalizedIdentifier,
        identifierType: extractedIdentifiers.identifierType,
        accountId: suspiciousAccounts.id,
        accountUsername: suspiciousAccounts.commenterUsername,
        confidence: extractedIdentifiers.confidence,
        createdAt: extractedIdentifiers.createdAt
      })
      .from(extractedIdentifiers)
      .innerJoin(suspiciousAccounts, eq(extractedIdentifiers.suspiciousAccountId, suspiciousAccounts.id))
      .innerJoin(instagramAccounts, eq(suspiciousAccounts.instagramAccountId, instagramAccounts.id))
      .where(and(...whereConditions))
      .orderBy(desc(extractedIdentifiers.createdAt));

    // Build account-to-identifiers mapping
    const accountIdentifiers = new Map<string, Map<string, IdentifierData[]>>();
    const identifierAccounts = new Map<string, Set<string>>();

    for (const row of recentIdentifiers) {
      const accountId = row.accountId;
      const identifierKey = `${row.normalizedIdentifier}-${row.identifierType}`;

      // Track identifiers per account
      if (!accountIdentifiers.has(accountId)) {
        accountIdentifiers.set(accountId, new Map());
      }
      const accountMap = accountIdentifiers.get(accountId)!;

      if (!accountMap.has(identifierKey)) {
        accountMap.set(identifierKey, []);
      }
      accountMap.get(identifierKey)!.push({
        type: row.identifierType as IdentifierType,
        value: row.identifier,
        normalizedValue: row.normalizedIdentifier,
        confidence: parseFloat(row.confidence),
        createdAt: row.createdAt || new Date()
      });

      // Track accounts per identifier
      if (!identifierAccounts.has(identifierKey)) {
        identifierAccounts.set(identifierKey, new Set());
      }
      identifierAccounts.get(identifierKey)!.add(accountId);
    }

    // Find clusters of accounts that share multiple identifiers
    const clusters: IdentifierCluster[] = [];
    const processedAccounts = new Set<string>();

    for (const [accountId] of accountIdentifiers) {
      if (processedAccounts.has(accountId)) continue;

      const clusterAccounts = new Set<string>([accountId]);
      const clusterIdentifiers = new Map<string, IdentifierDataWithAccounts>();

      // Use breadth-first search to find all connected accounts
      const queue = [accountId];

      while (queue.length > 0) {
        const currentAccount = queue.shift()!;
        if (processedAccounts.has(currentAccount)) continue;
        processedAccounts.add(currentAccount);

        const currentIdentifiers = accountIdentifiers.get(currentAccount);
        if (!currentIdentifiers) continue;

        // Find other accounts that share identifiers with this account
        for (const [identifierKey, identifierData] of currentIdentifiers) {
          const connectedAccounts = identifierAccounts.get(identifierKey);
          if (!connectedAccounts) continue;

          for (const connectedAccount of connectedAccounts) {
            if (!clusterAccounts.has(connectedAccount)) {
              // Check if this account shares enough identifiers to be in the cluster
              const sharedCount = this.countSharedIdentifiers(
                accountIdentifiers.get(currentAccount)!,
                accountIdentifiers.get(connectedAccount)!
              );

              if (sharedCount >= minSharedIdentifiers) {
                clusterAccounts.add(connectedAccount);
                queue.push(connectedAccount);
              }
            }
          }

          // Add identifier to cluster
          if (!clusterIdentifiers.has(identifierKey)) {
            clusterIdentifiers.set(identifierKey, {
              ...identifierData[0],
              accounts: Array.from(connectedAccounts)
            });
          }
        }
      }

      // Only create cluster if it has multiple accounts
      if (clusterAccounts.size >= 2) {
        const cluster = this.buildClusterFromAccounts(
          Array.from(clusterAccounts),
          clusterIdentifiers
        );
        clusters.push(cluster);
      }
    }

    // Calculate risk scores and identify high-risk clusters
    let highRiskClusters = 0;
    for (const cluster of clusters) {
      cluster.riskScore = this.calculateClusterRiskScore(cluster);
      if (cluster.riskScore >= 70) {
        highRiskClusters++;
      }
    }

    return {
      clusters: clusters.sort((a, b) => b.riskScore - a.riskScore),
      totalClusters: clusters.length,
      highRiskClusters
    };
  }

  /**
   * Link identifiers within a cluster to identify likely real information
   */
  private buildClusterFromAccounts(
    accountIds: string[],
    identifierMap: Map<string, IdentifierDataWithAccounts>
  ): IdentifierCluster {
    const identifiers = Array.from(identifierMap.values()).map(id => ({
      type: id.type,
      value: id.value,
      normalizedValue: id.normalizedValue,
      accounts: id.accounts.filter(acc => accountIds.includes(acc)),
      confidence: id.confidence
    }));

    // Try to identify likely real information
    const likelyRealName = this.identifyLikelyRealName(identifiers);
    const likelyEmail = this.identifyLikelyEmail(identifiers);
    const likelyPhone = this.identifyLikelyPhone(identifiers);
    const paymentMethods = this.identifyPaymentMethods(identifiers);

    const totalMentions = identifiers.reduce((sum, id) => sum + id.accounts.length, 0);

    return {
      clusterId: this.generateClusterId(accountIds),
      identifiers,
      accountCount: accountIds.length,
      totalMentions,
      likelyRealName,
      likelyEmail,
      likelyPhone,
      paymentMethods,
      riskScore: 0 // Will be calculated later
    };
  }

  /**
   * Count shared identifiers between two accounts
   */
  private countSharedIdentifiers(
    identifiers1: Map<string, IdentifierData[]>,
    identifiers2: Map<string, IdentifierData[]>
  ): number {
    let shared = 0;
    for (const key of identifiers1.keys()) {
      if (identifiers2.has(key)) {
        shared++;
      }
    }
    return shared;
  }

  /**
   * Generate a unique cluster ID
   */
  private generateClusterId(accountIds: string[]): string {
    return accountIds.sort().join('-');
  }

  /**
   * Try to identify the most likely real name from identifiers
   */
  private identifyLikelyRealName(identifiers: ClusterIdentifier[]): string | undefined {
    // Look for username identifiers that look like real names
    const usernameIdentifiers = identifiers.filter(id => id.type === IdentifierType.USERNAME);
    if (usernameIdentifiers.length === 0) return undefined;

    // Find the most common username that appears across multiple accounts
    const usernameCounts = new Map<string, number>();
    for (const id of usernameIdentifiers) {
      const count = usernameCounts.get(id.normalizedValue) || 0;
      usernameCounts.set(id.normalizedValue, count + id.accounts.length);
    }

    let bestUsername: string | undefined;
    let bestScore = 0;

    for (const [username, score] of usernameCounts) {
      if (score > bestScore && this.looksLikeRealName(username)) {
        bestScore = score;
        bestUsername = username;
      }
    }

    return bestUsername;
  }

  /**
   * Try to identify the most likely email
   */
  private identifyLikelyEmail(identifiers: ClusterIdentifier[]): string | undefined {
    const emailIdentifiers = identifiers.filter(id => id.type === IdentifierType.EMAIL);
    if (emailIdentifiers.length === 0) return undefined;

    // Return the email that appears most frequently
    let bestEmail: string | undefined;
    let bestScore = 0;

    for (const id of emailIdentifiers) {
      const score = id.accounts.length;
      if (score > bestScore) {
        bestScore = score;
        bestEmail = id.value;
      }
    }

    return bestEmail;
  }

  /**
   * Try to identify the most likely phone number
   */
  private identifyLikelyPhone(identifiers: ClusterIdentifier[]): string | undefined {
    const phoneIdentifiers = identifiers.filter(id => id.type === IdentifierType.PHONE);
    if (phoneIdentifiers.length === 0) return undefined;

    // Return the phone that appears most frequently
    let bestPhone: string | undefined;
    let bestScore = 0;

    for (const id of phoneIdentifiers) {
      const score = id.accounts.length;
      if (score > bestScore) {
        bestScore = score;
        bestPhone = id.value;
      }
    }

    return bestPhone;
  }

  /**
   * Identify payment methods used by the cluster
   */
  private identifyPaymentMethods(identifiers: ClusterIdentifier[]): string[] {
    const paymentTypes = [IdentifierType.VENMO, IdentifierType.CASHAPP, IdentifierType.PAYPAL, IdentifierType.ZELLE];
    const paymentMethods: string[] = [];

    for (const type of paymentTypes) {
      const typeIdentifiers = identifiers.filter(id => id.type === type);
      if (typeIdentifiers.length > 0) {
        paymentMethods.push(type);
      }
    }

    return paymentMethods;
  }

  /**
   * Check if a username looks like a real name
   */
  private looksLikeRealName(username: string): boolean {
    // Simple heuristic: contains spaces or looks like first/last name
    if (username.includes(' ')) return true;
    if (username.length < 3) return false;
    if (/^\d+$/.test(username)) return false; // Just numbers
    if (/^@/.test(username)) return false; // Starts with @
    return true;
  }

  /**
   * Calculate risk score for a cluster
   */
  private calculateClusterRiskScore(cluster: IdentifierCluster): number {
    let score = 0;

    // Base score from account count
    score += Math.min(cluster.accountCount * 10, 40);

    // Bonus for multiple payment methods
    score += cluster.paymentMethods.length * 15;

    // Bonus for email/phone identification
    if (cluster.likelyEmail) score += 20;
    if (cluster.likelyPhone) score += 20;
    if (cluster.likelyRealName) score += 15;

    // Bonus for total mentions (activity level)
    score += Math.min(cluster.totalMentions * 2, 30);

    return Math.min(score, 100);
  }
}

export const crossReferenceService = new CrossReferenceService();
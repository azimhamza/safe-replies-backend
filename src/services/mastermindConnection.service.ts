import { db } from '../db';
import {
  botNetworkMasterminds,
  botNetworkConnections,
  suspiciousAccounts,
  extractedIdentifiers,
  comments,
  accountCommentMap
} from '../db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { ThreatLevel } from '../types';

interface CreateConnectionInput {
  suspiciousAccountId: string;
  mastermindId?: string;
  mastermindName?: string;
  knownIdentifiers?: Array<{ type: string; value: string }>;
  evidenceDescription: string;
  confidence: 'CONFIRMED' | 'HIGHLY_LIKELY' | 'SUSPECTED' | 'INVESTIGATING';
  connectionEvidence: string;
  evidenceAttachments?: string[];
  clientId?: string;
  userId?: string;
  detectedBy: 'MANUAL_INVESTIGATION' | 'PATTERN_DETECTION' | 'EXTERNAL_TIP' | 'THREAT_NETWORK' | 'MENTION_ANALYSIS';
}

interface MastermindConnection {
  connectionId: string;
  mastermindId: string;
  mastermindName: string;
  threatLevel: ThreatLevel;
  networkType: string;
  confidence: 'CONFIRMED' | 'HIGHLY_LIKELY' | 'SUSPECTED' | 'INVESTIGATING';
  connectedAt: Date;
  connectionEvidence: string;
  mentionsByConnectedAccounts: Array<{
    mentioningAccountId: string;
    mentioningAccountUsername: string;
    mentionCount: number;
    mentionedIdentifier: string;
    mentionType: string;
    sampleComments: Array<{
      commentId: string;
      commentText: string;
      commentedAt: Date;
    }>;
  }>;
  networkAccounts: Array<{
    accountId: string;
    username: string;
    connectionStrength: string;
    sharedIdentifiers: Array<{ type: string; value: string }>;
  }>;
}

export class MastermindConnectionService {
  /**
   * Get all mastermind connections for a suspicious account
   */
  async getConnectionsForAccount(
    suspiciousAccountId: string,
    clientId?: string,
    userId?: string
  ): Promise<MastermindConnection[]> {
    // Get all active connections for this account
    const connections = await db
      .select({
        connectionId: botNetworkConnections.id,
        mastermindId: botNetworkMasterminds.id,
        mastermindName: botNetworkMasterminds.name,
        threatLevel: botNetworkMasterminds.threatLevel,
        networkType: botNetworkMasterminds.networkType,
        confidence: botNetworkConnections.confidence,
        connectedAt: botNetworkConnections.createdAt,
        connectionEvidence: botNetworkConnections.connectionEvidence,
        knownIdentifiers: botNetworkMasterminds.knownIdentifiers
      })
      .from(botNetworkConnections)
      .innerJoin(
        botNetworkMasterminds,
        eq(botNetworkConnections.mastermindId, botNetworkMasterminds.id)
      )
      .where(
        and(
          eq(botNetworkConnections.suspiciousAccountId, suspiciousAccountId),
          eq(botNetworkConnections.isActive, true),
          ...(clientId ? [eq(botNetworkMasterminds.clientId, clientId)] : []),
          ...(userId ? [eq(botNetworkMasterminds.userId, userId)] : [])
        )
      );

    const result: MastermindConnection[] = [];

    for (const conn of connections) {
      // Get other accounts connected to the same mastermind
      const networkAccounts = await this.getNetworkAccounts(
        conn.mastermindId,
        suspiciousAccountId,
        clientId,
        userId
      );

      // Get mentions by connected accounts
      const mentions = await this.getMentionsByConnectedAccounts(
        suspiciousAccountId,
        conn.mastermindId,
        clientId,
        userId
      );

      result.push({
        connectionId: conn.connectionId,
        mastermindId: conn.mastermindId,
        mastermindName: conn.mastermindName,
        threatLevel: conn.threatLevel as ThreatLevel,
        networkType: conn.networkType,
        confidence: conn.confidence,
        connectedAt: conn.connectedAt ?? new Date(),
        connectionEvidence: conn.connectionEvidence,
        mentionsByConnectedAccounts: mentions,
        networkAccounts: networkAccounts
      });
    }

    return result;
  }

  /**
   * Get other accounts in the same mastermind network
   */
  private async getNetworkAccounts(
    mastermindId: string,
    excludeAccountId: string,
    _clientId?: string,
    _userId?: string
  ): Promise<Array<{
    accountId: string;
    username: string;
    connectionStrength: string;
    sharedIdentifiers: Array<{ type: string; value: string }>;
  }>> {
    const networkConnections = await db
      .select({
        accountId: suspiciousAccounts.id,
        username: suspiciousAccounts.commenterUsername,
        confidence: botNetworkConnections.confidence,
        connectionEvidence: botNetworkConnections.connectionEvidence
      })
      .from(botNetworkConnections)
      .innerJoin(
        suspiciousAccounts,
        eq(botNetworkConnections.suspiciousAccountId, suspiciousAccounts.id)
      )
      .where(
        and(
          eq(botNetworkConnections.mastermindId, mastermindId),
          eq(botNetworkConnections.isActive, true),
          sql`${botNetworkConnections.suspiciousAccountId} != ${excludeAccountId}`
        )
      );

    const accounts = [];
    for (const conn of networkConnections) {
      // Get shared identifiers for this account
      const identifiers = await db
        .select({
          type: extractedIdentifiers.identifierType,
          value: extractedIdentifiers.identifier
        })
        .from(extractedIdentifiers)
        .innerJoin(
          accountCommentMap,
          eq(extractedIdentifiers.commentId, accountCommentMap.commentId)
        )
        .where(eq(accountCommentMap.suspiciousAccountId, conn.accountId))
        .limit(5);

      accounts.push({
        accountId: conn.accountId,
        username: conn.username,
        connectionStrength: conn.confidence,
        sharedIdentifiers: identifiers.map(id => ({
          type: id.type || 'UNKNOWN',
          value: id.value || ''
        }))
      });
    }

    return accounts;
  }

  /**
   * Get mentions of this account by other accounts connected to the same mastermind
   */
  private async getMentionsByConnectedAccounts(
    targetAccountId: string,
    mastermindId: string,
    _clientId?: string,
    _userId?: string
  ): Promise<Array<{
    mentioningAccountId: string;
    mentioningAccountUsername: string;
    mentionCount: number;
    mentionedIdentifier: string;
    mentionType: string;
    sampleComments: Array<{
      commentId: string;
      commentText: string;
      commentedAt: Date;
    }>;
  }>> {
    // Get identifiers for the target account
    const targetIdentifiers = await db
      .select({
        type: extractedIdentifiers.identifierType,
        value: extractedIdentifiers.identifier,
        normalizedValue: extractedIdentifiers.normalizedIdentifier
      })
      .from(extractedIdentifiers)
      .innerJoin(
        accountCommentMap,
        eq(extractedIdentifiers.commentId, accountCommentMap.commentId)
      )
      .where(eq(accountCommentMap.suspiciousAccountId, targetAccountId));

    if (targetIdentifiers.length === 0) {
      return [];
    }

    // Get all other accounts connected to this mastermind
    const connectedAccounts = await db
      .select({
        accountId: suspiciousAccounts.id,
        username: suspiciousAccounts.commenterUsername
      })
      .from(botNetworkConnections)
      .innerJoin(
        suspiciousAccounts,
        eq(botNetworkConnections.suspiciousAccountId, suspiciousAccounts.id)
      )
      .where(
        and(
          eq(botNetworkConnections.mastermindId, mastermindId),
          eq(botNetworkConnections.isActive, true),
          sql`${botNetworkConnections.suspiciousAccountId} != ${targetAccountId}`
        )
      );

    const mentionsMap = new Map<string, {
      mentioningAccountId: string;
      mentioningAccountUsername: string;
      mentionCount: number;
      mentionedIdentifier: string;
      mentionType: string;
      sampleComments: Array<{
        commentId: string;
        commentText: string;
        commentedAt: Date;
      }>;
    }>();

    // For each connected account, check if their comments mention target account identifiers
    for (const connectedAccount of connectedAccounts) {
      // Get comments from this connected account
      const accountComments = await db
        .select({
          commentId: comments.id,
          commentText: comments.text,
          commentedAt: comments.commentedAt
        })
        .from(comments)
        .innerJoin(
          accountCommentMap,
          eq(comments.id, accountCommentMap.commentId)
        )
        .where(eq(accountCommentMap.suspiciousAccountId, connectedAccount.accountId))
        .orderBy(desc(comments.commentedAt))
        .limit(100);

      // Check each comment for mentions of target identifiers
      for (const comment of accountComments) {
        for (const identifier of targetIdentifiers) {
          const normalizedValue = identifier.normalizedValue || identifier.value?.toLowerCase() || '';
          const commentTextLower = comment.commentText.toLowerCase();

          // Check if comment contains the identifier (exact match or partial)
          if (normalizedValue && commentTextLower.includes(normalizedValue.toLowerCase())) {
            const key = `${connectedAccount.accountId}-${identifier.value}`;
            
            if (!mentionsMap.has(key)) {
              mentionsMap.set(key, {
                mentioningAccountId: connectedAccount.accountId,
                mentioningAccountUsername: connectedAccount.username,
                mentionCount: 0,
                mentionedIdentifier: identifier.value || '',
                mentionType: identifier.type || 'UNKNOWN',
                sampleComments: []
              });
            }

            const mention = mentionsMap.get(key)!;
            mention.mentionCount++;
            if (mention.sampleComments.length < 3) {
              mention.sampleComments.push({
                commentId: comment.commentId,
                commentText: comment.commentText,
                commentedAt: comment.commentedAt
              });
            }
          }
        }
      }
    }

    return Array.from(mentionsMap.values());
  }

  /**
   * Create a connection between a suspicious account and a mastermind
   */
  async createConnection(input: CreateConnectionInput): Promise<{
    connectionId: string;
    mastermindId: string;
  }> {
    let mastermindId = input.mastermindId;

    // Create mastermind if it doesn't exist
    if (!mastermindId && input.mastermindName) {
      const [newMastermind] = await db
        .insert(botNetworkMasterminds)
        .values({
          name: input.mastermindName,
          knownIdentifiers: input.knownIdentifiers || [],
          evidenceDescription: input.evidenceDescription,
          evidenceAttachments: input.evidenceAttachments || [],
          threatLevel: 'MEDIUM', // Default, can be updated
          networkType: 'SPAM_NETWORK', // Default, can be updated
          discoveryMethod: input.detectedBy,
          clientId: input.clientId || undefined,
          userId: input.userId || undefined,
          firstDetected: new Date()
        })
        .returning();

      mastermindId = newMastermind.id;
    }

    if (!mastermindId) {
      throw new Error('Either mastermindId or mastermindName must be provided');
    }

    // Create the connection
    const [connection] = await db
      .insert(botNetworkConnections)
      .values({
        mastermindId: mastermindId,
        suspiciousAccountId: input.suspiciousAccountId,
        confidence: input.confidence,
        connectionEvidence: input.connectionEvidence,
        evidenceAttachments: input.evidenceAttachments || [],
        detectedBy: input.detectedBy
      })
      .returning();

    // Update mastermind stats
    await db
      .update(botNetworkMasterminds)
      .set({
        totalBotAccounts: sql`${botNetworkMasterminds.totalBotAccounts} + 1`,
        lastActivity: new Date()
      })
      .where(eq(botNetworkMasterminds.id, mastermindId));

    return {
      connectionId: connection.id,
      mastermindId: mastermindId
    };
  }

  /**
   * Find all mentions of this account by connected accounts
   */
  async findMentionsByConnectedAccounts(
    suspiciousAccountId: string,
    clientId?: string,
    userId?: string
  ): Promise<Array<{
    mastermindId: string;
    mastermindName: string;
    mentions: Array<{
      mentioningAccountId: string;
      mentioningAccountUsername: string;
      mentionCount: number;
      mentionedIdentifier: string;
      mentionType: string;
      sampleComments: Array<{
        commentId: string;
        commentText: string;
        commentedAt: Date;
      }>;
    }>;
  }>> {
    const connections = await this.getConnectionsForAccount(
      suspiciousAccountId,
      clientId,
      userId
    );

    return connections.map(conn => ({
      mastermindId: conn.mastermindId,
      mastermindName: conn.mastermindName,
      mentions: conn.mentionsByConnectedAccounts
    }));
  }

  /**
   * Detect if a comment mentions any mastermind identifiers
   */
  detectMentionsInComment(
    commentText: string,
    identifiers: Array<{ type: string; value: string; normalizedValue?: string }>
  ): Array<{ identifier: string; type: string; position: number }> {
    const mentions: Array<{ identifier: string; type: string; position: number }> = [];
    const commentTextLower = commentText.toLowerCase();

    for (const identifier of identifiers) {
      const searchValue = (identifier.normalizedValue || identifier.value || '').toLowerCase();
      if (searchValue && commentTextLower.includes(searchValue)) {
        const position = commentTextLower.indexOf(searchValue);
        mentions.push({
          identifier: identifier.value || '',
          type: identifier.type || 'UNKNOWN',
          position
        });
      }
    }

    return mentions;
  }
}

export const mastermindConnectionService = new MastermindConnectionService();

import { relations } from 'drizzle-orm/relations';
import {
  users,
  clients,
  moderationSettings,
  instagramAccounts,
  facebookPages,
  followerHistory,
  posts,
  comments,
  moderationLogs,
  evidenceRecords,
  keywordFilters,
  customFilters,
  suspiciousAccounts,
  accountCommentMap,
  evidenceAttachments,
  legalCases,
  caseEvidenceMap,
  globalThreatNetwork,
  agencyNetworkSettings,
  threatNetworkReports,
  knownThreatsWatchlist,
  watchlistDetections,
  whitelistedIdentifiers,
  extractedIdentifiers,
  botNetworkMasterminds,
  botNetworkConnections,
  mastermindMentions,
} from './schema';

// Users relations
export const usersRelations = relations(users, ({ many }) => ({
  clients: many(clients),
  moderationSettings: many(moderationSettings),
  instagramAccounts: many(instagramAccounts),
  keywordFilters: many(keywordFilters),
  customFilters: many(customFilters),
  knownThreatsWatchlist: many(knownThreatsWatchlist),
  whitelistedIdentifiers: many(whitelistedIdentifiers),
  botNetworkMasterminds: many(botNetworkMasterminds),
  agencyNetworkSettings: many(agencyNetworkSettings),
  threatNetworkReports: many(threatNetworkReports),
}));

// Clients relations
export const clientsRelations = relations(clients, ({ one, many }) => ({
  user: one(users, {
    fields: [clients.userId],
    references: [users.id],
  }),
  moderationSettings: many(moderationSettings),
  instagramAccounts: many(instagramAccounts),
  keywordFilters: many(keywordFilters),
  customFilters: many(customFilters),
  knownThreatsWatchlist: many(knownThreatsWatchlist),
  whitelistedIdentifiers: many(whitelistedIdentifiers),
  legalCases: many(legalCases),
  botNetworkMasterminds: many(botNetworkMasterminds),
}));

// Moderation settings relations
export const moderationSettingsRelations = relations(moderationSettings, ({ one }) => ({
  client: one(clients, {
    fields: [moderationSettings.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [moderationSettings.userId],
    references: [users.id],
  }),
}));

// Instagram accounts relations
export const instagramAccountsRelations = relations(instagramAccounts, ({ one, many }) => ({
  client: one(clients, {
    fields: [instagramAccounts.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [instagramAccounts.userId],
    references: [users.id],
  }),
  posts: many(posts),
  suspiciousAccounts: many(suspiciousAccounts),
  followerHistory: many(followerHistory),
}));

// Facebook pages relations
export const facebookPagesRelations = relations(facebookPages, ({ one, many }) => ({
  client: one(clients, {
    fields: [facebookPages.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [facebookPages.userId],
    references: [users.id],
  }),
  followerHistory: many(followerHistory),
}));

// Follower history relations
export const followerHistoryRelations = relations(followerHistory, ({ one }) => ({
  instagramAccount: one(instagramAccounts, {
    fields: [followerHistory.instagramAccountId],
    references: [instagramAccounts.id],
  }),
  facebookPage: one(facebookPages, {
    fields: [followerHistory.facebookPageId],
    references: [facebookPages.id],
  }),
}));

// Posts relations
export const postsRelations = relations(posts, ({ one, many }) => ({
  instagramAccount: one(instagramAccounts, {
    fields: [posts.instagramAccountId],
    references: [instagramAccounts.id],
  }),
  comments: many(comments),
}));

// Comments relations
export const commentsRelations = relations(comments, ({ one, many }) => ({
  post: one(posts, {
    fields: [comments.postId],
    references: [posts.id],
  }),
  moderationLogs: many(moderationLogs),
  accountCommentMap: many(accountCommentMap),
  evidenceAttachments: many(evidenceAttachments),
  watchlistDetections: many(watchlistDetections),
  mastermindMentions: many(mastermindMentions),
  caseEvidenceMap: many(caseEvidenceMap),
}));

// Moderation logs relations
export const moderationLogsRelations = relations(moderationLogs, ({ one, many }) => ({
  comment: one(comments, {
    fields: [moderationLogs.commentId],
    references: [comments.id],
  }),
  evidenceRecords: many(evidenceRecords),
}));

// Evidence records relations
export const evidenceRecordsRelations = relations(evidenceRecords, ({ one }) => ({
  moderationLog: one(moderationLogs, {
    fields: [evidenceRecords.moderationLogId],
    references: [moderationLogs.id],
  }),
}));

// Keyword filters relations
export const keywordFiltersRelations = relations(keywordFilters, ({ one }) => ({
  client: one(clients, {
    fields: [keywordFilters.clientId],
    references: [clients.id],
  }),
}));

// Custom filters relations
export const customFiltersRelations = relations(customFilters, ({ one }) => ({
  client: one(clients, {
    fields: [customFilters.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [customFilters.userId],
    references: [users.id],
  }),
}));

// Suspicious accounts relations
export const suspiciousAccountsRelations = relations(suspiciousAccounts, ({ one, many }) => ({
  instagramAccount: one(instagramAccounts, {
    fields: [suspiciousAccounts.instagramAccountId],
    references: [instagramAccounts.id],
  }),
  accountCommentMap: many(accountCommentMap),
  legalCases: many(legalCases),
  botNetworkConnections: many(botNetworkConnections),
}));

// Account comment map relations
export const accountCommentMapRelations = relations(accountCommentMap, ({ one }) => ({
  suspiciousAccount: one(suspiciousAccounts, {
    fields: [accountCommentMap.suspiciousAccountId],
    references: [suspiciousAccounts.id],
  }),
  comment: one(comments, {
    fields: [accountCommentMap.commentId],
    references: [comments.id],
  }),
}));

// Evidence attachments relations
export const evidenceAttachmentsRelations = relations(evidenceAttachments, ({ one, many }) => ({
  comment: one(comments, {
    fields: [evidenceAttachments.commentId],
    references: [comments.id],
  }),
  caseEvidenceMap: many(caseEvidenceMap),
}));

// Legal cases relations
export const legalCasesRelations = relations(legalCases, ({ one, many }) => ({
  client: one(clients, {
    fields: [legalCases.clientId],
    references: [clients.id],
  }),
  suspiciousAccount: one(suspiciousAccounts, {
    fields: [legalCases.suspiciousAccountId],
    references: [suspiciousAccounts.id],
  }),
  caseEvidenceMap: many(caseEvidenceMap),
}));

// Case evidence map relations
export const caseEvidenceMapRelations = relations(caseEvidenceMap, ({ one }) => ({
  legalCase: one(legalCases, {
    fields: [caseEvidenceMap.legalCaseId],
    references: [legalCases.id],
  }),
  comment: one(comments, {
    fields: [caseEvidenceMap.commentId],
    references: [comments.id],
  }),
  evidenceAttachment: one(evidenceAttachments, {
    fields: [caseEvidenceMap.evidenceAttachmentId],
    references: [evidenceAttachments.id],
  }),
}));

// Global threat network relations
export const globalThreatNetworkRelations = relations(globalThreatNetwork, ({ many }) => ({
  threatNetworkReports: many(threatNetworkReports),
}));

// Agency network settings relations
export const agencyNetworkSettingsRelations = relations(agencyNetworkSettings, ({ one }) => ({
  user: one(users, {
    fields: [agencyNetworkSettings.userId],
    references: [users.id],
  }),
}));

// Threat network reports relations
export const threatNetworkReportsRelations = relations(threatNetworkReports, ({ one }) => ({
  globalThreat: one(globalThreatNetwork, {
    fields: [threatNetworkReports.globalThreatId],
    references: [globalThreatNetwork.id],
  }),
  reportingAgency: one(users, {
    fields: [threatNetworkReports.reportingAgencyId],
    references: [users.id],
  }),
}));

// Known threats watchlist relations
export const knownThreatsWatchlistRelations = relations(knownThreatsWatchlist, ({ one, many }) => ({
  client: one(clients, {
    fields: [knownThreatsWatchlist.clientId],
    references: [clients.id],
  }),
  watchlistDetections: many(watchlistDetections),
}));

// Watchlist detections relations
export const watchlistDetectionsRelations = relations(watchlistDetections, ({ one }) => ({
  knownThreat: one(knownThreatsWatchlist, {
    fields: [watchlistDetections.knownThreatId],
    references: [knownThreatsWatchlist.id],
  }),
  comment: one(comments, {
    fields: [watchlistDetections.commentId],
    references: [comments.id],
  }),
}));

// Whitelisted identifiers relations
export const whitelistedIdentifiersRelations = relations(whitelistedIdentifiers, ({ one }) => ({
  client: one(clients, {
    fields: [whitelistedIdentifiers.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [whitelistedIdentifiers.userId],
    references: [users.id],
  }),
}));

// Extracted identifiers relations
export const extractedIdentifiersRelations = relations(extractedIdentifiers, ({ one }) => ({
  comment: one(comments, {
    fields: [extractedIdentifiers.commentId],
    references: [comments.id],
  }),
  suspiciousAccount: one(suspiciousAccounts, {
    fields: [extractedIdentifiers.suspiciousAccountId],
    references: [suspiciousAccounts.id],
  }),
}));

// Bot network masterminds relations
export const botNetworkMastermindsRelations = relations(botNetworkMasterminds, ({ one, many }) => ({
  client: one(clients, {
    fields: [botNetworkMasterminds.clientId],
    references: [clients.id],
  }),
  user: one(users, {
    fields: [botNetworkMasterminds.userId],
    references: [users.id],
  }),
  botNetworkConnections: many(botNetworkConnections),
  mastermindMentions: many(mastermindMentions),
}));

// Bot network connections relations
export const botNetworkConnectionsRelations = relations(botNetworkConnections, ({ one, many }) => ({
  mastermind: one(botNetworkMasterminds, {
    fields: [botNetworkConnections.mastermindId],
    references: [botNetworkMasterminds.id],
  }),
  suspiciousAccount: one(suspiciousAccounts, {
    fields: [botNetworkConnections.suspiciousAccountId],
    references: [suspiciousAccounts.id],
  }),
  mastermindMentions: many(mastermindMentions),
}));

// Mastermind mentions relations
export const mastermindMentionsRelations = relations(mastermindMentions, ({ one }) => ({
  mastermind: one(botNetworkMasterminds, {
    fields: [mastermindMentions.mastermindId],
    references: [botNetworkMasterminds.id],
  }),
  comment: one(comments, {
    fields: [mastermindMentions.commentId],
    references: [comments.id],
  }),
  botConnection: one(botNetworkConnections, {
    fields: [mastermindMentions.botConnectionId],
    references: [botNetworkConnections.id],
  }),
}));
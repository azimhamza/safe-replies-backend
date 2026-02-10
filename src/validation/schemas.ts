import { z } from 'zod';

// Comment validation
export const CreateCommentSchema = z.object({
  text: z.string().min(1).max(2000),
  commenterUsername: z.string().regex(/^[a-zA-Z0-9._]+$/),
  commenterId: z.string(),
  postId: z.string().uuid()
});

export const ModerationSettingsSchema = z.object({
  autoDeleteBlackmail: z.boolean(),
  autoDeleteThreat: z.boolean(),
  autoDeleteHarassment: z.boolean(),
  autoDeleteDefamation: z.boolean(),
  autoDeleteSpam: z.boolean(),
  blackmailThreshold: z.number().min(0).max(100),
  threatThreshold: z.number().min(0).max(100),
  harassmentThreshold: z.number().min(0).max(100),
  defamationThreshold: z.number().min(0).max(100),
  spamThreshold: z.number().min(0).max(100),
  globalThreshold: z.number().min(0).max(100)
});

// User signup validation
export const AgencySignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(255),
  agencyName: z.string().min(2).max(255).optional(),
  agencyType: z.enum(['BASIC_AGENCY', 'MAX_AGENCY']).default('BASIC_AGENCY')
});

export const CreatorSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(255),
  businessName: z.string().min(2).max(255)
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

// Client creation (by agency)
export const CreateClientSchema = z.object({
  businessName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8).optional() // Optional - will generate temporary password if not provided
});

// Instagram connection
export const InstagramOAuthCallbackSchema = z.object({
  code: z.string(),
  state: z.string()
});

// Legal case validation
export const CreateLegalCaseSchema = z.object({
  suspiciousAccountId: z.string().uuid(),
  caseTitle: z.string().min(5).max(255),
  caseType: z.enum(['BLACKMAIL', 'THREAT', 'HARASSMENT', 'DEFAMATION', 'SPAM_BOT']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  description: z.string().min(20),
  impactStatement: z.string().optional()
});

// Watchlist validation
export const AddWatchlistThreatSchema = z.object({
  instagramUsername: z.string().optional(),
  instagramId: z.string().optional(),
  threatType: z.enum(['blackmail', 'threat', 'harassment', 'defamation', 'spam_bot', 'coordinated_attack']),
  threatLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  description: z.string().min(20),
  source: z.string().optional(),
  evidenceUrl: z.string().url().optional(),
  monitorKeywords: z.array(z.string()).optional(),
  autoBlockDirectComments: z.boolean().default(true),
  autoFlagReferences: z.boolean().default(true),
  escalateImmediately: z.boolean().default(false)
});

// Whitelist validation
export const AddWhitelistIdentifierSchema = z.object({
  identifier: z.string().min(1).max(500),
  identifierType: z.enum(['USERNAME', 'VENMO', 'CASHAPP', 'PAYPAL', 'ZELLE', 'BITCOIN', 'ETHEREUM', 'CRYPTO', 'EMAIL', 'PHONE', 'DOMAIN']),
  description: z.string().optional()
});

// Bot network validation
export const CreateBotNetworkMastermindSchema = z.object({
  name: z.string().min(2).max(255),
  knownIdentifiers: z.object({
    venmo: z.array(z.string()).optional(),
    cashapp: z.array(z.string()).optional(),
    email: z.array(z.string()).optional(),
    phone: z.array(z.string()).optional(),
    realNames: z.array(z.string()).optional()
  }).optional(),
  evidenceDescription: z.string().min(20),
  threatLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  networkType: z.enum(['SPAM_NETWORK', 'BLACKMAIL_RING', 'HARASSMENT_CAMPAIGN', 'COORDINATED_ATTACK']),
  discoveryMethod: z.enum(['MANUAL_INVESTIGATION', 'PATTERN_DETECTION', 'EXTERNAL_TIP', 'THREAT_NETWORK', 'MENTION_ANALYSIS'])
});

export const ConnectBotToNetworkSchema = z.object({
  mastermindId: z.string().uuid(),
  suspiciousAccountId: z.string().uuid(),
  confidence: z.enum(['CONFIRMED', 'HIGHLY_LIKELY', 'SUSPECTED', 'INVESTIGATING']),
  connectionEvidence: z.string().min(20)
});

// Evidence upload validation
export const UploadEvidenceSchema = z.object({
  commentId: z.string().uuid(),
  fileType: z.enum(['IMAGE', 'SCREENSHOT', 'URL', 'VIDEO']),
  screenshotContext: z.string().optional(),
  uploadNotes: z.string().optional()
});

// Export types
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;
export type ModerationSettings = z.infer<typeof ModerationSettingsSchema>;
export type AgencySignupInput = z.infer<typeof AgencySignupSchema>;
export type CreatorSignupInput = z.infer<typeof CreatorSignupSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateClientInput = z.infer<typeof CreateClientSchema>;
export type InstagramOAuthCallback = z.infer<typeof InstagramOAuthCallbackSchema>;
export type CreateLegalCaseInput = z.infer<typeof CreateLegalCaseSchema>;
export type AddWatchlistThreatInput = z.infer<typeof AddWatchlistThreatSchema>;
export type AddWhitelistIdentifierInput = z.infer<typeof AddWhitelistIdentifierSchema>;
export type CreateBotNetworkMastermindInput = z.infer<typeof CreateBotNetworkMastermindSchema>;
export type ConnectBotToNetworkInput = z.infer<typeof ConnectBotToNetworkSchema>;
export type UploadEvidenceInput = z.infer<typeof UploadEvidenceSchema>;

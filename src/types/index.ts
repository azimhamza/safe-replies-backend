// Central type definitions - NO 'any' allowed

// Enums
export enum UserRole {
  BASIC_AGENCY = 'BASIC_AGENCY',
  MAX_AGENCY = 'MAX_AGENCY',
  CREATOR = 'CREATOR',
  CLIENT = 'CLIENT'
}

export enum CommentCategory {
  BLACKMAIL = 'blackmail',
  THREAT = 'threat',
  DEFAMATION = 'defamation',
  HARASSMENT = 'harassment',
  SPAM = 'spam',
  BENIGN = 'benign'
}

export enum ActionTaken {
  DELETED = 'DELETED',
  FLAGGED = 'FLAGGED',
  BENIGN = 'BENIGN',
  BLOCKED = 'BLOCKED',
  RESTRICTED = 'RESTRICTED',
  REPORTED = 'REPORTED',
  APPROVED = 'APPROVED'
}

export enum ThreatType {
  BLACKMAIL = 'blackmail',
  THREAT = 'threat',
  HARASSMENT = 'harassment',
  DEFAMATION = 'defamation',
  SPAM_BOT = 'spam_bot',
  COORDINATED_ATTACK = 'coordinated_attack'
}

export enum ThreatLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export enum IdentifierType {
  USERNAME = 'USERNAME',
  VENMO = 'VENMO',
  CASHAPP = 'CASHAPP',
  PAYPAL = 'PAYPAL',
  ZELLE = 'ZELLE',
  BITCOIN = 'BITCOIN',
  ETHEREUM = 'ETHEREUM',
  CRYPTO = 'CRYPTO',
  EMAIL = 'EMAIL',
  PHONE = 'PHONE',
  DOMAIN = 'DOMAIN'
}

// Service types
export interface RiskScoringInput {
  severity: number; // 0-100
  confidence: number; // 0-1
  repeatOffenderCount: number;
  commentVelocity: number; // comments/hour
  accountAgeDays: number;
}

export interface RiskScoringResult {
  riskScore: number;
  baseScore: number;
  repeatOffenderBonus: number;
  velocityBonus: number;
  accountAgePenalty: number;
  shouldDelete: boolean;
  shouldEscalate: boolean;
}

export interface ExtractedIdentifier {
  type: IdentifierType;
  value: string;
  platform?: string;
}

export interface LLMClassificationResult {
  category: CommentCategory;
  severity: number; // 0-100
  confidence: number; // 0-1
  rationale: string;
  extractedIdentifiers: ExtractedIdentifier[];
}

export interface BotNetworkDetection {
  potentialMastermindIdentifier: string;
  mentionType: IdentifierType | 'unknown' | string; // Allow any identifier type or custom fraud coordination method
  botAccounts: {
    id: string;
    username: string;
    commentCount: number;
  }[];
  confidence: 'CONFIRMED' | 'HIGHLY_LIKELY' | 'SUSPECTED';
  evidence: string[]; // Array of evidence strings
  sampleComments: string[];
}

export interface ModerationResult {
  action: ActionTaken;
  identifiers?: ExtractedIdentifier[];
  llmClassification?: LLMClassificationResult;
  riskScore?: number;
  reason?: string;
}

// API Response types
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// Instagram API types
export interface InstagramComment {
  id: string;
  legacy_instagram_comment_id?: string;
  text: string;
  username: string;
  from?: {
    id: string;
    username: string;
  };
  timestamp: string;
  like_count?: number;
  hidden?: boolean;
  parent_id?: string; // API field: ID of parent comment if this is a reply
  parentCommentId?: string; // Mapped from parent_id for our internal use
}

export interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

export interface InstagramAccount {
  id: string;
  username: string;
  name?: string;
  account_type?: 'BUSINESS' | 'CREATOR' | 'PERSONAL'; // Optional: not reliably available in Instagram Graph API
  followers_count?: number;
  follows_count?: number;
  profile_picture_url?: string;
  media_count?: number;
  biography?: string;
}

// Instagram API Response types
export interface InstagramTokenExchangeResponse {
  access_token: string;
  user_id: string;
  permissions?: string;
}

export interface InstagramLongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface InstagramTokenRefreshResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface InstagramApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface InstagramPaging {
  cursors?: {
    before?: string;
    after?: string;
  };
  next?: string;
  previous?: string;
}

export interface InstagramMediaResponse {
  data: InstagramMedia[];
  paging?: InstagramPaging;
}

export interface InstagramCommentResponse {
  data: InstagramComment[];
  paging?: InstagramPaging;
  error?: InstagramApiError['error'];
}

export interface InstagramWebhookSubscriptionResponse {
  success: boolean;
  error?: {
    message: string;
    type: string;
    code: number;
  };
}

export interface InstagramWebhookSubscription {
  application: {
    id: string;
    name: string;
  };
  subscribed_fields: string[];
}

export interface InstagramWebhookSubscriptionsResponse {
  data: InstagramWebhookSubscription[];
}

export interface InstagramWebhookSubscriptionResult {
  success: boolean;
  subscribedFields?: string[];
  error?: string;
}

export interface InstagramWebhookSubscriptionStatus {
  isSubscribed: boolean;
  subscribedFields: string[];
  error?: string;
}

export interface InstagramTestResult {
  approach: string;
  success: boolean;
  commentCount?: number;
  error?: string;
  response?: unknown;
}

export interface InstagramDeleteCommentResponse {
  success: boolean;
}

export interface InstagramHideCommentResponse {
  success: boolean;
}

export interface InstagramBlockUserResponse {
  success: boolean;
}

export interface InstagramRestrictUserResponse {
  success: boolean;
}

export interface InstagramReportCommentResponse {
  success: boolean;
}

export interface InstagramApproveCommentResponse {
  success: boolean;
}

// Facebook API types
export interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  category: string;
  category_list?: Array<{ id: string; name: string }>;
  picture?: {
    data: {
      url: string;
    };
  };
  instagram_business_account?: {
    id: string;
    username?: string;
    profile_picture_url?: string;
  };
}

export interface FacebookTokenExchangeResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

export interface FacebookLongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface FacebookPagesResponse {
  data: FacebookPage[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface FacebookUserResponse {
  id: string;
  name: string;
  email?: string;
}

export interface FacebookPageAccessTokenResponse {
  access_token: string;
  id: string;
}

export interface FacebookApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

// Facebook Post types
export interface FacebookPost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  likes?: {
    summary: {
      total_count: number;
    };
  };
  comments?: {
    summary: {
      total_count: number;
    };
  };
}

export interface FacebookPostsResponse {
  data: FacebookPost[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
    previous?: string;
  };
}

// Facebook Comment types
export interface FacebookComment {
  id: string;
  message: string;
  from: {
    id: string;
    name: string;
  };
  created_time: string;
  parent?: {
    id: string;
  };
  can_comment?: boolean;
  can_remove?: boolean;
  can_hide?: boolean;
  is_hidden?: boolean;
}

export interface FacebookCommentsResponse {
  data: FacebookComment[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface FacebookDeleteCommentResponse {
  success: boolean;
}

export interface FacebookHideCommentResponse {
  success: boolean;
}

// Instagram Insights types
export interface InstagramInsight {
  name: string;
  value: number;
  period?: string;
  end_time?: string;
}

export interface InstagramInsightsResponse {
  data: Array<{
    name: string;
    period: string;
    values: Array<{ value: number; end_time?: string }>;
  }>;
  error?: InstagramApiError['error'];
}

export interface PostInsights {
  impressions?: number;
  reach?: number;
  engagement?: number;
  saved?: number;
  videoViews?: number;
  insightsLastFetchedAt?: Date;
}

export interface PostModerationStats {
  totalComments: number;
  deletedCount: number;
  hiddenCount: number;
  flaggedCount: number;
  deletedRatio: number; // percentage
  hiddenRatio: number; // percentage
  flaggedRatio: number; // percentage
}

// Queue types
export interface QueueJob<T = unknown> {
  id: string;
  type: string;
  data: T;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export interface ClassifyCommentJob {
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterUsername: string;
  postId: string;
  instagramAccountId?: string;
  igCommentId?: string;
  facebookPageId?: string;
  fbCommentId?: string;
  accessToken: string;
  userId?: string;
  clientId?: string;
}

export interface DeleteCommentJob {
  commentId: string;
  igCommentId: string;
  accessToken: string;
}

/** Job for background polling of an account (Instagram or Facebook Page) */
export interface PollAccountJob {
  source: 'instagram' | 'facebook';
  accountId: string;
}

// Authentication types
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR';
  businessName?: string | null;
}

export interface AuthSession {
  userId: string;
  accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT';
  token: string;
  expiresAt: Date;
}

// Function signatures
export type CommentModerationFunction = (
  commentText: string,
  commenterId: string,
  instagramAccountId: string
) => Promise<ModerationResult>;

export type BotNetworkDetectionFunction = (
  clientId: string,
  whitelist: string[]
) => Promise<BotNetworkDetection[]>;

// Moderation service types
export interface ModerationSettingsResult {
  globalThreshold: number;
  blackmailThreshold?: number;
  threatThreshold?: number;
  harassmentThreshold?: number;
  defamationThreshold?: number;
  spamThreshold?: number;
  autoDeleteBlackmail?: boolean;
  autoDeleteThreat?: boolean;
  autoDeleteHarassment?: boolean;
  autoDeleteDefamation?: boolean;
  autoDeleteSpam?: boolean;
  flagHideBlackmail?: boolean;
  flagHideThreat?: boolean;
  flagHideHarassment?: boolean;
  flagHideDefamation?: boolean;
  flagHideSpam?: boolean;
  flagDeleteBlackmail?: boolean;
  flagDeleteThreat?: boolean;
  flagDeleteHarassment?: boolean;
  flagDeleteDefamation?: boolean;
  flagDeleteSpam?: boolean;
  flagHideBlackmailThreshold?: number;
  flagHideThreatThreshold?: number;
  flagHideHarassmentThreshold?: number;
  flagHideDefamationThreshold?: number;
  flagHideSpamThreshold?: number;
  flagDeleteBlackmailThreshold?: number;
  flagDeleteThreatThreshold?: number;
  flagDeleteHarassmentThreshold?: number;
  flagDeleteDefamationThreshold?: number;
  flagDeleteSpamThreshold?: number;
  // Confidence-based thresholds (percentage 0-100)
  confidenceDeleteThreshold?: number;
  confidenceHideThreshold?: number;
  // Similarity-based auto-moderation
  similarityAutoModEnabled?: boolean;
  similarityThreshold?: number;
}

// Embedding similarity context passed between services
export interface EmbeddingSimilarityContext {
  isSimilarToAllowed: boolean;
  similarityScore?: number;
  similarCommentText?: string;
  similarCommentCategory?: string;
}

// Auto-action match result from embedding similarity checks
export interface EmbeddingAutoActionMatch {
  action: 'AUTO_HIDE_SIMILAR' | 'AUTO_DELETE_SIMILAR';
  match: {
    commentId: string;
    commenterId: string;
    commenterUsername: string;
    similarity: number;
    text: string;
    score: number;
    commentText: string;
    category?: string;
  };
}

// Pre-LLM check results collected in parallel
export interface PreLLMCheckResults {
  isCommenterWhitelisted: boolean;
  isPostOwner: boolean;
  suspiciousAccount: SuspiciousAccountMatch | null;
  watchlistCheck: WatchlistCheckResult;
  userCustomFilters: import('../db/schema').CustomFilter[];
  embeddingSimilarityContext: EmbeddingSimilarityContext | undefined;
  autoActionMatch: EmbeddingAutoActionMatch | null;
  commentEmbedding: number[] | null;
  settings: ModerationSettingsResult;
}

// Suspicious account match result
export interface SuspiciousAccountMatch {
  id: string;
  commenterId: string;
  commenterUsername: string;
  autoDeleteEnabled?: boolean | null;
  autoHideEnabled?: boolean | null;
  isBlocked?: boolean | null;
  [key: string]: unknown;
}

// Watchlist check result
export interface WatchlistCheckResult {
  shouldAutoDelete: boolean;
  matches: Array<{
    threatId: string;
    name: string;
  }>;
}

export interface LLMClassificationInput {
  category: CommentCategory;
  severity: number;
  confidence: number;
  rationale: string;
  extractedIdentifiers?: ExtractedIdentifier[];
}

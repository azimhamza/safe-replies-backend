import { pgTable, uuid, varchar, text, timestamp, boolean, integer, decimal, jsonb, pgEnum, vector } from 'drizzle-orm/pg-core';

// Enums
export const accountTypeEnum = pgEnum('account_type', ['BASIC_AGENCY', 'MAX_AGENCY', 'CREATOR']);
export const planEnum = pgEnum('plan', ['FREE', 'STARTER', 'PRO', 'AGENCY']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['TRIAL', 'ACTIVE', 'CANCELLED', 'EXPIRED']);
export const igAccountTypeEnum = pgEnum('ig_account_type', ['BUSINESS', 'CREATOR']);
export const mediaTypeEnum = pgEnum('media_type', ['IMAGE', 'VIDEO', 'CAROUSEL']);
export const commentCategoryEnum = pgEnum('comment_category', ['blackmail', 'threat', 'defamation', 'harassment', 'spam', 'benign']);
export const filterScopeEnum = pgEnum('filter_scope', ['GENERAL', 'SPECIFIC']);
export const actionTakenEnum = pgEnum('action_taken', ['DELETED', 'FLAGGED', 'BENIGN']);
export const patternTypeEnum = pgEnum('pattern_type', ['KEYWORD', 'REGEX']);
export const threatTypeEnum = pgEnum('threat_type', ['blackmail', 'threat', 'harassment', 'defamation', 'spam_bot', 'coordinated_attack']);
export const threatLevelEnum = pgEnum('threat_level', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const detectionTypeEnum = pgEnum('detection_type', ['DIRECT_COMMENT', 'USERNAME_MENTION', 'KEYWORD_MATCH', 'COORDINATED_PATTERN']);
export const identifierTypeEnum = pgEnum('identifier_type', ['USERNAME', 'VENMO', 'CASHAPP', 'PAYPAL', 'ZELLE', 'BITCOIN', 'ETHEREUM', 'CRYPTO', 'EMAIL', 'PHONE', 'DOMAIN']);
export const networkTypeEnum = pgEnum('network_type', ['SPAM_NETWORK', 'BLACKMAIL_RING', 'HARASSMENT_CAMPAIGN', 'COORDINATED_ATTACK']);
export const connectionConfidenceEnum = pgEnum('connection_confidence', ['CONFIRMED', 'HIGHLY_LIKELY', 'SUSPECTED', 'INVESTIGATING']);
// Note: mention_type is now flexible to support any fraud coordination method
// Previously was: export const mentionTypeEnum = pgEnum('mention_type', ['USERNAME', 'VENMO', 'EMAIL', 'PHONE', 'OTHER']);
export const discoveryMethodEnum = pgEnum('discovery_method', ['MANUAL_INVESTIGATION', 'PATTERN_DETECTION', 'EXTERNAL_TIP', 'THREAT_NETWORK', 'MENTION_ANALYSIS']);
export const fileTypeEnum = pgEnum('file_type', ['IMAGE', 'SCREENSHOT', 'URL', 'VIDEO']);
export const caseTypeEnum = pgEnum('case_type', ['BLACKMAIL', 'THREAT', 'HARASSMENT', 'DEFAMATION', 'SPAM_BOT']);
export const caseSeverityEnum = pgEnum('case_severity', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const caseStatusEnum = pgEnum('case_status', ['DRAFT', 'SUBMITTED_TO_INSTAGRAM', 'POLICE_REPORT', 'LEGAL_ACTION', 'RESOLVED', 'CLOSED']);
export const reviewActionEnum = pgEnum('review_action', ['ALLOW_THIS', 'ALLOW_SIMILAR', 'HIDE_THIS', 'AUTO_HIDE_SIMILAR', 'DELETE_THIS', 'AUTO_DELETE_SIMILAR']);
export const sourceEnum = pgEnum('source', ['instagram', 'facebook']);

// Users table (agencies AND direct clients)
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  name: varchar('name', { length: 255 }),
  
  // User type
  accountType: accountTypeEnum('account_type').notNull(),
  
  // Business info (for CREATOR accounts)
  businessName: varchar('business_name', { length: 255 }),
  
  // Agency branding (for AGENCY accounts)
  logoUrl: text('logo_url'),
  brandingConfig: jsonb('branding_config'), // theme colors, display name overrides, etc.
  
  // Subscription
  plan: planEnum('plan').default('FREE'),
  subscriptionStatus: subscriptionStatusEnum('subscription_status').default('TRIAL'),
  trialEndsAt: timestamp('trial_ends_at'),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Onboarding progress enum
export const onboardingStageEnum = pgEnum('onboarding_stage', [
  'INVITATION_SENT',
  'ACCOUNT_CREATED',
  'FACEBOOK_CONNECTED',
  'INSTAGRAM_CONNECTED',
  'COMMENTS_SYNCING',
  'COMPLETED'
]);

// Clients table (created by agencies)
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  businessName: varchar('business_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: text('password_hash').notNull(),

  // Account type - always 'CLIENT' for consistency with users table
  accountType: text('account_type').notNull().default('CLIENT'),

  // Invitation system
  invitationToken: varchar('invitation_token', { length: 255 }).unique(),
  invitationSentAt: timestamp('invitation_sent_at'),
  invitationAcceptedAt: timestamp('invitation_accepted_at'),
  isInvited: boolean('is_invited').default(false),

  // Onboarding progress tracking
  onboardingStage: onboardingStageEnum('onboarding_stage').default('INVITATION_SENT'),
  accountCreatedAt: timestamp('account_created_at'),
  facebookConnectedAt: timestamp('facebook_connected_at'),
  instagramConnectedAt: timestamp('instagram_connected_at'),
  firstCommentsSyncedAt: timestamp('first_comments_synced_at'),
  onboardingCompletedAt: timestamp('onboarding_completed_at'),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Moderation settings table
export const moderationSettings = pgTable('moderation_settings', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Owner (agency-managed client OR direct user)
  clientId: uuid('client_id').references(() => clients.id),
  userId: uuid('user_id').references(() => users.id),

  // When set with userId (agency): agency's rule for this client. Null for global/account (creator or agency's own).
  managedClientId: uuid('managed_client_id').references(() => clients.id),

  // Instagram account (null = global/client-level, not null = account-specific)
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id),
  
  // Category enable/disable
  autoDeleteBlackmail: boolean('auto_delete_blackmail').default(true),
  autoDeleteThreat: boolean('auto_delete_threat').default(true),
  autoDeleteDefamation: boolean('auto_delete_defamation').default(true),
  autoDeleteHarassment: boolean('auto_delete_harassment').default(true),
  autoDeleteSpam: boolean('auto_delete_spam').default(false),

  // Flag and hide thresholds
  flagHideBlackmail: boolean('flag_hide_blackmail').default(false),
  flagHideThreat: boolean('flag_hide_threat').default(false),
  flagHideDefamation: boolean('flag_hide_defamation').default(false),
  flagHideHarassment: boolean('flag_hide_harassment').default(false),
  flagHideSpam: boolean('flag_hide_spam').default(false),

  // Flag and delete thresholds
  flagDeleteBlackmail: boolean('flag_delete_blackmail').default(false),
  flagDeleteThreat: boolean('flag_delete_threat').default(false),
  flagDeleteDefamation: boolean('flag_delete_defamation').default(false),
  flagDeleteHarassment: boolean('flag_delete_harassment').default(false),
  flagDeleteSpam: boolean('flag_delete_spam').default(false),

  // Threshold per category
  blackmailThreshold: integer('blackmail_threshold').default(70),
  threatThreshold: integer('threat_threshold').default(70),
  defamationThreshold: integer('defamation_threshold').default(75),
  harassmentThreshold: integer('harassment_threshold').default(75),
  spamThreshold: integer('spam_threshold').default(85),

  // Flag and hide threshold per category
  flagHideBlackmailThreshold: integer('flag_hide_blackmail_threshold').default(60),
  flagHideThreatThreshold: integer('flag_hide_threat_threshold').default(60),
  flagHideDefamationThreshold: integer('flag_hide_defamation_threshold').default(65),
  flagHideHarassmentThreshold: integer('flag_hide_harassment_threshold').default(65),
  flagHideSpamThreshold: integer('flag_hide_spam_threshold').default(75),

  // Flag and delete threshold per category
  flagDeleteBlackmailThreshold: integer('flag_delete_blackmail_threshold').default(50),
  flagDeleteThreatThreshold: integer('flag_delete_threat_threshold').default(50),
  flagDeleteDefamationThreshold: integer('flag_delete_defamation_threshold').default(55),
  flagDeleteHarassmentThreshold: integer('flag_delete_harassment_threshold').default(55),
  flagDeleteSpamThreshold: integer('flag_delete_spam_threshold').default(65),
  
  // Global settings
  globalThreshold: integer('global_threshold').default(70),
  enableKeywordFilter: boolean('enable_keyword_filter').default(true),
  enableLlmFilter: boolean('enable_llm_filter').default(true),

  // Confidence-based thresholds (0-100, maps to LLM confidence 0-1)
  // Delete if LLM confidence > this% (default 90)
  confidenceDeleteThreshold: integer('confidence_delete_threshold').default(90),
  // Hide if LLM confidence > this% (default 70)
  confidenceHideThreshold: integer('confidence_hide_threshold').default(70),

  // Similarity-based auto-moderation
  similarityAutoModEnabled: boolean('similarity_auto_mod_enabled').default(true),
  // Similarity threshold for auto-action (0-100, default 85 = 0.85 cosine)
  similarityThreshold: integer('similarity_threshold').default(85),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Facebook Pages table
export const facebookPages = pgTable('facebook_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  
  // Owner (can be agency-managed client OR direct user)
  userId: uuid('user_id').references(() => users.id),
  clientId: uuid('client_id').references(() => clients.id),
  
  facebookPageId: varchar('facebook_page_id', { length: 255 }).notNull(),
  pageName: varchar('page_name', { length: 255 }).notNull(),
  pageAccessToken: text('page_access_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at'),
  category: varchar('category', { length: 255 }),
  profilePictureUrl: text('profile_picture_url'),
  isActive: boolean('is_active').default(true),

  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Instagram accounts table
export const instagramAccounts = pgTable('instagram_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Owner (can be agency-managed client OR direct user) - kept for backward compatibility
  clientId: uuid('client_id').references(() => clients.id),
  userId: uuid('user_id').references(() => users.id),

  // Facebook Page connection (new authentication method)
  facebookPageId: uuid('facebook_page_id').references(() => facebookPages.id),

  instagramId: varchar('instagram_id', { length: 255 }).notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }), // Display name
  accountType: igAccountTypeEnum('account_type').notNull(),

  // Account stats
  followersCount: integer('followers_count'),
  followingCount: integer('following_count'),
  profilePictureUrl: text('profile_picture_url'),

  // Legacy token field (kept for migration period)
  accessToken: text('access_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  isActive: boolean('is_active').default(true),
  connectedAt: timestamp('connected_at').defaultNow(),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow()
});

// Follower history table - tracks follower counts over time for analytics
export const followerHistory = pgTable('follower_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: varchar('source', { length: 50 }).default('instagram').notNull(),
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id, { onDelete: 'cascade' }),
  facebookPageId: uuid('facebook_page_id').references(() => facebookPages.id, { onDelete: 'cascade' }),
  followersCount: integer('followers_count').notNull(),
  followingCount: integer('following_count'),
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

// Page-Instagram connections table
export const pageInstagramConnections = pgTable('page_instagram_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  facebookPageId: uuid('facebook_page_id').references(() => facebookPages.id).notNull(),
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id).notNull(),
  isVerified: boolean('is_verified').default(true),
  verifiedAt: timestamp('verified_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow()
});

// Posts table
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  
  // Source discriminator (instagram or facebook)
  source: sourceEnum('source').default('instagram').notNull(),
  
  // Instagram fields (used when source = 'instagram')
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id),
  igPostId: varchar('ig_post_id', { length: 255 }),
  
  // Facebook fields (used when source = 'facebook')
  facebookPageId: uuid('facebook_page_id').references(() => facebookPages.id),
  fbPostId: varchar('fb_post_id', { length: 255 }),
  
  // Common fields
  caption: text('caption'),
  mediaType: mediaTypeEnum('media_type'),
  permalink: varchar('permalink', { length: 500 }),
  postedAt: timestamp('posted_at').notNull(),
  likesCount: integer('likes_count'),
  commentsCount: integer('comments_count'),
  
  // Insights data (requires instagram_manage_insights permission)
  impressions: integer('impressions'),
  reach: integer('reach'),
  engagement: integer('engagement'),
  saved: integer('saved'),
  videoViews: integer('video_views'),
  insightsLastFetchedAt: timestamp('insights_last_fetched_at'),
  createdAt: timestamp('created_at').defaultNow()
});

// Comments table
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').references(() => posts.id).notNull(),
  parentCommentId: uuid('parent_comment_id'), // For replies - null means top-level comment, references comments.id
  
  // Source discriminator (instagram or facebook)
  source: sourceEnum('source').default('instagram').notNull(),
  
  // Platform-specific IDs
  igCommentId: varchar('ig_comment_id', { length: 255 }),
  fbCommentId: varchar('fb_comment_id', { length: 255 }),
  
  text: text('text').notNull(),
  commenterUsername: varchar('commenter_username', { length: 255 }).notNull(),
  commenterId: varchar('commenter_id', { length: 255 }).notNull(),
  
  // Deletion tracking
  isDeleted: boolean('is_deleted').default(false),
  deletedAt: timestamp('deleted_at'),
  deletionFailed: boolean('deletion_failed').default(false),
  deletionError: text('deletion_error'),
  
  // Hide/visibility tracking
  isHidden: boolean('is_hidden').default(false),
  hiddenAt: timestamp('hidden_at'),

  // Block tracking
  isBlocked: boolean('is_blocked').default(false),
  blockedAt: timestamp('blocked_at'),
  blockFailed: boolean('block_failed').default(false),
  blockError: text('block_error'),

  // Restrict tracking
  isRestricted: boolean('is_restricted').default(false),
  restrictedAt: timestamp('restricted_at'),
  restrictFailed: boolean('restrict_failed').default(false),
  restrictError: text('restrict_error'),

  // Report tracking
  isReported: boolean('is_reported').default(false),
  reportedAt: timestamp('reported_at'),
  reportFailed: boolean('report_failed').default(false),
  reportError: text('report_error'),

  // Approve tracking (for business accounts)
  isApproved: boolean('is_approved').default(false),
  approvedAt: timestamp('approved_at'),
  approveFailed: boolean('approve_failed').default(false),
  approveError: text('approve_error'),

  // AI Embeddings for content analysis (vector embeddings)
  embedding: vector('embedding', { dimensions: 1024 }), // Jina embeddings-v3 dimensions

  // Review tracking
  reviewedAt: timestamp('reviewed_at'),
  reviewAction: reviewActionEnum('review_action'),
  isAllowed: boolean('is_allowed').default(false), // Marks comments manually allowed by reviewer

  // Timestamps
  commentedAt: timestamp('commented_at').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

// Moderation logs table
export const moderationLogs = pgTable('moderation_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  
  // Classification
  category: commentCategoryEnum('category').notNull(),
  severity: integer('severity').notNull(),
  confidence: decimal('confidence', { precision: 5, scale: 4 }).notNull(), // 0-1 float from LLM (e.g., 0.8523)
  rationale: text('rationale').notNull(),
  
  // Risk scoring
  riskScore: integer('risk_score').notNull(),
  riskFormula: text('risk_formula'),
  
  // Model info
  modelName: varchar('model_name', { length: 100 }).notNull(),
  modelVersion: varchar('model_version', { length: 50 }),
  
  // Action
  actionTaken: actionTakenEnum('action_taken').notNull(),
  actionTimestamp: timestamp('action_timestamp').notNull(),
  
  // Fallback mode
  isDegradedMode: boolean('is_degraded_mode').default(false),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Evidence records table
export const evidenceRecords = pgTable('evidence_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  moderationLogId: uuid('moderation_log_id').references(() => moderationLogs.id).notNull(),
  
  // Raw data preservation
  rawComment: text('raw_comment').notNull(),
  rawCommenterUsername: varchar('raw_commenter_username', { length: 255 }).notNull(),
  rawCommenterId: varchar('raw_commenter_id', { length: 255 }).notNull(),
  
  // LLM response
  llmRequestJson: jsonb('llm_request_json'),
  llmResponseJson: jsonb('llm_response_json').notNull(),
  
  // Risk calculation
  formulaUsed: text('formula_used').notNull(),
  riskVariables: jsonb('risk_variables'),
  
  // Instagram API confirmation
  instagramApiResponse: jsonb('instagram_api_response'),
  deletionConfirmed: boolean('deletion_confirmed').default(false),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Keyword filters table
export const keywordFilters = pgTable('keyword_filters', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id),

  pattern: varchar('pattern', { length: 500 }).notNull(),
  patternType: patternTypeEnum('pattern_type').notNull(),
  category: commentCategoryEnum('category').notNull(),

  isWhitelist: boolean('is_whitelist').default(false),
  isEnabled: boolean('is_enabled').default(true),

  description: text('description'),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Custom filters table (user-defined prompts for LLM)
export const customFilters = pgTable('custom_filters', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id),
  userId: uuid('user_id').references(() => users.id),

  // Instagram account (null = global filter, not null = account-specific)
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id),

  name: varchar('name', { length: 255 }).notNull(),
  prompt: text('prompt').notNull(),
  category: commentCategoryEnum('category').notNull(),
  scope: filterScopeEnum('scope').default('GENERAL'),

  isEnabled: boolean('is_enabled').default(true),
  description: text('description'),

  // Auto-actions when filter matches
  autoHide: boolean('auto_hide').default(false),
  autoDelete: boolean('auto_delete').default(false),
  autoFlag: boolean('auto_flag').default(false),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Custom filter Instagram account associations
export const customFilterAccounts = pgTable('custom_filter_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  customFilterId: uuid('custom_filter_id').references(() => customFilters.id).notNull(),
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id).notNull(),

  createdAt: timestamp('created_at').defaultNow()
});

// Comment review actions table (for flagged comments review workflow)
export const commentReviewActions = pgTable('comment_review_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  action: reviewActionEnum('action').notNull(),
  
  // Reviewer identity (either userId or clientId)
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id),
  reviewedByClientId: uuid('reviewed_by_client_id').references(() => clients.id),
  
  reviewedAt: timestamp('reviewed_at').defaultNow(),
  
  // Similarity threshold used for similarity-based actions
  similarityThreshold: decimal('similarity_threshold', { precision: 5, scale: 4 }),
  
  // Link to custom filter if auto-filter was created
  customFilterId: uuid('custom_filter_id').references(() => customFilters.id),
  
  // Optional notes from reviewer
  notes: text('notes'),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Suspicious accounts table
export const suspiciousAccounts = pgTable('suspicious_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id).notNull(),
  
  // Commenter identity
  commenterId: varchar('commenter_id', { length: 255 }).notNull(),
  commenterUsername: varchar('commenter_username', { length: 255 }).notNull(),
  
  // Violation tracking
  totalComments: integer('total_comments').default(0),
  flaggedComments: integer('flagged_comments').default(0),
  deletedComments: integer('deleted_comments').default(0),
  
  // Category breakdown
  blackmailCount: integer('blackmail_count').default(0),
  threatCount: integer('threat_count').default(0),
  harassmentCount: integer('harassment_count').default(0),
  spamCount: integer('spam_count').default(0),
  defamationCount: integer('defamation_count').default(0),
  
  // Risk metrics
  averageRiskScore: decimal('average_risk_score', { precision: 5, scale: 2 }),
  highestRiskScore: integer('highest_risk_score'),
  
  // Pattern detection
  commentVelocity: decimal('comment_velocity', { precision: 5, scale: 2 }),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  
  // Auto-block (auto-delete future comments)
  isBlocked: boolean('is_blocked').default(false),
  isSpamBot: boolean('is_spam_bot').default(false),
  blockReason: text('block_reason'),
  blockedAt: timestamp('blocked_at'),

  // Per-account auto-moderation settings
  autoHideEnabled: boolean('auto_hide_enabled').default(false), // Auto-hide future comments
  autoDeleteEnabled: boolean('auto_delete_enabled').default(false), // Auto-delete future comments (synonym for isBlocked, kept for clarity)

  // Watchlist & Public Threat features
  isWatchlisted: boolean('is_watchlisted').default(false),
  watchlistedAt: timestamp('watchlisted_at'),
  watchlistReason: text('watchlist_reason'),

  isPublicThreat: boolean('is_public_threat').default(false),
  publicThreatAt: timestamp('public_threat_at'),
  publicThreatDescription: text('public_threat_description'),

  // Auto-hide by default (only show if watchlisted or high risk)
  isHidden: boolean('is_hidden').default(true),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Account comment map table
export const accountCommentMap = pgTable('account_comment_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  suspiciousAccountId: uuid('suspicious_account_id').references(() => suspiciousAccounts.id).notNull(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Evidence attachments table
export const evidenceAttachments = pgTable('evidence_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  
  // File storage
  fileType: fileTypeEnum('file_type').notNull(),
  fileUrl: text('file_url'),
  fileSize: integer('file_size'),
  mimeType: varchar('mime_type', { length: 100 }),
  
  // Screenshot metadata
  screenshotTimestamp: timestamp('screenshot_timestamp'),
  screenshotContext: text('screenshot_context'),
  
  // Manual uploads
  uploadedBy: uuid('uploaded_by'),
  uploadNotes: text('upload_notes'),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Legal cases table
export const legalCases = pgTable('legal_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id),
  suspiciousAccountId: uuid('suspicious_account_id').references(() => suspiciousAccounts.id).notNull(),
  
  // Case details
  caseTitle: varchar('case_title', { length: 255 }).notNull(),
  caseType: caseTypeEnum('case_type').notNull(),
  severity: caseSeverityEnum('severity').notNull(),
  
  // Status tracking
  status: caseStatusEnum('status').default('DRAFT'),
  
  // Evidence summary
  totalComments: integer('total_comments').default(0),
  totalAttachments: integer('total_attachments').default(0),
  dateRangeStart: timestamp('date_range_start'),
  dateRangeEnd: timestamp('date_range_end'),
  
  // Case narrative
  description: text('description').notNull(),
  impactStatement: text('impact_statement'),
  
  // Actions taken
  instagramReportId: varchar('instagram_report_id', { length: 255 }),
  instagramReportDate: timestamp('instagram_report_date'),
  policeReportNumber: varchar('police_report_number', { length: 255 }),
  policeReportDate: timestamp('police_report_date'),
  lawyerContact: varchar('lawyer_contact', { length: 255 }),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Case evidence map table
export const caseEvidenceMap = pgTable('case_evidence_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  legalCaseId: uuid('legal_case_id').references(() => legalCases.id).notNull(),
  commentId: uuid('comment_id').references(() => comments.id),
  evidenceAttachmentId: uuid('evidence_attachment_id').references(() => evidenceAttachments.id),
  
  notes: text('notes'),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Global threat network table
export const globalThreatNetwork = pgTable('global_threat_network', {
  id: uuid('id').primaryKey().defaultRandom(),
  
  // Bad actor identity (anonymized)
  commenterIdHash: varchar('commenter_id_hash', { length: 64 }).unique().notNull(),
  commenterUsernameHash: varchar('commenter_username_hash', { length: 64 }),
  
  // Aggregate data
  totalAgenciesTargeted: integer('total_agencies_targeted').default(0),
  totalViolations: integer('total_violations').default(0),
  blackmailCount: integer('blackmail_count').default(0),
  threatCount: integer('threat_count').default(0),
  harassmentCount: integer('harassment_count').default(0),
  spamCount: integer('spam_count').default(0),
  
  // Risk metrics
  averageRiskScore: decimal('average_risk_score', { precision: 5, scale: 2 }),
  highestRiskScore: integer('highest_risk_score'),
  
  // First/last seen globally
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  
  // Status
  isGlobalThreat: boolean('is_global_threat').default(false),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Agency network settings table
export const agencyNetworkSettings = pgTable('agency_network_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).unique().notNull(),
  
  // Profile
  publicName: varchar('public_name', { length: 255 }),
  instagramHandle: varchar('instagram_handle', { length: 255 }),
  twitterHandle: varchar('twitter_handle', { length: 255 }),
  website: varchar('website', { length: 500 }),
  
  // Sharing preferences
  shareThreatData: boolean('share_threat_data').default(false),
  receiveThreatAlerts: boolean('receive_threat_alerts').default(true),
  
  // Visibility
  isPublicProfile: boolean('is_public_profile').default(false),
  allowDirectContact: boolean('allow_direct_contact').default(false),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Threat network reports table
export const threatNetworkReports = pgTable('threat_network_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  globalThreatId: uuid('global_threat_id').references(() => globalThreatNetwork.id).notNull(),
  reportingAgencyId: uuid('reporting_agency_id').references(() => users.id).notNull(),
  
  // Report details
  violationCategory: commentCategoryEnum('violation_category').notNull(),
  severity: integer('severity').notNull(),
  
  // Context
  anonymizedDescription: text('anonymized_description'),
  
  // Verification
  isVerified: boolean('is_verified').default(false),
  verificationCount: integer('verification_count').default(1),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Known threats watchlist table
export const knownThreatsWatchlist = pgTable('known_threats_watchlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id),
  userId: uuid('user_id').references(() => users.id),

  // Threat identity
  instagramUsername: varchar('instagram_username', { length: 255 }),
  instagramId: varchar('instagram_id', { length: 255 }),
  
  // Threat details
  threatType: threatTypeEnum('threat_type').notNull(),
  threatLevel: threatLevelEnum('threat_level').notNull(),
  
  // Monitoring keywords
  monitorKeywords: jsonb('monitor_keywords'),
  monitorUsernameMentions: boolean('monitor_username_mentions').default(true),
  
  // Context
  description: text('description').notNull(),
  source: text('source'),
  
  // Evidence
  evidenceUrl: text('evidence_url'),
  addedBy: uuid('added_by'),
  
  // Actions
  autoBlockDirectComments: boolean('auto_block_direct_comments').default(true),
  autoFlagReferences: boolean('auto_flag_references').default(true),
  escalateImmediately: boolean('escalate_immediately').default(false),
  
  // Tracking
  timesDetected: integer('times_detected').default(0),
  lastDetectedAt: timestamp('last_detected_at'),
  
  // Status
  isActive: boolean('is_active').default(true),
  resolved: boolean('resolved').default(false),
  resolvedNote: text('resolved_note'),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Watchlist detections table
export const watchlistDetections = pgTable('watchlist_detections', {
  id: uuid('id').primaryKey().defaultRandom(),
  knownThreatId: uuid('known_threat_id').references(() => knownThreatsWatchlist.id).notNull(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  
  // Detection details
  detectionType: detectionTypeEnum('detection_type').notNull(),
  matchedKeyword: varchar('matched_keyword', { length: 500 }),
  
  // Context
  commentText: text('comment_text').notNull(),
  commenterUsername: varchar('commenter_username', { length: 255 }),
  commenterId: varchar('commenter_id', { length: 255 }),
  
  // Action taken
  actionTaken: actionTakenEnum('action_taken').notNull(),
  autoAction: boolean('auto_action').default(true),
  
  // Alert
  clientNotified: boolean('client_notified').default(false),
  notificationSentAt: timestamp('notification_sent_at'),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Whitelisted identifiers table
export const whitelistedIdentifiers = pgTable('whitelisted_identifiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id),
  userId: uuid('user_id').references(() => users.id),

  // Instagram account (null = global whitelist, not null = account-specific whitelist)
  instagramAccountId: uuid('instagram_account_id').references(() => instagramAccounts.id),

  // Whitelisted identifier
  identifier: varchar('identifier', { length: 500 }).notNull(),
  identifierType: identifierTypeEnum('identifier_type').notNull(),

  // Context
  description: text('description'),

  // Auto-added
  isAutoAdded: boolean('is_auto_added').default(false),

  // Status
  isActive: boolean('is_active').default(true),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Extracted identifiers table - tracks all identifiers found across comments
export const extractedIdentifiers = pgTable('extracted_identifiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  suspiciousAccountId: uuid('suspicious_account_id').references(() => suspiciousAccounts.id).notNull(),

  // Identifier details
  identifier: varchar('identifier', { length: 500 }).notNull(),
  identifierType: identifierTypeEnum('identifier_type').notNull(),
  platform: varchar('platform', { length: 100 }),

  // Normalization (for cross-referencing)
  normalizedIdentifier: varchar('normalized_identifier', { length: 500 }).notNull(), // lowercase, cleaned version

  // Confidence and source
  confidence: decimal('confidence', { precision: 5, scale: 4 }).notNull(), // 0-1 from LLM
  source: varchar('source', { length: 50 }).default('llm_extraction'), // llm_extraction, manual_entry, etc.

  // Status
  isActive: boolean('is_active').default(true),

  createdAt: timestamp('created_at').defaultNow()
});

// Bot network masterminds table
export const botNetworkMasterminds = pgTable('bot_network_masterminds', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').references(() => clients.id),
  userId: uuid('user_id').references(() => users.id),
  
  // Mastermind identity
  name: varchar('name', { length: 255 }).notNull(),
  knownIdentifiers: jsonb('known_identifiers'),
  
  // Evidence
  evidenceDescription: text('evidence_description').notNull(),
  evidenceAttachments: jsonb('evidence_attachments'),
  
  // Network stats
  totalBotAccounts: integer('total_bot_accounts').default(0),
  totalViolations: integer('total_violations').default(0),
  firstDetected: timestamp('first_detected').notNull(),
  lastActivity: timestamp('last_activity'),
  
  // Threat assessment
  threatLevel: threatLevelEnum('threat_level').notNull(),
  networkType: networkTypeEnum('network_type').notNull(),
  
  // Status
  isActive: boolean('is_active').default(true),
  isReportedToAuthorities: boolean('is_reported_to_authorities').default(false),
  policeReportNumber: varchar('police_report_number', { length: 255 }),
  
  // Source
  discoveryMethod: discoveryMethodEnum('discovery_method').notNull(),
  discoveredBy: uuid('discovered_by'),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

// Bot network connections table
export const botNetworkConnections = pgTable('bot_network_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  mastermindId: uuid('mastermind_id').references(() => botNetworkMasterminds.id).notNull(),
  suspiciousAccountId: uuid('suspicious_account_id').references(() => suspiciousAccounts.id).notNull(),
  
  // Connection strength
  confidence: connectionConfidenceEnum('confidence').notNull(),
  
  // Evidence
  connectionEvidence: text('connection_evidence').notNull(),
  evidenceAttachments: jsonb('evidence_attachments'),
  
  // Mention tracking
  mentionsMastermind: boolean('mentions_mastermind').default(false),
  totalMentions: integer('total_mentions').default(0),
  mentionTypes: jsonb('mention_types'),
  sampleMentions: jsonb('sample_mentions'),
  
  // Discovery
  detectedAt: timestamp('detected_at').defaultNow(),
  detectedBy: discoveryMethodEnum('detected_by').notNull(),
  
  // Status
  isActive: boolean('is_active').default(true),
  disconnectedAt: timestamp('disconnected_at'),
  disconnectionReason: text('disconnection_reason'),
  
  createdAt: timestamp('created_at').defaultNow()
});

// Mastermind mentions table
export const mastermindMentions = pgTable('mastermind_mentions', {
  id: uuid('id').primaryKey().defaultRandom(),
  mastermindId: uuid('mastermind_id').references(() => botNetworkMasterminds.id).notNull(),
  commentId: uuid('comment_id').references(() => comments.id).notNull(),
  botConnectionId: uuid('bot_connection_id').references(() => botNetworkConnections.id),

  // Mention details
  mentionedIdentifier: varchar('mentioned_identifier', { length: 255 }).notNull(),
  mentionType: varchar('mention_type', { length: 100 }).notNull(), // Now flexible to support any fraud coordination method

  // Context
  fullCommentText: text('full_comment_text').notNull(),
  mentionPosition: integer('mention_position'),

  // Action
  actionTaken: actionTakenEnum('action_taken').notNull(),

  createdAt: timestamp('created_at').defaultNow()
});

// Export types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type ModerationSettings = typeof moderationSettings.$inferSelect;
export type NewModerationSettings = typeof moderationSettings.$inferInsert;
export type FacebookPage = typeof facebookPages.$inferSelect;
export type NewFacebookPage = typeof facebookPages.$inferInsert;
export type InstagramAccount = typeof instagramAccounts.$inferSelect;
export type NewInstagramAccount = typeof instagramAccounts.$inferInsert;
export type PageInstagramConnection = typeof pageInstagramConnections.$inferSelect;
export type NewPageInstagramConnection = typeof pageInstagramConnections.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type ModerationLog = typeof moderationLogs.$inferSelect;
export type NewModerationLog = typeof moderationLogs.$inferInsert;
export type EvidenceRecord = typeof evidenceRecords.$inferSelect;
export type NewEvidenceRecord = typeof evidenceRecords.$inferInsert;
export type KeywordFilter = typeof keywordFilters.$inferSelect;
export type NewKeywordFilter = typeof keywordFilters.$inferInsert;
export type CustomFilter = typeof customFilters.$inferSelect;
export type NewCustomFilter = typeof customFilters.$inferInsert;
export type CustomFilterAccount = typeof customFilterAccounts.$inferSelect;
export type NewCustomFilterAccount = typeof customFilterAccounts.$inferInsert;
export type SuspiciousAccount = typeof suspiciousAccounts.$inferSelect;
export type NewSuspiciousAccount = typeof suspiciousAccounts.$inferInsert;
export type AccountCommentMap = typeof accountCommentMap.$inferSelect;
export type NewAccountCommentMap = typeof accountCommentMap.$inferInsert;
export type EvidenceAttachment = typeof evidenceAttachments.$inferSelect;
export type NewEvidenceAttachment = typeof evidenceAttachments.$inferInsert;
export type LegalCase = typeof legalCases.$inferSelect;
export type NewLegalCase = typeof legalCases.$inferInsert;
export type CaseEvidenceMap = typeof caseEvidenceMap.$inferSelect;
export type NewCaseEvidenceMap = typeof caseEvidenceMap.$inferInsert;
export type GlobalThreatNetwork = typeof globalThreatNetwork.$inferSelect;
export type NewGlobalThreatNetwork = typeof globalThreatNetwork.$inferInsert;
export type AgencyNetworkSettings = typeof agencyNetworkSettings.$inferSelect;
export type NewAgencyNetworkSettings = typeof agencyNetworkSettings.$inferInsert;
export type ThreatNetworkReport = typeof threatNetworkReports.$inferSelect;
export type NewThreatNetworkReport = typeof threatNetworkReports.$inferInsert;
export type KnownThreatsWatchlist = typeof knownThreatsWatchlist.$inferSelect;
export type NewKnownThreatsWatchlist = typeof knownThreatsWatchlist.$inferInsert;
export type WatchlistDetection = typeof watchlistDetections.$inferSelect;
export type NewWatchlistDetection = typeof watchlistDetections.$inferInsert;
export type WhitelistedIdentifier = typeof whitelistedIdentifiers.$inferSelect;
export type NewWhitelistedIdentifier = typeof whitelistedIdentifiers.$inferInsert;
export type ExtractedIdentifier = typeof extractedIdentifiers.$inferSelect;
export type NewExtractedIdentifier = typeof extractedIdentifiers.$inferInsert;
export type BotNetworkMastermind = typeof botNetworkMasterminds.$inferSelect;
export type NewBotNetworkMastermind = typeof botNetworkMasterminds.$inferInsert;
export type BotNetworkConnection = typeof botNetworkConnections.$inferSelect;
export type NewBotNetworkConnection = typeof botNetworkConnections.$inferInsert;
export type MastermindMention = typeof mastermindMentions.$inferSelect;
export type NewMastermindMention = typeof mastermindMentions.$inferInsert;
export type CommentReviewAction = typeof commentReviewActions.$inferSelect;
export type NewCommentReviewAction = typeof commentReviewActions.$inferInsert;
export type FollowerHistory = typeof followerHistory.$inferSelect;
export type NewFollowerHistory = typeof followerHistory.$inferInsert;
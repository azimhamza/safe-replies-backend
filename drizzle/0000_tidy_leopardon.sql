CREATE TYPE "public"."account_type" AS ENUM('AGENCY', 'DIRECT_CLIENT');--> statement-breakpoint
CREATE TYPE "public"."action_taken" AS ENUM('DELETED', 'FLAGGED', 'BENIGN');--> statement-breakpoint
CREATE TYPE "public"."case_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('DRAFT', 'SUBMITTED_TO_INSTAGRAM', 'POLICE_REPORT', 'LEGAL_ACTION', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."case_type" AS ENUM('BLACKMAIL', 'THREAT', 'HARASSMENT', 'DEFAMATION', 'SPAM_BOT');--> statement-breakpoint
CREATE TYPE "public"."comment_category" AS ENUM('blackmail', 'threat', 'defamation', 'harassment', 'spam', 'benign');--> statement-breakpoint
CREATE TYPE "public"."connection_confidence" AS ENUM('CONFIRMED', 'HIGHLY_LIKELY', 'SUSPECTED', 'INVESTIGATING');--> statement-breakpoint
CREATE TYPE "public"."detection_type" AS ENUM('DIRECT_COMMENT', 'USERNAME_MENTION', 'KEYWORD_MATCH', 'COORDINATED_PATTERN');--> statement-breakpoint
CREATE TYPE "public"."discovery_method" AS ENUM('MANUAL_INVESTIGATION', 'PATTERN_DETECTION', 'EXTERNAL_TIP', 'THREAT_NETWORK', 'MENTION_ANALYSIS');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('IMAGE', 'SCREENSHOT', 'URL', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."identifier_type" AS ENUM('USERNAME', 'VENMO', 'CASHAPP', 'PAYPAL', 'ZELLE', 'BITCOIN', 'ETHEREUM', 'CRYPTO', 'EMAIL', 'PHONE', 'DOMAIN');--> statement-breakpoint
CREATE TYPE "public"."ig_account_type" AS ENUM('BUSINESS', 'CREATOR');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('IMAGE', 'VIDEO', 'CAROUSEL');--> statement-breakpoint
CREATE TYPE "public"."mention_type" AS ENUM('USERNAME', 'VENMO', 'EMAIL', 'PHONE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."network_type" AS ENUM('SPAM_NETWORK', 'BLACKMAIL_RING', 'HARASSMENT_CAMPAIGN', 'COORDINATED_ATTACK');--> statement-breakpoint
CREATE TYPE "public"."pattern_type" AS ENUM('KEYWORD', 'REGEX');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('FREE', 'STARTER', 'PRO', 'AGENCY');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."threat_level" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."threat_type" AS ENUM('blackmail', 'threat', 'harassment', 'defamation', 'spam_bot', 'coordinated_attack');--> statement-breakpoint
CREATE TABLE "account_comment_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suspicious_account_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agency_network_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"public_name" varchar(255),
	"instagram_handle" varchar(255),
	"twitter_handle" varchar(255),
	"website" varchar(500),
	"share_threat_data" boolean DEFAULT false,
	"receive_threat_alerts" boolean DEFAULT true,
	"is_public_profile" boolean DEFAULT false,
	"allow_direct_contact" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "agency_network_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "bot_network_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mastermind_id" uuid NOT NULL,
	"suspicious_account_id" uuid NOT NULL,
	"confidence" "connection_confidence" NOT NULL,
	"connection_evidence" text NOT NULL,
	"evidence_attachments" jsonb,
	"mentions_mastermind" boolean DEFAULT false,
	"total_mentions" integer DEFAULT 0,
	"mention_types" jsonb,
	"sample_mentions" jsonb,
	"detected_at" timestamp DEFAULT now(),
	"detected_by" "discovery_method" NOT NULL,
	"is_active" boolean DEFAULT true,
	"disconnected_at" timestamp,
	"disconnection_reason" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_network_masterminds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"name" varchar(255) NOT NULL,
	"known_identifiers" jsonb,
	"evidence_description" text NOT NULL,
	"evidence_attachments" jsonb,
	"total_bot_accounts" integer DEFAULT 0,
	"total_violations" integer DEFAULT 0,
	"first_detected" timestamp NOT NULL,
	"last_activity" timestamp,
	"threat_level" "threat_level" NOT NULL,
	"network_type" "network_type" NOT NULL,
	"is_active" boolean DEFAULT true,
	"is_reported_to_authorities" boolean DEFAULT false,
	"police_report_number" varchar(255),
	"discovery_method" "discovery_method" NOT NULL,
	"discovered_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "case_evidence_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_case_id" uuid NOT NULL,
	"comment_id" uuid,
	"evidence_attachment_id" uuid,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "clients_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"ig_comment_id" varchar(255) NOT NULL,
	"text" text NOT NULL,
	"commenter_username" varchar(255) NOT NULL,
	"commenter_id" varchar(255) NOT NULL,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp,
	"deletion_failed" boolean DEFAULT false,
	"deletion_error" text,
	"commented_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "comments_ig_comment_id_unique" UNIQUE("ig_comment_id")
);
--> statement-breakpoint
CREATE TABLE "evidence_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"file_type" "file_type" NOT NULL,
	"file_url" text,
	"file_size" integer,
	"mime_type" varchar(100),
	"screenshot_timestamp" timestamp,
	"screenshot_context" text,
	"uploaded_by" uuid,
	"upload_notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"moderation_log_id" uuid NOT NULL,
	"raw_comment" text NOT NULL,
	"raw_commenter_username" varchar(255) NOT NULL,
	"raw_commenter_id" varchar(255) NOT NULL,
	"llm_request_json" jsonb,
	"llm_response_json" jsonb NOT NULL,
	"formula_used" text NOT NULL,
	"risk_variables" jsonb,
	"instagram_api_response" jsonb,
	"deletion_confirmed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "global_threat_network" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commenter_id_hash" varchar(64) NOT NULL,
	"commenter_username_hash" varchar(64),
	"total_agencies_targeted" integer DEFAULT 0,
	"total_violations" integer DEFAULT 0,
	"blackmail_count" integer DEFAULT 0,
	"threat_count" integer DEFAULT 0,
	"harassment_count" integer DEFAULT 0,
	"spam_count" integer DEFAULT 0,
	"average_risk_score" numeric(5, 2),
	"highest_risk_score" integer,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"is_global_threat" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "global_threat_network_commenter_id_hash_unique" UNIQUE("commenter_id_hash")
);
--> statement-breakpoint
CREATE TABLE "instagram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"instagram_id" varchar(255) NOT NULL,
	"username" varchar(255) NOT NULL,
	"account_type" "ig_account_type" NOT NULL,
	"access_token" text NOT NULL,
	"token_expires_at" timestamp,
	"is_active" boolean DEFAULT true,
	"connected_at" timestamp DEFAULT now(),
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "instagram_accounts_instagram_id_unique" UNIQUE("instagram_id")
);
--> statement-breakpoint
CREATE TABLE "keyword_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"pattern" varchar(500) NOT NULL,
	"pattern_type" "pattern_type" NOT NULL,
	"category" "comment_category" NOT NULL,
	"is_whitelist" boolean DEFAULT false,
	"is_enabled" boolean DEFAULT true,
	"description" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "known_threats_watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"instagram_username" varchar(255),
	"instagram_id" varchar(255),
	"threat_type" "threat_type" NOT NULL,
	"threat_level" "threat_level" NOT NULL,
	"monitor_keywords" jsonb,
	"monitor_username_mentions" boolean DEFAULT true,
	"description" text NOT NULL,
	"source" text,
	"evidence_url" text,
	"added_by" uuid,
	"auto_block_direct_comments" boolean DEFAULT true,
	"auto_flag_references" boolean DEFAULT true,
	"escalate_immediately" boolean DEFAULT false,
	"times_detected" integer DEFAULT 0,
	"last_detected_at" timestamp,
	"is_active" boolean DEFAULT true,
	"resolved" boolean DEFAULT false,
	"resolved_note" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "legal_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"suspicious_account_id" uuid NOT NULL,
	"case_title" varchar(255) NOT NULL,
	"case_type" "case_type" NOT NULL,
	"severity" "case_severity" NOT NULL,
	"status" "case_status" DEFAULT 'DRAFT',
	"total_comments" integer DEFAULT 0,
	"total_attachments" integer DEFAULT 0,
	"date_range_start" timestamp,
	"date_range_end" timestamp,
	"description" text NOT NULL,
	"impact_statement" text,
	"instagram_report_id" varchar(255),
	"instagram_report_date" timestamp,
	"police_report_number" varchar(255),
	"police_report_date" timestamp,
	"lawyer_contact" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "mastermind_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mastermind_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"bot_connection_id" uuid,
	"mentioned_identifier" varchar(255) NOT NULL,
	"mention_type" "mention_type" NOT NULL,
	"full_comment_text" text NOT NULL,
	"mention_position" integer,
	"action_taken" "action_taken" NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "moderation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"category" "comment_category" NOT NULL,
	"severity" integer NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"rationale" text NOT NULL,
	"risk_score" integer NOT NULL,
	"risk_formula" text,
	"model_name" varchar(100) NOT NULL,
	"model_version" varchar(50),
	"action_taken" "action_taken" NOT NULL,
	"action_timestamp" timestamp NOT NULL,
	"is_degraded_mode" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "moderation_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"auto_delete_blackmail" boolean DEFAULT true,
	"auto_delete_threat" boolean DEFAULT true,
	"auto_delete_defamation" boolean DEFAULT true,
	"auto_delete_harassment" boolean DEFAULT true,
	"auto_delete_spam" boolean DEFAULT false,
	"blackmail_threshold" integer DEFAULT 70,
	"threat_threshold" integer DEFAULT 70,
	"defamation_threshold" integer DEFAULT 75,
	"harassment_threshold" integer DEFAULT 75,
	"spam_threshold" integer DEFAULT 85,
	"global_threshold" integer DEFAULT 70,
	"enable_keyword_filter" boolean DEFAULT true,
	"enable_llm_filter" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"ig_post_id" varchar(255) NOT NULL,
	"caption" text,
	"media_type" "media_type",
	"permalink" varchar(500),
	"posted_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "posts_ig_post_id_unique" UNIQUE("ig_post_id")
);
--> statement-breakpoint
CREATE TABLE "suspicious_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"commenter_id" varchar(255) NOT NULL,
	"commenter_username" varchar(255) NOT NULL,
	"total_comments" integer DEFAULT 0,
	"flagged_comments" integer DEFAULT 0,
	"deleted_comments" integer DEFAULT 0,
	"blackmail_count" integer DEFAULT 0,
	"threat_count" integer DEFAULT 0,
	"harassment_count" integer DEFAULT 0,
	"spam_count" integer DEFAULT 0,
	"defamation_count" integer DEFAULT 0,
	"average_risk_score" numeric(5, 2),
	"highest_risk_score" integer,
	"comment_velocity" numeric(5, 2),
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"is_blocked" boolean DEFAULT false,
	"is_spam_bot" boolean DEFAULT false,
	"block_reason" text,
	"blocked_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "threat_network_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"global_threat_id" uuid NOT NULL,
	"reporting_agency_id" uuid NOT NULL,
	"violation_category" "comment_category" NOT NULL,
	"severity" integer NOT NULL,
	"anonymized_description" text,
	"is_verified" boolean DEFAULT false,
	"verification_count" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(255),
	"account_type" "account_type" NOT NULL,
	"business_name" varchar(255),
	"plan" "plan" DEFAULT 'FREE',
	"subscription_status" "subscription_status" DEFAULT 'TRIAL',
	"trial_ends_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "watchlist_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"known_threat_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"detection_type" "detection_type" NOT NULL,
	"matched_keyword" varchar(500),
	"comment_text" text NOT NULL,
	"commenter_username" varchar(255),
	"commenter_id" varchar(255),
	"action_taken" "action_taken" NOT NULL,
	"auto_action" boolean DEFAULT true,
	"client_notified" boolean DEFAULT false,
	"notification_sent_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "whitelisted_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"identifier" varchar(500) NOT NULL,
	"identifier_type" "identifier_type" NOT NULL,
	"description" text,
	"is_auto_added" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account_comment_map" ADD CONSTRAINT "account_comment_map_suspicious_account_id_suspicious_accounts_id_fk" FOREIGN KEY ("suspicious_account_id") REFERENCES "public"."suspicious_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_comment_map" ADD CONSTRAINT "account_comment_map_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_network_settings" ADD CONSTRAINT "agency_network_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_network_connections" ADD CONSTRAINT "bot_network_connections_mastermind_id_bot_network_masterminds_id_fk" FOREIGN KEY ("mastermind_id") REFERENCES "public"."bot_network_masterminds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_network_connections" ADD CONSTRAINT "bot_network_connections_suspicious_account_id_suspicious_accounts_id_fk" FOREIGN KEY ("suspicious_account_id") REFERENCES "public"."suspicious_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_network_masterminds" ADD CONSTRAINT "bot_network_masterminds_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_network_masterminds" ADD CONSTRAINT "bot_network_masterminds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_evidence_map" ADD CONSTRAINT "case_evidence_map_legal_case_id_legal_cases_id_fk" FOREIGN KEY ("legal_case_id") REFERENCES "public"."legal_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_evidence_map" ADD CONSTRAINT "case_evidence_map_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_evidence_map" ADD CONSTRAINT "case_evidence_map_evidence_attachment_id_evidence_attachments_id_fk" FOREIGN KEY ("evidence_attachment_id") REFERENCES "public"."evidence_attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_attachments" ADD CONSTRAINT "evidence_attachments_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_moderation_log_id_moderation_logs_id_fk" FOREIGN KEY ("moderation_log_id") REFERENCES "public"."moderation_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_filters" ADD CONSTRAINT "keyword_filters_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "known_threats_watchlist" ADD CONSTRAINT "known_threats_watchlist_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_cases" ADD CONSTRAINT "legal_cases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_cases" ADD CONSTRAINT "legal_cases_suspicious_account_id_suspicious_accounts_id_fk" FOREIGN KEY ("suspicious_account_id") REFERENCES "public"."suspicious_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastermind_mentions" ADD CONSTRAINT "mastermind_mentions_mastermind_id_bot_network_masterminds_id_fk" FOREIGN KEY ("mastermind_id") REFERENCES "public"."bot_network_masterminds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastermind_mentions" ADD CONSTRAINT "mastermind_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastermind_mentions" ADD CONSTRAINT "mastermind_mentions_bot_connection_id_bot_network_connections_id_fk" FOREIGN KEY ("bot_connection_id") REFERENCES "public"."bot_network_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_logs" ADD CONSTRAINT "moderation_logs_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD CONSTRAINT "suspicious_accounts_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threat_network_reports" ADD CONSTRAINT "threat_network_reports_global_threat_id_global_threat_network_id_fk" FOREIGN KEY ("global_threat_id") REFERENCES "public"."global_threat_network"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threat_network_reports" ADD CONSTRAINT "threat_network_reports_reporting_agency_id_users_id_fk" FOREIGN KEY ("reporting_agency_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_detections" ADD CONSTRAINT "watchlist_detections_known_threat_id_known_threats_watchlist_id_fk" FOREIGN KEY ("known_threat_id") REFERENCES "public"."known_threats_watchlist"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_detections" ADD CONSTRAINT "watchlist_detections_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelisted_identifiers" ADD CONSTRAINT "whitelisted_identifiers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelisted_identifiers" ADD CONSTRAINT "whitelisted_identifiers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_blackmail" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_threat" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_defamation" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_harassment" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_spam" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_blackmail" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_threat" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_defamation" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_harassment" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_spam" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_blackmail_threshold" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_threat_threshold" integer DEFAULT 60;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_defamation_threshold" integer DEFAULT 65;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_harassment_threshold" integer DEFAULT 65;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_hide_spam_threshold" integer DEFAULT 75;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_blackmail_threshold" integer DEFAULT 50;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_threat_threshold" integer DEFAULT 50;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_defamation_threshold" integer DEFAULT 55;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_harassment_threshold" integer DEFAULT 55;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "flag_delete_spam_threshold" integer DEFAULT 65;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "is_watchlisted" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "watchlisted_at" timestamp;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "watchlist_reason" text;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "is_public_threat" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "public_threat_at" timestamp;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "public_threat_description" text;--> statement-breakpoint
ALTER TABLE "suspicious_accounts" ADD COLUMN "is_hidden" boolean DEFAULT true;
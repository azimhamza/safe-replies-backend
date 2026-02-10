CREATE TYPE "public"."onboarding_stage" AS ENUM('INVITATION_SENT', 'ACCOUNT_CREATED', 'FACEBOOK_CONNECTED', 'INSTAGRAM_CONNECTED', 'COMMENTS_SYNCING', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_ig_comment_id_unique";--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_fb_comment_id_unique";--> statement-breakpoint
ALTER TABLE "facebook_pages" DROP CONSTRAINT "facebook_pages_facebook_page_id_unique";--> statement-breakpoint
ALTER TABLE "instagram_accounts" DROP CONSTRAINT "instagram_accounts_instagram_id_unique";--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_ig_post_id_unique";--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_fb_post_id_unique";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "onboarding_stage" "onboarding_stage" DEFAULT 'INVITATION_SENT';--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "account_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "facebook_connected_at" timestamp;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "instagram_connected_at" timestamp;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "first_comments_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "onboarding_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "managed_client_id" uuid;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_managed_client_id_clients_id_fk" FOREIGN KEY ("managed_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
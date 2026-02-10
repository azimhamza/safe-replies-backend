CREATE TABLE "follower_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(50) DEFAULT 'instagram' NOT NULL,
	"instagram_account_id" uuid,
	"facebook_page_id" uuid,
	"followers_count" integer NOT NULL,
	"following_count" integer,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "account_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."account_type";--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('BASIC_AGENCY', 'MAX_AGENCY', 'CREATOR');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "account_type" SET DATA TYPE "public"."account_type" USING "account_type"::"public"."account_type";--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "confidence_delete_threshold" integer DEFAULT 90;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "confidence_hide_threshold" integer DEFAULT 70;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "similarity_auto_mod_enabled" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN "similarity_threshold" integer DEFAULT 85;--> statement-breakpoint
ALTER TABLE "follower_history" ADD CONSTRAINT "follower_history_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follower_history" ADD CONSTRAINT "follower_history_facebook_page_id_facebook_pages_id_fk" FOREIGN KEY ("facebook_page_id") REFERENCES "public"."facebook_pages"("id") ON DELETE cascade ON UPDATE no action;
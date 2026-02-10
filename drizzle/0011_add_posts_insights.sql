-- Add Instagram insights columns to posts table
-- Requires instagram_business_manage_insights permission
ALTER TABLE "posts" ADD COLUMN "impressions" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "reach" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "engagement" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "saved" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "video_views" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "insights_last_fetched_at" timestamp;

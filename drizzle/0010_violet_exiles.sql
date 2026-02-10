ALTER TABLE "mastermind_mentions" ALTER COLUMN "mention_type" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_blocked" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "blocked_at" timestamp;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "block_failed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "block_error" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_restricted" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "restricted_at" timestamp;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "restrict_failed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "restrict_error" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_reported" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "reported_at" timestamp;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "report_failed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "report_error" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_approved" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "approve_failed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "approve_error" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "likes_count" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "comments_count" integer;--> statement-breakpoint
DROP TYPE "public"."mention_type";
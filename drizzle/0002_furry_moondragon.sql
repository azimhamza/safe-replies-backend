ALTER TABLE "comments" ADD COLUMN "is_hidden" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "hidden_at" timestamp;
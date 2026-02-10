ALTER TABLE "clients" ADD COLUMN "invitation_token" varchar(255);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "invitation_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "invitation_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "is_invited" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD COLUMN "name" varchar(255);--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD COLUMN "followers_count" integer;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD COLUMN "following_count" integer;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD COLUMN "profile_picture_url" text;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_invitation_token_unique" UNIQUE("invitation_token");
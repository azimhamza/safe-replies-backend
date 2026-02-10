-- Add managed_client_id to moderation_settings for agency client-scoped rules
--> statement-breakpoint
ALTER TABLE "moderation_settings" ADD COLUMN IF NOT EXISTS "managed_client_id" uuid REFERENCES "clients"("id");

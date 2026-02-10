-- Add auto-hide and auto-delete fields to suspicious_accounts table
ALTER TABLE "suspicious_accounts" ADD COLUMN IF NOT EXISTS "auto_hide_enabled" boolean DEFAULT false;
ALTER TABLE "suspicious_accounts" ADD COLUMN IF NOT EXISTS "auto_delete_enabled" boolean DEFAULT false;

-- Set auto_delete_enabled to true for accounts that are already blocked
UPDATE "suspicious_accounts" SET "auto_delete_enabled" = true WHERE "is_blocked" = true;

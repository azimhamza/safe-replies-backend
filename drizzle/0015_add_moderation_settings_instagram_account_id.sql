-- Ensure moderation_settings has instagram_account_id (added in 0007; this is idempotent for DBs that missed 0007)
ALTER TABLE "moderation_settings" ADD COLUMN IF NOT EXISTS "instagram_account_id" uuid;

-- Add FK only if it doesn't exist (e.g. 0007 was never run)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'moderation_settings_instagram_account_id_instagram_accounts_id_fk'
  ) THEN
    ALTER TABLE "moderation_settings"
    ADD CONSTRAINT "moderation_settings_instagram_account_id_instagram_accounts_id_fk"
    FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

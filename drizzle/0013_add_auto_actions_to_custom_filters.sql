-- Add auto-action fields to custom_filters table
ALTER TABLE "custom_filters" ADD COLUMN IF NOT EXISTS "auto_hide" boolean DEFAULT false;
ALTER TABLE "custom_filters" ADD COLUMN IF NOT EXISTS "auto_delete" boolean DEFAULT false;
ALTER TABLE "custom_filters" ADD COLUMN IF NOT EXISTS "auto_flag" boolean DEFAULT false;

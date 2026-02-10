-- Add isHidden and hiddenAt fields to comments table
ALTER TABLE "comments" ADD COLUMN "is_hidden" boolean DEFAULT false;
ALTER TABLE "comments" ADD COLUMN "hidden_at" timestamp;

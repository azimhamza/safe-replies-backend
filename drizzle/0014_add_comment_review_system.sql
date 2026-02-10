-- Create review_action enum for comment review workflow
CREATE TYPE "review_action" AS ENUM ('ALLOW_THIS', 'ALLOW_SIMILAR', 'HIDE_THIS', 'AUTO_HIDE_SIMILAR', 'DELETE_THIS', 'AUTO_DELETE_SIMILAR');

-- Create comment_review_actions table
CREATE TABLE "comment_review_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "comment_id" uuid NOT NULL REFERENCES "comments"("id"),
  "action" "review_action" NOT NULL,
  "reviewed_by_user_id" uuid REFERENCES "users"("id"),
  "reviewed_by_client_id" uuid REFERENCES "clients"("id"),
  "reviewed_at" timestamp DEFAULT now(),
  "similarity_threshold" numeric(5,4),
  "custom_filter_id" uuid REFERENCES "custom_filters"("id"),
  "notes" text,
  "created_at" timestamp DEFAULT now()
);

-- Add indexes for comment_review_actions
CREATE INDEX "comment_review_actions_comment_id_idx" ON "comment_review_actions"("comment_id");
CREATE INDEX "comment_review_actions_action_idx" ON "comment_review_actions"("action");
CREATE INDEX "comment_review_actions_reviewed_at_idx" ON "comment_review_actions"("reviewed_at");

-- Add review tracking columns to comments table
ALTER TABLE "comments" ADD COLUMN "reviewed_at" timestamp;
ALTER TABLE "comments" ADD COLUMN "review_action" "review_action";
ALTER TABLE "comments" ADD COLUMN "is_allowed" boolean DEFAULT false;

-- Add indexes for comments review columns
CREATE INDEX "comments_reviewed_at_idx" ON "comments"("reviewed_at");
CREATE INDEX "comments_is_allowed_idx" ON "comments"("is_allowed");
CREATE INDEX "comments_review_action_idx" ON "comments"("review_action");

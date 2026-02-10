-- Migration: Add follower_history table for tracking follower counts over time
-- This enables follower growth analytics (hourly, daily, weekly, monthly, yearly)

CREATE TABLE IF NOT EXISTS follower_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) DEFAULT 'instagram' NOT NULL,
  instagram_account_id UUID REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  facebook_page_id UUID REFERENCES facebook_pages(id) ON DELETE CASCADE,
  followers_count INTEGER NOT NULL,
  following_count INTEGER,
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),

  -- Constraint: must have either IG or FB account reference
  CONSTRAINT check_account_reference CHECK (
    (instagram_account_id IS NOT NULL AND facebook_page_id IS NULL) OR
    (instagram_account_id IS NULL AND facebook_page_id IS NOT NULL)
  )
);

-- Performance indexes for time-range queries
CREATE INDEX IF NOT EXISTS idx_follower_history_ig_account ON follower_history(instagram_account_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_follower_history_fb_page ON follower_history(facebook_page_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_follower_history_recorded_at ON follower_history(recorded_at DESC);

-- Index for efficient cleanup queries (data retention)
CREATE INDEX IF NOT EXISTS idx_follower_history_source_recorded ON follower_history(source, recorded_at DESC);

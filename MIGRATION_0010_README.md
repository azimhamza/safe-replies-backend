# Migration 0010: Add Likes and Comments Count to Posts

## Overview
This migration adds `likes_count` and `comments_count` columns to the `posts` table to track Instagram post engagement metrics.

## Migration Files
- **Generated Migration**: `drizzle/0010_violet_exiles.sql`
- **Manual Migration** (if needed): `manual-migration-0010.sql`
- **Test Data Script**: `update-posts-with-test-data.ts`

## Running the Migration

### Option 1: Using Drizzle Kit (Recommended)
```bash
cd backend
npx drizzle-kit push
```

### Option 2: Manual SQL Execution
If the automated migration fails, you can run the SQL manually:

1. Connect to your database
2. Execute the SQL from `manual-migration-0010.sql`:
```bash
psql $DATABASE_URL -f manual-migration-0010.sql
```

Or copy and paste the SQL directly into your database client.

### Option 3: Using the Migration Runner Script
```bash
cd backend
npm run migrate:run
```

## Populating Test Data

After running the migration, populate existing posts with test data:

```bash
cd backend
npm run update:posts
```

This script will:
- Find all posts without likes/comments count
- Generate realistic test data based on Instagram engagement patterns
- Update posts with likes (500-5000 range) and comments (1-5% of likes)

## What Changed

### Database Schema
- Added `likes_count` (integer, nullable) to `posts` table
- Added `comments_count` (integer, nullable) to `posts` table

### Code Changes
- Updated `InstagramService` to fetch `like_count` and `comments_count` from Instagram API
- Updated sync function to store these values when syncing posts
- Updated comments controller to return post details with likes/comments count
- Updated frontend to display post engagement metrics

## Verification

After running the migration, verify the columns exist:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'posts'
AND column_name IN ('likes_count', 'comments_count');
```

You should see:
- `likes_count` | `integer` | `YES`
- `comments_count` | `integer` | `YES`

## Notes

- The columns are nullable to support existing posts that don't have this data yet
- New posts synced from Instagram will automatically have these values populated
- Use the test data script to populate existing posts for testing purposes

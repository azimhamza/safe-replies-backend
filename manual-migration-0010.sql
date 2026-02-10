-- Manual migration script for adding likes_count and comments_count to posts table
-- Run this SQL directly in your database if the automated migration fails

-- Add likes_count column (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'posts'
        AND column_name = 'likes_count'
    ) THEN
        ALTER TABLE "posts" ADD COLUMN "likes_count" integer;
        RAISE NOTICE 'Added likes_count column to posts table';
    ELSE
        RAISE NOTICE 'likes_count column already exists';
    END IF;
END $$;

-- Add comments_count column (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'posts'
        AND column_name = 'comments_count'
    ) THEN
        ALTER TABLE "posts" ADD COLUMN "comments_count" integer;
        RAISE NOTICE 'Added comments_count column to posts table';
    ELSE
        RAISE NOTICE 'comments_count column already exists';
    END IF;
END $$;

-- Verify the columns were added
SELECT 
    column_name, 
    data_type, 
    is_nullable
FROM information_schema.columns
WHERE table_name = 'posts'
AND column_name IN ('likes_count', 'comments_count')
ORDER BY column_name;

-- Run these commands manually in your database if push fails

-- Enable pgvector extension (skip if already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column as vector if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'comments'
        AND column_name = 'embedding'
        AND data_type = 'USER-DEFINED'
        AND udt_name = 'vector'
    ) THEN
        -- Add the vector column
        ALTER TABLE comments ADD COLUMN embedding_vector vector(1024);

        -- Copy any existing data if needed
        UPDATE comments SET embedding_vector = embedding::text::vector WHERE embedding IS NOT NULL AND embedding != 'null';

        -- Drop old column and rename new one
        ALTER TABLE comments DROP COLUMN IF EXISTS embedding;
        ALTER TABLE comments RENAME COLUMN embedding_vector TO embedding;
    END IF;
END $$;

-- Create index for vector similarity (skip if already exists)
CREATE INDEX CONCURRENTLY IF NOT EXISTS comments_embedding_idx ON comments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
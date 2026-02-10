-- Enable pgvector extension for vector operations
CREATE EXTENSION IF NOT EXISTS vector;

-- Convert embedding column from jsonb to vector type
-- First, add a temporary column
ALTER TABLE comments ADD COLUMN embedding_vector vector(1024);

-- Migrate existing data (if any) - convert jsonb arrays to vectors
UPDATE comments SET embedding_vector = embedding::text::vector WHERE embedding IS NOT NULL;

-- Drop the old jsonb column
ALTER TABLE comments DROP COLUMN embedding;

-- Rename the new column
ALTER TABLE comments RENAME COLUMN embedding_vector TO embedding;

-- Add index for vector similarity search
CREATE INDEX comments_embedding_idx ON comments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
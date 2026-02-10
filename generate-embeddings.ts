#!/usr/bin/env tsx

import { embeddingsService } from './src/services/embeddings.service';

/**
 * Script to generate embeddings for existing comments using Jina AI
 * Run with: pnpm tsx generate-embeddings.ts
 */
async function main() {
  console.log('Starting embedding generation...');

  try {
    await embeddingsService.generateEmbeddingsForComments(50);
    console.log('Embedding generation completed successfully!');
  } catch (error) {
    console.error('Error generating embeddings:', error);
    process.exit(1);
  }
}

main();
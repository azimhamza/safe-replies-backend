import * as https from 'https';
import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { comments, posts, instagramAccounts } from '../db/schema';

interface JinaEmbeddingResponse {
  data: Array<{
    embedding: number[];
  }>;
  usage?: {
    total_tokens?: number;
  };
}

export class EmbeddingsService {

  /**
   * Generate embeddings for comments that don't have them yet
   */
  async generateEmbeddingsForComments(batchSize: number = 50): Promise<void> {
    // Get comments without embeddings
    const commentsWithoutEmbeddings = await db
      .select({
        id: comments.id,
        text: comments.text,
      })
      .from(comments)
      .where(sql`${comments.embedding} IS NULL`)
      .limit(batchSize);

    if (commentsWithoutEmbeddings.length === 0) {
      console.log('No comments found that need embeddings');
      return;
    }

    console.log(`Generating embeddings for ${commentsWithoutEmbeddings.length} comments`);

    // Prepare texts for embedding
    const texts = commentsWithoutEmbeddings.map(comment => comment.text);

    try {
      // Generate embeddings using Jina AI
      const embeddings = await this.generateJinaEmbeddings(texts);

      // Update comments with embeddings
      for (let i = 0; i < commentsWithoutEmbeddings.length; i++) {
        const comment = commentsWithoutEmbeddings[i];
        const embedding = embeddings[i];

        await db
          .update(comments)
          .set({
            embedding: embedding,
          })
          .where(eq(comments.id, comment.id));
      }

      console.log(`Successfully generated embeddings for ${commentsWithoutEmbeddings.length} comments`);
    } catch (error) {
      console.error('Error generating embeddings:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings using Jina AI.
   * Public so ModerationService can generate embeddings for incoming comments inline.
   */
  async generateJinaEmbeddings(texts: string[]): Promise<number[][]> {
    const data = JSON.stringify({
      model: "jina-embeddings-v3",
      task: "text-matching",
      input: texts
    });

    const options = {
      hostname: 'api.jina.ai',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const response: JinaEmbeddingResponse = JSON.parse(responseData);

            if (!response.data || !Array.isArray(response.data)) {
              reject(new Error('Invalid response format from Jina AI'));
              return;
            }

            const embeddings = response.data.map(item => item.embedding);
            resolve(embeddings);
          } catch (error) {
            reject(new Error(`Failed to parse Jina AI response: ${error}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Jina AI request failed: ${e.message}`));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  calculateCosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have the same dimensions');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  /**
   * Find similar comments using pgvector similarity search (efficient)
   */
  async findSimilarCommentsEfficient(
    commentId: string,
    limit: number = 20,
    minSimilarity: number = 0.7
  ): Promise<{
    commentId: string;
    commenterId: string;
    commenterUsername: string;
    similarity: number;
    text: string;
  }[]> {
    // Get the embedding for the target comment
    const targetComment = await db
      .select({
        id: comments.id,
        commenterId: comments.commenterId,
        embedding: comments.embedding,
      })
      .from(comments)
      .where(eq(comments.id, commentId))
      .limit(1);

    if (!targetComment[0]?.embedding) {
      throw new Error('Target comment does not have an embedding');
    }

    const targetEmbedding = targetComment[0].embedding as number[];
    const targetCommenterId = targetComment[0].commenterId;

    // Use pgvector's built-in similarity search
    const similarComments = await db
      .select({
        id: comments.id,
        commenterId: comments.commenterId,
        commenterUsername: comments.commenterUsername,
        text: comments.text,
        similarity: sql<number>`1 - (${comments.embedding} <=> ${targetEmbedding})`,
      })
      .from(comments)
      .where(and(
        sql`${comments.embedding} IS NOT NULL`,
        sql`${comments.id} != ${commentId}`,
        sql`${comments.commenterId} != ${targetCommenterId}`, // Different accounts only
        sql`1 - (${comments.embedding} <=> ${targetEmbedding}) > ${minSimilarity}`
      ))
      .orderBy(sql`1 - (${comments.embedding} <=> ${targetEmbedding}) DESC`)
      .limit(limit);

    return similarComments.map(comment => ({
      commentId: comment.id,
      commenterId: comment.commenterId,
      commenterUsername: comment.commenterUsername,
      similarity: comment.similarity,
      text: comment.text,
    }));
  }

  /**
   * Find all similar comment pairs across different accounts (efficient batch processing)
   */
  async findSimilarCommentPairsBatch(
    clientId?: string,
    userId?: string,
    daysBack: number = 30,
    batchSize: number = 100,
    minSimilarity: number = 0.75
  ): Promise<Array<{
    comment1: { id: string; commenterId: string; text: string };
    comment2: { id: string; commenterId: string; text: string };
    similarity: number;
  }>> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    // Get all comments with embeddings in the time range
    const allComments = await db
      .select({
        id: comments.id,
        commenterId: comments.commenterId,
        commenterUsername: comments.commenterUsername,
        text: comments.text,
        embedding: comments.embedding,
      })
      .from(comments)
      .leftJoin(posts, eq(comments.postId, posts.id))
      .leftJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
      .where(and(
        ...(clientId ? [eq(instagramAccounts.clientId, clientId)] : []),
        ...(userId ? [eq(instagramAccounts.userId, userId)] : []),
        gte(comments.commentedAt, startDate),
        eq(comments.isDeleted, false),
        sql`${comments.embedding} IS NOT NULL`
      ))
      .orderBy(comments.commentedAt)
      .limit(batchSize * 2); // Get enough for batch processing

    const similarPairs: Array<{
      comment1: { id: string; commenterId: string; text: string };
      comment2: { id: string; commenterId: string; text: string };
      similarity: number;
    }> = [];

    // Process in batches to avoid memory issues
    for (let i = 0; i < Math.min(allComments.length, batchSize); i++) {
      const comment1 = allComments[i];
      if (!comment1.embedding) continue;

      const embedding1 = comment1.embedding as number[];

      // Find similar comments from different accounts
      for (let j = i + 1; j < allComments.length; j++) {
        const comment2 = allComments[j];
        if (!comment2.embedding || comment1.commenterId === comment2.commenterId) continue;

        const embedding2 = comment2.embedding as number[];
        const similarity = this.calculateCosineSimilarity(embedding1, embedding2);

        if (similarity > minSimilarity) {
          similarPairs.push({
            comment1: {
              id: comment1.id,
              commenterId: comment1.commenterId,
              text: comment1.text,
            },
            comment2: {
              id: comment2.id,
              commenterId: comment2.commenterId,
              text: comment2.text,
            },
            similarity,
          });

          // Limit pairs per comment to avoid explosion
          if (similarPairs.length >= batchSize * 10) break;
        }
      }

      if (similarPairs.length >= batchSize * 10) break;
    }

    return similarPairs;
  }

  /**
   * Calculate centroid of multiple vectors
   */
  calculateCentroid(vectors: number[][]): number[] {
    if (vectors.length === 0) {
      throw new Error('Cannot calculate centroid of empty vector array');
    }

    const dimensions = vectors[0].length;
    const centroid = new Array(dimensions).fill(0);

    for (const vector of vectors) {
      if (vector.length !== dimensions) {
        throw new Error('All vectors must have the same dimensions');
      }
      for (let i = 0; i < dimensions; i++) {
        centroid[i] += vector[i];
      }
    }

    for (let i = 0; i < dimensions; i++) {
      centroid[i] /= vectors.length;
    }

    return centroid;
  }

  /**
   * Calculate dynamic similarity threshold based on data distribution
   */
  async calculateDynamicThreshold(
    clientId?: string,
    userId?: string,
    daysBack: number = 30,
    sampleSize: number = 1000
  ): Promise<number> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    // Sample embeddings to analyze distribution
    const sampleEmbeddings = await db
      .select({ embedding: comments.embedding })
      .from(comments)
      .leftJoin(posts, eq(comments.postId, posts.id))
      .leftJoin(instagramAccounts, eq(posts.instagramAccountId, instagramAccounts.id))
      .where(and(
        ...(clientId ? [eq(instagramAccounts.clientId, clientId)] : []),
        ...(userId ? [eq(instagramAccounts.userId, userId)] : []),
        gte(comments.commentedAt, startDate),
        eq(comments.isDeleted, false),
        sql`${comments.embedding} IS NOT NULL`
      ))
      .limit(sampleSize);

    if (sampleEmbeddings.length < 10) {
      return 0.75; // Default threshold if insufficient data
    }

    // Calculate similarities between random pairs
    const similarities: number[] = [];
    const vectors = sampleEmbeddings
      .map(row => row.embedding as number[])
      .filter(vec => vec && vec.length > 0);

    // Sample random pairs (limit to avoid O(n²))
    const pairCount = Math.min(1000, vectors.length * (vectors.length - 1) / 2);
    for (let i = 0; i < Math.min(pairCount, vectors.length); i++) {
      const j = Math.floor(Math.random() * vectors.length);
      const k = Math.floor(Math.random() * vectors.length);
      if (j !== k) {
        similarities.push(this.calculateCosineSimilarity(vectors[j], vectors[k]));
      }
    }

    if (similarities.length === 0) {
      return 0.75;
    }

    // Calculate dynamic threshold based on distribution
    similarities.sort((a, b) => a - b);

    // Use 85th percentile as threshold (filter out most noise but catch patterns)
    const percentile85 = similarities[Math.floor(similarities.length * 0.85)];

    // Ensure reasonable bounds
    return Math.max(0.6, Math.min(0.9, percentile85));
  }
}

export const embeddingsService = new EmbeddingsService();
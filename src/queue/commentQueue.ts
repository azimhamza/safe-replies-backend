import { QueueJob, ClassifyCommentJob } from '../types';
import { moderationService } from '../services/moderation.service';
import { db } from '../db';
import { instagramAccounts, facebookPages } from '../db/schema';
import { eq } from 'drizzle-orm';

type JobHandler<T> = (data: T) => Promise<void>;

const DEFAULT_CONCURRENCY = 15;
const MAX_CONCURRENCY = 100;
const getConcurrency = (): number => {
  const env = process.env.COMMENT_QUEUE_CONCURRENCY;
  if (env === undefined || env === '') return DEFAULT_CONCURRENCY;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_CONCURRENCY) : DEFAULT_CONCURRENCY;
};

export class CommentQueue {
  private queue: QueueJob[] = [];
  private processing = false;
  private activeCount = 0;
  private handlers: Map<string, JobHandler<unknown>> = new Map();
  private maxRetries = 3;
  private concurrency = getConcurrency();

  constructor() {
    this.registerHandler('CLASSIFY_COMMENT', this.handleClassifyComment.bind(this));
  }

  /**
   * Register a job handler
   */
  registerHandler<T>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler<unknown>);
  }

  /**
   * Add a single job to queue
   */
  async enqueue<T>(type: string, data: T): Promise<void> {
    const job: QueueJob<T> = {
      id: this.generateId(),
      type,
      data,
      attempts: 0,
      maxAttempts: this.maxRetries,
      createdAt: new Date()
    };

    this.queue.push(job as QueueJob);

    // Start processing if not already running
    if (!this.processing) {
      this.processing = true;
      void this.drain();
    }
  }

  /**
   * Add multiple jobs at once (avoids repeated drain checks per item).
   * Accepts an array of {type, data} pairs.
   */
  async enqueueBatch<T>(jobs: Array<{ type: string; data: T }>): Promise<number> {
    const enqueued: QueueJob[] = jobs.map(j => ({
      id: this.generateId(),
      type: j.type,
      data: j.data,
      attempts: 0,
      maxAttempts: this.maxRetries,
      createdAt: new Date()
    }));

    this.queue.push(...enqueued);

    if (!this.processing) {
      this.processing = true;
      void this.drain();
    }

    return enqueued.length;
  }

  /**
   * Drain queue: start up to concurrency jobs; when each finishes, start the next.
   */
  private drain(): void {
    while (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const job = this.queue.shift();
      if (!job) continue;

      this.activeCount++;
      this.runOne(job);
    }

    if (this.activeCount === 0 && this.queue.length === 0) {
      this.processing = false;
    }
  }

  /**
   * Run a single job; on completion (or failure) decrement active count and drain again.
   */
  private runOne(job: QueueJob): void {
    this.processJob(job)
      .then(() => {
        // success – no retry
      })
      .catch((error) => {
        console.error(`Job ${job.id} failed:`, error);
        if (job.attempts < job.maxAttempts) {
          job.attempts++;
          this.queue.push(job);
          console.log(`Re-queuing job ${job.id}, attempt ${job.attempts}/${job.maxAttempts}`);
        } else {
          console.error(`Job ${job.id} failed after ${job.maxAttempts} attempts`);
        }
      })
      .finally(() => {
        this.activeCount--;
        this.drain();
      });
  }

  /**
   * Process a single job
   */
  private async processJob(job: QueueJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    
    if (!handler) {
      throw new Error(`No handler registered for job type: ${job.type}`);
    }

    await handler(job.data);
  }

  /**
   * Handler for classifying comments
   */
  private async handleClassifyComment(data: unknown): Promise<void> {
    const jobData = data as ClassifyCommentJob;
    
    console.log(`🔍 Processing comment ${jobData.commentId} for moderation...`);
    
    // Get userId/clientId if not provided in job data
    let userId = jobData.userId;
    let clientId = jobData.clientId;
    
    if (!userId && !clientId) {
      // Try to find via Instagram Account
      if (jobData.instagramAccountId) {
        const instagramAccount = await db.query.instagramAccounts.findFirst({
          where: eq(instagramAccounts.id, jobData.instagramAccountId)
        });
        
        if (instagramAccount) {
          userId = instagramAccount.userId || undefined;
          clientId = instagramAccount.clientId || undefined;
        }
      } 
      
      // If not found, try via Facebook Page
      if ((!userId && !clientId) && jobData.facebookPageId) {
        const facebookPage = await db.query.facebookPages.findFirst({
          where: eq(facebookPages.id, jobData.facebookPageId)
        });
        
        if (facebookPage) {
          userId = facebookPage.userId || undefined;
          clientId = facebookPage.clientId || undefined;
        }
      }
    }
    
    await moderationService.moderateComment({
      commentId: jobData.commentId,
      commentText: jobData.commentText,
      commenterId: jobData.commenterId,
      commenterUsername: jobData.commenterUsername,
      instagramAccountId: jobData.instagramAccountId,
      facebookPageId: jobData.facebookPageId,
      postId: jobData.postId,
      igCommentId: jobData.igCommentId,
      fbCommentId: jobData.fbCommentId,
      accessToken: jobData.accessToken,
      userId,
      clientId
    });
    
    console.log(`✅ Comment ${jobData.commentId} moderation complete`);
  }

  /**
   * Get queue stats
   */
  getStats(): {
    queueLength: number;
    activeCount: number;
    concurrency: number;
    processing: boolean;
  } {
    return {
      queueLength: this.queue.length,
      activeCount: this.activeCount,
      concurrency: this.concurrency,
      processing: this.processing
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}

// Export singleton instance
export const commentQueue = new CommentQueue();

import { Request, Response } from 'express';
import { instagramService } from '../services/instagram.service';
import { commentQueue } from '../queue/commentQueue';
import { db } from '../db';
import { comments } from '../db/schema';
import { eq } from 'drizzle-orm';

interface WebhookEntry {
  id: string;
  time: number;
  changes: Array<{
    value: {
      id: string;
      text?: string;
      from?: {
        id: string;
        username: string;
      };
      media?: {
        id: string;
      };
    };
    field: string;
  }>;
}

/**
 * Handle Instagram webhook events
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  try {
    // Verify webhook signature
    const signature = req.headers['x-hub-signature-256'] as string;
    
    if (!signature) {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }

    const body = JSON.stringify(req.body);
    const isValid = instagramService.verifyWebhookSignature(signature, body);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse webhook payload
    const entries = req.body.entry as WebhookEntry[];

    for (const entry of entries) {
      for (const change of entry.changes) {
        if (change.field === 'comments') {
          await handleCommentEvent(change.value);
        }
      }
    }

    // Return 200 immediately (non-blocking)
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Handle verification challenge from Instagram
 */
export async function verifyWebhook(req: Request, res: Response): Promise<void> {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
}

/**
 * Handle comment event
 * 
 * Note: Instagram webhooks only send minimal data (id, text, from, media).
 * We store immediately with webhook data, then optionally fetch full comment
 * details (including hidden, like_count, timestamp) from the API in the background.
 */
async function handleCommentEvent(value: {
  id: string;
  text?: string;
  from?: {
    id: string;
    username: string;
  };
  media?: {
    id: string;
  };
  parent_id?: string; // Instagram webhook may include parent_id for replies
}): Promise<void> {
  if (!value.text || !value.from || !value.media) {
    console.log('Incomplete comment data, skipping');
    return;
  }

  try {
    // Find ALL posts matching this media ID (could be multiple accounts connected)
    const matchingPosts = await db.query.posts.findMany({
      where: (posts, { eq }) => eq(posts.igPostId, value.media!.id)
    });

    if (matchingPosts.length === 0) {
      console.log(`Post not found for media ID: ${value.media.id}`);
      return;
    }

    console.log(`Processing comment ${value.id} for ${matchingPosts.length} account(s)`);

    // Process for each account that has this post
    for (const post of matchingPosts) {
        // Get Instagram account
        const instagramAccount = await db.query.instagramAccounts.findFirst({
          where: (ia, { eq }) => eq(ia.id, post.instagramAccountId!)
        });
        
        if (!instagramAccount) {
          console.error(`Instagram account not found for post ${post.id}`);
          continue;
        }

        // Get Page access token (Facebook Login migration)
        let accessToken: string | null = null;
        if (instagramAccount.facebookPageId) {
          const facebookPage = await db.query.facebookPages.findFirst({
            where: (facebookPages, { eq }) => eq(facebookPages.id, instagramAccount.facebookPageId!)
          });
          accessToken = facebookPage?.pageAccessToken || null;
        }
        
        // Fallback to legacy token if no Page token
        if (!accessToken) {
          accessToken = instagramAccount.accessToken;
        }

        if (!accessToken) {
          console.error(`No access token available for Instagram account ${instagramAccount.username}`);
          continue;
        }

        // Check if this is a reply (webhook may include parent_id)
        let initialParentCommentId: string | null = null;
        if (value.parent_id) {
          // Try to find parent comment in database linked to THIS post
          const parentComment = await db.query.comments.findFirst({
            where: (comments, { and, eq }) => and(
                eq(comments.igCommentId, value.parent_id!),
                eq(comments.postId, post.id)
            )
          });
          if (parentComment) {
            initialParentCommentId = parentComment.id;
            console.log(`📩 Reply detected in webhook: ${value.id} → parent: ${value.parent_id}`);
          } else {
            console.warn(`⚠️  Parent comment ${value.parent_id} not found for reply ${value.id} on post ${post.id} (will retry after API fetch)`);
          }
        }

        // Store comment in database IMMEDIATELY (before any processing)
        // Use webhook data first, then enhance with full API data if available
        const [comment] = await db.insert(comments).values({
          postId: post.id,
          igCommentId: value.id,
          text: value.text,
          commenterUsername: value.from.username,
          commenterId: value.from.id,
          commentedAt: new Date(), // Webhook doesn't provide timestamp, use current time
          parentCommentId: initialParentCommentId // Set if we found parent from webhook
        }).returning();

        // Fetch full comment details from API (non-blocking, in background)
        // This ensures we get fields like hidden, like_count, accurate timestamp, and parent_id
        instagramService.getComments(value.media.id, accessToken)
          .then(async (fullComments) => {
            // Find the specific comment we just stored
            const fullComment = fullComments.find(c => c.id === value.id);
            if (fullComment) {
              // Check if this is a reply (has parent_id)
              let parentCommentId: string | null = null;
              if (fullComment.parent_id || fullComment.parentCommentId) {
                const parentIgCommentId = fullComment.parent_id || fullComment.parentCommentId;
                // Find parent comment in database FOR THIS POST
                const parentComment = await db.query.comments.findFirst({
                  where: (comments, { and, eq }) => and(
                      eq(comments.igCommentId, parentIgCommentId!),
                      eq(comments.postId, post.id)
                  )
                });
                if (parentComment) {
                  parentCommentId = parentComment.id;
                } else {
                  console.warn(`⚠️  Parent comment ${parentIgCommentId} not found for reply ${value.id} on post ${post.id}`);
                }
              }

              // Update comment with full details including parent relationship
              await db.update(comments)
                .set({
                  commentedAt: new Date(fullComment.timestamp),
                  isHidden: fullComment.hidden === true,
                  parentCommentId: parentCommentId
                })
                .where(eq(comments.id, comment.id));
              
              console.log(`✅ Enhanced comment ${value.id} for post ${post.id} with full API data${parentCommentId ? ` (reply to ${parentCommentId})` : ''}`);
            }
          })
          .catch(err => {
            // Non-critical - webhook data is already stored
            console.log(`⚠️  Could not fetch full comment details for ${value.id} (non-critical):`, err.message);
          });

        // Enqueue for moderation (async) - ALL comments including replies go through LLM moderation
        await commentQueue.enqueue('CLASSIFY_COMMENT', {
          commentId: comment.id,
          commentText: value.text!,
          commenterId: value.from.id,
          commenterUsername: value.from.username,
          postId: post.id,
          instagramAccountId: instagramAccount.id,
          igCommentId: value.id,
          accessToken: accessToken,
          userId: instagramAccount.userId || undefined,
          clientId: instagramAccount.clientId || undefined
        });

        const isReply = initialParentCommentId !== null || value.parent_id !== undefined;
        console.log(`${isReply ? '💬 Reply' : '💬 Comment'} ${comment.id} stored and enqueued for LLM moderation${isReply ? ` (reply to ${initialParentCommentId || value.parent_id})` : ''}`);
    }
  } catch (error) {
    console.error('Error handling comment event:', error);
  }
}

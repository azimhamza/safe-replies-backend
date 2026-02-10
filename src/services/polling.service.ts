/**
 * Polling service: incremental sync of posts and comments from Instagram and Facebook.
 * Used by the 1-minute cron (Hybrid Poll) and the Daily Cron (Deep Sync).
 * 
 * Strategies:
 * 1. Hybrid Smart-Polling (Default):
 *    - Deep Check (Top 20 posts): Always fetch comments.
 *    - Signal Check (Older posts): Only fetch if comments_count changed.
 * 2. Deep Sync (Safety Net):
 *    - Fetches larger history (e.g., 500 posts).
 *    - Always fetches comments (ignores counts) to catch silent edits.
 */

import { db } from '../db';
import { instagramAccounts, facebookPages, posts, comments } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { instagramService } from './instagram.service';
import { facebookService } from './facebook.service';
import { commentQueue } from '../queue/commentQueue';
import pLimit from 'p-limit';

// Concurrency limits
const POST_CONCURRENCY = 5;
const HYBRID_DEEP_CHECK_LIMIT = 20;
const DEEP_SYNC_POST_LIMIT = 500;

interface PollOptions {
  forceDeepSync?: boolean;
}

async function getInstagramAccessToken(accountId: string): Promise<string | null> {
  const account = await db.query.instagramAccounts.findFirst({
    where: eq(instagramAccounts.id, accountId)
  });
  if (!account || !account.facebookPageId) {
    return account?.accessToken ?? null;
  }
  const page = await db.query.facebookPages.findFirst({
    where: eq(facebookPages.id, account.facebookPageId)
  });
  return page?.pageAccessToken ?? null;
}

/**
 * Polls an Instagram account.
 * @param accountId - The Instagram Account ID
 * @param options - { forceDeepSync: true } disables optimizations and checks history.
 */
export async function pollInstagramAccount(accountId: string, options: PollOptions = {}): Promise<{ postsUpdated: number; commentsNew: number; commentsUpdated: number }> {
  const account = await db.query.instagramAccounts.findFirst({
    where: eq(instagramAccounts.id, accountId)
  });
  if (!account || !account.isActive) {
    return { postsUpdated: 0, commentsNew: 0, commentsUpdated: 0 };
  }

  const accessToken = await getInstagramAccessToken(accountId);
  if (!accessToken) {
    console.warn(`[POLL] No access token for Instagram account ${account.username}`);
    return { postsUpdated: 0, commentsNew: 0, commentsUpdated: 0 };
  }

  const instagramUserId = account.instagramId;
  let postsUpdated = 0;
  let commentsNew = 0;
  let commentsUpdated = 0;

  try {
    // Determine post limit based on mode
    const fetchLimit = options.forceDeepSync ? DEEP_SYNC_POST_LIMIT : 25; // Default 25 covers Hybrid Deep Check (20)
    
    const mediaPosts = await instagramService.getMedia(instagramUserId, accessToken, fetchLimit);
    const limit = pLimit(POST_CONCURRENCY);

    await Promise.all(mediaPosts.map((post, index) => limit(async () => {
      try {
        // 1. Post Sync (Upsert) - Scoped to account
        const existingPost = await db.query.posts.findFirst({
          where: and(
            eq(posts.igPostId, post.id),
            eq(posts.instagramAccountId, accountId)
          )
        });

        let dbPostId: string;
        let dbCommentsCount = existingPost?.commentsCount ?? 0;

        if (existingPost) {
          await db.update(posts).set({
            caption: post.caption,
            likesCount: post.like_count ?? null,
            commentsCount: post.comments_count ?? null
          }).where(eq(posts.id, existingPost.id));
          dbPostId = existingPost.id;
          postsUpdated++;
        } else {
          let mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL' = 'IMAGE';
          if (post.media_type === 'VIDEO') mediaType = 'VIDEO';
          else if (post.media_type === 'CAROUSEL_ALBUM') mediaType = 'CAROUSEL';

          const [newPost] = await db.insert(posts).values({
            instagramAccountId: accountId,
            igPostId: post.id,
            caption: post.caption,
            mediaType,
            permalink: post.permalink,
            postedAt: new Date(post.timestamp),
            likesCount: post.like_count ?? null,
            commentsCount: post.comments_count ?? null
          }).returning();
          dbPostId = newPost!.id;
          postsUpdated++;
        }

        // 2. Optimization Check (Skip if not needed)
        if (!options.forceDeepSync) {
            const isRecent = index < HYBRID_DEEP_CHECK_LIMIT;
            const countChanged = (post.comments_count ?? 0) !== dbCommentsCount;
            if (!isRecent && !countChanged) {
                return; // SKIP
            }
        }

        // 3. Fetch Comments
        const apiComments = await instagramService.getComments(post.id, accessToken);
        
        // 4. Batch Diffing
        const existingComments = await db.query.comments.findMany({
          where: eq(comments.postId, dbPostId)
        });
        
        const existingMap = new Map(existingComments.map(c => [c.igCommentId, c]));
        const jobsToEnqueue: any[] = [];

        const topLevelApi = apiComments.filter(c => !c.parentCommentId);
        const repliesApi = apiComments.filter(c => c.parentCommentId);
        const newTopLevelMap = new Map<string, string>(); // igId -> dbId

        // Process Top Level
        for (const comment of topLevelApi) {
          if (!comment.from) {
            console.error('Comment missing from field', comment.id);
            continue;
          }
          const existing = existingMap.get(comment.id);
          const commenterId = comment.from.id; // Instagram always provides this
          const commenterUsername = comment.from.username || comment.username || 'unknown';
          const isHidden = comment.hidden === true;

          if (existing) {
            const textChanged = existing.text !== comment.text;
            const hiddenChanged = existing.isHidden !== isHidden;
            if (textChanged || hiddenChanged) {
               await db.update(comments).set({
                text: comment.text,
                isHidden: isHidden,
                ...(hiddenChanged && isHidden ? { hiddenAt: new Date() } : {})
              }).where(eq(comments.id, existing.id));
              commentsUpdated++;
              
              if (textChanged) {
                // Re-moderate if text changed
                jobsToEnqueue.push({
                  commentId: existing.id,
                  commentText: comment.text,
                  commenterId,
                  commenterUsername,
                  igCommentId: comment.id
                });
              }
            }
          } else {
             const [inserted] = await db.insert(comments).values({
                postId: dbPostId,
                igCommentId: comment.id,
                text: comment.text,
                commenterUsername: commenterUsername,
                commenterId: commenterId,
                commentedAt: new Date(comment.timestamp),
                isHidden: isHidden,
                parentCommentId: null
              }).returning();
              
              newTopLevelMap.set(comment.id, inserted.id);
              commentsNew++;
              
              jobsToEnqueue.push({
                commentId: inserted.id,
                commentText: comment.text,
                commenterId,
                commenterUsername,
                igCommentId: comment.id
              });
          }
        }

        // Process Replies
        for (const reply of repliesApi) {
          if (!reply.from) {
            console.error('Reply missing from field', reply.id);
            continue;
          }
          const existing = existingMap.get(reply.id);
          const commenterId = reply.from.id; // Instagram always provides this
          const commenterUsername = reply.from.username || reply.username || 'unknown';
          const isHidden = reply.hidden === true;

          if (existing) {
             const textChanged = existing.text !== reply.text;
             const hiddenChanged = existing.isHidden !== isHidden;
             if (textChanged || hiddenChanged) {
               await db.update(comments).set({
                text: reply.text,
                isHidden: isHidden,
                ...(hiddenChanged && isHidden ? { hiddenAt: new Date() } : {})
              }).where(eq(comments.id, existing.id));
              commentsUpdated++;
              
              if (textChanged) {
                // Re-moderate if text changed
                jobsToEnqueue.push({
                  commentId: existing.id,
                  commentText: reply.text,
                  commenterId,
                  commenterUsername,
                  igCommentId: reply.id
                });
              }
             }
          } else {
            let parentDbId: string | undefined;
            const parentExisting = existingMap.get(reply.parentCommentId!);
            if (parentExisting) parentDbId = parentExisting.id;
            if (!parentDbId) parentDbId = newTopLevelMap.get(reply.parentCommentId!);
            if (!parentDbId) {
               const p = await db.query.comments.findFirst({ 
                   where: and(
                       eq(comments.igCommentId, reply.parentCommentId!), 
                       eq(comments.postId, dbPostId)
                   ) 
               });
               if (p) parentDbId = p.id;
            }

            const [inserted] = await db.insert(comments).values({
              postId: dbPostId,
              parentCommentId: parentDbId ?? null,
              igCommentId: reply.id,
              text: reply.text,
              commenterUsername: commenterUsername,
              commenterId: commenterId,
              commentedAt: new Date(reply.timestamp),
              isHidden: isHidden
            }).returning();

             commentsNew++;
             jobsToEnqueue.push({
                commentId: inserted.id,
                commentText: reply.text,
                commenterId,
                commenterUsername,
                igCommentId: reply.id
              });
          }
        }

        if (jobsToEnqueue.length > 0) {
           await Promise.all(jobsToEnqueue.map(job => 
              commentQueue.enqueue('CLASSIFY_COMMENT', {
                commentId: job.commentId,
                commentText: job.commentText,
                commenterId: job.commenterId,
                commenterUsername: job.commenterUsername,
                postId: dbPostId,
                instagramAccountId: accountId,
                igCommentId: job.igCommentId,
                accessToken
              })
           ));
        }

      } catch (err) {
        console.error(`[POLL] Post ${post.id} error:`, err);
      }
    })));

    await db.update(instagramAccounts).set({ lastSyncAt: new Date() }).where(eq(instagramAccounts.id, accountId));
  } catch (err) {
    console.error(`[POLL] Account ${account.username} error:`, err);
    throw err;
  }

  return { postsUpdated, commentsNew, commentsUpdated };
}

export async function pollFacebookPage(pageId: string, options: PollOptions = {}): Promise<{ postsUpdated: number; commentsNew: number; commentsUpdated: number }> {
  const page = await db.query.facebookPages.findFirst({
    where: eq(facebookPages.id, pageId)
  });
  if (!page || !page.isActive) {
    return { postsUpdated: 0, commentsNew: 0, commentsUpdated: 0 };
  }

  const accessToken = page.pageAccessToken;
  const facebookPageId = page.facebookPageId;
  let postsUpdated = 0;
  let commentsNew = 0;
  let commentsUpdated = 0;

  try {
    const fbPosts = await facebookService.getPagePublishedPosts(facebookPageId, accessToken);
    const limit = pLimit(POST_CONCURRENCY);

    // Limit FB posts if needed, though getPagePublishedPosts fetches "some" posts (usually paged).
    // For now we process what is returned (usually recent).
    // Facebook API pagination is handled inside facebookService.getPagePublishedPosts.
    // If we want Deep Sync for FB, we might need to fetch more pages in facebookService.
    // Assuming standard fetch is sufficient or we can extend later.

    await Promise.all(fbPosts.map((fbPost, index) => limit(async () => {
      try {
        const existingPost = await db.query.posts.findFirst({
          where: and(
            eq(posts.fbPostId, fbPost.id),
            eq(posts.facebookPageId, pageId)
          )
        });

        let dbPostId: string;
        const currentCommentCount = fbPost.comments?.summary?.total_count ?? 0;
        const dbCommentsCount = existingPost?.commentsCount ?? 0;

        if (existingPost) {
           await db.update(posts).set({
            caption: fbPost.message ?? null,
            likesCount: fbPost.likes?.summary?.total_count ?? null,
            commentsCount: currentCommentCount
          }).where(eq(posts.id, existingPost.id));
          dbPostId = existingPost.id;
          postsUpdated++;
        } else {
           const [newPost] = await db.insert(posts).values({
            source: 'facebook',
            facebookPageId: pageId,
            fbPostId: fbPost.id,
            caption: fbPost.message ?? null,
            permalink: fbPost.permalink_url ?? null,
            postedAt: new Date(fbPost.created_time),
            likesCount: fbPost.likes?.summary?.total_count ?? null,
            commentsCount: currentCommentCount
          }).returning();
          dbPostId = newPost!.id;
          postsUpdated++;
        }

        if (!options.forceDeepSync) {
            const isRecent = index < HYBRID_DEEP_CHECK_LIMIT;
            const countChanged = currentCommentCount !== dbCommentsCount;
            if (!isRecent && !countChanged) return;
        }

        const fbComments = await facebookService.getPostComments(fbPost.id, accessToken);
        
        const existingComments = await db.query.comments.findMany({
            where: eq(comments.postId, dbPostId)
        });
        const existingMap = new Map(existingComments.map(c => [c.fbCommentId, c]));
        const jobsToEnqueue: any[] = [];
        
        const topLevel = fbComments.filter(c => !c.parent);
        const replies = fbComments.filter(c => c.parent);
        const newTopLevelMap = new Map<string, string>();

        for (const comment of topLevel) {
           const existing = existingMap.get(comment.id);
           const isHidden = comment.is_hidden || false;
           
           if (existing) {
             const textChanged = existing.text !== comment.message;
             const hiddenChanged = existing.isHidden !== isHidden;
             if (textChanged || hiddenChanged) {
                 await db.update(comments).set({
                    text: comment.message,
                    isHidden: isHidden,
                    ...(hiddenChanged && isHidden ? { hiddenAt: new Date() } : {})
                 }).where(eq(comments.id, existing.id));
                 commentsUpdated++;

                 if (textChanged) {
                    jobsToEnqueue.push({
                        commentId: existing.id,
                        commentText: comment.message,
                        commenterId: comment.from.id,
                        commenterUsername: comment.from.name,
                        fbCommentId: comment.id
                    });
                 }
             }
           } else {
              const [inserted] = await db.insert(comments).values({
                source: 'facebook',
                postId: dbPostId,
                fbCommentId: comment.id,
                text: comment.message,
                commenterUsername: comment.from.name,
                commenterId: comment.from.id,
                commentedAt: new Date(comment.created_time),
                isHidden: isHidden
              }).returning();
              newTopLevelMap.set(comment.id, inserted.id);
              commentsNew++;

              jobsToEnqueue.push({
                commentId: inserted.id,
                commentText: comment.message,
                commenterId: comment.from.id,
                commenterUsername: comment.from.name,
                fbCommentId: comment.id
              });
           }
        }

        for (const reply of replies) {
           const existing = existingMap.get(reply.id);
           const isHidden = reply.is_hidden || false;

           if (existing) {
             const textChanged = existing.text !== reply.message;
             const hiddenChanged = existing.isHidden !== isHidden;
              if (textChanged || hiddenChanged) {
                 await db.update(comments).set({
                    text: reply.message,
                    isHidden: isHidden,
                    ...(hiddenChanged && isHidden ? { hiddenAt: new Date() } : {})
                 }).where(eq(comments.id, existing.id));
                 commentsUpdated++;

                 if (textChanged) {
                    jobsToEnqueue.push({
                        commentId: existing.id,
                        commentText: reply.message,
                        commenterId: reply.from.id,
                        commenterUsername: reply.from.name,
                        fbCommentId: reply.id
                    });
                 }
             }
           } else {
             let parentDbId: string | undefined;
             const parentExisting = existingMap.get(reply.parent!.id);
             if (parentExisting) parentDbId = parentExisting.id;
             if (!parentDbId) parentDbId = newTopLevelMap.get(reply.parent!.id);
             if (!parentDbId) {
                const p = await db.query.comments.findFirst({ 
                    where: and(
                        eq(comments.fbCommentId, reply.parent!.id), 
                        eq(comments.postId, dbPostId)
                    ) 
                });
                if (p) parentDbId = p.id;
             }

             if (parentDbId) {
                const [inserted] = await db.insert(comments).values({
                    source: 'facebook',
                    postId: dbPostId,
                    parentCommentId: parentDbId,
                    fbCommentId: reply.id,
                    text: reply.message,
                    commenterUsername: reply.from.name,
                    commenterId: reply.from.id,
                    commentedAt: new Date(reply.created_time),
                    isHidden: isHidden
                }).returning();
                commentsNew++;

                jobsToEnqueue.push({
                    commentId: inserted.id,
                    commentText: reply.message,
                    commenterId: reply.from.id,
                    commenterUsername: reply.from.name,
                    fbCommentId: reply.id
                });
             }
           }
        }

        if (jobsToEnqueue.length > 0) {
           await Promise.all(jobsToEnqueue.map(job => 
              commentQueue.enqueue('CLASSIFY_COMMENT', {
                commentId: job.commentId,
                commentText: job.commentText,
                commenterId: job.commenterId,
                commenterUsername: job.commenterUsername,
                postId: dbPostId,
                facebookPageId: pageId,
                fbCommentId: job.fbCommentId,
                accessToken
              })
           ));
        }

      } catch (postErr) {
        console.error(`[POLL] Facebook post ${fbPost.id} error:`, postErr);
      }
    })));

    await db.update(facebookPages).set({ lastSyncAt: new Date() }).where(eq(facebookPages.id, pageId));
  } catch (err) {
    console.error(`[POLL] Facebook page ${page.pageName} error:`, err);
    throw err;
  }

  return { postsUpdated, commentsNew, commentsUpdated };
}

// Wrapper for deep sync (cleaner API)
export async function deepSyncInstagramAccount(accountId: string) {
    return pollInstagramAccount(accountId, { forceDeepSync: true });
}

export async function deepSyncFacebookPage(pageId: string) {
    return pollFacebookPage(pageId, { forceDeepSync: true });
}

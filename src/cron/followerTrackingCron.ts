/**
 * Follower Tracking Cron: Hourly follower count snapshots
 * Tracks Instagram and Facebook follower counts every hour for growth analytics
 */

import { db } from '../db';
import { instagramAccounts, facebookPages, followerHistory } from '../db/schema';
import { eq } from 'drizzle-orm';
import { InstagramService } from '../services/instagram.service';
import { FacebookService } from '../services/facebook.service';
import pLimit from 'p-limit';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ACCOUNT_CONCURRENCY = 10; // Higher concurrency for lightweight follower count checks

function getIntervalMs(): number {
  const env = process.env.FOLLOWER_TRACKING_INTERVAL_MS;
  if (env === undefined || env === '') return DEFAULT_INTERVAL_MS;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS; // Min 1 minute
}

function isCronEnabled(): boolean {
  return process.env.FOLLOWER_TRACKING_ENABLED !== 'false';
}

function skipInstagram(): boolean {
  return process.env.FOLLOWER_TRACKING_SKIP_INSTAGRAM === 'true';
}

function skipFacebook(): boolean {
  return process.env.FOLLOWER_TRACKING_SKIP_FACEBOOK === 'true';
}

let intervalId: ReturnType<typeof setInterval> | null = null;
const limit = pLimit(ACCOUNT_CONCURRENCY);

// Account-level locks: prevent same account from being processed multiple times
const processingAccounts = new Set<string>();

const instagramService = new InstagramService();
const facebookService = new FacebookService();

/**
 * Track Instagram account follower count
 */
async function trackInstagramFollowers(accountId: string, username: string): Promise<void> {
  const lockKey = `ig:${accountId}`;
  if (processingAccounts.has(lockKey)) {
    console.log(`[FOLLOWER TRACKING] IG ${username} already processing, skipping`);
    return;
  }

  processingAccounts.add(lockKey);

  try {
    // Fetch account from database
    const account = await db.query.instagramAccounts.findFirst({
      where: eq(instagramAccounts.id, accountId)
    });

    if (!account) {
      console.error(`[FOLLOWER TRACKING] IG ${username} not found in database`);
      return;
    }

    // Get associated Facebook page for access token
    if (!account.facebookPageId) {
      console.error(`[FOLLOWER TRACKING] IG ${username} has no associated Facebook page`);
      return;
    }

    const fbPage = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, account.facebookPageId)
    });

    if (!fbPage?.pageAccessToken) {
      console.error(`[FOLLOWER TRACKING] IG ${username} missing Facebook page access token`);
      return;
    }

    // Fetch current follower count from Instagram API
    const accountInfo = await instagramService.getAccountInfo(
      account.instagramId,
      fbPage.pageAccessToken
    );

    const followersCount = accountInfo.followers_count ?? null;
    const followingCount = accountInfo.follows_count ?? null;

    if (followersCount === null) {
      console.warn(`[FOLLOWER TRACKING] IG ${username} API returned null followers_count`);
      return;
    }

    // Insert into follower_history
    await db.insert(followerHistory).values({
      source: 'instagram',
      instagramAccountId: accountId,
      facebookPageId: null,
      followersCount,
      followingCount,
      recordedAt: new Date()
    });

    // Update current count in instagramAccounts table
    await db
      .update(instagramAccounts)
      .set({
        followersCount,
        followingCount,
        lastSyncAt: new Date()
      })
      .where(eq(instagramAccounts.id, accountId));

    console.log(
      `[FOLLOWER TRACKING] IG ${username}: followers=${followersCount} following=${followingCount}`
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[FOLLOWER TRACKING] Failed IG ${username}:`, errorMessage);
  } finally {
    processingAccounts.delete(lockKey);
  }
}

/**
 * Track Facebook page follower count
 */
async function trackFacebookFollowers(pageId: string, pageName: string): Promise<void> {
  const lockKey = `fb:${pageId}`;
  if (processingAccounts.has(lockKey)) {
    console.log(`[FOLLOWER TRACKING] FB ${pageName} already processing, skipping`);
    return;
  }

  processingAccounts.add(lockKey);

  try {
    // Fetch page from database
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, pageId)
    });

    if (!page) {
      console.error(`[FOLLOWER TRACKING] FB ${pageName} not found in database`);
      return;
    }

    if (!page.pageAccessToken) {
      console.error(`[FOLLOWER TRACKING] FB ${pageName} missing page access token`);
      return;
    }

    // Fetch current follower count from Facebook API
    const pageInfo = await facebookService.getPageInfo(page.facebookPageId, page.pageAccessToken);

    const followersCount = pageInfo.followers_count ?? null;

    if (followersCount === null) {
      console.warn(`[FOLLOWER TRACKING] FB ${pageName} API returned null followers_count`);
      return;
    }

    // Insert into follower_history
    await db.insert(followerHistory).values({
      source: 'facebook',
      instagramAccountId: null,
      facebookPageId: pageId,
      followersCount,
      followingCount: null, // Facebook pages don't have "following"
      recordedAt: new Date()
    });

    // Note: facebookPages table doesn't have followersCount field yet
    // If needed, add it in a future migration
    console.log(`[FOLLOWER TRACKING] FB ${pageName}: followers=${followersCount}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[FOLLOWER TRACKING] Failed FB ${pageName}:`, errorMessage);
  } finally {
    processingAccounts.delete(lockKey);
  }
}

/**
 * Main tick function - runs every hour
 */
async function tick(): Promise<void> {
  try {
    const instagramList = skipInstagram()
      ? []
      : await db.query.instagramAccounts.findMany({
          where: eq(instagramAccounts.isActive, true),
          columns: { id: true, username: true }
        });

    const facebookList = skipFacebook()
      ? []
      : await db.query.facebookPages.findMany({
          where: eq(facebookPages.isActive, true),
          columns: { id: true, pageName: true }
        });

    // Filter out accounts currently being processed
    const availableInstagram = instagramList.filter(
      acc => !processingAccounts.has(`ig:${acc.id}`)
    );
    const availableFacebook = facebookList.filter(
      page => !processingAccounts.has(`fb:${page.id}`)
    );

    const skippedCount =
      instagramList.length -
      availableInstagram.length +
      (facebookList.length - availableFacebook.length);

    if (availableInstagram.length > 0 || availableFacebook.length > 0) {
      console.log(
        `[FOLLOWER TRACKING] Starting tracking for ${availableInstagram.length} Instagram + ${availableFacebook.length} Facebook accounts${skippedCount > 0 ? ` (${skippedCount} still processing)` : ''}`
      );
    }

    const tasks = [
      ...availableInstagram.map(acc =>
        limit(() => trackInstagramFollowers(acc.id, acc.username))
      ),
      ...availableFacebook.map(page =>
        limit(() => trackFacebookFollowers(page.id, page.pageName))
      )
    ];

    // Don't await - let tasks run in background and don't block the next tick
    Promise.all(tasks)
      .then(() => {
        if (availableInstagram.length > 0 || availableFacebook.length > 0) {
          console.log('[FOLLOWER TRACKING] Cycle complete');
        }
      })
      .catch((err: unknown) => {
        console.error('[FOLLOWER TRACKING] Background tasks error:', err);
      });
  } catch (err: unknown) {
    console.error('[FOLLOWER TRACKING] Tick error:', err);
  }
}

export function startFollowerTrackingCron(): void {
  if (!isCronEnabled()) {
    console.log('[FOLLOWER TRACKING] Disabled (FOLLOWER_TRACKING_ENABLED=false)');
    return;
  }
  const ms = getIntervalMs();
  intervalId = setInterval(() => void tick(), ms);
  console.log(
    `[FOLLOWER TRACKING] Started: interval=${ms}ms (${ms / 1000 / 60} minutes), concurrency=${ACCOUNT_CONCURRENCY}`
  );
  void tick(); // run once on startup
}

export function stopFollowerTrackingCron(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[FOLLOWER TRACKING] Stopped');
  }
}

/**
 * Cron: every 1 minute, poll all active Instagram accounts and Facebook Pages
 * in parallel using p-limit for concurrency control.
 */

import { db } from '../db';
import { instagramAccounts, facebookPages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { pollInstagramAccount, pollFacebookPage } from '../services/polling.service';
import pLimit from 'p-limit';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const ACCOUNT_CONCURRENCY = 5;

function getIntervalMs(): number {
  const env = process.env.POLL_CRON_INTERVAL_MS;
  if (env === undefined || env === '') return DEFAULT_INTERVAL_MS;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 10_000 ? n : DEFAULT_INTERVAL_MS;
}

function isCronEnabled(): boolean {
  return process.env.POLL_CRON_ENABLED !== 'false';
}

function skipInstagram(): boolean {
  return process.env.POLL_SKIP_INSTAGRAM === 'true';
}

function skipFacebook(): boolean {
  return process.env.POLL_SKIP_FACEBOOK === 'true';
}

let intervalId: ReturnType<typeof setInterval> | null = null;
const limit = pLimit(ACCOUNT_CONCURRENCY);

// Account-level locks: prevent same account from being processed multiple times
const processingAccounts = new Set<string>();

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
    const availableInstagram = instagramList.filter(acc => !processingAccounts.has(`ig:${acc.id}`));
    const availableFacebook = facebookList.filter(page => !processingAccounts.has(`fb:${page.id}`));

    const skippedCount = (instagramList.length - availableInstagram.length) + (facebookList.length - availableFacebook.length);

    if (availableInstagram.length > 0 || availableFacebook.length > 0) {
      console.log(`[POLL CRON] Starting poll for ${availableInstagram.length} Instagram + ${availableFacebook.length} Facebook accounts${skippedCount > 0 ? ` (${skippedCount} still processing)` : ''}`);
    }

    const tasks = [
      ...availableInstagram.map(acc => limit(async () => {
        const lockKey = `ig:${acc.id}`;
        processingAccounts.add(lockKey);

        try {
          const res = await pollInstagramAccount(acc.id);
          console.log(`[POLL] IG ${acc.username}: posts=${res.postsUpdated} new=${res.commentsNew} upd=${res.commentsUpdated}`);
        } catch (e) {
          console.error(`[POLL] Failed IG ${acc.username}`, e);
        } finally {
          processingAccounts.delete(lockKey);
        }
      })),
      ...availableFacebook.map(page => limit(async () => {
        const lockKey = `fb:${page.id}`;
        processingAccounts.add(lockKey);

        try {
          const res = await pollFacebookPage(page.id);
          console.log(`[POLL] FB ${page.pageName}: posts=${res.postsUpdated} new=${res.commentsNew} upd=${res.commentsUpdated}`);
        } catch (e) {
          console.error(`[POLL] Failed FB ${page.pageName}`, e);
        } finally {
          processingAccounts.delete(lockKey);
        }
      }))
    ];

    // Don't await - let tasks run in background and don't block the next tick
    Promise.all(tasks).then(() => {
      if (availableInstagram.length > 0 || availableFacebook.length > 0) {
        console.log('[POLL CRON] Cycle complete');
      }
    }).catch(err => {
      console.error('[POLL CRON] Background tasks error:', err);
    });

  } catch (err) {
    console.error('[POLL CRON] Tick error:', err);
  }
}

export function startPollCron(): void {
  if (!isCronEnabled()) {
    console.log('[POLL CRON] Disabled (POLL_CRON_ENABLED=false)');
    return;
  }
  const ms = getIntervalMs();
  intervalId = setInterval(() => void tick(), ms);
  console.log(`[POLL CRON] Started: interval=${ms}ms, concurrency=${ACCOUNT_CONCURRENCY}`);
  void tick(); // run once on startup
}

export function stopPollCron(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[POLL CRON] Stopped');
  }
}

/**
 * Deep Sync Cron: Daily safety net to catch silent edits/deletes.
 * Runs once a day (e.g., 3 AM) and forces a deep sync on all accounts.
 */

import { db } from '../db';
import { instagramAccounts, facebookPages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { deepSyncInstagramAccount, deepSyncFacebookPage } from '../services/polling.service';
import pLimit from 'p-limit';

const DEEP_SYNC_CONCURRENCY = 2; // Lower concurrency to be gentle on DB/API during long jobs

function isEnabled(): boolean {
  return process.env.DEEP_SYNC_CRON_ENABLED !== 'false';
}

// Calculate time until next 3 AM
function getTimeUntilNextRun(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

let timeoutId: NodeJS.Timeout | null = null;

// Account-level locks: prevent same account from being processed multiple times
const processingAccounts = new Set<string>();

async function runDeepSync() {
  console.log('[DEEP SYNC] Starting daily safety net sync...');
  const limit = pLimit(DEEP_SYNC_CONCURRENCY);

  try {
    const instagramList = await db.query.instagramAccounts.findMany({
      where: eq(instagramAccounts.isActive, true),
      columns: { id: true, username: true }
    });

    const facebookList = await db.query.facebookPages.findMany({
      where: eq(facebookPages.isActive, true),
      columns: { id: true, pageName: true }
    });

    // Filter out accounts currently being processed
    const availableInstagram = instagramList.filter(acc => !processingAccounts.has(`ig:${acc.id}`));
    const availableFacebook = facebookList.filter(page => !processingAccounts.has(`fb:${page.id}`));

    const skippedCount = (instagramList.length - availableInstagram.length) + (facebookList.length - availableFacebook.length);

    if (skippedCount > 0) {
      console.log(`[DEEP SYNC] ${skippedCount} accounts still being processed from previous run, skipping those`);
    }

    const tasks = [
      ...availableInstagram.map(acc => limit(async () => {
        const lockKey = `ig:${acc.id}`;
        processingAccounts.add(lockKey);

        try {
          console.log(`[DEEP SYNC] Processing IG ${acc.username}`);
          const res = await deepSyncInstagramAccount(acc.id);
          console.log(`[DEEP SYNC] IG ${acc.username}: posts=${res.postsUpdated} new=${res.commentsNew} upd=${res.commentsUpdated}`);
        } catch (e) {
          console.error(`[DEEP SYNC] Failed IG ${acc.username}`, e);
        } finally {
          processingAccounts.delete(lockKey);
        }
      })),
      ...availableFacebook.map(page => limit(async () => {
        const lockKey = `fb:${page.id}`;
        processingAccounts.add(lockKey);

        try {
          console.log(`[DEEP SYNC] Processing FB ${page.pageName}`);
          const res = await deepSyncFacebookPage(page.id);
          console.log(`[DEEP SYNC] FB ${page.pageName}: posts=${res.postsUpdated} new=${res.commentsNew} upd=${res.commentsUpdated}`);
        } catch (e) {
          console.error(`[DEEP SYNC] Failed FB ${page.pageName}`, e);
        } finally {
          processingAccounts.delete(lockKey);
        }
      }))
    ];

    // Don't await - let tasks run in background
    Promise.all(tasks).then(() => {
      console.log('[DEEP SYNC] Daily cycle complete');
    }).catch(err => {
      console.error('[DEEP SYNC] Background tasks error:', err);
    });

  } catch (err) {
    console.error('[DEEP SYNC] Run error:', err);
  }

  // Schedule next run
  scheduleNextRun();
}

function scheduleNextRun() {
  if (!isEnabled()) return;
  const ms = getTimeUntilNextRun();
  console.log(`[DEEP SYNC] Next run scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  timeoutId = setTimeout(runDeepSync, ms);
}

export function startDeepSyncCron(): void {
  if (!isEnabled()) {
    console.log('[DEEP SYNC] Disabled (DEEP_SYNC_CRON_ENABLED=false)');
    return;
  }
  scheduleNextRun();
}

export function stopDeepSyncCron(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

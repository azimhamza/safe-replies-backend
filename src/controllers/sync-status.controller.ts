import { Response } from 'express';
import { db } from '../db';
import { instagramAccounts, facebookPages } from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { DelegationRequest, getEffectiveOwner } from '../middleware/delegation.middleware';
import { ApiResponse } from '../types';
import { and, eq, desc } from 'drizzle-orm';

const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute

interface SyncStatusData {
  pollIntervalMs: number;
  lastSyncAt: string | null;
  serverTime: string;
}

type SyncStatusResponse = ApiResponse<SyncStatusData>;

function getPollIntervalMs(): number {
  const env = process.env.POLL_CRON_INTERVAL_MS;
  if (env === undefined || env === '') return DEFAULT_POLL_INTERVAL_MS;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 10_000 ? n : DEFAULT_POLL_INTERVAL_MS;
}

export async function getSyncStatus(
  req: AuthRequest & DelegationRequest,
  res: Response<SyncStatusResponse>
): Promise<void> {
  try {
    const owner = getEffectiveOwner(req);
    const pollIntervalMs = getPollIntervalMs();

    // Determine which field to query based on account type
    const igOwnerCondition = owner.clientId
      ? eq(instagramAccounts.clientId, owner.clientId)
      : eq(instagramAccounts.userId, owner.userId!);

    const fbOwnerCondition = owner.clientId
      ? eq(facebookPages.clientId, owner.clientId)
      : eq(facebookPages.userId, owner.userId!);

    // Query Instagram accounts for this owner
    const igAccounts = await db.query.instagramAccounts.findMany({
      where: and(
        igOwnerCondition,
        eq(instagramAccounts.isActive, true)
      ),
      columns: {
        lastSyncAt: true
      },
      orderBy: desc(instagramAccounts.lastSyncAt)
    });

    // Query Facebook pages for this owner
    const fbPages = await db.query.facebookPages.findMany({
      where: and(
        fbOwnerCondition,
        eq(facebookPages.isActive, true)
      ),
      columns: {
        lastSyncAt: true
      },
      orderBy: desc(facebookPages.lastSyncAt)
    });

    // Find the most recent lastSyncAt across all Instagram accounts and Facebook pages
    const validSyncTimes = [
      ...igAccounts.map(acc => acc.lastSyncAt),
      ...fbPages.map(page => page.lastSyncAt)
    ].filter((t): t is Date => t !== null);

    const lastSyncAt = validSyncTimes.length > 0
      ? validSyncTimes.reduce((latest, current) => current > latest ? current : latest)
      : null;

    res.json({
      success: true,
      data: {
        pollIntervalMs,
        lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
        serverTime: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[SYNC STATUS] Error fetching sync status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sync status'
    });
  }
}

const syncStatusController = {
  getSyncStatus
};

export default syncStatusController;

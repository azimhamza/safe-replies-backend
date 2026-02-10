/**
 * Client Service: Aggregates client data for comprehensive client details page
 */

import { db } from '../db';
import {
  clients,
  instagramAccounts,
  facebookPages,
  followerHistory,
  moderationSettings,
  customFilters,
  suspiciousAccounts,
  comments
} from '../db/schema';
import { eq, and, sql, desc, lte } from 'drizzle-orm';
import {
  getFollowerGrowthCache,
  setFollowerGrowthCache,
  getClientDetailsCache,
  setClientDetailsCache
} from './cache.service';

export interface ConnectedAccount {
  id: string;
  platform: 'instagram' | 'facebook';
  username: string;
  profilePictureUrl: string | null;
  currentFollowers: number;
  currentFollowing: number | null;
  growth: {
    hourly: number;
    daily: number;
    weekly: number;
    monthly: number;
    yearly: number;
  };
}

export interface ModerationSetting {
  level: 'client' | 'account';
  accountId?: string;
  accountUsername?: string;
  settings: {
    category: string;
    autoDelete: boolean;
    autoHide: boolean;
    threshold: number;
  }[];
}

export interface CustomFilterData {
  id: string;
  name: string;
  prompt: string;
  category: string;
  autoHide: boolean;
  autoDelete: boolean;
  autoFlag: boolean;
  appliesTo: string; // "All accounts" or specific username
  instagramAccountId: string | null;
}

export interface SuspiciousAccountData {
  id: string;
  username: string;
  violations: number;
  autoHideEnabled: boolean;
  autoDeleteEnabled: boolean;
  onAccountUsername: string;
  instagramAccountId: string;
}

export interface ClientStats {
  connectedAccounts: number;
  commentsModerated: number;
  autoDeleted: number;
  flagged: number;
  totalFollowers: number;
  followerGrowth: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  commentsPerFollower: number; // Comments moderated per 1000 followers
  protectionRate: string; // e.g., "15 comments per 1K followers"
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

/**
 * Calculate follower growth for a specific time period
 */
async function getFollowerCountAt(
  accountId: string,
  platform: 'instagram' | 'facebook',
  minutesAgo: number
): Promise<number | null> {
  const targetTime = new Date(Date.now() - minutesAgo * 60 * 1000);

  const record = await db.query.followerHistory.findFirst({
    where: and(
      platform === 'instagram'
        ? eq(followerHistory.instagramAccountId, accountId)
        : eq(followerHistory.facebookPageId, accountId),
      eq(followerHistory.source, platform),
      lte(followerHistory.recordedAt, targetTime)
    ),
    orderBy: desc(followerHistory.recordedAt)
  });

  return record?.followersCount ?? null;
}

/**
 * Calculate follower growth metrics for an account
 */
export async function calculateFollowerGrowth(
  accountId: string,
  platform: 'instagram' | 'facebook',
  currentFollowers: number
): Promise<{
  hourly: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}> {
  // Check cache first
  const cached = getFollowerGrowthCache(accountId, platform);
  if (cached) {
    return {
      hourly: cached.hourly ?? 0,
      daily: cached.daily ?? 0,
      weekly: cached.weekly ?? 0,
      monthly: cached.monthly ?? 0,
      yearly: cached.yearly ?? 0
    };
  }

  // Calculate growth for each time period
  const [hourlyCount, dailyCount, weeklyCount, monthlyCount, yearlyCount] = await Promise.all([
    getFollowerCountAt(accountId, platform, 60), // 1 hour ago
    getFollowerCountAt(accountId, platform, 24 * 60), // 1 day ago
    getFollowerCountAt(accountId, platform, 7 * 24 * 60), // 1 week ago
    getFollowerCountAt(accountId, platform, 30 * 24 * 60), // 1 month ago
    getFollowerCountAt(accountId, platform, 365 * 24 * 60) // 1 year ago
  ]);

  const growth = {
    hourly: hourlyCount !== null ? currentFollowers - hourlyCount : 0,
    daily: dailyCount !== null ? currentFollowers - dailyCount : 0,
    weekly: weeklyCount !== null ? currentFollowers - weeklyCount : 0,
    monthly: monthlyCount !== null ? currentFollowers - monthlyCount : 0,
    yearly: yearlyCount !== null ? currentFollowers - yearlyCount : 0
  };

  // Cache the result
  setFollowerGrowthCache(accountId, platform, growth);

  return growth;
}

/**
 * Get all connected accounts for a client with follower growth
 */
export async function getClientConnectedAccounts(
  clientId: string,
  pagination?: PaginationParams
): Promise<ConnectedAccount[]> {
  // If pagination is requested, use the paginated version
  if (pagination) {
    const result = await getClientConnectedAccountsPaginated(clientId, pagination);
    return result.items;
  }

  // Fetch Instagram accounts
  const igAccounts = await db.query.instagramAccounts.findMany({
    where: eq(instagramAccounts.clientId, clientId),
    columns: {
      id: true,
      username: true,
      profilePictureUrl: true,
      followersCount: true,
      followingCount: true
    }
  });

  // Fetch Facebook pages
  const fbPages = await db.query.facebookPages.findMany({
    where: eq(facebookPages.clientId, clientId),
    columns: {
      id: true,
      pageName: true,
      profilePictureUrl: true
    }
  });

  // Calculate growth for each account
  const accounts: ConnectedAccount[] = [];

  for (const account of igAccounts) {
    const growth = await calculateFollowerGrowth(
      account.id,
      'instagram',
      account.followersCount ?? 0
    );

    accounts.push({
      id: account.id,
      platform: 'instagram',
      username: account.username,
      profilePictureUrl: account.profilePictureUrl,
      currentFollowers: account.followersCount ?? 0,
      currentFollowing: account.followingCount,
      growth
    });
  }

  for (const page of fbPages) {
    // Facebook pages don't have followerCount in schema yet, so we'll skip growth calculation
    // or fetch from follower_history if available
    const latestRecord = await db.query.followerHistory.findFirst({
      where: and(
        eq(followerHistory.facebookPageId, page.id),
        eq(followerHistory.source, 'facebook')
      ),
      orderBy: desc(followerHistory.recordedAt)
    });

    const currentFollowers = latestRecord?.followersCount ?? 0;

    const growth = await calculateFollowerGrowth(page.id, 'facebook', currentFollowers);

    accounts.push({
      id: page.id,
      platform: 'facebook',
      username: page.pageName,
      profilePictureUrl: page.profilePictureUrl,
      currentFollowers,
      currentFollowing: null,
      growth
    });
  }

  return accounts;
}

/**
 * Get connected accounts for a client with pagination
 */
export async function getClientConnectedAccountsPaginated(
  clientId: string,
  pagination: PaginationParams = {}
): Promise<PaginatedResult<ConnectedAccount>> {
  const limit = pagination.limit ?? 20;
  const offset = pagination.offset ?? 0;

  // First, get total count
  const [igCount, fbCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(instagramAccounts)
      .where(eq(instagramAccounts.clientId, clientId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(facebookPages)
      .where(eq(facebookPages.clientId, clientId))
  ]);

  const total = (igCount[0]?.count ?? 0) + (fbCount[0]?.count ?? 0);

  // Fetch Instagram accounts with limit/offset
  const igAccounts = await db.query.instagramAccounts.findMany({
    where: eq(instagramAccounts.clientId, clientId),
    columns: {
      id: true,
      username: true,
      profilePictureUrl: true,
      followersCount: true,
      followingCount: true
    },
    limit: limit + 1, // Fetch one extra to check if there are more
    offset
  });

  // If we got all IG accounts and still need more for pagination
  const remainingLimit = Math.max(0, limit - igAccounts.length);
  const fbOffset = Math.max(0, offset - (igCount[0]?.count ?? 0));

  const fbPages =
    remainingLimit > 0
      ? await db.query.facebookPages.findMany({
          where: eq(facebookPages.clientId, clientId),
          columns: {
            id: true,
            pageName: true,
            profilePictureUrl: true
          },
          limit: remainingLimit + 1,
          offset: fbOffset
        })
      : [];

  // Combine and calculate growth
  const accounts: ConnectedAccount[] = [];

  // Take only up to limit items (we fetched +1 to check hasMore)
  const igAccountsToProcess = igAccounts.slice(0, limit);
  const fbPagesToProcess = fbPages.slice(0, remainingLimit);

  for (const account of igAccountsToProcess) {
    const growth = await calculateFollowerGrowth(
      account.id,
      'instagram',
      account.followersCount ?? 0
    );

    accounts.push({
      id: account.id,
      platform: 'instagram',
      username: account.username,
      profilePictureUrl: account.profilePictureUrl,
      currentFollowers: account.followersCount ?? 0,
      currentFollowing: account.followingCount,
      growth
    });
  }

  for (const page of fbPagesToProcess) {
    const latestRecord = await db.query.followerHistory.findFirst({
      where: and(
        eq(followerHistory.facebookPageId, page.id),
        eq(followerHistory.source, 'facebook')
      ),
      orderBy: desc(followerHistory.recordedAt)
    });

    const currentFollowers = latestRecord?.followersCount ?? 0;
    const growth = await calculateFollowerGrowth(page.id, 'facebook', currentFollowers);

    accounts.push({
      id: page.id,
      platform: 'facebook',
      username: page.pageName,
      profilePictureUrl: page.profilePictureUrl,
      currentFollowers,
      currentFollowing: null,
      growth
    });
  }

  const hasMore = offset + limit < total;

  return {
    items: accounts,
    total,
    hasMore,
    offset,
    limit
  };
}

/**
 * Get moderation settings for a client (client-level + account-specific)
 */
export async function getClientModerationSettings(
  clientId: string
): Promise<ModerationSetting[]> {
  const settings = await db.query.moderationSettings.findMany({
    where: eq(moderationSettings.clientId, clientId)
  });

  const result: ModerationSetting[] = [];

  // Fetch Instagram account info for account-specific settings
  const accountMap = new Map<string, string>();
  const accountIds = settings
    .filter(s => s.instagramAccountId)
    .map(s => s.instagramAccountId!);

  if (accountIds.length > 0) {
    const accounts = await db.query.instagramAccounts.findMany({
      where: sql`${instagramAccounts.id} IN ${accountIds}`
    });
    accounts.forEach(acc => accountMap.set(acc.id, acc.username));
  }

  for (const setting of settings) {
    const categories = [
      {
        category: 'blackmail',
        autoDelete: setting.autoDeleteBlackmail ?? false,
        autoHide: setting.flagHideBlackmail ?? false,
        threshold: setting.blackmailThreshold ?? 70
      },
      {
        category: 'threat',
        autoDelete: setting.autoDeleteThreat ?? false,
        autoHide: setting.flagHideThreat ?? false,
        threshold: setting.threatThreshold ?? 70
      },
      {
        category: 'defamation',
        autoDelete: setting.autoDeleteDefamation ?? false,
        autoHide: setting.flagHideDefamation ?? false,
        threshold: setting.defamationThreshold ?? 75
      },
      {
        category: 'harassment',
        autoDelete: setting.autoDeleteHarassment ?? false,
        autoHide: setting.flagHideHarassment ?? false,
        threshold: setting.harassmentThreshold ?? 75
      },
      {
        category: 'spam',
        autoDelete: setting.autoDeleteSpam ?? false,
        autoHide: setting.flagHideSpam ?? false,
        threshold: setting.spamThreshold ?? 85
      }
    ];

    result.push({
      level: setting.instagramAccountId ? 'account' : 'client',
      accountId: setting.instagramAccountId ?? undefined,
      accountUsername: setting.instagramAccountId
        ? accountMap.get(setting.instagramAccountId)
        : undefined,
      settings: categories
    });
  }

  return result;
}

/**
 * Get custom filters for a client
 */
export async function getClientCustomFilters(clientId: string): Promise<CustomFilterData[]> {
  const filters = await db.query.customFilters.findMany({
    where: eq(customFilters.clientId, clientId)
  });

  // Fetch account usernames for filters
  const accountIds = filters
    .filter(f => f.instagramAccountId)
    .map(f => f.instagramAccountId!);

  const accountMap = new Map<string, string>();
  if (accountIds.length > 0) {
    const accounts = await db.query.instagramAccounts.findMany({
      where: sql`${instagramAccounts.id} IN ${accountIds}`
    });
    accounts.forEach(acc => accountMap.set(acc.id, acc.username));
  }

  return filters.map(filter => ({
    id: filter.id,
    name: filter.name,
    prompt: filter.prompt,
    category: filter.category,
    autoHide: filter.autoHide ?? false,
    autoDelete: filter.autoDelete ?? false,
    autoFlag: filter.autoFlag ?? false,
    appliesTo: filter.instagramAccountId
      ? accountMap.get(filter.instagramAccountId) ?? 'Unknown'
      : 'All accounts',
    instagramAccountId: filter.instagramAccountId
  }));
}

/**
 * Get suspicious accounts with auto-actions for a client
 */
export async function getClientSuspiciousAccounts(
  clientId: string
): Promise<SuspiciousAccountData[]> {
  // Get all Instagram accounts for this client
  const igAccounts = await db.query.instagramAccounts.findMany({
    where: eq(instagramAccounts.clientId, clientId),
    columns: { id: true, username: true }
  });

  const accountIds = igAccounts.map(acc => acc.id);
  if (accountIds.length === 0) return [];

  const accountMap = new Map(igAccounts.map(acc => [acc.id, acc.username]));

  // Get suspicious accounts for these Instagram accounts (with auto-actions enabled)
  const suspicious = await db.query.suspiciousAccounts.findMany({
    where: and(
      sql`${suspiciousAccounts.instagramAccountId} IN ${accountIds}`,
      sql`(${suspiciousAccounts.autoHideEnabled} = true OR ${suspiciousAccounts.autoDeleteEnabled} = true)`
    )
  });

  return suspicious.map(acc => ({
    id: acc.id,
    username: acc.commenterUsername,
    violations: (acc.flaggedComments ?? 0) + (acc.deletedComments ?? 0),
    autoHideEnabled: acc.autoHideEnabled ?? false,
    autoDeleteEnabled: acc.autoDeleteEnabled ?? false,
    onAccountUsername: accountMap.get(acc.instagramAccountId) ?? 'Unknown',
    instagramAccountId: acc.instagramAccountId
  }));
}

/**
 * Get aggregated stats for a client
 */
export async function getClientStats(clientId: string): Promise<ClientStats> {
  // Get connected accounts count
  const [igCount, fbCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(instagramAccounts)
      .where(eq(instagramAccounts.clientId, clientId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(facebookPages)
      .where(eq(facebookPages.clientId, clientId))
  ]);

  const connectedAccountsCount =
    (igCount[0]?.count ?? 0) + (fbCount[0]?.count ?? 0);

  // Get Instagram accounts with follower counts
  const igAccounts = await db.query.instagramAccounts.findMany({
    where: eq(instagramAccounts.clientId, clientId),
    columns: { id: true, followersCount: true }
  });

  const accountIds = igAccounts.map(acc => acc.id);

  // Calculate total current followers
  const totalFollowers = igAccounts.reduce(
    (sum, acc) => sum + (acc.followersCount ?? 0),
    0
  );

  if (accountIds.length === 0) {
    return {
      connectedAccounts: connectedAccountsCount,
      commentsModerated: 0,
      autoDeleted: 0,
      flagged: 0,
      totalFollowers: 0,
      followerGrowth: { daily: 0, weekly: 0, monthly: 0 },
      commentsPerFollower: 0,
      protectionRate: '0 comments per 1K followers'
    };
  }

  // Get comment stats
  const commentStats = await db
    .select({
      total: sql<number>`count(*)`,
      deleted: sql<number>`count(*) FILTER (WHERE ${comments.isDeleted} = true)`,
      flagged: sql<number>`count(*) FILTER (WHERE ${comments.isHidden} = true OR ${comments.isReported} = true)`
    })
    .from(comments)
    .innerJoin(
      sql`(SELECT id, instagram_account_id FROM posts WHERE instagram_account_id IN ${accountIds}) AS posts`,
      sql`${comments.postId} = posts.id`
    );

  const commentsModerated = commentStats[0]?.total ?? 0;

  // Calculate aggregate follower growth
  let totalDailyGrowth = 0;
  let totalWeeklyGrowth = 0;
  let totalMonthlyGrowth = 0;

  for (const account of igAccounts) {
    const growth = await calculateFollowerGrowth(
      account.id,
      'instagram',
      account.followersCount ?? 0
    );
    totalDailyGrowth += growth.daily;
    totalWeeklyGrowth += growth.weekly;
    totalMonthlyGrowth += growth.monthly;
  }

  // Calculate comments per 1000 followers
  const commentsPerFollower = totalFollowers > 0
    ? (commentsModerated / totalFollowers) * 1000
    : 0;

  // Format protection rate
  const protectionRate = totalFollowers > 0
    ? `${Math.round(commentsPerFollower)} comments per 1K followers`
    : '0 comments per 1K followers';

  return {
    connectedAccounts: connectedAccountsCount,
    commentsModerated,
    autoDeleted: commentStats[0]?.deleted ?? 0,
    flagged: commentStats[0]?.flagged ?? 0,
    totalFollowers,
    followerGrowth: {
      daily: totalDailyGrowth,
      weekly: totalWeeklyGrowth,
      monthly: totalMonthlyGrowth
    },
    commentsPerFollower: Math.round(commentsPerFollower * 10) / 10, // Round to 1 decimal
    protectionRate
  };
}

export interface ClientDetailsOptions {
  accountsPagination?: PaginationParams;
}

/**
 * Get comprehensive client details (all data for client details page)
 */
export async function getClientDetails(
  clientId: string,
  options?: ClientDetailsOptions
): Promise<{
  client: {
    id: string;
    businessName: string;
    email: string;
    createdAt: Date | null;
    onboardingStage: string;
  } | null;
  connectedAccounts: ConnectedAccount[];
  connectedAccountsPagination?: {
    total: number;
    hasMore: boolean;
    offset: number;
    limit: number;
  };
  moderationSettings: ModerationSetting[];
  customFilters: CustomFilterData[];
  suspiciousAccounts: SuspiciousAccountData[];
  stats: ClientStats;
}> {
  // Skip cache if pagination is used
  if (!options?.accountsPagination) {
    const cached = getClientDetailsCache(clientId);
    if (cached) {
      return cached as ReturnType<typeof getClientDetails> extends Promise<infer T> ? T : never;
    }
  }

  // Fetch client info
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: {
      id: true,
      businessName: true,
      email: true,
      createdAt: true,
      onboardingStage: true
    }
  });

  // Fetch connected accounts (with or without pagination)
  let connectedAccounts: ConnectedAccount[];
  let accountsPaginationInfo: PaginatedResult<ConnectedAccount> | undefined;

  if (options?.accountsPagination) {
    accountsPaginationInfo = await getClientConnectedAccountsPaginated(
      clientId,
      options.accountsPagination
    );
    connectedAccounts = accountsPaginationInfo.items;
  } else {
    connectedAccounts = await getClientConnectedAccounts(clientId);
  }

  // Fetch all other data in parallel
  const [moderationSettingsData, customFiltersData, suspiciousAccountsData, stats] =
    await Promise.all([
      getClientModerationSettings(clientId),
      getClientCustomFilters(clientId),
      getClientSuspiciousAccounts(clientId),
      getClientStats(clientId)
    ]);

  const result = {
    client: client
      ? {
          id: client.id,
          businessName: client.businessName,
          email: client.email,
          createdAt: client.createdAt,
          onboardingStage: client.onboardingStage ?? 'INVITATION_SENT'
        }
      : null,
    connectedAccounts,
    ...(accountsPaginationInfo
      ? {
          connectedAccountsPagination: {
            total: accountsPaginationInfo.total,
            hasMore: accountsPaginationInfo.hasMore,
            offset: accountsPaginationInfo.offset,
            limit: accountsPaginationInfo.limit
          }
        }
      : {}),
    moderationSettings: moderationSettingsData,
    customFilters: customFiltersData,
    suspiciousAccounts: suspiciousAccountsData,
    stats
  };

  // Cache the result only if not paginated
  if (!options?.accountsPagination) {
    setClientDetailsCache(clientId, result);
  }

  return result;
}

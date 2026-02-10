/**
 * Cache Service: In-memory caching with TTL
 * Uses node-cache for lightweight caching of frequently accessed data
 */

import NodeCache from 'node-cache';

// Cache instances with different TTLs
const followerGrowthCache = new NodeCache({
  stdTTL: 5 * 60, // 5 minutes
  checkperiod: 60, // Check for expired keys every 60 seconds
  useClones: false // Don't clone objects (better performance)
});

const clientDetailsCache = new NodeCache({
  stdTTL: 3 * 60, // 3 minutes
  checkperiod: 60,
  useClones: false
});

const oauthTokenCache = new NodeCache({
  stdTTL: 5 * 60, // 5 minutes — user must complete account selection within 5 min
  checkperiod: 60,
  useClones: false
});

/**
 * Generate cache key for follower growth
 */
function getFollowerGrowthKey(accountId: string, platform: 'instagram' | 'facebook'): string {
  return `follower_growth:${platform}:${accountId}`;
}

/**
 * Generate cache key for client details
 */
function getClientDetailsKey(clientId: string): string {
  return `client_details:${clientId}`;
}

/**
 * Get follower growth data from cache
 */
export function getFollowerGrowthCache(
  accountId: string,
  platform: 'instagram' | 'facebook'
): Record<string, number> | undefined {
  const key = getFollowerGrowthKey(accountId, platform);
  return followerGrowthCache.get<Record<string, number>>(key);
}

/**
 * Set follower growth data in cache
 */
export function setFollowerGrowthCache(
  accountId: string,
  platform: 'instagram' | 'facebook',
  data: Record<string, number>
): void {
  const key = getFollowerGrowthKey(accountId, platform);
  followerGrowthCache.set(key, data);
}

/**
 * Get client details from cache
 */
export function getClientDetailsCache(clientId: string): unknown | undefined {
  const key = getClientDetailsKey(clientId);
  return clientDetailsCache.get(key);
}

/**
 * Set client details in cache
 */
export function setClientDetailsCache(clientId: string, data: unknown): void {
  const key = getClientDetailsKey(clientId);
  clientDetailsCache.set(key, data);
}

/**
 * Invalidate follower growth cache for an account
 */
export function invalidateFollowerGrowthCache(
  accountId: string,
  platform: 'instagram' | 'facebook'
): void {
  const key = getFollowerGrowthKey(accountId, platform);
  followerGrowthCache.del(key);
}

/**
 * Invalidate client details cache
 */
export function invalidateClientDetailsCache(clientId: string): void {
  const key = getClientDetailsKey(clientId);
  clientDetailsCache.del(key);
}

/**
 * Invalidate all caches for a client (client details + all connected accounts)
 */
export function invalidateClientCaches(clientId: string): void {
  invalidateClientDetailsCache(clientId);
  // Note: We don't know which accounts belong to this client here,
  // so specific account caches should be invalidated at insertion time
}

// ---------- OAuth token cache helpers ----------

interface DiscoveredAccount {
  pageId: string;
  pageName: string;
  pageCategory: string;
  pageProfilePic: string | null;
  igId: string | null;
  igUsername: string | null;
  igProfilePic: string | null;
}

interface OAuthTokenCacheEntry {
  longLivedUserToken: string;
  pages: Array<{
    page: DiscoveredAccount;
    pageAccessToken: string;
  }>;
  userId: string;
  accountType: string | null;
  managedClientId: string | undefined;
}

function getOAuthTokenKey(userId: string, nonce: string): string {
  return `oauth_tokens:${userId}:${nonce}`;
}

/**
 * Store OAuth tokens + discovered pages for later account selection
 */
export function setOAuthTokenCache(
  userId: string,
  nonce: string,
  data: OAuthTokenCacheEntry
): void {
  const key = getOAuthTokenKey(userId, nonce);
  oauthTokenCache.set(key, data);
}

/**
 * Retrieve stored OAuth tokens + discovered pages
 */
export function getOAuthTokenCache(
  userId: string,
  nonce: string
): OAuthTokenCacheEntry | undefined {
  const key = getOAuthTokenKey(userId, nonce);
  return oauthTokenCache.get<OAuthTokenCacheEntry>(key);
}

/**
 * Delete stored OAuth tokens after use
 */
export function deleteOAuthTokenCache(userId: string, nonce: string): void {
  const key = getOAuthTokenKey(userId, nonce);
  oauthTokenCache.del(key);
}

export type { DiscoveredAccount, OAuthTokenCacheEntry };

/**
 * Clear all caches (for testing/debugging)
 */
export function clearAllCaches(): void {
  followerGrowthCache.flushAll();
  clientDetailsCache.flushAll();
  oauthTokenCache.flushAll();
  console.log('[CACHE] All caches cleared');
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  followerGrowth: NodeCache.Stats;
  clientDetails: NodeCache.Stats;
} {
  return {
    followerGrowth: followerGrowthCache.getStats(),
    clientDetails: clientDetailsCache.getStats()
  };
}

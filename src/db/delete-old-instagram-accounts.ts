/**
 * Cleanup script to delete old Instagram accounts not connected via Facebook
 * 
 * This script permanently deletes Instagram accounts that:
 * - Don't have a facebookPageId (not connected via Facebook Login)
 * - These are legacy accounts from the old Instagram OAuth flow
 * 
 * WARNING: This will permanently delete accounts and ALL related data from the database.
 * This includes posts, comments, moderation logs, suspicious accounts, etc.
 * Make sure users have reconnected via Facebook Login before running this.
 * 
 * To run:
 * ```
 * pnpm tsx src/db/delete-old-instagram-accounts.ts
 * ```
 */

import { db } from './index';
import { 
  instagramAccounts, 
  posts, 
  comments, 
  moderationLogs,
  evidenceRecords,
  suspiciousAccounts,
  pageInstagramConnections,
  moderationSettings,
  extractedIdentifiers,
  accountCommentMap,
  watchlistDetections,
  customFilters,
  customFilterAccounts
} from './schema';
import { isNull, inArray, sql } from 'drizzle-orm';

async function deleteOldInstagramAccounts() {
  try {
    console.log('🗑️  Starting cleanup of old Instagram accounts...');
    console.log('');
    
    // Find all accounts without facebookPageId
    const oldAccounts = await db.query.instagramAccounts.findMany({
      where: isNull(instagramAccounts.facebookPageId),
      columns: {
        id: true,
        username: true,
        userId: true,
        createdAt: true
      }
    });

    if (oldAccounts.length === 0) {
      console.log('✅ No old Instagram accounts found. All accounts are connected via Facebook.');
      process.exit(0);
    }

    const accountIds = oldAccounts.map(acc => acc.id);

    console.log(`⚠️  Found ${oldAccounts.length} old Instagram account(s) to delete:`);
    oldAccounts.forEach((acc, index) => {
      console.log(`   ${index + 1}. @${acc.username} (ID: ${acc.id}, Created: ${acc.createdAt})`);
    });
    console.log('');
    console.log('⚠️  WARNING: This will also delete ALL related data:');
    console.log('   - Posts from these accounts');
    console.log('   - Comments on those posts');
    console.log('   - Moderation logs and evidence');
    console.log('   - Suspicious accounts linked to these Instagram accounts');
    console.log('   - All other related records');
    console.log('');

    // Delete in reverse dependency order to handle foreign key constraints

    // Get post IDs for these accounts first
    const postIds = await db.select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.instagramAccountId, accountIds));
    const postIdArray = postIds.map(p => p.id);

    // Get comment IDs for these posts
    const commentIds = postIdArray.length > 0 
      ? (await db.select({ id: comments.id })
          .from(comments)
          .where(inArray(comments.postId, postIdArray)))
          .map(c => c.id)
      : [];

    // Get suspicious account IDs linked to these Instagram accounts
    const suspiciousAccountIds = await db.select({ id: suspiciousAccounts.id })
      .from(suspiciousAccounts)
      .where(inArray(suspiciousAccounts.instagramAccountId, accountIds));
    const suspiciousAccountIdArray = suspiciousAccountIds.map(s => s.id);

    // 1. Delete evidence records for comments from posts of these accounts
    if (commentIds.length > 0) {
      console.log('🗑️  Step 1: Deleting evidence records...');
      const moderationLogIds = await db.select({ id: moderationLogs.id })
        .from(moderationLogs)
        .where(inArray(moderationLogs.commentId, commentIds));
      const logIdArray = moderationLogIds.map(l => l.id);
      
      if (logIdArray.length > 0) {
        await db.delete(evidenceRecords).where(
          inArray(evidenceRecords.moderationLogId, logIdArray)
        );
      }
      console.log(`✅ Deleted evidence records`);
    }

    // 2. Delete moderation logs for comments from posts of these accounts
    if (commentIds.length > 0) {
      console.log('🗑️  Step 2: Deleting moderation logs...');
      await db.delete(moderationLogs).where(
        inArray(moderationLogs.commentId, commentIds)
      );
      console.log(`✅ Deleted moderation logs`);
    }

    // 3. Delete extracted identifiers for comments from posts of these accounts
    if (commentIds.length > 0) {
      console.log('🗑️  Step 3: Deleting extracted identifiers...');
      await db.delete(extractedIdentifiers).where(
        inArray(extractedIdentifiers.commentId, commentIds)
      );
      console.log(`✅ Deleted extracted identifiers`);
    }

    // 4. Delete account-comment mappings for suspicious accounts linked to these Instagram accounts
    if (suspiciousAccountIdArray.length > 0) {
      console.log('🗑️  Step 4: Deleting account-comment mappings...');
      await db.delete(accountCommentMap).where(
        inArray(accountCommentMap.suspiciousAccountId, suspiciousAccountIdArray)
      );
      console.log(`✅ Deleted account-comment mappings`);
    }

    // 5. Delete watchlist detections for comments from posts of these accounts
    if (commentIds.length > 0) {
      console.log('🗑️  Step 5: Deleting watchlist detections...');
      await db.delete(watchlistDetections).where(
        inArray(watchlistDetections.commentId, commentIds)
      );
      console.log(`✅ Deleted watchlist detections`);
    }

    // 6. Delete suspicious accounts linked to these Instagram accounts
    if (suspiciousAccountIdArray.length > 0) {
      console.log('🗑️  Step 6: Deleting suspicious accounts...');
      await db.delete(suspiciousAccounts).where(
        inArray(suspiciousAccounts.id, suspiciousAccountIdArray)
      );
      console.log(`✅ Deleted suspicious accounts`);
    }

    // 7. Delete comments from posts of these accounts
    if (commentIds.length > 0) {
      console.log('🗑️  Step 7: Deleting comments...');
      await db.delete(comments).where(
        inArray(comments.id, commentIds)
      );
      console.log(`✅ Deleted comments`);
    }

    // 8. Delete posts from these accounts
    if (postIdArray.length > 0) {
      console.log('🗑️  Step 8: Deleting posts...');
      await db.delete(posts).where(
        inArray(posts.id, postIdArray)
      );
      console.log(`✅ Deleted posts`);
    }

    // 9. Delete page-instagram connections (shouldn't exist for old accounts, but just in case)
    console.log('🗑️  Step 9: Deleting page-instagram connections...');
    await db.delete(pageInstagramConnections).where(
      inArray(pageInstagramConnections.instagramAccountId, accountIds)
    );
    console.log(`✅ Deleted page-instagram connections`);

    // 10. Delete moderation settings for these accounts (only if instagramAccountId is not null)
    console.log('🗑️  Step 10: Deleting moderation settings...');
    // Get all moderation settings with non-null instagramAccountId
    const allSettings = await db.select({ 
      id: moderationSettings.id,
      instagramAccountId: moderationSettings.instagramAccountId 
    })
      .from(moderationSettings)
      .where(
        sql`${moderationSettings.instagramAccountId} IS NOT NULL`
      );
    
    // Filter to only those that match our account IDs
    const matchingSettings = allSettings
      .filter(s => s.instagramAccountId && accountIds.includes(s.instagramAccountId))
      .map(s => s.id);
    
    if (matchingSettings.length > 0) {
      await db.delete(moderationSettings).where(
        inArray(moderationSettings.id, matchingSettings)
      );
    }
    console.log(`✅ Deleted moderation settings`);

    // 11. Delete custom filter account associations
    console.log('🗑️  Step 11: Deleting custom filter account associations...');
    await db.delete(customFilterAccounts).where(
      inArray(customFilterAccounts.instagramAccountId, accountIds)
    );
    console.log(`✅ Deleted custom filter account associations`);

    // 12. Delete custom filters that reference these Instagram accounts
    console.log('🗑️  Step 12: Deleting custom filters...');
    // Get custom filters that reference these accounts
    const filtersToDelete = await db.select({ 
      id: customFilters.id,
      instagramAccountId: customFilters.instagramAccountId 
    })
      .from(customFilters)
      .where(
        sql`${customFilters.instagramAccountId} IS NOT NULL`
      );
    
    // Filter to only those that match our account IDs
    const matchingFilters = filtersToDelete
      .filter(f => f.instagramAccountId && accountIds.includes(f.instagramAccountId))
      .map(f => f.id);
    
    if (matchingFilters.length > 0) {
      await db.delete(customFilters).where(
        inArray(customFilters.id, matchingFilters)
      );
    }
    console.log(`✅ Deleted custom filters`);

    // 13. Finally, delete the Instagram accounts
    console.log('🗑️  Step 13: Deleting Instagram accounts...');
    const deleted = await db
      .delete(instagramAccounts)
      .where(isNull(instagramAccounts.facebookPageId))
      .returning();

    console.log(`✅ Successfully deleted ${deleted.length} old Instagram account(s) and all related data.`);
    console.log('');
    console.log('Note: Users will need to reconnect their Instagram accounts via Facebook Login.');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Cleanup error:', error);
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  deleteOldInstagramAccounts();
}

export { deleteOldInstagramAccounts };

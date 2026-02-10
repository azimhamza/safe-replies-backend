/**
 * Database Cleanup Script
 * 
 * This script clears test data from the database.
 * Use with caution - this will delete data!
 * 
 * Usage:
 *   npx ts-node src/db/clear-test-data.ts
 * 
 * Options:
 *   --all: Clear ALL data (including production data) - USE WITH EXTREME CAUTION
 *   --test-only: Clear only test data (default)
 *   --migration: Clear data to prepare for Facebook Login migration
 */

import { db } from './index';
import {
  moderationLogs,
  evidenceRecords,
  comments,
  posts,
  suspiciousAccounts,
  accountCommentMap,
  extractedIdentifiers,
  evidenceAttachments,
  customFilters,
  instagramAccounts,
  facebookPages,
  pageInstagramConnections,
  moderationSettings
} from './schema';
import { sql, like, inArray } from 'drizzle-orm';

const args = process.argv.slice(2);
const clearAll = args.includes('--all');
const migrationMode = args.includes('--migration');

async function clearTestData() {
  console.log('🧹 Starting database cleanup...\n');

  if (clearAll) {
    console.log('⚠️  WARNING: --all flag detected. This will delete ALL data!');
    console.log('⚠️  Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('🗑️  Proceeding with full database cleanup...\n');
  } else if (migrationMode) {
    console.log('🔄 Migration mode: Preparing for Facebook Login migration...\n');
  } else {
    console.log('🧪 Test mode: Clearing only test data...\n');
  }

  try {
    // Start transaction
    await db.transaction(async (tx) => {
      let deletedCount = 0;

      if (clearAll) {
        // Delete everything in reverse dependency order
        console.log('1️⃣  Clearing moderation logs...');
        await tx.delete(moderationLogs);
        deletedCount += 1;

        console.log('2️⃣  Clearing evidence records...');
        await tx.delete(evidenceRecords);
        deletedCount += 1;

        console.log('3️⃣  Clearing evidence attachments...');
        await tx.delete(evidenceAttachments);
        deletedCount += 1;

        console.log('4️⃣  Clearing extracted identifiers...');
        await tx.delete(extractedIdentifiers);
        deletedCount += 1;

        console.log('5️⃣  Clearing account-comment mappings...');
        await tx.delete(accountCommentMap);
        deletedCount += 1;

        console.log('6️⃣  Clearing suspicious accounts...');
        await tx.delete(suspiciousAccounts);
        deletedCount += 1;

        console.log('7️⃣  Clearing comments...');
        await tx.delete(comments);
        deletedCount += 1;

        console.log('8️⃣  Clearing posts...');
        await tx.delete(posts);
        deletedCount += 1;

        console.log('9️⃣  Clearing page-instagram connections...');
        await tx.delete(pageInstagramConnections);
        deletedCount += 1;

        console.log('🔟 Clearing Instagram accounts...');
        await tx.delete(instagramAccounts);
        deletedCount += 1;

        console.log('1️⃣1️⃣  Clearing Facebook pages...');
        await tx.delete(facebookPages);
        deletedCount += 1;

        console.log('1️⃣2️⃣  Clearing custom filters...');
        await tx.delete(customFilters);
        deletedCount += 1;

        console.log('1️⃣3️⃣  Clearing moderation settings...');
        await tx.delete(moderationSettings);
        deletedCount += 1;

        console.log(`\n✅ Cleared ${deletedCount} table(s) - ALL DATA DELETED`);
      } else if (migrationMode) {
        // Migration mode: Mark Instagram accounts for re-authentication
        console.log('1️⃣  Marking Instagram accounts for re-authentication...');
        await tx
          .update(instagramAccounts)
          .set({
            isActive: false,
            accessToken: null, // Clear old tokens
            tokenExpiresAt: null
          })
          .where(sql`${instagramAccounts.facebookPageId} IS NULL`);
        
        console.log(`   ✅ Marked accounts without Facebook Page connection as inactive`);
        console.log(`   ℹ️  Accounts will need to reconnect via Facebook Login\n`);

        // Clear test data in reverse dependency order
        // First, get test comment IDs
        const testCommentIds = await tx
          .select({ id: comments.id })
          .from(comments)
          .where(like(comments.igCommentId, 'test-%'));

        const testCommentIdArray = testCommentIds.map(c => c.id);

        if (testCommentIds.length > 0) {
          console.log(`2️⃣  Found ${testCommentIds.length} test comment(s) to clean up...\n`);

          // Delete dependent records first
          console.log('   🗑️  Clearing account-comment mappings for test comments...');
          await tx
            .delete(accountCommentMap)
            .where(inArray(accountCommentMap.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared account-comment mappings\n`);

          console.log('   🗑️  Clearing extracted identifiers for test comments...');
          await tx
            .delete(extractedIdentifiers)
            .where(inArray(extractedIdentifiers.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared extracted identifiers\n`);

          console.log('   🗑️  Clearing evidence attachments for test comments...');
          await tx
            .delete(evidenceAttachments)
            .where(inArray(evidenceAttachments.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared evidence attachments\n`);

          console.log('   🗑️  Clearing evidence records for test comments...');
          // Evidence records reference moderation_logs, not comments directly
          // So we need to find moderation logs for test comments first
          const testModerationLogIds = await tx
            .select({ id: moderationLogs.id })
            .from(moderationLogs)
            .where(inArray(moderationLogs.commentId, testCommentIdArray));
          
          if (testModerationLogIds.length > 0) {
            const moderationLogIdArray = testModerationLogIds.map(l => l.id);
            await tx
              .delete(evidenceRecords)
              .where(inArray(evidenceRecords.moderationLogId, moderationLogIdArray));
          }
          console.log(`   ✅ Cleared evidence records\n`);

          console.log('   🗑️  Clearing moderation logs for test comments...');
          await tx
            .delete(moderationLogs)
            .where(inArray(moderationLogs.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared moderation logs\n`);

          // Now safe to delete comments
          console.log('   🗑️  Clearing test comments...');
          await tx
            .delete(comments)
            .where(like(comments.igCommentId, 'test-%'));
          console.log(`   ✅ Cleared ${testCommentIds.length} test comment(s)\n`);
        } else {
          console.log('2️⃣  No test comments found to clean up.\n');
        }

        console.log('✅ Migration cleanup complete!');
        console.log('   Next steps:');
        console.log('   1. Run database migrations: pnpm drizzle-kit push');
        console.log('   2. Users should reconnect via Facebook Login');
      } else {
        // Test mode: Only clear test data
        // Delete in reverse dependency order to avoid foreign key violations
        
        // First, get test comment IDs
        const testCommentIds = await tx
          .select({ id: comments.id })
          .from(comments)
          .where(like(comments.igCommentId, 'test-%'));

        const testCommentIdArray = testCommentIds.map(c => c.id);

        if (testCommentIds.length > 0) {
          console.log(`1️⃣  Found ${testCommentIds.length} test comment(s) to clean up...\n`);

          // Delete dependent records first
          console.log('   🗑️  Clearing account-comment mappings for test comments...');
          await tx
            .delete(accountCommentMap)
            .where(inArray(accountCommentMap.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared account-comment mappings\n`);

          console.log('   🗑️  Clearing extracted identifiers for test comments...');
          await tx
            .delete(extractedIdentifiers)
            .where(inArray(extractedIdentifiers.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared extracted identifiers\n`);

          console.log('   🗑️  Clearing evidence attachments for test comments...');
          await tx
            .delete(evidenceAttachments)
            .where(inArray(evidenceAttachments.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared evidence attachments\n`);

          console.log('   🗑️  Clearing evidence records for test comments...');
          // Evidence records reference moderation_logs, not comments directly
          // So we need to find moderation logs for test comments first
          const testModerationLogIds = await tx
            .select({ id: moderationLogs.id })
            .from(moderationLogs)
            .where(inArray(moderationLogs.commentId, testCommentIdArray));
          
          if (testModerationLogIds.length > 0) {
            const moderationLogIdArray = testModerationLogIds.map(l => l.id);
            await tx
              .delete(evidenceRecords)
              .where(inArray(evidenceRecords.moderationLogId, moderationLogIdArray));
          }
          console.log(`   ✅ Cleared evidence records\n`);

          console.log('   🗑️  Clearing moderation logs for test comments...');
          await tx
            .delete(moderationLogs)
            .where(inArray(moderationLogs.commentId, testCommentIdArray));
          console.log(`   ✅ Cleared moderation logs\n`);

          // Now safe to delete comments
          console.log('   🗑️  Clearing test comments...');
          await tx
            .delete(comments)
            .where(like(comments.igCommentId, 'test-%'));
          console.log(`   ✅ Cleared ${testCommentIds.length} test comment(s)\n`);
        } else {
          console.log('1️⃣  No test comments found to clean up.\n');
        }

        console.log('2️⃣  Clearing test custom filters (name contains "Test")...');
        await tx
          .delete(customFilters)
          .where(like(customFilters.name, '%Test%'));
        console.log(`   ✅ Cleared test custom filters\n`);

        console.log('3️⃣  Clearing test suspicious accounts (commenterUsername starts with "test_")...');
        // Delete suspicious accounts that are no longer linked to any comments
        await tx.execute(sql`
          DELETE FROM suspicious_accounts 
          WHERE commenter_username LIKE 'test_%'
          AND id NOT IN (
            SELECT DISTINCT suspicious_account_id 
            FROM account_comment_map 
            WHERE suspicious_account_id IS NOT NULL
          )
        `);
        console.log(`   ✅ Cleared test suspicious accounts\n`);

        console.log('✅ Test data cleanup complete!');
        console.log('   Production data (real comments, accounts) has been preserved.');
      }
    });

    console.log('\n✅ Database cleanup completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database cleanup failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  clearTestData();
}

export { clearTestData };

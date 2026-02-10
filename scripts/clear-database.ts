/**
 * Database Cleanup and User Deletion Script
 *
 * This script provides options to:
 * 1. Clear the entire database (all tables)
 * 2. Delete a specific user (agency, client, or creator) and all associated data
 *
 * Usage:
 *   # Clear entire database
 *   pnpm script:clear-db --all
 *
 *   # Delete a specific user by email
 *   pnpm script:clear-db --user user@example.com
 *
 *   # Delete a specific client by email
 *   pnpm script:clear-db --client client@example.com
 *
 *   # Delete a specific client by email
 *   pnpm script:clear-db --client client@example.com
 *
 * CAUTION: These operations are IRREVERSIBLE!
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../.env.local') });

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, inArray, or, SQL } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import * as relations from '../src/db/relations';
import * as readline from 'readline';

// Initialize database connection
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool, { schema: { ...schema, ...relations } });

// Helper function for user confirmation
function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

// Parse command line arguments
interface ScriptArgs {
  clearAll: boolean;
  userEmail?: string;
  clientEmail?: string;
}

function parseArgs(): ScriptArgs {
  const args = process.argv.slice(2);
  const result: ScriptArgs = {
    clearAll: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') {
      result.clearAll = true;
    } else if (args[i] === '--user' && args[i + 1]) {
      result.userEmail = args[i + 1];
      i++;
    } else if (args[i] === '--client' && args[i + 1]) {
      result.clientEmail = args[i + 1];
      i++;
    }
  }

  return result;
}

/**
 * Clear the entire database
 */
async function clearEntireDatabase(): Promise<void> {
  console.log('⚠️  WARNING: This will delete ALL data from the database!');
  console.log('⚠️  This action is IRREVERSIBLE!\n');

  const confirm = await askQuestion('Type "DELETE ALL" to confirm: ');

  if (confirm !== 'delete all') {
    console.log('❌ Operation cancelled.');
    return;
  }

  console.log('\n🗑️  Starting database cleanup...\n');

  try {
    await db.transaction(async (tx) => {
      let step = 1;

      // Delete in reverse dependency order to avoid foreign key violations

      // Step 1: Delete moderation logs and evidence
      console.log(`${step++}. Deleting moderation evidence records...`);
      await tx.delete(schema.evidenceRecords);

      console.log(`${step++}. Deleting moderation logs...`);
      await tx.delete(schema.moderationLogs);

      // Step 2: Delete comment-related data
      console.log(`${step++}. Deleting comment review actions...`);
      await tx.delete(schema.commentReviewActions);

      console.log(`${step++}. Deleting watchlist detections...`);
      await tx.delete(schema.watchlistDetections);

      console.log(`${step++}. Deleting evidence attachments...`);
      await tx.delete(schema.evidenceAttachments);

      console.log(`${step++}. Deleting account-comment mappings...`);
      await tx.delete(schema.accountCommentMap);

      console.log(`${step++}. Deleting extracted identifiers...`);
      await tx.delete(schema.extractedIdentifiers);

      console.log(`${step++}. Deleting mastermind mentions...`);
      await tx.delete(schema.mastermindMentions);

      // Step 3: Delete comments
      console.log(`${step++}. Deleting comments...`);
      await tx.delete(schema.comments);

      // Step 4: Delete posts
      console.log(`${step++}. Deleting posts...`);
      await tx.delete(schema.posts);

      // Step 5: Delete network and connection data
      console.log(`${step++}. Deleting bot network connections...`);
      await tx.delete(schema.botNetworkConnections);

      console.log(`${step++}. Deleting bot network masterminds...`);
      await tx.delete(schema.botNetworkMasterminds);

      console.log(`${step++}. Deleting case evidence mappings...`);
      await tx.delete(schema.caseEvidenceMap);

      console.log(`${step++}. Deleting legal cases...`);
      await tx.delete(schema.legalCases);

      // Step 6: Delete suspicious accounts and watchlist
      console.log(`${step++}. Deleting suspicious accounts...`);
      await tx.delete(schema.suspiciousAccounts);

      console.log(`${step++}. Deleting known threats watchlist...`);
      await tx.delete(schema.knownThreatsWatchlist);

      // Step 7: Delete filters and settings
      console.log(`${step++}. Deleting custom filter accounts...`);
      await tx.delete(schema.customFilterAccounts);

      console.log(`${step++}. Deleting custom filters...`);
      await tx.delete(schema.customFilters);

      console.log(`${step++}. Deleting keyword filters...`);
      await tx.delete(schema.keywordFilters);

      console.log(`${step++}. Deleting whitelisted identifiers...`);
      await tx.delete(schema.whitelistedIdentifiers);

      console.log(`${step++}. Deleting moderation settings...`);
      await tx.delete(schema.moderationSettings);

      // Step 8: Delete Instagram and Facebook connections
      console.log(`${step++}. Deleting page-Instagram connections...`);
      await tx.delete(schema.pageInstagramConnections);

      console.log(`${step++}. Deleting follower history...`);
      await tx.delete(schema.followerHistory);

      console.log(`${step++}. Deleting Instagram accounts...`);
      await tx.delete(schema.instagramAccounts);

      console.log(`${step++}. Deleting Facebook pages...`);
      await tx.delete(schema.facebookPages);

      // Step 9: Delete network and agency data
      console.log(`${step++}. Deleting threat network reports...`);
      await tx.delete(schema.threatNetworkReports);

      console.log(`${step++}. Deleting global threat network...`);
      await tx.delete(schema.globalThreatNetwork);

      console.log(`${step++}. Deleting agency network settings...`);
      await tx.delete(schema.agencyNetworkSettings);

      // Step 10: Delete clients
      console.log(`${step++}. Deleting clients...`);
      await tx.delete(schema.clients);

      // Step 11: Delete users
      console.log(`${step++}. Deleting users...`);
      await tx.delete(schema.users);

      console.log(`\n✅ Successfully deleted all data from ${step - 1} tables!`);
    });

    console.log('\n✅ Database cleanup completed successfully!');
  } catch (error) {
    console.error('\n❌ Database cleanup failed:', error);
    throw error;
  }
}

/**
 * Delete a specific user and all their associated data
 */
async function deleteUser(email: string): Promise<void> {
  console.log(`🔍 Looking for user: ${email}...\n`);

  try {
    // Find the user
    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    if (!user) {
      console.log('❌ User not found.');
      return;
    }

    console.log('✅ User found:');
    console.log(`   - Name: ${user.name || 'N/A'}`);
    console.log(`   - Email: ${user.email}`);
    console.log(`   - Account Type: ${user.accountType}`);
    console.log(`   - Business Name: ${user.businessName || 'N/A'}`);
    console.log(`   - Plan: ${user.plan}`);
    console.log(`   - Created: ${user.createdAt}\n`);

    const confirm = await askQuestion(`Type "DELETE ${email}" to confirm deletion: `);

    if (confirm !== `delete ${email}`) {
      console.log('❌ Operation cancelled.');
      return;
    }

    console.log('\n🗑️  Deleting user and all associated data...\n');

    await db.transaction(async (tx) => {
      let step = 1;

      // Get all clients managed by this user (if agency)
      const userClients = await tx.query.clients.findMany({
        where: eq(schema.clients.userId, user.id),
      });

      const clientIds = userClients.map((c) => c.id);
      console.log(`${step++}. Found ${clientIds.length} client(s) managed by this user.`);

      // Get all Instagram accounts (user's own + clients')
      const instagramAccountQuery = clientIds.length > 0
        ? or(
            eq(schema.instagramAccounts.userId, user.id),
            inArray(schema.instagramAccounts.clientId, clientIds)
          )
        : eq(schema.instagramAccounts.userId, user.id);

      const instagramAccounts = await tx.query.instagramAccounts.findMany({
        where: instagramAccountQuery,
      });

      const instagramAccountIds = instagramAccounts.map((a) => a.id);
      console.log(`${step++}. Found ${instagramAccountIds.length} Instagram account(s).`);

      // Get all Facebook pages
      const facebookPageQuery = clientIds.length > 0
        ? or(
            eq(schema.facebookPages.userId, user.id),
            inArray(schema.facebookPages.clientId, clientIds)
          )
        : eq(schema.facebookPages.userId, user.id);

      const facebookPages = await tx.query.facebookPages.findMany({
        where: facebookPageQuery,
      });

      const facebookPageIds = facebookPages.map((p) => p.id);
      console.log(`${step++}. Found ${facebookPageIds.length} Facebook page(s).`);

      // Get all posts from these Instagram accounts and Facebook pages
      if (instagramAccountIds.length > 0 || facebookPageIds.length > 0) {
        const postQuery: SQL[] = [];
        if (instagramAccountIds.length > 0) {
          postQuery.push(inArray(schema.posts.instagramAccountId, instagramAccountIds));
        }
        if (facebookPageIds.length > 0) {
          postQuery.push(inArray(schema.posts.facebookPageId, facebookPageIds));
        }

        const posts = await tx.query.posts.findMany({
          where: postQuery.length > 1 ? or(...postQuery) : postQuery[0],
        });

        const postIds = posts.map((p) => p.id);
        console.log(`${step++}. Found ${postIds.length} post(s).`);

        // Get all comments from these posts
        if (postIds.length > 0) {
          const comments = await tx.query.comments.findMany({
            where: inArray(schema.comments.postId, postIds),
          });

          const commentIds = comments.map((c) => c.id);
          console.log(`${step++}. Found ${commentIds.length} comment(s).\n`);

          if (commentIds.length > 0) {
            // Delete comment-related data
            console.log('Deleting comment-related data...');

            // Get moderation logs for these comments
            const moderationLogs = await tx.query.moderationLogs.findMany({
              where: inArray(schema.moderationLogs.commentId, commentIds),
            });
            const moderationLogIds = moderationLogs.map((l) => l.id);

            if (moderationLogIds.length > 0) {
              console.log(`  - Deleting ${moderationLogIds.length} evidence record(s)...`);
              await tx.delete(schema.evidenceRecords).where(
                inArray(schema.evidenceRecords.moderationLogId, moderationLogIds)
              );
            }

            console.log(`  - Deleting ${moderationLogs.length} moderation log(s)...`);
            if (commentIds.length > 0) {
              await tx.delete(schema.moderationLogs).where(
                inArray(schema.moderationLogs.commentId, commentIds)
              );
            }

            console.log(`  - Deleting comment review actions...`);
            await tx.delete(schema.commentReviewActions).where(
              inArray(schema.commentReviewActions.commentId, commentIds)
            );

            console.log(`  - Deleting watchlist detections...`);
            await tx.delete(schema.watchlistDetections).where(
              inArray(schema.watchlistDetections.commentId, commentIds)
            );

            console.log(`  - Deleting evidence attachments...`);
            await tx.delete(schema.evidenceAttachments).where(
              inArray(schema.evidenceAttachments.commentId, commentIds)
            );

            console.log(`  - Deleting account-comment mappings...`);
            await tx.delete(schema.accountCommentMap).where(
              inArray(schema.accountCommentMap.commentId, commentIds)
            );

            console.log(`  - Deleting extracted identifiers...`);
            await tx.delete(schema.extractedIdentifiers).where(
              inArray(schema.extractedIdentifiers.commentId, commentIds)
            );

            console.log(`  - Deleting mastermind mentions...`);
            await tx.delete(schema.mastermindMentions).where(
              inArray(schema.mastermindMentions.commentId, commentIds)
            );

            console.log(`  - Deleting case evidence mappings...`);
            await tx.delete(schema.caseEvidenceMap).where(
              inArray(schema.caseEvidenceMap.commentId, commentIds)
            );

            console.log(`  - Deleting ${commentIds.length} comment(s)...\n`);
            await tx.delete(schema.comments).where(
              inArray(schema.comments.id, commentIds)
            );
          }

          console.log(`Deleting ${postIds.length} post(s)...\n`);
          await tx.delete(schema.posts).where(inArray(schema.posts.id, postIds));
        }
      }

      // Delete suspicious accounts related to Instagram accounts
      if (instagramAccountIds.length > 0) {
        const suspiciousAccounts = await tx.query.suspiciousAccounts.findMany({
          where: inArray(schema.suspiciousAccounts.instagramAccountId, instagramAccountIds),
        });

        const suspiciousAccountIds = suspiciousAccounts.map((a) => a.id);

        if (suspiciousAccountIds.length > 0) {
          console.log(`Deleting ${suspiciousAccountIds.length} suspicious account(s)...`);

          console.log(`  - Deleting bot network connections...`);
          await tx.delete(schema.botNetworkConnections).where(
            inArray(schema.botNetworkConnections.suspiciousAccountId, suspiciousAccountIds)
          );

          console.log(`  - Deleting legal cases...`);
          await tx.delete(schema.legalCases).where(
            inArray(schema.legalCases.suspiciousAccountId, suspiciousAccountIds)
          );

          console.log(`  - Deleting suspicious accounts...\n`);
          await tx.delete(schema.suspiciousAccounts).where(
            inArray(schema.suspiciousAccounts.id, suspiciousAccountIds)
          );
        }
      }

      // Delete bot network masterminds
      const mastermindQuery = clientIds.length > 0
        ? or(
            eq(schema.botNetworkMasterminds.userId, user.id),
            inArray(schema.botNetworkMasterminds.clientId, clientIds)
          )
        : eq(schema.botNetworkMasterminds.userId, user.id);

      console.log('Deleting bot network masterminds...');
      await tx.delete(schema.botNetworkMasterminds).where(mastermindQuery);

      // Delete filters and settings
      const filterQuery = clientIds.length > 0
        ? or(
            eq(schema.customFilters.userId, user.id),
            inArray(schema.customFilters.clientId, clientIds)
          )
        : eq(schema.customFilters.userId, user.id);

      console.log('Deleting custom filters...');
      await tx.delete(schema.customFilters).where(filterQuery);

      if (clientIds.length > 0) {
        console.log('Deleting keyword filters...');
        await tx.delete(schema.keywordFilters).where(
          inArray(schema.keywordFilters.clientId, clientIds)
        );
      }

      const whitelistQuery = clientIds.length > 0
        ? or(
            eq(schema.whitelistedIdentifiers.userId, user.id),
            inArray(schema.whitelistedIdentifiers.clientId, clientIds)
          )
        : eq(schema.whitelistedIdentifiers.userId, user.id);

      console.log('Deleting whitelisted identifiers...');
      await tx.delete(schema.whitelistedIdentifiers).where(whitelistQuery);

      const moderationSettingsQuery = clientIds.length > 0
        ? or(
            eq(schema.moderationSettings.userId, user.id),
            inArray(schema.moderationSettings.clientId, clientIds)
          )
        : eq(schema.moderationSettings.userId, user.id);

      console.log('Deleting moderation settings...');
      await tx.delete(schema.moderationSettings).where(moderationSettingsQuery);

      // Delete watchlist
      if (clientIds.length > 0) {
        console.log('Deleting known threats watchlist...');
        await tx.delete(schema.knownThreatsWatchlist).where(
          inArray(schema.knownThreatsWatchlist.clientId, clientIds)
        );
      }

      // Delete Instagram and Facebook connections
      if (instagramAccountIds.length > 0) {
        console.log('Deleting page-Instagram connections...');
        await tx.delete(schema.pageInstagramConnections).where(
          inArray(schema.pageInstagramConnections.instagramAccountId, instagramAccountIds)
        );

        console.log('Deleting follower history (Instagram)...');
        await tx.delete(schema.followerHistory).where(
          inArray(schema.followerHistory.instagramAccountId, instagramAccountIds)
        );

        console.log('Deleting Instagram accounts...');
        await tx.delete(schema.instagramAccounts).where(
          inArray(schema.instagramAccounts.id, instagramAccountIds)
        );
      }

      if (facebookPageIds.length > 0) {
        console.log('Deleting follower history (Facebook)...');
        await tx.delete(schema.followerHistory).where(
          inArray(schema.followerHistory.facebookPageId, facebookPageIds)
        );

        console.log('Deleting Facebook pages...');
        await tx.delete(schema.facebookPages).where(
          inArray(schema.facebookPages.id, facebookPageIds)
        );
      }

      // Delete agency network data
      console.log('Deleting threat network reports...');
      await tx.delete(schema.threatNetworkReports).where(
        eq(schema.threatNetworkReports.reportingAgencyId, user.id)
      );

      console.log('Deleting agency network settings...');
      await tx.delete(schema.agencyNetworkSettings).where(
        eq(schema.agencyNetworkSettings.userId, user.id)
      );

      // Delete clients
      if (clientIds.length > 0) {
        console.log(`Deleting ${clientIds.length} client(s)...`);
        await tx.delete(schema.clients).where(inArray(schema.clients.id, clientIds));
      }

      // Finally, delete the user
      console.log('Deleting user...\n');
      await tx.delete(schema.users).where(eq(schema.users.id, user.id));

      console.log(`✅ Successfully deleted user and all associated data!`);
    });

    console.log('\n✅ User deletion completed successfully!');
  } catch (error) {
    console.error('\n❌ User deletion failed:', error);
    throw error;
  }
}

/**
 * Delete a specific client and all their associated data
 */
async function deleteClient(email: string): Promise<void> {
  console.log(`🔍 Looking for client: ${email}...\n`);

  try {
    // Find the client
    const client = await db.query.clients.findFirst({
      where: eq(schema.clients.email, email),
    });

    if (!client) {
      console.log('❌ Client not found.');
      return;
    }

    // Get the managing user
    const managingUser = await db.query.users.findFirst({
      where: eq(schema.users.id, client.userId),
    });

    console.log('✅ Client found:');
    console.log(`   - Business Name: ${client.businessName}`);
    console.log(`   - Email: ${client.email}`);
    console.log(`   - Account Type: ${client.accountType}`);
    console.log(`   - Managed by: ${managingUser?.email || 'N/A'}`);
    console.log(`   - Onboarding Stage: ${client.onboardingStage}`);
    console.log(`   - Created: ${client.createdAt}\n`);

    const confirm = await askQuestion(`Type "DELETE ${email}" to confirm deletion: `);

    if (confirm !== `delete ${email}`) {
      console.log('❌ Operation cancelled.');
      return;
    }

    console.log('\n🗑️  Deleting client and all associated data...\n');

    await db.transaction(async (tx) => {
      let step = 1;

      // Get all Instagram accounts
      const instagramAccounts = await tx.query.instagramAccounts.findMany({
        where: eq(schema.instagramAccounts.clientId, client.id),
      });

      const instagramAccountIds = instagramAccounts.map((a) => a.id);
      console.log(`${step++}. Found ${instagramAccountIds.length} Instagram account(s).`);

      // Get all Facebook pages
      const facebookPages = await tx.query.facebookPages.findMany({
        where: eq(schema.facebookPages.clientId, client.id),
      });

      const facebookPageIds = facebookPages.map((p) => p.id);
      console.log(`${step++}. Found ${facebookPageIds.length} Facebook page(s).`);

      // Get all posts
      if (instagramAccountIds.length > 0 || facebookPageIds.length > 0) {
        const postQuery: SQL[] = [];
        if (instagramAccountIds.length > 0) {
          postQuery.push(inArray(schema.posts.instagramAccountId, instagramAccountIds));
        }
        if (facebookPageIds.length > 0) {
          postQuery.push(inArray(schema.posts.facebookPageId, facebookPageIds));
        }

        const posts = await tx.query.posts.findMany({
          where: postQuery.length > 1 ? or(...postQuery) : postQuery[0],
        });

        const postIds = posts.map((p) => p.id);
        console.log(`${step++}. Found ${postIds.length} post(s).`);

        // Get all comments
        if (postIds.length > 0) {
          const comments = await tx.query.comments.findMany({
            where: inArray(schema.comments.postId, postIds),
          });

          const commentIds = comments.map((c) => c.id);
          console.log(`${step++}. Found ${commentIds.length} comment(s).\n`);

          if (commentIds.length > 0) {
            // Delete comment-related data
            console.log('Deleting comment-related data...');

            // Get moderation logs
            const moderationLogs = await tx.query.moderationLogs.findMany({
              where: inArray(schema.moderationLogs.commentId, commentIds),
            });
            const moderationLogIds = moderationLogs.map((l) => l.id);

            if (moderationLogIds.length > 0) {
              console.log(`  - Deleting evidence records...`);
              await tx.delete(schema.evidenceRecords).where(
                inArray(schema.evidenceRecords.moderationLogId, moderationLogIds)
              );
            }

            console.log(`  - Deleting moderation logs...`);
            if (commentIds.length > 0) {
              await tx.delete(schema.moderationLogs).where(
                inArray(schema.moderationLogs.commentId, commentIds)
              );
            }

            console.log(`  - Deleting comment review actions...`);
            await tx.delete(schema.commentReviewActions).where(
              inArray(schema.commentReviewActions.commentId, commentIds)
            );

            console.log(`  - Deleting watchlist detections...`);
            await tx.delete(schema.watchlistDetections).where(
              inArray(schema.watchlistDetections.commentId, commentIds)
            );

            console.log(`  - Deleting evidence attachments...`);
            await tx.delete(schema.evidenceAttachments).where(
              inArray(schema.evidenceAttachments.commentId, commentIds)
            );

            console.log(`  - Deleting account-comment mappings...`);
            await tx.delete(schema.accountCommentMap).where(
              inArray(schema.accountCommentMap.commentId, commentIds)
            );

            console.log(`  - Deleting extracted identifiers...`);
            await tx.delete(schema.extractedIdentifiers).where(
              inArray(schema.extractedIdentifiers.commentId, commentIds)
            );

            console.log(`  - Deleting mastermind mentions...`);
            await tx.delete(schema.mastermindMentions).where(
              inArray(schema.mastermindMentions.commentId, commentIds)
            );

            console.log(`  - Deleting case evidence mappings...`);
            await tx.delete(schema.caseEvidenceMap).where(
              inArray(schema.caseEvidenceMap.commentId, commentIds)
            );

            console.log(`  - Deleting comments...\n`);
            await tx.delete(schema.comments).where(inArray(schema.comments.id, commentIds));
          }

          console.log(`Deleting posts...\n`);
          await tx.delete(schema.posts).where(inArray(schema.posts.id, postIds));
        }
      }

      // Delete suspicious accounts
      if (instagramAccountIds.length > 0) {
        const suspiciousAccounts = await tx.query.suspiciousAccounts.findMany({
          where: inArray(schema.suspiciousAccounts.instagramAccountId, instagramAccountIds),
        });

        const suspiciousAccountIds = suspiciousAccounts.map((a) => a.id);

        if (suspiciousAccountIds.length > 0) {
          console.log(`Deleting suspicious accounts...`);

          console.log(`  - Deleting bot network connections...`);
          await tx.delete(schema.botNetworkConnections).where(
            inArray(schema.botNetworkConnections.suspiciousAccountId, suspiciousAccountIds)
          );

          console.log(`  - Deleting legal cases...`);
          await tx.delete(schema.legalCases).where(
            inArray(schema.legalCases.suspiciousAccountId, suspiciousAccountIds)
          );

          console.log(`  - Deleting suspicious accounts...\n`);
          await tx.delete(schema.suspiciousAccounts).where(
            inArray(schema.suspiciousAccounts.id, suspiciousAccountIds)
          );
        }
      }

      // Delete bot network masterminds
      console.log('Deleting bot network masterminds...');
      await tx.delete(schema.botNetworkMasterminds).where(
        eq(schema.botNetworkMasterminds.clientId, client.id)
      );

      // Delete filters and settings
      console.log('Deleting custom filters...');
      await tx.delete(schema.customFilters).where(
        eq(schema.customFilters.clientId, client.id)
      );

      console.log('Deleting keyword filters...');
      await tx.delete(schema.keywordFilters).where(
        eq(schema.keywordFilters.clientId, client.id)
      );

      console.log('Deleting whitelisted identifiers...');
      await tx.delete(schema.whitelistedIdentifiers).where(
        eq(schema.whitelistedIdentifiers.clientId, client.id)
      );

      console.log('Deleting moderation settings...');
      await tx.delete(schema.moderationSettings).where(
        eq(schema.moderationSettings.clientId, client.id)
      );

      console.log('Deleting known threats watchlist...');
      await tx.delete(schema.knownThreatsWatchlist).where(
        eq(schema.knownThreatsWatchlist.clientId, client.id)
      );

      // Delete Instagram and Facebook connections
      if (instagramAccountIds.length > 0) {
        console.log('Deleting page-Instagram connections...');
        await tx.delete(schema.pageInstagramConnections).where(
          inArray(schema.pageInstagramConnections.instagramAccountId, instagramAccountIds)
        );

        console.log('Deleting follower history (Instagram)...');
        await tx.delete(schema.followerHistory).where(
          inArray(schema.followerHistory.instagramAccountId, instagramAccountIds)
        );

        console.log('Deleting Instagram accounts...');
        await tx.delete(schema.instagramAccounts).where(
          inArray(schema.instagramAccounts.id, instagramAccountIds)
        );
      }

      if (facebookPageIds.length > 0) {
        console.log('Deleting follower history (Facebook)...');
        await tx.delete(schema.followerHistory).where(
          inArray(schema.followerHistory.facebookPageId, facebookPageIds)
        );

        console.log('Deleting Facebook pages...');
        await tx.delete(schema.facebookPages).where(
          inArray(schema.facebookPages.id, facebookPageIds)
        );
      }

      // Finally, delete the client
      console.log('Deleting client...\n');
      await tx.delete(schema.clients).where(eq(schema.clients.id, client.id));

      console.log(`✅ Successfully deleted client and all associated data!`);
    });

    console.log('\n✅ Client deletion completed successfully!');
  } catch (error) {
    console.error('\n❌ Client deletion failed:', error);
    throw error;
  }
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const args = parseArgs();

  console.log('🗑️  Database Cleanup Script\n');
  console.log('=' .repeat(60));
  console.log();

  try {
    if (args.clearAll) {
      await clearEntireDatabase();
    } else if (args.userEmail) {
      await deleteUser(args.userEmail);
    } else if (args.clientEmail) {
      await deleteClient(args.clientEmail);
    } else {
      console.log('Usage:');
      console.log('  # Clear entire database:');
      console.log('  pnpm script:clear-db --all\n');
      console.log('  # Delete a specific user (agency or creator):');
      console.log('  pnpm script:clear-db --user user@example.com\n');
      console.log('  # Delete a specific client:');
      console.log('  pnpm script:clear-db --client client@example.com\n');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Operation failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { clearEntireDatabase, deleteUser, deleteClient };

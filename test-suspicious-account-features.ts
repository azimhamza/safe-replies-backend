/**
 * Test script to verify Identifiers, Network, Patterns, and Bot Network features
 * Run with: npx tsx test-suspicious-account-features.ts
 */

import { db } from './src/db';
import { suspiciousAccounts, extractedIdentifiers, comments, accountCommentMap, instagramAccounts } from './src/db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';

async function testSuspiciousAccountFeatures() {
  console.log('🔍 Testing Suspicious Account Features...\n');

  try {
    // Get a test suspicious account
    const testAccount = await db.query.suspiciousAccounts.findFirst({
      orderBy: [desc(suspiciousAccounts.firstSeenAt)]
    });

    if (!testAccount) {
      console.log('❌ No suspicious accounts found in database');
      console.log('💡 You need to create a suspicious account first by moderating some comments');
      return;
    }

    console.log(`✅ Found test account: @${testAccount.commenterUsername} (ID: ${testAccount.id})\n`);

    // 1. Test Identifiers
    console.log('📋 Testing Identifiers...');
    const identifiers = await db
      .select()
      .from(extractedIdentifiers)
      .where(eq(extractedIdentifiers.suspiciousAccountId, testAccount.id))
      .limit(10);

    console.log(`   Found ${identifiers.length} extracted identifiers`);
    if (identifiers.length > 0) {
      const paymentHandles = identifiers.filter(i => ['VENMO', 'CASHAPP', 'PAYPAL', 'ZELLE', 'BITCOIN', 'ETHEREUM', 'CRYPTO'].includes(i.identifierType));
      const contactInfo = identifiers.filter(i => ['EMAIL', 'PHONE'].includes(i.identifierType));
      const urls = identifiers.filter(i => i.identifierType === 'DOMAIN' || i.identifier.startsWith('http'));
      
      console.log(`   - Payment handles: ${paymentHandles.length}`);
      console.log(`   - Contact info: ${contactInfo.length}`);
      console.log(`   - URLs: ${urls.length}`);
      
      if (identifiers.length > 0) {
        console.log(`   ✅ Identifiers feature should work!`);
        console.log(`   Sample identifier: ${identifiers[0].identifier} (${identifiers[0].identifierType})`);
      }
    } else {
      console.log(`   ⚠️  No identifiers found - this is why the Identifiers section is empty`);
      console.log(`   💡 Identifiers are extracted when comments are moderated. Make sure comments contain payment handles, emails, or URLs.`);
    }
    console.log('');

    // 2. Test Network Activity
    console.log('🌐 Testing Network Activity...');
    const networkAccounts = await db
      .select({
        id: suspiciousAccounts.id,
        instagramAccountId: suspiciousAccounts.instagramAccountId,
        username: instagramAccounts.username
      })
      .from(suspiciousAccounts)
      .innerJoin(instagramAccounts, eq(suspiciousAccounts.instagramAccountId, instagramAccounts.id))
      .where(
        and(
          eq(suspiciousAccounts.commenterId, testAccount.commenterId),
          sql`${suspiciousAccounts.id} != ${testAccount.id}`
        )
      );

    console.log(`   Found ${networkAccounts.length} other accounts with same commenterId`);
    if (networkAccounts.length > 0) {
      console.log(`   ✅ Network feature should work!`);
      console.log(`   Accounts: ${networkAccounts.map(a => `@${a.username}`).join(', ')}`);
    } else {
      console.log(`   ⚠️  No network activity - this is why the Network section shows 0`);
      console.log(`   💡 Network activity requires the same commenterId to appear on multiple Instagram accounts`);
    }
    console.log('');

    // 3. Test Patterns (Similar Behaviors)
    console.log('🔗 Testing Patterns (Similar Behaviors)...');
    const accountComments = await db
      .select({
        id: comments.id,
        text: comments.text,
        hasEmbedding: sql<boolean>`${comments.embedding} IS NOT NULL`
      })
      .from(comments)
      .innerJoin(accountCommentMap, eq(comments.id, accountCommentMap.commentId))
      .where(eq(accountCommentMap.suspiciousAccountId, testAccount.id))
      .limit(10);

    const commentsWithEmbeddings = accountComments.filter(c => c.hasEmbedding);
    console.log(`   Found ${accountComments.length} comments for this account`);
    console.log(`   Comments with embeddings: ${commentsWithEmbeddings.length}`);

    if (commentsWithEmbeddings.length > 0) {
      // Check if there are similar comments from other accounts
      const sampleComment = commentsWithEmbeddings[0];
      console.log(`   ✅ Patterns feature should work if there are similar comments from other accounts`);
      console.log(`   Sample comment: "${sampleComment.text.substring(0, 50)}..."`);
    } else {
      console.log(`   ⚠️  No comments with embeddings - this is why Patterns section is empty`);
      console.log(`   💡 Comments need embeddings generated. This happens during moderation.`);
    }
    console.log('');

    // 4. Test Bot Network Detection
    console.log('🤖 Testing Bot Network Detection...');
    const accountIdentifiers = await db
      .select({
        normalizedIdentifier: extractedIdentifiers.normalizedIdentifier,
        identifierType: extractedIdentifiers.identifierType
      })
      .from(extractedIdentifiers)
      .where(eq(extractedIdentifiers.suspiciousAccountId, testAccount.id))
      .limit(10);

    if (accountIdentifiers.length > 0) {
      // Check if any other accounts share these identifiers
      const sharedIdentifierCounts = await Promise.all(
        accountIdentifiers.slice(0, 5).map(async (id) => {
          const sharedAccounts = await db
            .select({ count: sql<number>`COUNT(DISTINCT ${extractedIdentifiers.suspiciousAccountId})` })
            .from(extractedIdentifiers)
            .where(
              and(
                eq(extractedIdentifiers.normalizedIdentifier, id.normalizedIdentifier),
                sql`${extractedIdentifiers.suspiciousAccountId} != ${testAccount.id}`
              )
            );
          return { identifier: id.normalizedIdentifier, sharedCount: parseInt(sharedAccounts[0]?.count?.toString() || '0') };
        })
      );

      const hasSharedIdentifiers = sharedIdentifierCounts.some(s => s.sharedCount > 0);
      if (hasSharedIdentifiers) {
        console.log(`   ✅ Bot Network feature should work!`);
        console.log(`   Found shared identifiers across accounts`);
      } else {
        console.log(`   ⚠️  No shared identifiers - this is why Bot Network shows "No bot network detected"`);
        console.log(`   💡 Bot networks are detected when multiple accounts share the same identifiers (payment handles, emails, etc.)`);
      }
    } else {
      console.log(`   ⚠️  No identifiers found for bot network detection`);
    }
    console.log('');

    // Summary
    console.log('📊 Summary:');
    console.log(`   Account: @${testAccount.commenterUsername}`);
    console.log(`   Total violations: ${testAccount.flaggedComments || 0}`);
    console.log(`   - Blackmail: ${testAccount.blackmailCount || 0}`);
    console.log(`   - Threats: ${testAccount.threatCount || 0}`);
    console.log(`   - Harassment: ${testAccount.harassmentCount || 0}`);
    console.log(`   - Defamation: ${testAccount.defamationCount || 0}`);
    console.log(`   - Spam: ${testAccount.spamCount || 0}`);
    console.log('');

    console.log('💡 To populate these features:');
    console.log('   1. Identifiers: Comments must contain payment handles (@venmo, $cashapp), emails, or URLs');
    console.log('   2. Network: Same commenterId must appear on multiple Instagram accounts');
    console.log('   3. Patterns: Comments need embeddings and similar comments from other accounts');
    console.log('   4. Bot Network: Multiple accounts must share the same identifiers');

  } catch (error) {
    console.error('❌ Error testing features:', error);
  } finally {
    process.exit(0);
  }
}

testSuspiciousAccountFeatures();

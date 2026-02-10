import { db } from './src/db';
import { suspiciousAccounts, comments, accountCommentMap } from './src/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { embeddingsService } from './src/services/embeddings.service';

/**
 * Test script for Similar Behaviors feature
 * Tests the embeddings-based pattern detection
 */
async function testSimilarBehaviors() {
  console.log('🧪 Testing Similar Behaviors Feature\n');

  try {
    // Get a suspicious account with comments that have embeddings
    const testAccount = await db.query.suspiciousAccounts.findFirst({
      where: sql`EXISTS (
        SELECT 1 FROM ${accountCommentMap} acm
        INNER JOIN ${comments} c ON acm.comment_id = c.id
        WHERE acm.suspicious_account_id = ${suspiciousAccounts.id}
        AND c.embedding IS NOT NULL
      )`
    });

    if (!testAccount) {
      console.log('⚠️  No suspicious accounts found with comments that have embeddings');
      console.log('   Run the embeddings generation service first to populate embeddings');
      return;
    }

    console.log(`✓ Found test account: @${testAccount.commenterUsername} (${testAccount.id})`);

    // Get comments for this account
    const accountComments = await db
      .select({
        id: comments.id,
        text: comments.text,
        embedding: comments.embedding
      })
      .from(comments)
      .innerJoin(accountCommentMap, eq(comments.id, accountCommentMap.commentId))
      .where(
        and(
          eq(accountCommentMap.suspiciousAccountId, testAccount.id),
          sql`${comments.embedding} IS NOT NULL`
        )
      );

    console.log(`✓ Found ${accountComments.length} comments with embeddings`);

    if (accountComments.length === 0) {
      console.log('⚠️  No comments with embeddings for this account');
      return;
    }

    // Test similarity search for each comment
    let totalSimilarFound = 0;
    const categoryCounts = new Map<string, Set<string>>();

    for (const comment of accountComments.slice(0, 3)) { // Test first 3 comments
      console.log(`\n📝 Testing comment: "${comment.text.substring(0, 50)}..."`);

      const similarComments = await embeddingsService.findSimilarCommentsEfficient(
        comment.id,
        20,
        0.75
      );

      console.log(`   Found ${similarComments.length} similar comments from other accounts`);
      totalSimilarFound += similarComments.length;

      // Group by commenter
      const uniqueCommenters = new Set(similarComments.map(sc => sc.commenterId));
      console.log(`   From ${uniqueCommenters.size} different accounts`);

      if (similarComments.length > 0) {
        const topSimilar = similarComments[0];
        console.log(`   Top match: ${(topSimilar.similarity * 100).toFixed(1)}% similar`);
        console.log(`   Sample: "${topSimilar.text.substring(0, 50)}..."`);
      }

      // Track commenter stats
      const commentKey = comment.id;
      if (!categoryCounts.has(commentKey)) {
        categoryCounts.set(commentKey, new Set());
      }
      similarComments.forEach(sc => categoryCounts.get(commentKey)!.add(sc.commenterId));
    }

    console.log(`\n\n📊 Aggregated Results:`);
    console.log(`   Total similar comments found: ${totalSimilarFound}`);
    console.log(`   Patterns by category:`);
    
    for (const [category, accounts] of categoryCounts.entries()) {
      console.log(`     - ${category}: ${accounts.size} accounts`);
    }

    // Calculate network risk level
    const totalUniqueAccounts = new Set(
      Array.from(categoryCounts.values()).flatMap(set => Array.from(set))
    ).size;

    let networkRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (totalUniqueAccounts >= 10 || categoryCounts.has('blackmail')) {
      networkRiskLevel = 'CRITICAL';
    } else if (totalUniqueAccounts >= 5 || categoryCounts.has('threat')) {
      networkRiskLevel = 'HIGH';
    } else if (totalUniqueAccounts >= 2) {
      networkRiskLevel = 'MEDIUM';
    }

    console.log(`\n   Network Risk Level: ${networkRiskLevel}`);
    console.log(`   Total unique accounts with similar behavior: ${totalUniqueAccounts}`);

    console.log('\n✅ Similar Behaviors Test Complete\n');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Run test
testSimilarBehaviors()
  .then(() => {
    console.log('Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });

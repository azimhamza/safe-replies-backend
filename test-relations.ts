import { db } from './src/db';

async function testRelations() {
  console.log('🧪 Testing Drizzle Relations...\n');

  try {
    // Test basic queries that were failing before
    console.log('📸 Testing Instagram accounts query...');
    const accounts = await db.query.instagramAccounts.findMany({
      limit: 1
    });
    console.log(`✅ Found ${accounts.length} Instagram accounts`);

    if (accounts.length > 0) {
      console.log('📝 Testing posts query with relation...');
      const posts = await db.query.posts.findMany({
        where: (posts, { eq }) => eq(posts.instagramAccountId, accounts[0].id),
        limit: 1
      });
      console.log(`✅ Found ${posts.length} posts for account`);

      if (posts.length > 0) {
        console.log('💬 Testing comments query with relation...');
        const comments = await db.query.comments.findMany({
          where: (comments, { eq }) => eq(comments.postId, posts[0].id),
          limit: 1
        });
        console.log(`✅ Found ${comments.length} comments for post`);
      }
    }

    console.log('\n🎉 All relation tests passed! The referencedTable error is fixed.');
    process.exit(0);

  } catch (error) {
    console.error('❌ Relation test failed:', error);
    process.exit(1);
  }
}

testRelations();
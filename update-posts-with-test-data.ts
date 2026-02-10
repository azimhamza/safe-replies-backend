/**
 * Script to update existing posts with test data (likes and comments count)
 * Uses realistic data based on actual Instagram post patterns
 */

import * as dotenv from 'dotenv';
import { db } from './src/db';
import { posts } from './src/db/schema';
import { eq } from 'drizzle-orm';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

interface TestPostData {
  likesCount: number;
  commentsCount: number;
}

// Realistic test data patterns based on Instagram analytics
// Posts with more engagement typically have:
// - Higher likes (100-10k range for medium accounts)
// - Comments are usually 1-5% of likes
const generateTestData = (index: number): TestPostData => {
  // Vary the data to make it realistic
  const baseLikes = 500 + (index % 20) * 200; // 500-4300 range
  const likesVariation = Math.floor(Math.random() * 1000);
  const likesCount = baseLikes + likesVariation;
  
  // Comments are typically 1-5% of likes
  const commentRatio = 0.01 + (Math.random() * 0.04); // 1-5%
  const commentsCount = Math.floor(likesCount * commentRatio);
  
  return {
    likesCount,
    commentsCount: Math.max(0, commentsCount) // Ensure non-negative
  };
};

async function updatePostsWithTestData(): Promise<void> {
  try {
    console.log('🔄 Starting to update posts with test data...\n');

    // Get all existing posts
    const allPosts = await db.query.posts.findMany({
      columns: {
        id: true,
        igPostId: true,
        caption: true,
        likesCount: true,
        commentsCount: true
      }
    });

    console.log(`📊 Found ${allPosts.length} posts in database\n`);

    if (allPosts.length === 0) {
      console.log('⚠️  No posts found in database. Please sync Instagram account first.');
      return;
    }

    // Filter posts that need updating (null likes/comments count)
    const postsToUpdate = allPosts.filter(
      post => post.likesCount === null || post.commentsCount === null
    );

    console.log(`📝 Posts that need updating: ${postsToUpdate.length}`);
    console.log(`✅ Posts already have data: ${allPosts.length - postsToUpdate.length}\n`);

    if (postsToUpdate.length === 0) {
      console.log('✅ All posts already have likes and comments count!');
      return;
    }

    // Update each post with test data
    let updatedCount = 0;
    for (let i = 0; i < postsToUpdate.length; i++) {
      const post = postsToUpdate[i];
      const testData = generateTestData(i);

      try {
        await db
          .update(posts)
          .set({
            likesCount: testData.likesCount,
            commentsCount: testData.commentsCount
          })
          .where(eq(posts.id, post.id));

        updatedCount++;
        console.log(
          `  ✅ Updated post ${i + 1}/${postsToUpdate.length}: ` +
          `"${post.caption?.substring(0, 40) || post.igPostId}..." ` +
          `→ ${testData.likesCount} likes, ${testData.commentsCount} comments`
        );
      } catch (error) {
        console.error(`  ❌ Failed to update post ${post.id}:`, error);
      }
    }

    console.log(`\n✅ Successfully updated ${updatedCount} posts with test data!`);
    console.log('\n📊 Summary:');
    console.log(`   - Total posts: ${allPosts.length}`);
    console.log(`   - Updated: ${updatedCount}`);
    console.log(`   - Already had data: ${allPosts.length - postsToUpdate.length}`);

    // Show sample of updated data
    const samplePosts = await db.query.posts.findMany({
      columns: {
        caption: true,
        likesCount: true,
        commentsCount: true
      },
      limit: 5
    });

    console.log('\n📸 Sample posts:');
    samplePosts.forEach((post, idx) => {
      const caption = post.caption?.substring(0, 50) || 'No caption';
      console.log(
        `   ${idx + 1}. "${caption}..." - ` +
        `${post.likesCount?.toLocaleString() || 'N/A'} likes, ` +
        `${post.commentsCount?.toLocaleString() || 'N/A'} comments`
      );
    });

  } catch (error) {
    console.error('❌ Error updating posts:', error);
    throw error;
  }
}

// Run the script
updatePostsWithTestData()
  .then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });

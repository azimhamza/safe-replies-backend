/**
 * Script to create test comments for specific media IDs
 * Creates realistic test comments to simulate Instagram comment data
 */

import * as dotenv from 'dotenv';
import { db } from './src/db';
import { posts, comments } from './src/db/schema';
import { eq, inArray } from 'drizzle-orm';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

// Media IDs and their expected comment counts
const TEST_POSTS = [
  { mediaId: '18127050079408565', expectedComments: 3 },
  { mediaId: '18055346117293980', expectedComments: 4 },
  { mediaId: '18050295020175812', expectedComments: 6 },
  { mediaId: '18027175127552398', expectedComments: 2 },
  { mediaId: '18020494589320350', expectedComments: 2 }
];

// Realistic comment templates based on the post captions
const COMMENT_TEMPLATES = [
  // Positive/Supportive comments
  'This looks amazing! 🔥',
  'Love this! Can\'t wait to join!',
  'So inspiring! ✨',
  'This is exactly what Dubai needs!',
  'Count me in! 🚀',
  'Amazing initiative!',
  'Looking forward to this!',
  'This is incredible! 💫',
  
  // Questions/Engagement
  'When is the next session?',
  'Where exactly is this located?',
  'How do I sign up?',
  'What time does it start?',
  'Is there parking available?',
  
  // Enthusiastic responses
  'YES! This is what I\'ve been waiting for!',
  'Finally! A space for creators in Dubai!',
  'This is going to be epic! 🎉',
  'Can\'t wait to connect with other creators!',
  'This is going to change everything!',
  
  // Appreciation
  'Thank you for creating this space!',
  'Grateful for this opportunity! 🙏',
  'This means so much to the creative community!',
  'You\'re doing amazing work!',
  
  // Casual/Conversational
  'Sounds interesting!',
  'Might check this out!',
  'Cool concept!',
  'Nice! 👌',
  'Interesting idea!'
];

// Test usernames for commenters
const TEST_USERNAMES = [
  'dubai_creator_2024',
  'creative_mind_dxb',
  'startup_dubai',
  'art_lover_uae',
  'entrepreneur_dxb',
  'design_studio_dubai',
  'tech_startup_uae',
  'content_creator_dxb',
  'freelancer_dubai',
  'business_owner_uae',
  'marketing_pro_dxb',
  'writer_dubai',
  'photographer_uae',
  'videographer_dxb',
  'social_media_dubai',
  'brand_strategy_uae',
  'digital_nomad_dxb',
  'coffee_lover_dubai',
  'workspace_seeker_uae',
  'networking_dubai'
];

// Generate a random comment text
function generateCommentText(index: number): string {
  const template = COMMENT_TEMPLATES[index % COMMENT_TEMPLATES.length];
  return template;
}

// Generate a random username
function generateUsername(index: number): string {
  return TEST_USERNAMES[index % TEST_USERNAMES.length];
}

// Generate a commenter ID (simulate Instagram user ID)
function generateCommenterId(index: number): string {
  return `test_commenter_${index}_${Date.now()}`;
}

async function createTestComments(): Promise<void> {
  try {
    console.log('🔄 Starting to create test comments...\n');

    // Get all posts by their Instagram post IDs
    const mediaIds = TEST_POSTS.map(p => p.mediaId);
    const existingPosts = await db.query.posts.findMany({
      where: inArray(posts.igPostId, mediaIds)
    });

    console.log(`📊 Found ${existingPosts.length} posts in database\n`);

    if (existingPosts.length === 0) {
      console.log('⚠️  No posts found with the specified media IDs. Please sync Instagram account first.');
      console.log('   Looking for media IDs:', mediaIds.join(', '));
      return;
    }

    // Create a map of mediaId to post
    const postMap = new Map(existingPosts.map(p => [p.igPostId, p]));

    let totalCommentsCreated = 0;
    let commentIndex = 0;

    // Process each test post
    for (const testPost of TEST_POSTS) {
      const post = postMap.get(testPost.mediaId);
      
      if (!post) {
        console.log(`⚠️  Post with media ID ${testPost.mediaId} not found in database, skipping...`);
        continue;
      }

      // Check if comments already exist for this post
      const existingComments = await db.query.comments.findMany({
        where: eq(comments.postId, post.id)
      });

      const commentsToCreate = testPost.expectedComments - existingComments.length;

      if (commentsToCreate <= 0) {
        console.log(
          `  ✅ Post ${testPost.mediaId} already has ${existingComments.length} comments ` +
          `(expected ${testPost.expectedComments}), skipping...`
        );
        continue;
      }

      console.log(
        `📝 Creating ${commentsToCreate} comments for post ${testPost.mediaId} ` +
        `(${existingComments.length} existing, ${testPost.expectedComments} expected)...`
      );

      // Create comments
      for (let i = 0; i < commentsToCreate; i++) {
        const commentText = generateCommentText(commentIndex);
        const username = generateUsername(commentIndex);
        const commenterId = generateCommenterId(commentIndex);
        const igCommentId = `test_comment_${testPost.mediaId}_${commentIndex}_${Date.now()}`;
        
        // Random timestamp within the last 30 days
        const commentedAt = new Date();
        commentedAt.setDate(commentedAt.getDate() - Math.floor(Math.random() * 30));
        commentedAt.setHours(Math.floor(Math.random() * 24));
        commentedAt.setMinutes(Math.floor(Math.random() * 60));

        try {
          await db.insert(comments).values({
            postId: post.id,
            igCommentId: igCommentId,
            text: commentText,
            commenterUsername: username,
            commenterId: commenterId,
            commentedAt: commentedAt,
            parentCommentId: null, // All top-level comments
            isDeleted: false,
            isHidden: false
          });

          totalCommentsCreated++;
          commentIndex++;
          
          console.log(`    ✅ Created comment: "${commentText.substring(0, 40)}..." by @${username}`);
        } catch (error) {
          console.error(`    ❌ Failed to create comment for post ${testPost.mediaId}:`, error);
        }
      }

      console.log(`  ✅ Completed post ${testPost.mediaId}\n`);
    }

    console.log(`\n✅ Successfully created ${totalCommentsCreated} test comments!`);
    console.log('\n📊 Summary:');
    console.log(`   - Posts processed: ${TEST_POSTS.length}`);
    console.log(`   - Posts found: ${existingPosts.length}`);
    console.log(`   - Comments created: ${totalCommentsCreated}`);

    // Show sample of created comments
    const sampleComments = await db.query.comments.findMany({
      where: inArray(comments.postId, existingPosts.map(p => p.id)),
      columns: {
        text: true,
        commenterUsername: true,
        commentedAt: true
      },
      limit: 10,
      orderBy: (comments, { desc }) => [desc(comments.commentedAt)]
    });

    console.log('\n💬 Sample comments:');
    sampleComments.forEach((comment, idx) => {
      const text = comment.text.substring(0, 50);
      const date = comment.commentedAt.toLocaleDateString();
      console.log(
        `   ${idx + 1}. @${comment.commenterUsername}: "${text}..." (${date})`
      );
    });

  } catch (error) {
    console.error('❌ Error creating test comments:', error);
    throw error;
  }
}

// Run the script
createTestComments()
  .then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });

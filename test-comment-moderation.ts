import { db } from './src/db';
import { 
  posts, 
  comments, 
  suspiciousAccounts,
  knownThreatsWatchlist,
  extractedIdentifiers,
  accountCommentMap,
  evidenceAttachments,
  customFilters,
  instagramAccounts,
  moderationLogs
} from './src/db/schema';
import { commentQueue } from './src/queue/commentQueue';
import { moderationService } from './src/services/moderation.service';
import { llmService } from './src/services/llm.service';
// Note: storageService available for future S3 upload tests
// import { storageService } from './src/services/storage.service';
import { CommentCategory, ActionTaken, IdentifierType } from './src/types';
import { eq, and, desc, sql, isNotNull, inArray } from 'drizzle-orm';
// import { randomUUID } from 'crypto';

/**
 * Test script to simulate Instagram webhooks and test comment moderation
 * Uses the current database account and tests various comment scenarios
 */

interface TestComment {
  text: string;
  expectedCategory: CommentCategory;
  description: string;
  commenterId: string;
  commenterUsername: string;
  parentCommentId?: string; // For replies
  isReply?: boolean;
}

class CommentModerationTester {
  private account: any = null;
  private posts: any[] = [];
  private userId: string | null = null;
  private clientId: string | null = null;

  // Test comments covering various scenarios
  private testComments: TestComment[] = [
    // Benign comments
    {
      text: "Love this post! Great content 👏",
      expectedCategory: CommentCategory.BENIGN,
      description: "Positive feedback",
      commenterId: "17841400000000000",
      commenterUsername: "fan_user123"
    },
    {
      text: "This is amazing! Keep up the good work ✨",
      expectedCategory: CommentCategory.BENIGN,
      description: "Encouraging comment",
      commenterId: "17841400000000001",
      commenterUsername: "supporter_456"
    },

    // Spam/Promotional
    {
      text: "Check out my new dropshipping store! Get 50% off everything! www.fake-shop.com",
      expectedCategory: CommentCategory.SPAM,
      description: "Spam advertisement",
      commenterId: "17841400000000002",
      commenterUsername: "spam_bot_789"
    },
    {
      text: "DM me for custom graphics! Professional designer available 24/7 💻",
      expectedCategory: CommentCategory.SPAM,
      description: "Service promotion",
      commenterId: "17841400000000003",
      commenterUsername: "promo_account"
    },

    // Harassment
    {
      text: "You look ugly in this photo. Delete your account loser",
      expectedCategory: CommentCategory.HARASSMENT,
      description: "Personal attack",
      commenterId: "17841400000000004",
      commenterUsername: "troll_123"
    },
    {
      text: "No one cares about your stupid content. Just stop posting",
      expectedCategory: CommentCategory.HARASSMENT,
      description: "Discouraging harassment",
      commenterId: "17841400000000005",
      commenterUsername: "hater_456"
    },

    // Threats
    {
      text: "If you don't pay me I'll expose your secrets to everyone",
      expectedCategory: CommentCategory.THREAT,
      description: "Explicit threat",
      commenterId: "17841400000000006",
      commenterUsername: "extortionist"
    },
    {
      text: "Watch your back. You don't know who you're messing with",
      expectedCategory: CommentCategory.THREAT,
      description: "Implied threat",
      commenterId: "17841400000000007",
      commenterUsername: "threat_guy"
    },

    // Blackmail/Extortion
    {
      text: "Send $500 to my venmo @fakeuser123 or I'll post embarrassing photos",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Payment demand with Venmo",
      commenterId: "17841400000000008",
      commenterUsername: "blackmailer"
    },
    {
      text: "Pay me 0.05 BTC to bc1qfakeaddress or your reputation is ruined",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Cryptocurrency extortion",
      commenterId: "17841400000000009",
      commenterUsername: "btc_extorter"
    },

    // Defamation
    {
      text: "Everyone knows you're a cheater and liar. Your wife should leave you",
      expectedCategory: CommentCategory.DEFAMATION,
      description: "False personal claims",
      commenterId: "17841400000000010",
      commenterUsername: "rumor_spreader"
    },
    {
      text: "You got fired for stealing from your company. That's why you're unemployed",
      expectedCategory: CommentCategory.DEFAMATION,
      description: "False professional claims",
      commenterId: "17841400000000011",
      commenterUsername: "defamer"
    },

    // Nude exposure threats
    {
      text: "If you don't pay me $500 right now, I'll release all your nudes to your followers and family",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Nude exposure blackmail",
      commenterId: "17841400000000012",
      commenterUsername: "nude_blackmailer"
    },
    {
      text: "Remember those private photos you sent me? Send 0.1 BTC or they're going public tonight",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Cryptocurrency nude extortion",
      commenterId: "17841400000000013",
      commenterUsername: "crypto_nude_threat"
    },
    {
      text: "I've got screenshots of your DMs with nudes. Pay up or your reputation is destroyed",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "DM nude exposure threat",
      commenterId: "17841400000000014",
      commenterUsername: "dm_nude_threat"
    },
    {
      text: "Those naked pictures you sent will be posted everywhere unless you transfer money to my venmo",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Venmo nude blackmail",
      commenterId: "17841400000000015",
      commenterUsername: "venmo_nude_extort"
    },

    // Mixed/Edge cases
    {
      text: "Great post! But seriously, send me money via paypal.me/fakeuser or else",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Positive + blackmail",
      commenterId: "17841400000000016",
      commenterUsername: "mixed_threat"
    },
    {
      text: "This is fake news. The government is lying to you all",
      expectedCategory: CommentCategory.BENIGN,
      description: "Political opinion (should be benign)",
      commenterId: "17841400000000017",
      commenterUsername: "conspiracy_theorist"
    },

    // SHARED IDENTIFIER TEST COMMENTS - Same Venmo handle across multiple accounts (for suspicious accounts tracking)
    {
      text: "Send $500 to @venmo-mastermind-123 or I'll expose your secrets",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Account with shared Venmo identifier 1",
      commenterId: "17841400000000018",
      commenterUsername: "shared_venmo_account_1"
    },
    {
      text: "Pay me via venmo @venmo-mastermind-123 or your reputation is ruined",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Account with shared Venmo identifier 2",
      commenterId: "17841400000000019",
      commenterUsername: "shared_venmo_account_2"
    },
    {
      text: "Transfer money to @venmo-mastermind-123 now or I'll post everything",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Account with shared Venmo identifier 3",
      commenterId: "17841400000000020",
      commenterUsername: "shared_venmo_account_3"
    },

    // SUSPICIOUS ACCOUNT TEST - Repeat offender
    {
      text: "Send $300 to my cashapp $repeat-offender-456 or I'll expose you",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Repeat offender - first violation",
      commenterId: "17841400000000021",
      commenterUsername: "repeat_offender"
    },
    {
      text: "Pay me $400 via cashapp $repeat-offender-456 or your secrets go public",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Repeat offender - second violation (should auto-block)",
      commenterId: "17841400000000021",
      commenterUsername: "repeat_offender"
    },

    // WATCHLIST TEST - Account on watchlist
    {
      text: "This is a test comment from a watchlisted account",
      expectedCategory: CommentCategory.BENIGN,
      description: "Watchlisted account comment",
      commenterId: "17841400000000022",
      commenterUsername: "watchlisted_threat"
    },

    // MIXED COMMENTS TEST - Same account with both benign and problematic comments
    {
      text: "Love this post! Great content 👏",
      expectedCategory: CommentCategory.BENIGN,
      description: "Mixed account - benign comment 1",
      commenterId: "17841400000000023",
      commenterUsername: "mixed_account_user"
    },
    {
      text: "This is amazing! Keep up the good work ✨",
      expectedCategory: CommentCategory.BENIGN,
      description: "Mixed account - benign comment 2",
      commenterId: "17841400000000023",
      commenterUsername: "mixed_account_user"
    },
    {
      text: "Send $500 to my venmo @mixed-account-venmo or I'll expose your secrets",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Mixed account - problematic comment (should make account visible)",
      commenterId: "17841400000000023",
      commenterUsername: "mixed_account_user"
    },
    {
      text: "Thanks for sharing this!",
      expectedCategory: CommentCategory.BENIGN,
      description: "Mixed account - benign comment 3 (account should still be visible)",
      commenterId: "17841400000000023",
      commenterUsername: "mixed_account_user"
    }
  ];

  // Test replies - replies to some of the test comments above
  private testReplies: TestComment[] = [
    {
      text: "I totally agree with this!",
      expectedCategory: CommentCategory.BENIGN,
      description: "Reply to benign comment",
      commenterId: "17841400000000024",
      commenterUsername: "reply_user_1",
      isReply: true
    },
    {
      text: "This is also spam! Check my profile for deals!",
      expectedCategory: CommentCategory.SPAM,
      description: "Spam reply to spam comment",
      commenterId: "17841400000000025",
      commenterUsername: "spam_reply_user",
      isReply: true
    },
    {
      text: "You're right, they should pay up or else!",
      expectedCategory: CommentCategory.THREAT,
      description: "Threatening reply to blackmail comment",
      commenterId: "17841400000000026",
      commenterUsername: "threat_reply_user",
      isReply: true
    },
    {
      text: "Send me $200 too via venmo @reply-extorter-789",
      expectedCategory: CommentCategory.BLACKMAIL,
      description: "Blackmail reply to blackmail comment",
      commenterId: "17841400000000027",
      commenterUsername: "blackmail_reply_user",
      isReply: true
    },
    {
      text: "Yeah, they're definitely a liar!",
      expectedCategory: CommentCategory.DEFAMATION,
      description: "Defamatory reply to defamation comment",
      commenterId: "17841400000000028",
      commenterUsername: "defamation_reply_user",
      isReply: true
    }
  ];

  async initialize(): Promise<void> {
    console.log('🔍 Initializing test environment...\n');

    // Get Instagram account (prefer Facebook-connected accounts)
    const accounts = await db.query.instagramAccounts.findMany({
      where: and(
        eq(instagramAccounts.isActive, true),
        isNotNull(instagramAccounts.facebookPageId)
      ),
      limit: 1
    });

    // Fallback to any active account if no Facebook-connected account found
    if (accounts.length === 0) {
      console.warn('⚠️  No Facebook-connected Instagram accounts found, trying any active account...');
      const fallbackAccounts = await db.query.instagramAccounts.findMany({
        where: eq(instagramAccounts.isActive, true),
        limit: 1
      });
      
      if (fallbackAccounts.length === 0) {
        throw new Error('No active Instagram accounts found in database. Please connect an account via Facebook Login first.');
      }
      
      this.account = fallbackAccounts[0];
    } else {
      this.account = accounts[0];
    }

    this.userId = this.account.userId || null;
    this.clientId = this.account.clientId || null;
    
    console.log(`📸 Using Instagram account: @${this.account.username} (${this.account.instagramId})`);
    if (this.userId) {
      console.log(`   User ID: ${this.userId}`);
    }
    if (this.clientId) {
      console.log(`   Client ID: ${this.clientId}`);
    }
    if (!this.userId && !this.clientId) {
      console.warn('   ⚠️  Warning: Account has no userId or clientId. Moderation may fail.');
    }

    // Get posts for this account
    this.posts = await db.query.posts.findMany({
      where: (posts, { eq }) => eq(posts.instagramAccountId, this.account.id),
      limit: 5
    });

    // If no posts exist, create a test post
    if (this.posts.length === 0) {
      console.log('📝 No posts found, creating a test post...\n');

      const [testPost] = await db.insert(posts).values({
        instagramAccountId: this.account.id,
        igPostId: `test_post_${Date.now()}`,
        caption: 'Test post for comment moderation testing',
        postedAt: new Date()
      }).returning();

      this.posts = [testPost];
      console.log(`📝 Created test post: ${testPost.igPostId}\n`);
    } else {
      console.log(`📝 Found ${this.posts.length} posts to test with\n`);
    }
  }

  async testLLMDirectly(): Promise<void> {
    console.log('🤖 Testing Groq LLM Classification Directly\n');
    console.log('─'.repeat(60));

    for (const testComment of this.testComments.slice(0, 5)) { // Test first 5 to avoid rate limits
      try {
        console.log(`💬 Comment: "${testComment.text}"`);
        console.log(`📝 Expected: ${testComment.expectedCategory}`);

        const startTime = Date.now();
        const result = await llmService.classifyComment(testComment.text);
        const duration = Date.now() - startTime;

        console.log(`🤖 LLM Result: ${result.category} (confidence: ${(result.confidence * 100).toFixed(1)}%, severity: ${result.severity})`);
        console.log(`💡 Rationale: ${result.rationale}`);

        if (result.extractedIdentifiers.length > 0) {
          console.log(`🔍 Extracted IDs: ${result.extractedIdentifiers.map(id => `${id.type}: ${id.value}`).join(', ')}`);
        }

        const match = result.category === testComment.expectedCategory ? '✅' : '❌';
        console.log(`${match} Match: ${duration}ms\n`);

      } catch (error) {
        console.error(`❌ LLM test failed for "${testComment.text}":`, error);
      }
    }
  }

  async testFullModerationFlow(): Promise<void> {
    console.log('🔄 Testing Full Moderation Pipeline\n');
    console.log('─'.repeat(60));

    const testPost = this.posts[0]; // Use first post
    console.log(`Using post: ${testPost.caption?.substring(0, 50)}...\n`);

    const storedParentComments: Map<number, string> = new Map(); // Store parent comment IDs for replies

    // First, process all top-level comments
    for (let i = 0; i < this.testComments.length; i++) {
      const testComment = this.testComments[i];
      if (testComment.isReply) continue; // Skip replies for now

      try {
        console.log(`${i + 1}. Testing: ${testComment.description}`);
        console.log(`   Comment: "${testComment.text}"`);

        // Store comment in database first (like webhook handler does)
        const igCommentId = `test_moderation_${Date.now()}_${i}`;
        const [storedComment] = await db.insert(comments).values({
          postId: testPost.id,
          igCommentId: igCommentId,
          text: testComment.text,
          commenterUsername: testComment.commenterUsername,
          commenterId: testComment.commenterId,
          commentedAt: new Date(),
          parentCommentId: null // Top-level comment
        }).returning();

        storedParentComments.set(i, storedComment.id);
        console.log(`   Stored comment in DB: ✅ (ID: ${storedComment.id})`);

        // Now call moderation service
        const result = await moderationService.moderateComment({
          commentId: storedComment.id,
          commentText: testComment.text,
          commenterId: testComment.commenterId,
          commenterUsername: testComment.commenterUsername,
          instagramAccountId: this.account.id,
          postId: testPost.id,
          igCommentId: igCommentId,
          accessToken: this.account.accessToken,
          userId: this.userId || undefined,
          clientId: this.clientId || undefined
        });

        console.log(`   Result: ${result.action}`);
        console.log(`   Category: ${result.llmClassification?.category}`);
        console.log(`   Risk Score: ${result.riskScore}`);
        console.log(`   Confidence: ${(result.llmClassification?.confidence || 0) * 100}%`);

        if (result.identifiers && result.identifiers.length > 0) {
          console.log(`   Extracted: ${result.identifiers.map(id => `${id.type}: ${id.value}`).join(', ')}`);
        }

        const expectedMatch = result.llmClassification?.category === testComment.expectedCategory;
        const actionMatch = this.getExpectedAction(testComment.expectedCategory) === result.action;

        console.log(`   Expected: ${testComment.expectedCategory} → ${this.getExpectedAction(testComment.expectedCategory)}`);
        console.log(`   Got: ${result.llmClassification?.category} → ${result.action}`);
        console.log(`   ${expectedMatch ? '✅' : '❌'} Category Match | ${actionMatch ? '✅' : '❌'} Action Match\n`);

      } catch (error) {
        console.error(`❌ Moderation test failed for "${testComment.description}":`, error);
      }
    }

    // Now process replies - attach them to some parent comments
    console.log('\n💬 Processing Replies...\n');
    const replyIndices = [0, 2, 6, 8, 10]; // Indices of parent comments to attach replies to
    for (let replyIdx = 0; replyIdx < this.testReplies.length && replyIdx < replyIndices.length; replyIdx++) {
      const reply = this.testReplies[replyIdx];
      const parentIndex = replyIndices[replyIdx];
      const parentCommentId = storedParentComments.get(parentIndex);

      if (!parentCommentId) {
        console.log(`   ⚠️  Skipping reply - parent comment not found`);
        continue;
      }

      try {
        console.log(`   Reply ${replyIdx + 1}: "${reply.text}"`);
        console.log(`   → Replying to parent comment ID: ${parentCommentId}`);

        const igReplyId = `test_reply_${Date.now()}_${replyIdx}`;
        const [storedReply] = await db.insert(comments).values({
          postId: testPost.id,
          igCommentId: igReplyId,
          text: reply.text,
          commenterUsername: reply.commenterUsername,
          commenterId: reply.commenterId,
          commentedAt: new Date(),
          parentCommentId: parentCommentId // Link to parent
        }).returning();

        console.log(`   Stored reply in DB: ✅ (ID: ${storedReply.id})`);

        // Moderate the reply - REPLIES GO THROUGH THE SAME LLM MODERATION PIPELINE AS TOP-LEVEL COMMENTS
        // This ensures replies are properly classified, risk-scored, and actioned
        console.log(`   🤖 Running LLM moderation for reply...`);
        const replyResult = await moderationService.moderateComment({
          commentId: storedReply.id,
          commentText: reply.text,
          commenterId: reply.commenterId,
          commenterUsername: reply.commenterUsername,
          instagramAccountId: this.account.id,
          postId: testPost.id,
          igCommentId: igReplyId,
          accessToken: this.account.accessToken,
          userId: this.userId || undefined,
          clientId: this.clientId || undefined
        });

        console.log(`   Reply Result: ${replyResult.action}`);
        console.log(`   Reply Category: ${replyResult.llmClassification?.category}`);
        console.log(`   Reply Risk Score: ${replyResult.riskScore}`);
        console.log(`   ${replyResult.llmClassification?.category === reply.expectedCategory ? '✅' : '❌'} Category Match\n`);

      } catch (error) {
        console.error(`   ❌ Reply moderation failed:`, error);
      }
    }
  }

  private getExpectedAction(category: CommentCategory): ActionTaken {
    switch (category) {
      case CommentCategory.BLACKMAIL:
      case CommentCategory.THREAT:
      case CommentCategory.HARASSMENT:
      case CommentCategory.DEFAMATION:
        return ActionTaken.DELETED;
      case CommentCategory.SPAM:
        return ActionTaken.FLAGGED; // Based on settings
      default:
        return ActionTaken.BENIGN;
    }
  }

  async testQueueProcessing(): Promise<void> {
    console.log('📋 Testing Comment Queue Processing\n');
    console.log('─'.repeat(60));

    const testPost = this.posts[0];
    const testComment = this.testComments[0]; // Use benign comment for queue test

    console.log(`Queueing comment: "${testComment.text}"`);
    console.log(`Post ID: ${testPost.id}`);
    console.log(`Account ID: ${this.account.id}\n`);

    // Store comment first, then queue it
    const queueIgCommentId = `queue_test_${Date.now()}`;
    const [queueComment] = await db.insert(comments).values({
      postId: testPost.id,
      igCommentId: queueIgCommentId,
      text: testComment.text,
      commenterUsername: testComment.commenterUsername,
      commenterId: testComment.commenterId,
      commentedAt: new Date()
    }).returning();

    console.log(`   Stored comment for queue: ✅ (ID: ${queueComment.id})`);

    // Add to queue
    await commentQueue.enqueue('CLASSIFY_COMMENT', {
      commentId: queueComment.id,
      commentText: testComment.text,
      commenterId: testComment.commenterId,
      commenterUsername: testComment.commenterUsername,
      postId: testPost.id,
      instagramAccountId: this.account.id,
      igCommentId: queueIgCommentId,
      accessToken: this.account.accessToken,
      userId: this.userId || undefined,
      clientId: this.clientId || undefined
    });

    console.log('✅ Comment added to queue');

    // Wait a bit for processing
    console.log('⏳ Waiting for queue processing...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const queueStats = commentQueue.getStats();
    console.log(`📊 Queue stats: ${queueStats.processing ? 'Processing' : 'Idle'}, ${queueStats.queueLength} items remaining\n`);
  }

  async runHealthChecks(): Promise<void> {
    console.log('🏥 Running Health Checks\n');
    console.log('─'.repeat(60));

    // LLM Health Check
    try {
      const llmHealth = await llmService.healthCheck();
      console.log(`🤖 Groq LLM: ${llmHealth ? '✅ Healthy' : '❌ Unhealthy'}`);
    } catch (error) {
      console.log(`🤖 Groq LLM: ❌ Error - ${error}`);
    }

    // Database connection
    try {
      await db.execute('SELECT 1');
      console.log('🗄️  Database: ✅ Connected');
    } catch (error) {
      console.log(`🗄️  Database: ❌ Error - ${error}`);
    }

    // Queue status
    const queueStats = commentQueue.getStats();
    console.log(`📋 Queue: ✅ Active (${queueStats.queueLength} queued, ${queueStats.processing ? 'processing' : 'idle'})`);

    console.log();
  }

  /**
   * Set up connections: suspicious accounts, extracted identifiers, and watchlist
   * This demonstrates how comments connect to these systems in the frontend
   */
  async setupConnections(): Promise<void> {
    console.log('🔗 Setting up Suspicious Accounts, Identifiers, and Watchlist Connections\n');
    console.log('─'.repeat(60));

    try {
      // 1. Create a watchlist entry for watchlisted_threat
      console.log('📋 Creating watchlist entry...');
      const [watchlistEntry] = await db.insert(knownThreatsWatchlist).values({
        instagramUsername: 'watchlisted_threat',
        instagramId: '17841400000000022',
        threatType: 'blackmail' as const,
        threatLevel: 'HIGH' as const,
        description: 'Known blackmailer from previous incidents. Auto-block all direct comments.',
        source: 'Previous victim report',
        autoBlockDirectComments: true,
        autoFlagReferences: true,
        isActive: true
      }).returning();
      console.log(`   ✅ Created watchlist entry: ${watchlistEntry.id}\n`);

      // 2. Wait for comments to be processed and suspicious accounts to be created
      console.log('⏳ Waiting for comments to be processed...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // 3. Find suspicious accounts that were created
      const suspiciousAccountsList = await db.query.suspiciousAccounts.findMany({
        where: eq(suspiciousAccounts.instagramAccountId, this.account.id)
      });

      console.log(`   Found ${suspiciousAccountsList.length} suspicious accounts\n`);

      // 4. Create extracted identifiers for accounts with shared Venmo (for suspicious accounts tracking)
      console.log('🔍 Creating extracted identifiers for shared Venmo accounts...');
      const sharedVenmoUsernames = ['shared_venmo_account_1', 'shared_venmo_account_2', 'shared_venmo_account_3'];
      
      for (const username of sharedVenmoUsernames) {
        const suspiciousAccount = suspiciousAccountsList.find(
          sa => sa.commenterUsername === username
        );

        if (suspiciousAccount) {
          // Find comments from this account
          const accountComments = await db.query.comments.findMany({
            where: (comments, { eq, and }) => and(
              eq(comments.commenterId, suspiciousAccount.commenterId),
              eq(comments.commenterUsername, suspiciousAccount.commenterUsername)
            ),
            limit: 1
          });

          if (accountComments.length > 0) {
            // Check if identifier already exists
            const existingId = await db.query.extractedIdentifiers.findFirst({
              where: (ids, { and, eq }) => and(
                eq(ids.suspiciousAccountId, suspiciousAccount.id),
                eq(ids.identifier, 'venmo-mastermind-123')
              )
            });

            if (!existingId) {
              await db.insert(extractedIdentifiers).values({
                commentId: accountComments[0].id,
                suspiciousAccountId: suspiciousAccount.id,
                identifier: 'venmo-mastermind-123',
                identifierType: IdentifierType.VENMO,
                platform: 'venmo',
                normalizedIdentifier: 'venmomastermind123',
                confidence: '0.95',
                source: 'llm_extraction',
                isActive: true
              });
              console.log(`   ✅ Created identifier for @${username}`);
            }
          }
        }
      }

      // 5. Mark repeat_offender as a public threat
      console.log('\n⚠️  Marking repeat offender as public threat...');
      const repeatOffenderAccount = suspiciousAccountsList.find(
        sa => sa.commenterUsername === 'repeat_offender'
      );

      if (repeatOffenderAccount) {
        await db.update(suspiciousAccounts)
          .set({
            isPublicThreat: true,
            publicThreatAt: new Date(),
            publicThreatDescription: 'Repeat blackmail offender with 2+ violations. Auto-blocked after second attempt.'
          })
          .where(eq(suspiciousAccounts.id, repeatOffenderAccount.id));
        console.log(`   ✅ Marked @repeat_offender as public threat`);
      }

      console.log('\n✅ Connection setup complete!');
      console.log('─'.repeat(60));
      console.log('\n📱 Frontend Display:');
      console.log('   • Comments from shared_venmo_account_* will show:');
      console.log('     - "SUSPICIOUS" badge');
      console.log('     - Shared identifiers in Suspicious Accounts detail page');
      console.log('   • Comments from repeat_offender will show:');
      console.log('     - "SUSPICIOUS" badge');
      console.log('     - "PUBLIC THREAT" indicator');
      console.log('   • Comments from watchlisted_threat will show:');
      console.log('     - "WATCHLIST" badge');
      console.log('     - Watchlist entry details');
      console.log('─'.repeat(60) + '\n');

    } catch (error) {
      console.error('❌ Connection setup failed:', error);
      throw error;
    }
  }

  /**
   * Test new suspicious accounts features: comments endpoint, evidence, export
   */
  async testSuspiciousAccountsFeatures(): Promise<void> {
    console.log('🔍 Testing Suspicious Accounts Features\n');
    console.log('─'.repeat(60));

    try {
      // Wait for suspicious accounts to be created
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Find a suspicious account
      const suspiciousAccountsList = await db.query.suspiciousAccounts.findMany({
        where: eq(suspiciousAccounts.instagramAccountId, this.account.id),
        limit: 1
      });

      if (suspiciousAccountsList.length === 0) {
        console.log('⚠️  No suspicious accounts found. Skipping suspicious accounts feature tests.\n');
        return;
      }

      const testAccount = suspiciousAccountsList[0];
      console.log(`📋 Testing with account: @${testAccount.commenterUsername} (${testAccount.id})\n`);

      // 1. Test getAccountComments endpoint structure
      console.log('1️⃣  Testing Comments Endpoint Structure...');
      // First get the comment IDs from accountCommentMap
      const accountCommentMappings = await db.query.accountCommentMap.findMany({
        where: eq(accountCommentMap.suspiciousAccountId, testAccount.id),
        limit: 5
      });

      let accountComments: Array<{
        commentId: string;
        text: string;
        commentedAt: Date;
        isDeleted: boolean | null;
        isHidden: boolean | null;
        category: string | null;
        riskScore: number | null;
      }> = [];

      if (accountCommentMappings.length === 0) {
        console.log('   ⚠️  No comments linked to this suspicious account yet.\n');
      } else {
        const commentIds = accountCommentMappings.map(m => m.commentId);
        
        // Get comments with their moderation logs
        accountComments = await db
          .select({
            commentId: comments.id,
            text: comments.text,
            commentedAt: comments.commentedAt,
            isDeleted: comments.isDeleted,
            isHidden: comments.isHidden,
            category: moderationLogs.category,
            riskScore: moderationLogs.riskScore
          })
          .from(comments)
          .leftJoin(moderationLogs, eq(comments.id, moderationLogs.commentId))
          .where(inArray(comments.id, commentIds))
          .orderBy(desc(comments.commentedAt))
          .limit(5);

        console.log(`   ✅ Found ${accountComments.length} comments linked to account`);
        if (accountComments.length > 0) {
          console.log(`   📝 Sample comment: "${accountComments[0].text.substring(0, 50)}..."`);
          console.log(`   📊 Category: ${accountComments[0].category || 'N/A'}, Risk: ${accountComments[0].riskScore || 'N/A'}`);
        }
        console.log();
      }

      // 2. Test URL Analysis
      console.log('2️⃣  Testing URL Analysis...');
      const testUrls = [
        'https://paypal.me/fakeuser',
        'https://bit.ly/suspicious-link',
        'https://linktr.ee/scammer123',
        'https://www.temu.com/fake-deal'
      ];

      for (const url of testUrls.slice(0, 2)) { // Test 2 to avoid rate limits
        try {
          const analysis = await llmService.analyzeUrl(url);
          console.log(`   🔗 ${url}`);
          console.log(`      Suspicious: ${analysis.isSuspicious ? '✅ YES' : '❌ NO'}`);
          console.log(`      Type: ${analysis.linkType}`);
          console.log(`      Payment Solicitation: ${analysis.containsPaymentSolicitation ? '✅ YES' : '❌ NO'}`);
          console.log(`      Rationale: ${analysis.rationale.substring(0, 60)}...`);
        } catch (error) {
          console.log(`   ❌ URL analysis failed for ${url}: ${error}`);
        }
      }
      console.log();

      // 3. Test Evidence Linking
      console.log('3️⃣  Testing Evidence Linking...');
      if (accountComments.length > 0) {
        const testComment = accountComments[0];
        
        // Check if evidence exists for this comment
        const existingEvidence = await db.query.evidenceAttachments.findMany({
          where: eq(evidenceAttachments.commentId, testComment.commentId)
        });

        console.log(`   📎 Comment has ${existingEvidence.length} evidence file(s)`);
        if (existingEvidence.length > 0) {
          console.log(`   ✅ Evidence linked correctly to comment`);
          existingEvidence.forEach((ev, idx) => {
            console.log(`      ${idx + 1}. ${ev.fileType} - ${ev.fileUrl ? 'Has URL' : 'No URL'}`);
          });
        } else {
          console.log(`   ℹ️  No evidence yet (can be added via frontend)`);
        }
      }
      console.log();

      // 4. Test Extracted Identifiers
      console.log('4️⃣  Testing Extracted Identifiers...');
      const identifiers = await db.query.extractedIdentifiers.findMany({
        where: eq(extractedIdentifiers.suspiciousAccountId, testAccount.id),
        limit: 5
      });

      console.log(`   🔍 Found ${identifiers.length} extracted identifiers`);
      if (identifiers.length > 0) {
        identifiers.forEach((id, idx) => {
          console.log(`      ${idx + 1}. ${id.identifierType}: ${id.identifier} (confidence: ${id.confidence})`);
        });
      }
      console.log();

      // 5. Test Similar Behaviors (if embeddings exist)
      console.log('5️⃣  Testing Similar Behaviors...');
      const commentsWithEmbeddings = await db
        .select({
          id: comments.id,
          text: comments.text
        })
        .from(comments)
        .innerJoin(accountCommentMap, eq(comments.id, accountCommentMap.commentId))
        .where(
          and(
            eq(accountCommentMap.suspiciousAccountId, testAccount.id),
            sql`${comments.embedding} IS NOT NULL`
          )
        )
        .limit(1);

      if (commentsWithEmbeddings.length > 0) {
        console.log(`   ✅ Found ${commentsWithEmbeddings.length} comment(s) with embeddings`);
        console.log(`   📝 Can use embeddings service to find similar patterns`);
      } else {
        console.log(`   ℹ️  No comments with embeddings yet (generated during moderation)`);
      }
      console.log();

      console.log('✅ Suspicious Accounts Features Test Complete!\n');
      console.log('─'.repeat(60));
      console.log('\n💡 Frontend Features to Test:');
      console.log('   1. /client/suspicious-accounts/[id] → Comments tab');
      console.log('   2. /client/suspicious-accounts/[id] → Identifiers tab (with LLM URL analysis)');
      console.log('   3. /client/suspicious-accounts/[id] → Evidence tab (upload & view)');
      console.log('   4. /client/suspicious-accounts/[id] → Patterns tab (similar behaviors)');
      console.log('   5. /client/suspicious-accounts/[id] → Actions tab → Export Report');
      console.log('   6. /client/comments → Table view with all comment details');
      console.log('─'.repeat(60) + '\n');

    } catch (error) {
      console.error('❌ Suspicious accounts features test failed:', error);
    }
  }

  async testCustomFilters(): Promise<void> {
    console.log('🔍 Testing Custom Filters (Global & Account-Specific)...');
    console.log('─'.repeat(60));
    
    try {
      if (!this.account || (!this.userId && !this.clientId)) {
        console.log('   ⚠️  Skipping: No account or user/client ID available');
        return;
      }

      // Build ownership condition
      const ownershipCondition = this.clientId
        ? eq(customFilters.clientId, this.clientId)
        : this.userId
          ? eq(customFilters.userId, this.userId)
          : undefined;

      if (!ownershipCondition) {
        console.log('   ⚠️  Skipping: No ownership condition');
        return;
      }

      // 1. Create a global custom filter
      console.log('1️⃣  Creating Global Custom Filter...');
      const [globalFilter] = await db
        .insert(customFilters)
        .values({
          name: 'Test Global Filter - Brand Mentions',
          prompt: 'Detect any mention of competitor brands or products in comments',
          category: CommentCategory.SPAM,
          description: 'Test filter for detecting brand mentions',
          isEnabled: true,
          instagramAccountId: null, // Global filter
          clientId: this.clientId || undefined,
          userId: this.userId || undefined
        })
        .returning();

      console.log(`   ✅ Created global filter: "${globalFilter.name}" (ID: ${globalFilter.id})`);
      console.log();

      // 2. Create an account-specific custom filter
      console.log('2️⃣  Creating Account-Specific Custom Filter...');
      const [accountFilter] = await db
        .insert(customFilters)
        .values({
          name: 'Test Account Filter - Specific Pattern',
          prompt: 'Detect comments containing specific keywords like "test pattern" or "custom filter test"',
          category: CommentCategory.HARASSMENT,
          description: 'Test account-specific filter',
          isEnabled: true,
          instagramAccountId: this.account.id,
          clientId: this.clientId || undefined,
          userId: this.userId || undefined
        })
        .returning();

      console.log(`   ✅ Created account filter: "${accountFilter.name}" (ID: ${accountFilter.id})`);
      console.log(`   📌 Account: @${this.account.username}`);
      console.log();

      // 3. Test moderation with global filter
      console.log('3️⃣  Testing Moderation with Global Filter...');
      const testCommentGlobal = {
        text: 'Check out our competitor brand product!',
        commenterId: '17841400000000999',
        commenterUsername: 'test_brand_mentioner'
      };

      // Create test comment in database first
      const testPostId = this.posts[0]?.id;
      if (!testPostId) {
        throw new Error('No posts available for testing');
      }

      const [testCommentGlobalDb] = await db.insert(comments).values({
        postId: testPostId,
        igCommentId: `test-ig-comment-global-${Date.now()}`,
        text: testCommentGlobal.text,
        commenterUsername: testCommentGlobal.commenterUsername,
        commenterId: testCommentGlobal.commenterId,
        commentedAt: new Date()
      }).returning();

      const globalResult = await moderationService.moderateComment({
        commentId: testCommentGlobalDb.id,
        commentText: testCommentGlobal.text,
        commenterId: testCommentGlobal.commenterId,
        commenterUsername: testCommentGlobal.commenterUsername,
        postId: testPostId,
        instagramAccountId: this.account.id,
        igCommentId: testCommentGlobalDb.igCommentId ?? undefined,
        accessToken: 'test-token',
        clientId: this.clientId ?? undefined,
        userId: this.userId ?? undefined
      });

      console.log(`   📝 Comment: "${testCommentGlobal.text}"`);
      console.log(`   🏷️  Category: ${globalResult.llmClassification?.category || 'undefined'}`);
      console.log(`   ⚠️  Risk Score: ${globalResult.riskScore || 'undefined'}`);
      console.log(`   ✅ Action: ${globalResult.action || 'undefined'}`);
      if (globalResult.llmClassification?.rationale) {
        console.log(`   💭 Rationale: ${globalResult.llmClassification.rationale.substring(0, 100)}...`);
      }
      console.log();

      // 4. Test moderation with account-specific filter
      console.log('4️⃣  Testing Moderation with Account-Specific Filter...');
      const testCommentAccount = {
        text: 'This is a test pattern for custom filter test',
        commenterId: '17841400000001000',
        commenterUsername: 'test_pattern_user'
      };

      // Create test comment in database first
      const [testCommentAccountDb] = await db.insert(comments).values({
        postId: testPostId,
        igCommentId: `test-ig-comment-account-${Date.now()}`,
        text: testCommentAccount.text,
        commenterUsername: testCommentAccount.commenterUsername,
        commenterId: testCommentAccount.commenterId,
        commentedAt: new Date()
      }).returning();

      const accountResult = await moderationService.moderateComment({
        commentId: testCommentAccountDb.id,
        commentText: testCommentAccount.text,
        commenterId: testCommentAccount.commenterId,
        commenterUsername: testCommentAccount.commenterUsername,
        postId: testPostId,
        instagramAccountId: this.account.id,
        igCommentId: testCommentAccountDb.igCommentId ?? undefined,
        accessToken: 'test-token', // Not used in test mode
        clientId: this.clientId ?? undefined,
        userId: this.userId ?? undefined
      });

      console.log(`   📝 Comment: "${testCommentAccount.text}"`);
      console.log(`   🏷️  Category: ${accountResult.llmClassification?.category || 'undefined'}`);
      console.log(`   ⚠️  Risk Score: ${accountResult.riskScore || 'undefined'}`);
      console.log(`   ✅ Action: ${accountResult.action || 'undefined'}`);
      if (accountResult.llmClassification?.rationale) {
        console.log(`   💭 Rationale: ${accountResult.llmClassification.rationale.substring(0, 100)}...`);
      }
      console.log();

      // 5. Verify filters are being used
      console.log('5️⃣  Verifying Filters in Database...');
      const activeFilters = await db
        .select()
        .from(customFilters)
        .where(
          and(
            ownershipCondition,
            eq(customFilters.isEnabled, true),
            sql`(${customFilters.instagramAccountId} IS NULL OR ${customFilters.instagramAccountId} = ${this.account.id})`
          )
        );

      console.log(`   ✅ Found ${activeFilters.length} active filter(s) for this account:`);
      activeFilters.forEach((filter, idx) => {
        const scope = filter.instagramAccountId ? 'Account-Specific' : 'Global';
        console.log(`      ${idx + 1}. [${scope}] ${filter.name} (${filter.category})`);
      });
      console.log();

      // 6. Cleanup test filters (optional - comment out to keep them)
      console.log('6️⃣  Cleaning up test filters...');
      await db.delete(customFilters).where(
        sql`${customFilters.id} IN (${globalFilter.id}, ${accountFilter.id})`
      );
      console.log('   ✅ Test filters cleaned up');
      console.log();

      console.log('✅ Custom Filters Test Complete!');
      console.log('─'.repeat(60));
      console.log('\n💡 Frontend Features to Test:');
      console.log('   1. /client/settings → Custom Filters tab');
      console.log('   2. Create a global filter and verify it applies to all accounts');
      console.log('   3. Create an account-specific filter and verify it only applies to that account');
      console.log('   4. Test moderation with both filter types');
      console.log('─'.repeat(60) + '\n');

    } catch (error) {
      console.error('❌ Custom filters test failed:', error);
      if (error instanceof Error) {
        console.error('   Error details:', error.message);
        console.error('   Stack:', error.stack);
      }
    }
  }

  /**
   * Test comment handling: show how comments can be hidden/deleted based on moderation rules
   * This demonstrates the action buttons and rules that would appear in the frontend
   */
  async testCommentHandling(): Promise<void> {
    console.log('🎯 Testing Comment Handling (Hide/Delete Based on Rules)\n');
    console.log('─'.repeat(60));

    try {
      // Get some moderated comments with their moderation logs
      if (!this.posts[0]?.id) {
        console.log('   ⚠️  No posts available for testing.\n');
        return;
      }

      // Get all comments for this post
      const allComments = await db.query.comments.findMany({
        where: eq(comments.postId, this.posts[0].id),
        orderBy: desc(comments.commentedAt),
        limit: 20
      });

      if (allComments.length === 0) {
        console.log('   ⚠️  No comments found. Run moderation tests first.\n');
        return;
      }

      // Get moderation logs for these comments
      const commentIds = allComments.map(c => c.id);
      const moderationData = await db.query.moderationLogs.findMany({
        where: sql`${moderationLogs.commentId} IN (${sql.join(commentIds.map(id => sql`${id}`), sql`, `)})`
      });

      // Combine comments with moderation data
      const moderatedComments = allComments.map(comment => {
        const log = moderationData.find(l => l.commentId === comment.id);
        return {
          commentId: comment.id,
          text: comment.text,
          commenterUsername: comment.commenterUsername,
          category: log?.category as string | null,
          riskScore: log?.riskScore || null,
          actionTaken: log?.actionTaken as string | null,
          isDeleted: comment.isDeleted,
          isHidden: comment.isHidden,
          parentCommentId: comment.parentCommentId,
          igCommentId: comment.igCommentId
        };
      }).filter(c => c.category); // Only show comments with moderation logs

      if (moderatedComments.length === 0) {
        console.log('   ⚠️  No moderated comments found. Run moderation tests first.\n');
        return;
      }

      console.log(`📋 Found ${moderatedComments.length} moderated comments\n`);

      // Organize comments by parent (top-level vs replies)
      const topLevelComments = moderatedComments.filter(c => !c.parentCommentId);
      const replyComments = moderatedComments.filter(c => c.parentCommentId);

      console.log(`   📝 Top-level comments: ${topLevelComments.length}`);
      console.log(`   💬 Replies: ${replyComments.length}\n`);

      // Display comments with their handling options
      console.log('📊 Comment Handling Display:\n');

      for (const comment of topLevelComments.slice(0, 5)) {
        const isReply = !!comment.parentCommentId;
        const indent = isReply ? '   ↳ ' : '';

        console.log(`${indent}Comment: "${comment.text.substring(0, 60)}${comment.text.length > 60 ? '...' : ''}"`);
        console.log(`${indent}   👤 @${comment.commenterUsername}`);
        console.log(`${indent}   🏷️  Category: ${comment.category || 'N/A'}`);
        console.log(`${indent}   ⚠️  Risk Score: ${comment.riskScore || 'N/A'}`);
        console.log(`${indent}   ✅ Action Taken: ${comment.actionTaken || 'N/A'}`);
        console.log(`${indent}   📊 Status: ${comment.isDeleted ? '🗑️ DELETED' : comment.isHidden ? '👁️‍🗨️ HIDDEN' : '✅ VISIBLE'}`);

        // Show available actions based on rules
        console.log(`${indent}   🎯 Available Actions:`);
        
        if (comment.isDeleted) {
          console.log(`${indent}      ❌ Cannot act - Comment already deleted`);
        } else if (comment.isHidden) {
          console.log(`${indent}      👁️‍🗨️ Comment is hidden`);
          console.log(`${indent}      🗑️ [DELETE] - Delete comment permanently`);
        } else {
          // Show actions based on category and risk score
          if (comment.category === 'blackmail' || comment.category === 'threat' || comment.category === 'harassment') {
            console.log(`${indent}      🗑️ [DELETE] - High risk, should be deleted`);
            console.log(`${indent}      👁️‍🗨️ [HIDE] - Hide from view (if not auto-deleted)`);
          } else if (comment.category === 'spam' && (comment.riskScore || 0) >= 70) {
            console.log(`${indent}      🗑️ [DELETE] - Spam with high risk score`);
            console.log(`${indent}      👁️‍🗨️ [HIDE] - Hide spam comment`);
          } else if ((comment.riskScore || 0) >= 40) {
            console.log(`${indent}      👁️‍🗨️ [HIDE] - Moderate risk, consider hiding`);
            console.log(`${indent}      🗑️ [DELETE] - Delete if severe`);
          } else {
            console.log(`${indent}      ✅ [ALLOW] - Low risk, no action needed`);
            console.log(`${indent}      👁️‍🗨️ [HIDE] - Optional: Hide if needed`);
          }
        }

        // Show replies for this comment
        const replies = replyComments.filter(r => r.parentCommentId === comment.commentId);
        if (replies.length > 0) {
          console.log(`${indent}   💬 Replies (${replies.length}):`);
          for (const reply of replies.slice(0, 3)) {
            console.log(`${indent}      ↳ "${reply.text.substring(0, 40)}${reply.text.length > 40 ? '...' : ''}"`);
            console.log(`${indent}         👤 @${reply.commenterUsername} | 🏷️ ${reply.category || 'N/A'} | ⚠️ ${reply.riskScore || 'N/A'}`);
            console.log(`${indent}         ${reply.isDeleted ? '🗑️ DELETED' : reply.isHidden ? '👁️‍🗨️ HIDDEN' : '✅ VISIBLE'}`);
            
            if (!reply.isDeleted && !reply.isHidden) {
              if (reply.category === 'blackmail' || reply.category === 'threat' || (reply.riskScore || 0) >= 70) {
                console.log(`${indent}         🎯 [DELETE] or [HIDE] - High risk reply`);
              } else {
                console.log(`${indent}         🎯 [HIDE] - Optional action`);
              }
            }
          }
          if (replies.length > 3) {
            console.log(`${indent}      ... and ${replies.length - 3} more reply(ies)`);
          }
        }

        console.log();
      }

      // Summary of handling rules
      console.log('📋 Comment Handling Rules Summary:\n');
      console.log('   🗑️ DELETE - Use for:');
      console.log('      • Blackmail, Threats, Harassment (auto-deleted if risk ≥ threshold)');
      console.log('      • High-risk spam (risk ≥ 85)');
      console.log('      • Defamation with high severity');
      console.log('      • Comments from watchlisted accounts (if auto-block enabled)');
      console.log();
      console.log('   👁️‍🗨️ HIDE - Use for:');
      console.log('      • Moderate-risk comments (risk 40-70)');
      console.log('      • Spam that doesn\'t meet delete threshold');
      console.log('      • Comments flagged for review');
      console.log('      • Replies to problematic comments');
      console.log();
      console.log('   ✅ ALLOW - Use for:');
      console.log('      • Benign comments (risk < 30)');
      console.log('      • Low-risk spam (risk < 40)');
      console.log('      • Comments that don\'t violate rules');
      console.log();
      console.log('💡 Frontend Implementation:');
      console.log('   • Check /client/comments to see all comments with action buttons');
      console.log('   • Each comment row has [HIDE] and [DELETE] buttons');
      console.log('   • Replies are nested under parent comments');
      console.log('   • Actions are based on moderation rules and risk scores');
      console.log('   • Bulk actions available for selected comments');
      console.log('─'.repeat(60) + '\n');

    } catch (error) {
      console.error('❌ Comment handling test failed:', error);
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🚀 Starting Comment Moderation Test Suite\n');
    console.log('═'.repeat(60));

    try {
      // Enable test mode to skip API calls
      // Enable test mode BEFORE running tests to allow null commentId in logs
      moderationService.setTestMode(true);
      console.log('🔧 Test mode enabled - API calls will be skipped\n');

      await this.initialize();
      await this.runHealthChecks();
      await this.testLLMDirectly();
      await this.testFullModerationFlow();
      await this.testQueueProcessing();
      
      // Wait a bit for all moderation to complete
      console.log('\n⏳ Waiting for moderation processing to complete...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Set up connections after comments are processed
      await this.setupConnections();

      // Test new suspicious accounts features
      await this.testSuspiciousAccountsFeatures();

      // Test custom filters (global and account-specific)
      await this.testCustomFilters();

      // Test comment handling (hide/delete based on rules)
      await this.testCommentHandling();

      console.log('═'.repeat(60));
      console.log('✅ All tests completed successfully!');
      console.log('═'.repeat(60));
      console.log('\n💡 Next Steps:');
      console.log('   1. Check /client/comments to see table view with all comment details');
      console.log('   2. Check /client/suspicious-accounts to see tracked accounts');
      console.log('   3. Click on a suspicious account to see:');
      console.log('      - Comments tab (table of all comments with evidence)');
      console.log('      - Identifiers tab (payment handles, URLs with LLM analysis)');
      console.log('      - Evidence tab (upload/view evidence files)');
      console.log('      - Patterns tab (similar behaviors via embeddings)');
      console.log('      - Export button (generate legal report ZIP)');
      console.log('═'.repeat(60));

    } catch (error) {
      console.error('❌ Test suite failed:', error);
      process.exit(1);
    }
  }
}

// Run the tests
if (require.main === module) {
  const tester = new CommentModerationTester();
  tester.runAllTests().catch(console.error);
}

export default CommentModerationTester;
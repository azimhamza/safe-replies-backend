#!/usr/bin/env tsx

import axios from 'axios';
import crypto from 'crypto';
import { db } from './src/db';
import { posts } from './src/db/schema';

/**
 * Test script to simulate actual Instagram webhook calls
 * Tests the full webhook processing pipeline
 */

interface TestComment {
  text: string;
  expectedCategory: string;
  description: string;
  commenterId: string;
  commenterUsername: string;
}

class WebhookSimulator {
  private account: any = null;
  private posts: any[] = [];
  private baseUrl: string;
  private webhookVerifyToken: string;

  constructor() {
    this.baseUrl = process.env.BACKEND_URL || 'http://localhost:8080';
    this.webhookVerifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'test_verify_token';
  }

  // Test comments - focus on high-risk ones for webhook testing
  private testComments: TestComment[] = [
    {
      text: "Send $200 to my venmo @fakeuser123 or I'll expose your secrets online",
      expectedCategory: "blackmail",
      description: "Venmo blackmail",
      commenterId: "17841400000000001",
      commenterUsername: "blackmail_user1"
    },
    {
      text: "Pay me 0.02 BTC to bc1qfakeaddress1234567890123456789012345678901234567890 or your reputation is ruined",
      expectedCategory: "blackmail",
      description: "Bitcoin extortion",
      commenterId: "17841400000000002",
      commenterUsername: "btc_extorter"
    },
    {
      text: "You think you're safe? Watch your back - I know where you live",
      expectedCategory: "threat",
      description: "Direct threat",
      commenterId: "17841400000000003",
      commenterUsername: "threat_actor"
    },
    {
      text: "DM me for custom graphics and logos! Professional designer available 💻",
      expectedCategory: "spam",
      description: "Service promotion spam",
      commenterId: "17841400000000004",
      commenterUsername: "spam_designer"
    },
    {
      text: "This content is amazing! Keep it up! 🔥",
      expectedCategory: "benign",
      description: "Positive feedback",
      commenterId: "17841400000000005",
      commenterUsername: "fan_account"
    },
    {
      text: "I've got all your nude photos from when we dated. Pay me $1000 in crypto or they're posted publicly",
      expectedCategory: "blackmail",
      description: "Nude photo exposure blackmail",
      commenterId: "17841400000000006",
      commenterUsername: "nude_exposer"
    }
  ];

  async initialize(): Promise<void> {
    console.log('🔍 Initializing webhook simulator...\n');

    // Get Instagram account
    const accounts = await db.query.instagramAccounts.findMany({
      limit: 1
    });

    if (accounts.length === 0) {
      throw new Error('No Instagram accounts found in database. Please connect an account first.');
    }

    this.account = accounts[0];
    console.log(`📸 Using Instagram account: @${this.account.username} (${this.account.instagramId})`);

    // Get posts for this account
    this.posts = await db.query.posts.findMany({
      where: (posts, { eq }) => eq(posts.instagramAccountId, this.account.id),
      limit: 3
    });

    // If no posts exist, create a test post
    if (this.posts.length === 0) {
      console.log('📝 No posts found, creating a test post...');

      const [testPost] = await db.insert(posts).values({
        instagramAccountId: this.account.id,
        igPostId: `test_webhook_post_${Date.now()}`,
        caption: 'Test post for webhook simulation testing',
        postedAt: new Date()
      }).returning();

      this.posts = [testPost];
      console.log(`📝 Created test post: ${testPost.igPostId}`);
    } else {
      console.log(`📝 Found ${this.posts.length} posts to test with`);
    }

    console.log(`🌐 Webhook endpoint: ${this.baseUrl}/api/webhook/instagram\n`);
  }

  private createWebhookSignature(payload: string): string {
    const secret = process.env.INSTAGRAM_WEBHOOK_SECRET || 'test_webhook_secret';
    return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  private createInstagramWebhookPayload(
    commentText: string,
    commenterId: string,
    commenterUsername: string,
    postIgId: string,
    commentIgId: string
  ) {
    return {
      object: "instagram",
      entry: [{
        id: this.account.instagramId,
        time: Date.now(),
        changes: [{
          value: {
            id: commentIgId,
            text: commentText,
            from: {
              id: commenterId,
              username: commenterUsername
            },
            media: {
              id: postIgId,
              media_product_type: "FEED"
            }
          },
          field: "comments"
        }]
      }]
    };
  }

  async testWebhookVerification(): Promise<void> {
    console.log('🔐 Testing Webhook Verification\n');
    console.log('─'.repeat(50));

    try {
      const response = await axios.get(`${this.baseUrl}/api/webhook/instagram`, {
        params: {
          'hub.mode': 'subscribe',
          'hub.verify_token': this.webhookVerifyToken,
          'hub.challenge': 'test_challenge_123'
        }
      });

      if (response.data === 'test_challenge_123') {
        console.log('✅ Webhook verification: PASSED\n');
      } else {
        console.log('❌ Webhook verification: FAILED - Wrong challenge response\n');
      }
    } catch (error: any) {
      console.log(`❌ Webhook verification: FAILED - ${error.response?.status} ${error.response?.statusText}\n`);
    }
  }

  async testCommentWebhooks(): Promise<void> {
    console.log('📨 Testing Comment Webhooks\n');
    console.log('─'.repeat(50));

    const testPost = this.posts[0];
    console.log(`Using post: ${testPost.igPostId}\n`);

    for (let i = 0; i < this.testComments.length; i++) {
      const testComment = this.testComments[i];
      const commentIgId = `test_webhook_${Date.now()}_${i}`;

      console.log(`${i + 1}. ${testComment.description}`);
      console.log(`   Comment: "${testComment.text}"`);

      const payload = this.createInstagramWebhookPayload(
        testComment.text,
        testComment.commenterId,
        testComment.commenterUsername,
        testPost.igPostId,
        commentIgId
      );

      const payloadString = JSON.stringify(payload);
      const signature = this.createWebhookSignature(payloadString);

      try {
        const response = await axios.post(`${this.baseUrl}/api/webhook/instagram`, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature
          },
          timeout: 10000 // 10 second timeout
        });

        console.log(`   Response: ${response.status} ${response.statusText}`);
        console.log(`   Webhook accepted: ✅`);

        // Wait a bit for processing
        console.log(`   Waiting for moderation processing...`);
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if comment was stored
        const storedComment = await db.query.comments.findFirst({
          where: (comments, { eq }) => eq(comments.igCommentId, commentIgId)
        });

        if (storedComment) {
          console.log(`   Comment stored in DB: ✅ (ID: ${storedComment.id})`);

          // Check moderation logs
          const moderationLog = await db.query.moderationLogs.findFirst({
            where: (logs, { eq }) => eq(logs.commentId, storedComment.id)
          });

          if (moderationLog) {
            console.log(`   Moderation completed: ✅`);
            console.log(`   Category: ${moderationLog.category}`);
            console.log(`   Severity: ${moderationLog.severity}`);
            console.log(`   Risk Score: ${moderationLog.riskScore}`);
            console.log(`   Action: ${moderationLog.actionTaken}`);
          } else {
            console.log(`   Moderation log: ❌ (Not found)`);
          }
        } else {
          console.log(`   Comment stored in DB: ❌ (Not found)`);
        }

      } catch (error: any) {
        console.log(`   Response: ${error.response?.status} ${error.response?.statusText || 'Error'}`);
        console.log(`   Webhook rejected: ❌`);
        if (error.response?.data) {
          console.log(`   Error details: ${JSON.stringify(error.response.data)}`);
        }
      }

      console.log();
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🚀 Starting Webhook Simulation Test Suite\n');
    console.log('═'.repeat(60));

    try {
      await this.initialize();
      await this.testWebhookVerification();
      await this.testCommentWebhooks();

      console.log('═'.repeat(60));
      console.log('✅ Webhook simulation tests completed!');
      console.log('═'.repeat(60));
      console.log('\n💡 Check your backend logs for detailed moderation processing');
      console.log('💡 Check database for stored comments and moderation logs');

    } catch (error) {
      console.error('❌ Test suite failed:', error);
      process.exit(1);
    }
  }
}

// Run the webhook simulator
if (require.main === module) {
  const simulator = new WebhookSimulator();
  simulator.runAllTests().catch(console.error);
}

export default WebhookSimulator;
# Comment Moderation Test Scripts

This directory contains test scripts to validate the Instagram comment moderation system, particularly the Groq LLM integration.

## Prerequisites

1. **Database Setup**: Ensure you have a connected Instagram account in the database
2. **Posts Available**: The account should have synced posts
3. **Environment Variables**: Make sure your `.env` file has:
   - `GROQ_API_KEY` - Your Groq API key
   - `INSTAGRAM_WEBHOOK_SECRET` - Webhook secret for signature verification
   - `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` - Webhook verification token

## Test Scripts

### 1. Direct Moderation Testing (`test:moderation`)

**Command:** `npm run test:moderation`

This script tests the moderation pipeline directly without going through webhooks. It:
- ✅ Tests Groq LLM classification directly
- ✅ Tests the full moderation pipeline (LLM + risk scoring + action determination)
- ✅ Tests comment queue processing
- ✅ Runs health checks

**What it tests:**
- Various comment types (benign, spam, harassment, threats, blackmail, defamation)
- LLM classification accuracy
- Risk scoring calculations
- Action determination logic
- Queue processing

### 2. Webhook Simulation (`test:webhooks`)

**Command:** `npm run test:webhooks`

This script simulates actual Instagram webhook calls to test the full integration. It:
- ✅ Tests webhook verification endpoint
- ✅ Sends realistic Instagram webhook payloads
- ✅ Tests full comment processing pipeline
- ✅ Verifies database storage and moderation logs

**What it tests:**
- Webhook signature verification
- Comment storage in database
- Queue processing via webhooks
- Moderation log creation
- Evidence record storage

## Test Comment Scenarios

The scripts test these comment categories:

| Category | Example | Expected Action |
|----------|---------|-----------------|
| **Benign** | "Love this post! Great content 👏" | Allow (BENIGN) |
| **Spam** | "Check out my store! 50% off everything!" | Flag (FLAGGED) |
| **Harassment** | "You look ugly. Delete your account loser" | Delete (DELETED) |
| **Threat** | "Watch your back. You don't know who you're messing with" | Delete (DELETED) |
| **Blackmail** | "Send $500 to my venmo or I'll expose you" | Delete (DELETED) |
| **Defamation** | "Everyone knows you're a cheater and liar" | Delete (DELETED) |

## Running the Tests

1. **Start the backend server:**
   ```bash
   npm run dev
   ```

2. **In a new terminal, run the moderation test:**
   ```bash
   npm run test:moderation
   ```

3. **In another terminal, run the webhook simulation:**
   ```bash
   npm run test:webhooks
   ```

## Understanding Test Output

### Direct Moderation Test Output
```
🤖 Testing Groq LLM Classification Directly
─
💬 Comment: "Send $200 to my venmo @fakeuser123 or I'll expose your secrets"
📝 Expected: blackmail
🤖 LLM Result: blackmail (confidence: 95.2%, severity: 85)
💡 Rationale: This comment contains a blackmail threat with a payment demand
🔍 Extracted IDs: venmo: @fakeuser123
✅ Match: 1250ms
```

### Webhook Simulation Output
```
📨 Testing Comment Webhooks
─
1. Venmo blackmail
   Comment: "Send $200 to my venmo @fakeuser123 or I'll expose your secrets"
   Response: 200 OK
   Webhook accepted: ✅
   Comment stored in DB: ✅ (ID: 123e4567-e89b-12d3-a456-426614174000)
   Moderation completed: ✅
   Category: blackmail
   Severity: 85
   Risk Score: 95
   Action: DELETED
```

## Troubleshooting

### No Instagram Accounts Found
```
❌ No Instagram accounts found in database. Please connect an account first.
```
**Solution:** Use the frontend to connect an Instagram account first.

### No Posts Found
```
❌ No posts found for this account. Please sync posts first.
```
**Solution:** Use the Instagram sync endpoint or frontend to sync posts.

### Webhook Verification Failed
```
❌ Webhook verification: FAILED - 403 Forbidden
```
**Solution:** Check your `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` environment variable.

### LLM Classification Failed
```
❌ LLM test failed: API key invalid
```
**Solution:** Check your `GROQ_API_KEY` environment variable.

## Expected Behavior

- **Benign comments**: Should be allowed with low risk scores
- **Spam comments**: Should be flagged but not auto-deleted (based on default settings)
- **Harmful comments** (harassment, threats, blackmail, defamation): Should be auto-deleted with high risk scores
- **All comments**: Should be classified by LLM with confidence scores and rationales
- **Identifiers**: Payment methods, usernames, emails should be extracted

## Database Changes

After running tests, you'll see:
- New comments in the `comments` table
- Moderation logs in the `moderation_logs` table
- Evidence records in the `evidence_records` table
- Updated suspicious accounts tracking

## Performance Expectations

- LLM classification: ~500-2000ms per comment
- Full moderation pipeline: ~1000-3000ms per comment
- Webhook processing: Should complete within webhook timeout limits

## Next Steps

After validating the tests work correctly:
1. Monitor real Instagram webhooks in production
2. Adjust moderation settings based on test results
3. Fine-tune risk scoring thresholds
4. Add more test cases for edge cases
# Testing New Features: URL Analysis & Similar Behaviors

## Prerequisites

1. Ensure you have a `.env` file with:
   - `GROQ_API_KEY` - for LLM URL analysis
   - `JINA_API_KEY` - for embeddings (if testing similar behaviors)
   - Database connection configured

2. Build the backend:
   ```bash
   cd backend
   npm run build
   ```

## Test 1: URL Analysis

Tests the LLM-based URL classification for phishing, scams, payment solicitation, etc.

```bash
cd backend
npx tsx test-url-analysis.ts
```

**What it tests:**
- Various URL types (legitimate, phishing, payment, shopping scams)
- LLM classification accuracy
- Caching performance (2nd call should be much faster)

**Expected output:**
- Each URL classified as suspicious or safe
- Link type identified (phishing, scam, payment_solicitation, etc.)
- Rationale from LLM
- Cache performance improvement on repeat calls

## Test 2: Similar Behaviors

Tests the embeddings-based similarity search for detecting behavior patterns across accounts.

```bash
cd backend
npx tsx test-similar-behaviors.ts
```

**What it tests:**
- Finding similar comments from different accounts using embeddings
- Grouping patterns by category (harassment, spam, blackmail, etc.)
- Network risk level calculation
- Privacy: only shows stats, not actual comment content from other creators

**Expected output:**
- List of similar comments found for test account
- Similarity scores
- Accounts grouped by behavior pattern category
- Network risk level (LOW/MEDIUM/HIGH/CRITICAL)

**Note**: This test requires:
- At least one suspicious account with comments
- Comments must have embeddings generated (run embeddings generation service first)

## API Endpoints

### Get Extracted Identifiers (with URL analysis)
```bash
GET /api/suspicious-accounts/:id/identifiers
```

Returns:
- `paymentHandles`: Venmo, CashApp, crypto addresses, etc.
- `contactInfo`: Email, phone numbers
- `scamLinks`: Only URLs flagged as suspicious by LLM (phishing, scam, payment solicitation)

### Get Network Activity
```bash
GET /api/suspicious-accounts/:id/network-activity
```

Returns:
- How many creators have flagged this account
- List of creator usernames
- Total violations across network
- Network risk level

### Get Similar Behaviors
```bash
GET /api/suspicious-accounts/:id/similar-behaviors
```

Returns:
- Count of accounts with similar behavior patterns
- Behavior patterns grouped by category
- Similarity scores
- Example comments from THIS account only (privacy-preserving)
- Network risk level

## Frontend Testing

1. Start the backend:
   ```bash
   cd backend
   npm run dev
   ```

2. Start the frontend:
   ```bash
   cd frontend
   npm run dev
   ```

3. Navigate to a suspicious account detail page:
   - Go to `/client/suspicious-accounts`
   - Click on any account
   - Check the new tabs:
     - **Identifiers**: Should show payment handles, suspicious links (with LLM analysis)
     - **Network**: Should show cross-creator activity stats
     - **Patterns**: Should show similar behavior patterns (if embeddings exist)

## Troubleshooting

### "No embeddings found"
- Run the embeddings generation service to populate embeddings for existing comments
- Embeddings are generated automatically during moderation for new comments

### "LLM analysis failed"
- Check `GROQ_API_KEY` is set correctly in `.env`
- Check API rate limits
- LLM failures default to marking URLs as safe (conservative approach)

### "No similar behaviors detected"
- Ensure comments have embeddings generated
- Try lowering the similarity threshold (currently 0.75)
- May indicate this account's behavior is unique

## Performance Notes

- **URL Analysis**: Cached for 24 hours (in-memory)
- **Similar Behaviors**: Uses pgvector for efficient similarity search
- Both features are optimized for production use

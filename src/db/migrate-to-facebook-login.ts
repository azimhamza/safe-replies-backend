/**
 * Migration script for Facebook Login integration
 * 
 * This script prepares the database for the new Facebook Login authentication method.
 * 
 * Steps:
 * 1. The new tables (facebook_pages, page_instagram_connections) are defined in schema.ts
 * 2. The instagram_accounts table has been updated with facebookPageId field
 * 3. Existing Instagram accounts will need to be re-authenticated via Facebook Login
 * 
 * To apply these changes:
 * 
 * 1. Generate migration files:
 *    ```
 *    pnpm drizzle-kit generate
 *    ```
 * 
 * 2. Review the generated migration in ./drizzle folder
 * 
 * 3. Apply the migration:
 *    ```
 *    pnpm drizzle-kit push
 *    ```
 *    OR if you prefer manual control:
 *    ```
 *    pnpm drizzle-kit migrate
 *    ```
 * 
 * 4. Mark existing Instagram accounts for re-authentication:
 *    ```
 *    node -r esbuild-register src/db/mark-accounts-for-reauth.ts
 *    ```
 * 
 * IMPORTANT NOTES:
 * - Existing Instagram accounts will need to reconnect via Facebook Login
 * - The old Instagram OAuth endpoints are deprecated but temporarily available
 * - Page tokens from Facebook Login provide more reliable comment access
 * - All existing accessToken values in instagram_accounts will become legacy fallbacks
 */

import { db } from './index';
import { instagramAccounts } from './schema';
import { sql } from 'drizzle-orm';

async function markAccountsForReauth() {
  try {
    console.log('🔄 Marking existing Instagram accounts for re-authentication...');
    
    // Set isActive = false for all existing accounts that don't have a facebookPageId
    const result = await db
      .update(instagramAccounts)
      .set({
        isActive: false
      })
      .where(sql`${instagramAccounts.facebookPageId} IS NULL AND ${instagramAccounts.accessToken} IS NOT NULL`)
      .returning();

    console.log(`✅ Marked ${result.length} account(s) as inactive. Users will need to reconnect via Facebook Login.`);
    console.log('');
    console.log('Next steps for users:');
    console.log('1. Go to Connect Instagram page');
    console.log('2. Click "Connect via Facebook Login"');
    console.log('3. Authorize with Facebook and select their Page');
    console.log('4. The system will automatically link to their Instagram Business account');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  markAccountsForReauth();
}

export { markAccountsForReauth };

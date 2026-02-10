import { db } from './src/db';
import { instagramAccounts } from './src/db/schema';

async function checkAccounts() {
  console.log('🔍 Checking Instagram accounts in database...\n');

  try {
    const accounts = await db.select().from(instagramAccounts);

    console.log(`Found ${accounts.length} total Instagram accounts:`);

    accounts.forEach((acc, index) => {
      console.log(`${index + 1}. Username: @${acc.username}`);
      console.log(`   ID: ${acc.id}`);
      console.log(`   User ID: ${acc.userId}`);
      console.log(`   Active: ${acc.isActive}`);
      console.log(`   Account Type: ${acc.accountType}`);
      console.log(`   Instagram ID: ${acc.instagramId}`);
      console.log(`   Created: ${acc.createdAt}`);
      console.log('   ---');
    });

    // Check for active accounts specifically
    const activeAccounts = accounts.filter(acc => acc.isActive);
    console.log(`\nActive accounts: ${activeAccounts.length}`);

    if (activeAccounts.length === 0) {
      console.log('❌ No active Instagram accounts found!');
    } else {
      console.log('✅ Active accounts found:');
      activeAccounts.forEach(acc => {
        console.log(`   - @${acc.username} (User: ${acc.userId})`);
      });
    }

  } catch (error) {
    console.error('❌ Error checking accounts:', error);
  }
}

checkAccounts();
/**
 * Script to run the follower_history migration (0018)
 */

import * as dotenv from 'dotenv';
import { db } from './src/db';
import { sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

async function runMigration(): Promise<void> {
  try {
    console.log('🔄 Running follower_history migration (0018)...\n');

    // Read the migration file
    const migrationPath = path.join(__dirname, 'drizzle', '0018_add_follower_history.sql');

    if (!fs.existsSync(migrationPath)) {
      console.error(`❌ Migration file not found: ${migrationPath}`);
      process.exit(1);
    }

    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');

    // Split by statement breakpoint (if any) or by semicolons
    const statements = migrationSQL
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`📝 Found ${statements.length} SQL statement(s) to execute\n`);

    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      try {
        console.log(`  [${i + 1}/${statements.length}] Executing statement...`);
        // Log first 100 chars of statement for visibility
        const preview = statement.substring(0, 100).replace(/\n/g, ' ');
        console.log(`      ${preview}...`);

        await db.execute(sql.raw(statement));
        console.log(`      ✅ Success\n`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Some errors are expected (like column already exists)
        if (
          errorMessage.includes('already exists') ||
          errorMessage.includes('duplicate') ||
          errorMessage.includes('does not exist')
        ) {
          console.log(`      ⚠️  Skipped (${errorMessage.split('\n')[0]})\n`);
        } else {
          console.error(`      ❌ Error: ${errorMessage}\n`);
          throw error;
        }
      }
    }

    console.log('✅ Migration completed successfully!');
    console.log('\n📊 Migration Summary:');
    console.log('   - Created follower_history table');
    console.log('   - Added indexes for performance:');
    console.log('     * idx_follower_history_ig_account');
    console.log('     * idx_follower_history_fb_page');
    console.log('     * idx_follower_history_recorded_at');
    console.log('     * idx_follower_history_source_recorded');
    console.log('   - Added foreign key constraints');
    console.log('   - Added check constraint for account reference');
  } catch (error: unknown) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Run the migration
runMigration()
  .then(() => {
    console.log('\n✅ Migration script completed successfully!');
    console.log('\n🚀 Next steps:');
    console.log('   1. The follower tracking cron will start automatically when backend starts');
    console.log('   2. Follower counts will be tracked hourly');
    console.log('   3. Visit the client details page to see growth metrics');
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('\n❌ Migration script failed:', error);
    process.exit(1);
  });

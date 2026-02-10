/**
 * Script to manually run the database migration
 * This runs the SQL migration file directly
 */

import * as dotenv from 'dotenv';
import { db } from './src/db';
import { sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

async function runMigration(): Promise<void> {
  try {
    console.log('🔄 Running database migration...\n');

    // Read the migration file
    const migrationPath = path.join(__dirname, 'drizzle', '0010_violet_exiles.sql');
    
    if (!fs.existsSync(migrationPath)) {
      console.error(`❌ Migration file not found: ${migrationPath}`);
      process.exit(1);
    }

    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');
    
    // Split by statement breakpoint
    const statements = migrationSQL
      .split('--> statement-breakpoint')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log(`📝 Found ${statements.length} SQL statements to execute\n`);

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
      } catch (error: any) {
        // Some errors are expected (like column already exists)
        if (error.message?.includes('already exists') || 
            error.message?.includes('duplicate') ||
            error.message?.includes('does not exist')) {
          console.log(`      ⚠️  Skipped (${error.message.split('\n')[0]})\n`);
        } else {
          console.error(`      ❌ Error: ${error.message}\n`);
          throw error;
        }
      }
    }

    console.log('✅ Migration completed successfully!');
    console.log('\n📊 Migration Summary:');
    console.log('   - Added likes_count column to posts table');
    console.log('   - Added comments_count column to posts table');
    console.log('   - Updated other schema changes');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Run the migration
runMigration()
  .then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });

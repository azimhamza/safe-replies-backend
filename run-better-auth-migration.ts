import { db } from './src/db/index';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration(): Promise<void> {
  try {
    console.log('🔄 Running better-auth migration...');

    // Read the migration SQL file
    const migrationSql = readFileSync(
      resolve(__dirname, 'src/db/migrations/create-better-auth-tables.sql'),
      'utf-8'
    );

    // Execute the migration
    await db.execute(sql.raw(migrationSql));

    console.log('✅ Better-auth tables created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();

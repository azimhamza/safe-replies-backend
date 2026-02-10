import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';

async function checkTables(): Promise<void> {
  const result = await db.execute(sql`
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  console.log('All tables:');
  (result.rows as {tablename: string}[]).forEach((row) => {
    console.log('-', row.tablename);
  });

  process.exit(0);
}

checkTables().catch(console.error);

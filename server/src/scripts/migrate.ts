import 'dotenv/config';
import { loadConfig } from '../config.js';
import { AdminDb } from '../db/adminDb.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new AdminDb(config.adminDatabaseUrl);
  const applied = await db.migrate();
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No new migrations');
  await db.close();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

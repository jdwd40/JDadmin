import 'dotenv/config';
import { AuthService } from '../core/auth.js';
import { loadConfig } from '../config.js';
import { AdminDb } from '../db/adminDb.js';

/**
 * Creates the first (or an additional) admin user. No public registration
 * exists; this script is the only way to provision admin credentials.
 * Usage:
 *   ADMIN_BOOTSTRAP_USERNAME=admin ADMIN_BOOTSTRAP_PASSWORD='...' npm run create-admin
 */
async function main(): Promise<void> {
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    console.error('Set ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters');
    process.exit(1);
  }
  const config = loadConfig();
  const db = new AdminDb(config.adminDatabaseUrl);
  await db.migrate();
  const auth = new AuthService(db, config);
  const existing = await auth.findUserByUsername(username);
  if (existing) {
    console.error(`Admin user '${username}' already exists (id=${existing.id})`);
    await db.close();
    process.exit(1);
  }
  const user = await auth.createUser(username, password);
  console.log(`Created admin user '${user.username}' (id=${user.id})`);
  await db.close();
}

main().catch((err) => {
  console.error('create-admin failed:', err.message);
  process.exit(1);
});

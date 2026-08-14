import 'dotenv/config';
import { AdapterRegistry } from './adapters/registry.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AdminDb } from './db/adminDb.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const adminDb = new AdminDb(config.adminDatabaseUrl);
  const applied = await adminDb.migrate();
  if (applied.length) console.log(`[jdadmin] applied migrations: ${applied.join(', ')}`);

  const registry = await AdapterRegistry.build({
    ...config,
    enableMock: process.env.JDADMIN_ENABLE_MOCK === 'true' && config.nodeEnv !== 'production',
  });
  for (const app of registry.list()) {
    console.log(
      `[jdadmin] app ${app.id}: ${app.available ? 'available' : `UNAVAILABLE (${app.availabilityError})`}`,
    );
  }

  const { app } = buildApp({ config, adminDb, registry });
  const server = app.listen(config.port, () => {
    console.log(`[jdadmin] listening on http://localhost:${config.port} (${config.nodeEnv})`);
    console.log(`[jdadmin] destructive actions: ${config.destructiveEnabled ? 'ENABLED' : 'disabled'}`);
  });

  const shutdown = async () => {
    server.close();
    await registry.close();
    await adminDb.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[jdadmin] fatal startup error:', err.message);
  process.exit(1);
});

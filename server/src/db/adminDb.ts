import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient, QueryResultRow } from 'pg';

export class AdminDb {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(migrationsDir = path.join(__dirname, '..', '..', 'migrations')): Promise<string[]> {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    await this.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied: string[] = [];
    for (const file of files) {
      const seen = await this.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (seen.rowCount) continue;
      const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
      await this.transaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      });
      applied.push(file);
    }
    return applied;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

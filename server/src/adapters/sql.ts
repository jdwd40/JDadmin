import { Pool, PoolClient, QueryResultRow } from 'pg';
import type { ListQuery } from './types.js';

/** Shared lazily-created pg pool wrapper for app adapters. */
export class AppPool {
  private pool: Pool | null = null;

  constructor(private readonly connectionString: string) {}

  get(): Pool {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.connectionString, max: 5 });
    }
    return this.pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.get().query<T>(text, params);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.get().connect();
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

  async transactionAsPlayer<T>(playerId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(playerId)) {
      throw new TypeError('playerId must be a PostgreSQL UUID');
    }
    const client = await this.get().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [playerId]);
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

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

/**
 * Build a safe ORDER BY clause. `allowed` maps public sort keys to static SQL
 * column expressions; anything else falls back to the default key.
 * Identifiers never come from request input.
 */
export function orderByClause(
  query: ListQuery,
  allowed: Record<string, string>,
  defaultKey: string,
): string {
  const key = query.sort && allowed[query.sort] ? query.sort : defaultKey;
  const dir = query.order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${allowed[key]} ${dir}`;
}

export function pageClause(query: ListQuery, params: unknown[]): string {
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  return `LIMIT $${params.length - 1} OFFSET $${params.length}`;
}

export const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

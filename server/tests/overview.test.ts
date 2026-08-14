import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrlFor, COINS_SCHEMA, createHarness, TestHarness } from './helpers.js';

describe('overview endpoints', () => {
  let h: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    h = await createHarness({ withCoins: true, withDwarf: true });
    ({ cookie } = await h.login());
  });

  afterAll(async () => {
    await h.cleanup();
  });

  /**
   * Issue #17 regression: COINS_SCHEMA_SQL is production-shaped — transactions
   * has created_at and NO transaction_date. Any adapter reference to the
   * obsolete transaction_date column (overview ORDER BY, list sort, row
   * mapping) fails this suite with a PostgreSQL undefined-column error.
   */
  it('returns the complete Coins overview for the production-shaped schema', async () => {
    const res = await request(h.app).get('/api/apps/coins/overview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      users: 2,
      assets: 2,
      transactions: 2,
      totalBalance: 3000,
    });
    expect(res.body.assetsSparkline).toEqual([
      { assetId: '1', symbol: 'ALPHA', latestPrice: 10, points: [9, 9.5, 10] },
      { assetId: '2', symbol: 'BETA', latestPrice: 20, points: [19, 20] },
    ]);
    expect(res.body.recentTransactions).toHaveLength(2);
    expect(res.body.recentTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: '1', assetId: '1', assetSymbol: 'ALPHA', type: 'buy' }),
        expect.objectContaining({ userId: '2', assetId: '2', assetSymbol: 'BETA', type: 'buy' }),
      ]),
    );
    // Every recent transaction must carry a real ISO timestamp from created_at
    // (reading the obsolete transaction_date yields an invalid date / 500).
    for (const tx of res.body.recentTransactions as Array<{ createdAt: unknown }>) {
      expect(typeof tx.createdAt).toBe('string');
      expect(new Date(tx.createdAt as string).toISOString()).toBe(tx.createdAt);
    }
  });

  it('returns a useful zero-data Coins overview', async () => {
    const empty = await createHarness({ withCoins: true });
    const session = await empty.login();
    const client = new pg.Client(adminUrlFor(empty.dbName));
    await client.connect();
    await client.query(`DELETE FROM ${COINS_SCHEMA}.price_history`);
    await client.query(`DELETE FROM ${COINS_SCHEMA}.transactions`);
    await client.query(`DELETE FROM ${COINS_SCHEMA}.portfolios`);
    await client.query(`DELETE FROM ${COINS_SCHEMA}.users`);
    await client.query(`DELETE FROM ${COINS_SCHEMA}.coins`);
    await client.end();

    try {
      const res = await request(empty.app).get('/api/apps/coins/overview').set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        users: 0,
        assets: 0,
        transactions: 0,
        totalBalance: null,
        assetsSparkline: [],
        recentTransactions: [],
      });
    } finally {
      await empty.cleanup();
    }
  });

  it('keeps the Dwarf overview available', async () => {
    const res = await request(h.app).get('/api/apps/dwarf/overview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ users: 1, assets: 1, transactions: 1, totalBalance: 777 });
  });
});

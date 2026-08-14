import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrlFor, COINS_SCHEMA, createHarness, TestHarness } from './helpers.js';

describe('inventory + transactions (Coins adapter)', () => {
  let h: TestHarness;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    h = await createHarness({ withCoins: true, withDwarf: true });
    ({ cookie, csrf } = await h.login());
  });

  afterAll(async () => {
    await h.cleanup();
  });

  const authed = (r: request.Test) => r.set('Cookie', cookie).set('X-CSRF-Token', csrf);

  it('lists inventory for a user with asset join', async () => {
    const res = await request(h.app).get('/api/apps/coins/inventory?userId=1').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].assetSymbol).toBe('ALPHA');
    expect(res.body.items[0].quantity).toBe(5);
  });

  it('creates, updates and deletes inventory', async () => {
    const created = await authed(request(h.app).post('/api/apps/coins/inventory')).send({
      userId: '2',
      assetId: '1',
      quantity: 4,
      averagePrice: 10.25,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const updated = await authed(request(h.app).patch(`/api/apps/coins/inventory/${id}`)).send({ quantity: 7 });
    expect(updated.status).toBe(200);
    expect(updated.body.quantity).toBe(7);

    const del = await authed(request(h.app).delete(`/api/apps/coins/inventory/${id}`));
    expect(del.status).toBe(200);
    const gone = await request(h.app).get('/api/apps/coins/inventory?userId=2&assetId=1').set('Cookie', cookie);
    expect(gone.body.total).toBe(0);
  });

  it('rejects duplicate holding create with 409', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/inventory')).send({
      userId: '1',
      assetId: '1',
      quantity: 1,
    });
    expect(res.status).toBe(409);
  });

  it('Dwarf inventory create is unsupported (403 UNSUPPORTED_CAPABILITY)', async () => {
    const res = await authed(request(h.app).post('/api/apps/dwarf/inventory')).send({
      userId: '11111111-1111-1111-1111-111111111111',
      assetId: '22222222-2222-2222-2222-222222222222',
      quantity: 1,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('creates a BUY transaction with consistent funds + portfolio update', async () => {
    // bob: funds 2500, no ALPHA holding
    const res = await authed(request(h.app).post('/api/apps/coins/transactions')).send({
      userId: '2',
      assetId: '1',
      type: 'buy',
      quantity: 10,
      price: 10,
    });
    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe(100);

    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const funds = await client.query<{ funds: string }>(`SELECT funds::text FROM ${COINS_SCHEMA}.users WHERE user_id = 2`);
    const holding = await client.query<{ quantity: string }>(
      `SELECT quantity::text FROM ${COINS_SCHEMA}.portfolios WHERE user_id = 2 AND coin_id = 1`,
    );
    await client.end();
    expect(Number(funds.rows[0]!.funds)).toBe(2400);
    expect(Number(holding.rows[0]!.quantity)).toBe(10);
  });

  it('rolls back a BUY with insufficient funds (no partial writes)', async () => {
    const before = await request(h.app).get('/api/apps/coins/users/2').set('Cookie', cookie);
    const beforeFunds = before.body.balance;
    const beforeTx = await request(h.app).get('/api/apps/coins/transactions?userId=2').set('Cookie', cookie);
    const beforeCount = beforeTx.body.total;

    const res = await authed(request(h.app).post('/api/apps/coins/transactions')).send({
      userId: '2',
      assetId: '2',
      type: 'buy',
      quantity: 100000,
      price: 100,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    const after = await request(h.app).get('/api/apps/coins/users/2').set('Cookie', cookie);
    const afterTx = await request(h.app).get('/api/apps/coins/transactions?userId=2').set('Cookie', cookie);
    expect(after.body.balance).toBe(beforeFunds);
    expect(afterTx.body.total).toBe(beforeCount);
  });

  it('rolls back a SELL with insufficient holdings', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/transactions')).send({
      userId: '2',
      assetId: '2',
      type: 'sell',
      quantity: 999,
      price: 20,
    });
    expect(res.status).toBe(409);
  });

  it('SELL with sufficient holdings credits funds', async () => {
    // bob holds 3 BETA at 18 avg; sell 2 @ 20 → +40
    const res = await authed(request(h.app).post('/api/apps/coins/transactions')).send({
      userId: '2',
      assetId: '2',
      type: 'sell',
      quantity: 2,
      price: 20,
    });
    expect(res.status).toBe(201);
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const holding = await client.query<{ quantity: string }>(
      `SELECT quantity::text FROM ${COINS_SCHEMA}.portfolios WHERE user_id = 2 AND coin_id = 2`,
    );
    await client.end();
    expect(Number(holding.rows[0]!.quantity)).toBe(1);
  });

  it('transactions update/delete are not exposed (404) and capability flags are false', async () => {
    const patch = await authed(request(h.app).patch('/api/apps/coins/transactions/1')).send({ quantity: 1 });
    expect(patch.status).toBe(404);
    const apps = await request(h.app).get('/api/apps').set('Cookie', cookie);
    const coins = apps.body.apps.find((a: { id: string }) => a.id === 'coins');
    expect(coins.capabilities.transactions.update).toBe(false);
    expect(coins.capabilities.transactions.delete).toBe(false);
  });
});

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrlFor, COINS_SCHEMA, createHarness, TestHarness } from './helpers.js';

describe('price history (Coins adapter)', () => {
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

  it('lists price history with asset filter and pagination', async () => {
    const res = await request(h.app)
      .get('/api/apps/coins/price-history?assetId=1&page=1&pageSize=2')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(2);
    // newest first
    expect(res.body.items[0].price).toBe(10);
  });

  it('filters by date range', async () => {
    const res = await request(h.app)
      .get('/api/apps/coins/price-history?assetId=1&from=2026-01-02T00:00:00Z&to=2026-01-02T23:59:59Z')
      .set('Cookie', cookie);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].price).toBe(9.5);
  });

  it('returns per-asset stats', async () => {
    const res = await request(h.app).get('/api/apps/coins/price-history/stats').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const alpha = res.body.stats.find((s: { assetSymbol: string }) => s.assetSymbol === 'ALPHA');
    expect(alpha.count).toBe(3);
    expect(alpha.min).toBe(9);
    expect(alpha.max).toBe(10);
    expect(alpha.avg).toBeCloseTo(9.5, 5);
  });

  it('counts rows before delete-range; requires confirm=true', async () => {
    const count = await request(h.app)
      .get('/api/apps/coins/price-history/count?assetId=1&from=2026-01-01T00:00:00Z&to=2026-01-02T23:59:59Z')
      .set('Cookie', cookie);
    expect(count.body.count).toBe(2);

    const unconfirmed = await authed(request(h.app).post('/api/apps/coins/price-history/delete-range')).send({
      assetId: '1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T23:59:59Z',
    });
    expect(unconfirmed.status).toBe(400);

    const res = await authed(request(h.app).post('/api/apps/coins/price-history/delete-range')).send({
      assetId: '1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T23:59:59Z',
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const after = await request(h.app)
      .get('/api/apps/coins/price-history?assetId=1')
      .set('Cookie', cookie);
    expect(after.body.total).toBe(1);
  });

  it('reset requires the exact RESET phrase and resets only price history', async () => {
    const wrongPhrase = await authed(request(h.app).post('/api/apps/coins/price-history/reset')).send({
      phrase: 'reset',
    });
    expect(wrongPhrase.status).toBe(400);

    const res = await authed(request(h.app).post('/api/apps/coins/price-history/reset')).send({
      phrase: 'RESET',
    });
    expect(res.status).toBe(200);

    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const ph = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.price_history`);
    const users = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.users`);
    const tx = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.transactions`);
    const coins = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.coins`);
    await client.end();
    expect(Number(ph.rows[0]!.count)).toBe(0);
    // Reset isolation: other tables untouched
    expect(Number(users.rows[0]!.count)).toBe(2);
    expect(Number(tx.rows[0]!.count)).toBe(2);
    expect(Number(coins.rows[0]!.count)).toBe(2);
  });

  it('Dwarf price-history reset/delete are unsupported (honest 403)', async () => {
    const res = await authed(request(h.app).post('/api/apps/dwarf/price-history/reset')).send({ phrase: 'RESET' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
    const del = await authed(request(h.app).post('/api/apps/dwarf/price-history/delete-range')).send({
      assetId: '22222222-2222-2222-2222-222222222222',
      confirm: true,
    });
    expect(del.status).toBe(403);
  });
});

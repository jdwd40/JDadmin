import bcrypt from 'bcryptjs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrlFor, COINS_SCHEMA, createHarness, TestHarness } from './helpers.js';

describe('users endpoints (Coins adapter, disposable DB)', () => {
  let h: TestHarness;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    h = await createHarness({ withCoins: true });
    ({ cookie, csrf } = await h.login());
  });

  afterAll(async () => {
    await h.cleanup();
  });

  const authed = (r: request.Test) => r.set('Cookie', cookie).set('X-CSRF-Token', csrf);

  it('lists users with pagination and search', async () => {
    const res = await request(h.app).get('/api/apps/coins/users?page=1&pageSize=10').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((u: { username: string }) => u.username)).toContain('alice');

    const search = await request(h.app).get('/api/apps/coins/users?search=bob').set('Cookie', cookie);
    expect(search.body.total).toBe(1);
    expect(search.body.items[0].username).toBe('bob');
    // Never expose hashes
    expect(JSON.stringify(search.body)).not.toContain('password_hash');
  });

  it('sorts users by balance desc', async () => {
    const res = await request(h.app)
      .get('/api/apps/coins/users?sort=balance&order=desc')
      .set('Cookie', cookie);
    expect(res.body.items[0].username).toBe('bob');
  });

  it('creates a user with bcrypt hash, rejects duplicates with 409', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/users')).send({
      username: 'carol',
      email: 'carol@example.test',
      password: 'carol-password-1',
      balance: 321,
    });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('carol');
    expect(res.body.balance).toBe(321);

    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const row = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM ${COINS_SCHEMA}.users WHERE username = $1`,
      ['carol'],
    );
    await client.end();
    expect(row.rows[0]!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(bcrypt.compareSync('carol-password-1', row.rows[0]!.password_hash)).toBe(true);

    const dup = await authed(request(h.app).post('/api/apps/coins/users')).send({
      username: 'carol',
      password: 'another-password-1',
    });
    expect(dup.status).toBe(409);
  });

  it('rejects invalid create input (short password → 400)', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/users')).send({
      username: 'dave',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('gets and updates a user', async () => {
    const patch = await authed(request(h.app).patch('/api/apps/coins/users/1')).send({ balance: 999 });
    expect(patch.status).toBe(200);
    expect(patch.body.balance).toBe(999);
    const get = await request(h.app).get('/api/apps/coins/users/1').set('Cookie', cookie);
    expect(get.body.balance).toBe(999);
  });

  it('returns 404 for missing user', async () => {
    const res = await request(h.app).get('/api/apps/coins/users/9999').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('resets a user password (hash updated; plaintext never stored/returned)', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/users/2/reset-password')).send({
      newPassword: 'bob-new-password-1',
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('bob-new-password-1');
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const row = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM ${COINS_SCHEMA}.users WHERE user_id = 2`,
    );
    await client.end();
    expect(bcrypt.compareSync('bob-new-password-1', row.rows[0]!.password_hash)).toBe(true);
  });

  it('reports related counts before delete', async () => {
    const res = await request(h.app).get('/api/apps/coins/users/1/related-counts').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.counts.portfolios).toBe(1);
    expect(res.body.counts.transactions).toBe(1);
  });

  it('refuses delete without explicit confirmation (issue #16: no username typing)', async () => {
    const res = await authed(request(h.app).delete('/api/apps/coins/users/1')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.details?.[0]?.message).toMatch(/explicit confirmation/i);
  });

  it('deletes a user transactionally with related rows', async () => {
    const res = await authed(request(h.app).delete('/api/apps/coins/users/1')).send({
      confirm: true,
    });
    expect(res.status).toBe(200);
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const u = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.users WHERE user_id = 1`);
    const p = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.portfolios WHERE user_id = 1`);
    const t = await client.query(`SELECT count(*) FROM ${COINS_SCHEMA}.transactions WHERE user_id = 1`);
    await client.end();
    expect(Number(u.rows[0]!.count)).toBe(0);
    expect(Number(p.rows[0]!.count)).toBe(0);
    expect(Number(t.rows[0]!.count)).toBe(0);
  });

  it('disable is an unsupported capability for Coins (403, not faked)', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/users/2/disable')).send({ disabled: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('destructive guard', () => {
  let h: TestHarness;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    h = await createHarness({ withCoins: true, allowDestructive: false });
    ({ cookie, csrf } = await h.login());
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('refuses user delete when ALLOW_DESTRUCTIVE=false', async () => {
    const res = await request(h.app)
      .delete('/api/apps/coins/users/1')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ confirm: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DESTRUCTIVE_DISABLED');
  });

  it('refuses price-history reset when ALLOW_DESTRUCTIVE=false', async () => {
    const res = await request(h.app)
      .post('/api/apps/coins/price-history/reset')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ phrase: 'RESET' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DESTRUCTIVE_DISABLED');
  });
});

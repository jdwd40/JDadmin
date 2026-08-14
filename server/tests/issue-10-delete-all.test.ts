import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrlFor, COINS_SCHEMA, createHarness, TestHarness } from './helpers.js';

/**
 * Issue #10 regression suite: individual price-point delete, transactional
 * delete-all users, and the Dwarf provisioned price-history functions.
 * Asserts confirmation enforcement, CSRF/origin protection, FK rollback with
 * no partial delete, admin-caller (42501) enforcement, and audit content.
 */

const DWARF_PRINCIPAL = '11111111-1111-1111-1111-111111111111';
const DWARF_GEM = '22222222-2222-2222-2222-222222222222';

async function auditRows(h: TestHarness, action: string, appId?: string) {
  const res = await h.adminDb.query<{ previous: unknown; new: unknown; entity_id: string | null; entity_type: string }>(
    `SELECT previous, new, entity_id, entity_type FROM admin_audit_log
      WHERE action = $1 ${appId ? 'AND app_id = $2' : ''}`,
    appId ? [action, appId] : [action],
  );
  return res.rows;
}

async function coinsTableCounts(dbName: string) {
  const client = new pg.Client(adminUrlFor(dbName));
  await client.connect();
  const q = async (t: string) =>
    Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${COINS_SCHEMA}.${t}`)).rows[0]!.count);
  const counts = {
    users: await q('users'),
    portfolios: await q('portfolios'),
    transactions: await q('transactions'),
    coins: await q('coins'),
    priceHistory: await q('price_history'),
  };
  await client.end();
  return counts;
}

describe('issue #10: individual price-point delete + delete-all users (Coins)', () => {
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

  it('individual price-point delete: 404 for unknown id, success returns + audits the deleted row', async () => {
    const missing = await authed(request(h.app).delete('/api/apps/coins/price-history/9999'));
    expect(missing.status).toBe(404);
    expect((await auditRows(h, 'price_history.delete', 'coins')).length).toBe(0);

    // Fixture row 2: coin 1, price 9.5 (2026-01-02).
    const res = await authed(request(h.app).delete('/api/apps/coins/price-history/2'));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toMatchObject({ id: '2', assetId: '1', price: 9.5 });

    const list = await request(h.app).get('/api/apps/coins/price-history').set('Cookie', cookie);
    expect(list.body.total).toBe(4);

    const audit = await auditRows(h, 'price_history.delete', 'coins');
    expect(audit.length).toBe(1);
    expect(audit[0]!.entity_type).toBe('price_history');
    expect(audit[0]!.entity_id).toBe('2');
    expect(audit[0]!.previous).toMatchObject({ id: '2', price: 9.5 });
    const dump = JSON.stringify(audit[0]);
    expect(dump).not.toContain('password');
    expect(dump).not.toMatch(/\$2[aby]\$/);
  });

  it('CSRF/origin failures on the new routes: 403, no state change, no audit', async () => {
    const noToken = await request(h.app).delete('/api/apps/coins/price-history/1').set('Cookie', cookie);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');

    const badToken = await request(h.app)
      .post('/api/apps/coins/users/delete-all')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'wrong')
      .send({ phrase: 'DELETE ALL', expectedCount: 2 });
    expect(badToken.status).toBe(403);

    const badOrigin = await request(h.app)
      .post('/api/apps/coins/users/delete-all')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'https://evil.example')
      .send({ phrase: 'DELETE ALL', expectedCount: 2 });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('BAD_ORIGIN');

    const counts = await coinsTableCounts(h.dbName);
    expect(counts.users).toBe(2);
    expect(counts.priceHistory).toBe(4);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
    expect((await auditRows(h, 'price_history.delete', 'coins')).length).toBe(1);
  });

  it('users delete-all requires the exact phrase and the exact current user count', async () => {
    const wrongPhrase = await authed(request(h.app).post('/api/apps/coins/users/delete-all')).send({
      phrase: 'delete all',
      expectedCount: 2,
    });
    expect(wrongPhrase.status).toBe(400);

    const wrongCount = await authed(request(h.app).post('/api/apps/coins/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 99,
    });
    expect(wrongCount.status).toBe(400);
    expect(wrongCount.body.error.message).toContain('2');

    const counts = await coinsTableCounts(h.dbName);
    expect(counts.users).toBe(2);
    expect(counts.portfolios).toBe(2);
    expect(counts.transactions).toBe(2);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
  });

  it('users delete-all rolls back fully on an FK violation: 409, no partial delete, no audit', async () => {
    // Simulate an app table the adapter does not cascade into.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query(
      `CREATE TABLE ${COINS_SCHEMA}.fk_trap (
         id serial PRIMARY KEY,
         user_id int REFERENCES ${COINS_SCHEMA}.users(user_id)
       )`,
    );
    await client.query(`INSERT INTO ${COINS_SCHEMA}.fk_trap (user_id) VALUES (2)`);
    await client.end();

    const res = await authed(request(h.app).post('/api/apps/coins/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 2,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    // Atomic rollback: portfolios/transactions were deleted first in the
    // transaction, so their survival proves there was no partial delete.
    const counts = await coinsTableCounts(h.dbName);
    expect(counts).toMatchObject({ users: 2, portfolios: 2, transactions: 2 });
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);

    const cleanup = new pg.Client(adminUrlFor(h.dbName));
    await cleanup.connect();
    await cleanup.query(`DROP TABLE ${COINS_SCHEMA}.fk_trap`);
    await cleanup.end();
  });

  it('users delete-all succeeds transactionally and audits redacted scope/count only', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.deletedUsers).toBe(2);
    expect(res.body.deletedRelated).toMatchObject({ portfolios: 2, transactions: 2 });

    const counts = await coinsTableCounts(h.dbName);
    expect(counts).toMatchObject({ users: 0, portfolios: 0, transactions: 0 });
    // Delete-all scope is users + related rows only: assets and price
    // history are untouched.
    expect(counts.coins).toBe(2);
    expect(counts.priceHistory).toBe(4);

    const audit = await auditRows(h, 'users.delete_all', 'coins');
    expect(audit.length).toBe(1);
    expect(audit[0]!.entity_type).toBe('user');
    expect(audit[0]!.previous).toMatchObject({ scope: 'all users', confirmedCount: 2 });
    expect(audit[0]!.new).toMatchObject({ deletedUsers: 2 });
    const dump = JSON.stringify(audit[0]);
    expect(dump).not.toContain('password');
    expect(dump).not.toMatch(/\$2[aby]\$/);
  });
});

describe('issue #10: Dwarf provisioned price-history functions', () => {
  let h: TestHarness;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    h = await createHarness({ withDwarf: true });
    ({ cookie, csrf } = await h.login());
  });

  afterAll(async () => {
    await h.cleanup();
  });

  const authed = (r: request.Test) => r.set('Cookie', cookie).set('X-CSRF-Token', csrf);

  it('advertises honest issue #10 capabilities', async () => {
    const res = await request(h.app).get('/api/apps').set('Cookie', cookie);
    const dwarf = res.body.apps.find((a: { id: string }) => a.id === 'dwarf');
    expect(dwarf.capabilities.priceHistory).toMatchObject({
      list: true,
      stats: true,
      delete: true,
      deleteRange: true,
      reset: true,
    });
    // Individual user delete since issue #11; delete-all since issue #15,
    // scoped to all users except the control-plane principal (covered by the
    // issue #15 suite). With only the principal present, the in-scope count
    // is 0, so a stale count of 1 is rejected without deleting anything.
    expect(dwarf.capabilities.users.delete).toBe(true);
    expect(dwarf.capabilities.users.deleteAll).toBe(true);

    const delAll = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 1,
    });
    expect(delAll.status).toBe(400);
    expect(delAll.body.error.message).toMatch(/count confirmation mismatch/i);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
  });

  it('individual point delete via jdadmin_admin_delete_price_point (+404, audit)', async () => {
    const list = await request(h.app).get('/api/apps/dwarf/price-history').set('Cookie', cookie);
    expect(list.body.total).toBe(2);
    const point = list.body.items.find((p: { price: number }) => p.price === 95);

    const res = await authed(request(h.app).delete(`/api/apps/dwarf/price-history/${point.id}`));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toMatchObject({ id: point.id, assetId: DWARF_GEM, price: 95 });

    const missing = await authed(
      request(h.app).delete('/api/apps/dwarf/price-history/99999999-9999-9999-9999-999999999999'),
    );
    expect(missing.status).toBe(404);

    const after = await request(h.app).get('/api/apps/dwarf/price-history').set('Cookie', cookie);
    expect(after.body.total).toBe(1);

    const audit = await auditRows(h, 'price_history.delete', 'dwarf');
    expect(audit.length).toBe(1);
    expect(audit[0]!.entity_id).toBe(point.id);
    expect(audit[0]!.previous).toMatchObject({ price: 95 });
  });

  it('delete-range via jdadmin_admin_delete_price_history_range; filterless rejected at the route', async () => {
    const filterless = await authed(request(h.app).post('/api/apps/dwarf/price-history/delete-range')).send({
      confirm: true,
    });
    expect(filterless.status).toBe(400);

    const res = await authed(request(h.app).post('/api/apps/dwarf/price-history/delete-range')).send({
      assetId: DWARF_GEM,
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    const after = await request(h.app).get('/api/apps/dwarf/price-history').set('Cookie', cookie);
    expect(after.body.total).toBe(0);
    const audit = await auditRows(h, 'price_history.delete_range', 'dwarf');
    expect(audit.length).toBe(1);
  });

  it('reset via jdadmin_admin_reset_price_history requires the exact in-scope count', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query(
      `INSERT INTO public.price_history (gem_id, price, recorded_at) VALUES
        ($1, 101, '2026-02-01T00:00:00Z'), ($1, 102, '2026-02-02T00:00:00Z')`,
      [DWARF_GEM],
    );
    await client.end();

    const wrongCount = await authed(request(h.app).post('/api/apps/dwarf/price-history/reset')).send({
      phrase: 'RESET',
      expectedCount: 5,
    });
    expect(wrongCount.status).toBe(400);
    expect(wrongCount.body.error.message).toContain('2');

    const res = await authed(request(h.app).post('/api/apps/dwarf/price-history/reset')).send({
      phrase: 'RESET',
      expectedCount: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const after = await request(h.app).get('/api/apps/dwarf/price-history').set('Cookie', cookie);
    expect(after.body.total).toBe(0);
    const audit = await auditRows(h, 'price_history.reset', 'dwarf');
    expect(audit.length).toBe(1);
    expect(audit[0]!.previous).toMatchObject({ confirmedCount: 2 });
  });

  it('provisioned functions enforce the admin caller at the database (42501)', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();

    // Non-admin transaction-local identity: every wrapper refuses with 42501.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, ['99999999-9999-9999-9999-999999999999']);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_price_point(gen_random_uuid())`),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, ['99999999-9999-9999-9999-999999999999']);
    await expect(
      client.query(`SELECT public.jdadmin_admin_reset_price_history(NULL)`),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');

    // Admin identity: the range function still refuses an unfiltered call.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [DWARF_PRINCIPAL]);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_price_history_range(NULL, NULL, NULL)`),
    ).rejects.toThrow(/filter/i);
    await client.query('ROLLBACK');
    await client.end();
  });

  it('a demoted principal turns HTTP deletes into a generic 403 (no internals leak)', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.price_history (gem_id, price, recorded_at) VALUES ($1, 103, '2026-03-01T00:00:00Z') RETURNING id`,
      [DWARF_GEM],
    );
    const pointId = inserted.rows[0]!.id;
    await client.query(`UPDATE public.profiles SET role = 'player' WHERE id = $1`, [DWARF_PRINCIPAL]);

    const res = await authed(request(h.app).delete(`/api/apps/dwarf/price-history/${pointId}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).not.toMatch(/profiles|assert_admin/);

    await client.query(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [DWARF_PRINCIPAL]);
    const stillThere = await client.query(`SELECT count(*)::text AS count FROM public.price_history WHERE id = $1`, [pointId]);
    await client.end();
    expect(Number(stillThere.rows[0]!.count)).toBe(1);
    expect((await auditRows(h, 'price_history.delete', 'dwarf')).length).toBe(1);
  });
});

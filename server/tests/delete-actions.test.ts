import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrlFor, COINS_SCHEMA, createHarness, TestHarness } from './helpers.js';

/**
 * Issue #1 regression suite: capability-gated confirmed delete actions.
 * Covers cancellation (no request effect / no audit), CSRF and destructive
 * guard failures, successful-action audit content + redaction,
 * referential-integrity handling, and unsupported adapters.
 */

const DESTRUCTIVE_ACTIONS = [
  'users.delete',
  'users.delete_all',
  'price_history.delete',
  'price_history.delete_range',
  'price_history.reset',
];

async function destructiveAuditCount(h: TestHarness, appId?: string): Promise<number> {
  const res = await h.adminDb.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM admin_audit_log
      WHERE action = ANY($1) ${appId ? 'AND app_id = $2' : ''}`,
    appId ? [DESTRUCTIVE_ACTIONS, appId] : [DESTRUCTIVE_ACTIONS],
  );
  return Number(res.rows[0]?.count ?? 0);
}

describe('issue #1: delete-action regression (Coins + Dwarf harness)', () => {
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

  it('failed/cancelled confirmations change nothing and write no audit event', async () => {
    const before = await destructiveAuditCount(h);

    const wrongUser = await authed(request(h.app).delete('/api/apps/coins/users/2')).send({
      confirmUsername: 'not-bob',
    });
    expect(wrongUser.status).toBe(400);

    const unconfirmedRange = await authed(request(h.app).post('/api/apps/coins/price-history/delete-range')).send({
      assetId: '1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T23:59:59Z',
    });
    expect(unconfirmedRange.status).toBe(400);

    const wrongPhrase = await authed(request(h.app).post('/api/apps/coins/price-history/reset')).send({
      phrase: 'reset',
    });
    expect(wrongPhrase.status).toBe(400);

    // No state change: user 2 and all 5 price points still present.
    const user = await request(h.app).get('/api/apps/coins/users/2').set('Cookie', cookie);
    expect(user.status).toBe(200);
    const ph = await request(h.app).get('/api/apps/coins/price-history').set('Cookie', cookie);
    expect(ph.body.total).toBe(5);

    expect(await destructiveAuditCount(h)).toBe(before);
  });

  it('CSRF failure on destructive routes → 403, no state change, no audit', async () => {
    const before = await destructiveAuditCount(h);

    const noToken = await request(h.app)
      .delete('/api/apps/coins/users/2')
      .set('Cookie', cookie)
      .send({ confirmUsername: 'bob' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');

    const badToken = await request(h.app)
      .post('/api/apps/coins/price-history/reset')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'wrong')
      .send({ phrase: 'RESET' });
    expect(badToken.status).toBe(403);

    const badOrigin = await request(h.app)
      .delete('/api/apps/coins/users/2')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'https://evil.example')
      .send({ confirmUsername: 'bob' });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('BAD_ORIGIN');

    const user = await request(h.app).get('/api/apps/coins/users/2').set('Cookie', cookie);
    expect(user.status).toBe(200);
    const ph = await request(h.app).get('/api/apps/coins/price-history').set('Cookie', cookie);
    expect(ph.body.total).toBe(5);
    expect(await destructiveAuditCount(h)).toBe(before);
  });

  it('unsupported adapter (Dwarf) delete is an honest 403 with no audit event', async () => {
    const before = await destructiveAuditCount(h, 'dwarf');
    const del = await authed(
      request(h.app).delete('/api/apps/dwarf/users/11111111-1111-1111-1111-111111111111'),
    ).send({ confirmUsername: 'DwarfOne' });
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(await destructiveAuditCount(h, 'dwarf')).toBe(before);
  });

  it('successful user delete records actor/app/action/entity with redacted summaries', async () => {
    const res = await authed(request(h.app).delete('/api/apps/coins/users/1')).send({
      confirmUsername: 'alice',
    });
    expect(res.status).toBe(200);
    expect(res.body.deletedRelated).toMatchObject({ portfolios: 1, transactions: 1 });

    const audit = await request(h.app)
      .get('/api/audit?appId=coins&action=users.delete')
      .set('Cookie', cookie);
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
    const entry = audit.body.items[0];
    expect(entry.actorUsername).toBe('testadmin');
    expect(entry.appId).toBe('coins');
    expect(entry.action).toBe('users.delete');
    expect(entry.entityType).toBe('user');
    expect(entry.entityId).toBe('1');
    expect(entry.previous.username).toBe('alice');
    expect(entry.next.relatedCounts).toMatchObject({ portfolios: 1, transactions: 1 });
    // Redaction: no password material or hashes anywhere in the entry.
    const dump = JSON.stringify(entry);
    expect(dump).not.toContain('password');
    expect(dump).not.toMatch(/\$2[aby]\$/);
  });

  it('successful delete-range records matched/deleted counts in the audit event', async () => {
    const res = await authed(request(h.app).post('/api/apps/coins/price-history/delete-range')).send({
      assetId: '2',
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    const audit = await request(h.app)
      .get('/api/audit?appId=coins&action=price_history.delete_range')
      .set('Cookie', cookie);
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
    const entry = audit.body.items[0];
    expect(entry.entityType).toBe('price_history');
    expect(entry.entityId).toBe('2');
    expect(entry.previous.matchedCount).toBe(2);
    expect(entry.next.deleted).toBe(2);
  });

  it('referential-integrity violation surfaces as 409 CONFLICT, never a silent 500', async () => {
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

    const before = await destructiveAuditCount(h);
    const res = await authed(request(h.app).delete('/api/apps/coins/users/2')).send({
      confirmUsername: 'bob',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    // Nothing deleted, nothing audited.
    const user = await request(h.app).get('/api/apps/coins/users/2').set('Cookie', cookie);
    expect(user.status).toBe(200);
    expect(user.body.username).toBe('bob');
    expect(await destructiveAuditCount(h)).toBe(before);
  });
});

describe('issue #1: destructive guard writes no audit event', () => {
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

  it('ALLOW_DESTRUCTIVE=false → 403 DESTRUCTIVE_DISABLED, no state change, no audit', async () => {
    const before = await destructiveAuditCount(h);
    const authed = (r: request.Test) => r.set('Cookie', cookie).set('X-CSRF-Token', csrf);

    const del = await authed(request(h.app).delete('/api/apps/coins/users/1')).send({
      confirmUsername: 'alice',
    });
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe('DESTRUCTIVE_DISABLED');

    const reset = await authed(request(h.app).post('/api/apps/coins/price-history/reset')).send({
      phrase: 'RESET',
    });
    expect(reset.status).toBe(403);

    const user = await request(h.app).get('/api/apps/coins/users/1').set('Cookie', cookie);
    expect(user.status).toBe(200);
    expect(await destructiveAuditCount(h)).toBe(before);
  });
});

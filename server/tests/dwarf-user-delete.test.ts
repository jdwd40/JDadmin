import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dwarfCapabilities } from '../src/adapters/dwarf.js';
import { adminUrlFor, createHarness, TestHarness } from './helpers.js';

/**
 * Issue #11 regression suite: controlled Dwarf user hard delete via the
 * provisioned jdadmin_admin_delete_user SECURITY DEFINER function
 * (ops/dwarf/004). Asserts success with related-record deletion, truthful
 * counts, rollback with no partial delete, self-delete prevention, DB-level
 * admin-caller enforcement, CSRF/origin/cancellation with no audit, and audit
 * redaction. Delete-all users is covered by the issue #15 suite (it is
 * supported since #15, scoped to all users except the control-plane
 * principal).
 */

const PRINCIPAL = '11111111-1111-1111-1111-111111111111';
const GEM = '22222222-2222-2222-2222-222222222222';
const VICTIM = '33333333-3333-3333-3333-333333333333';

async function auditRows(h: TestHarness, action: string, appId = 'dwarf') {
  const res = await h.adminDb.query<{ previous: unknown; new: unknown; entity_id: string | null }>(
    `SELECT previous, new, entity_id FROM admin_audit_log WHERE action = $1 AND app_id = $2`,
    [action, appId],
  );
  return res.rows;
}

/** Seed a victim user with one row in every user-anchored table. */
async function seedVictim(dbName: string): Promise<void> {
  const client = new pg.Client(adminUrlFor(dbName));
  await client.connect();
  await client.query(`INSERT INTO app_auth.users (id, email, display_name) VALUES ($1, 'victim@example.test', 'Victim')`, [VICTIM]);
  await client.query(`INSERT INTO public.profiles (id, display_name, role) VALUES ($1, 'Victim', 'player')`, [VICTIM]);
  await client.query(`INSERT INTO public.wallets (user_id, dcoin_balance) VALUES ($1, 42)`, [VICTIM]);
  await client.query(`INSERT INTO public.portfolio_holdings (user_id, gem_id, amount_grams, average_buy_price) VALUES ($1, $2, 1, 100)`, [VICTIM, GEM]);
  await client.query(`INSERT INTO public.transactions (user_id, gem_id, type, amount_dcoins) VALUES ($1, $2, 'buy', 100)`, [VICTIM, GEM]);
  await client.query(`INSERT INTO public.limit_orders (user_id, gem_id, side) VALUES ($1, $2, 'buy')`, [VICTIM, GEM]);
  await client.query(`INSERT INTO public.mining_jobs (user_id, gem_id) VALUES ($1, $2)`, [VICTIM, GEM]);
  await client.query(`INSERT INTO public.player_action_cooldowns (user_id, gem_id, action) VALUES ($1, $2, 'mine')`, [VICTIM, GEM]);
  await client.query(`INSERT INTO public.leaderboard_cache (user_id, total_value) VALUES ($1, 142)`, [VICTIM]);
  await client.query(`INSERT INTO public.public_feed (user_id, gem_id, message) VALUES ($1, $2, 'victim bought')`, [VICTIM, GEM]);
  await client.query(`INSERT INTO app_auth.identities (user_id, provider, provider_subject) VALUES ($1, 'email', 'victim@example.test')`, [VICTIM]);
  await client.query(`INSERT INTO app_auth.refresh_sessions (user_id) VALUES ($1)`, [VICTIM]);
  await client.query(`INSERT INTO app_auth.password_reset_tokens (user_id, token_hash) VALUES ($1, 'x')`, [VICTIM]);
  await client.end();
}

async function victimRowCounts(dbName: string) {
  const client = new pg.Client(adminUrlFor(dbName));
  await client.connect();
  const q = async (sql: string, params: unknown[] = [VICTIM]) =>
    Number((await client.query<{ count: string }>(sql, params)).rows[0]!.count);
  const counts = {
    authUsers: await q(`SELECT count(*)::text AS count FROM app_auth.users WHERE id = $1`),
    profiles: await q(`SELECT count(*)::text AS count FROM public.profiles WHERE id = $1`),
    wallets: await q(`SELECT count(*)::text AS count FROM public.wallets WHERE user_id = $1`),
    holdings: await q(`SELECT count(*)::text AS count FROM public.portfolio_holdings WHERE user_id = $1`),
    transactions: await q(`SELECT count(*)::text AS count FROM public.transactions WHERE user_id = $1`),
    limitOrders: await q(`SELECT count(*)::text AS count FROM public.limit_orders WHERE user_id = $1`),
    miningJobs: await q(`SELECT count(*)::text AS count FROM public.mining_jobs WHERE user_id = $1`),
    cooldowns: await q(`SELECT count(*)::text AS count FROM public.player_action_cooldowns WHERE user_id = $1`),
    leaderboard: await q(`SELECT count(*)::text AS count FROM public.leaderboard_cache WHERE user_id = $1`),
    feedRows: await q(`SELECT count(*)::text AS count FROM public.public_feed WHERE user_id = $1`),
    feedAnonymized: await q(
      `SELECT count(*)::text AS count FROM public.public_feed WHERE user_id IS NULL AND message = 'victim bought'`,
      [],
    ),
    identities: await q(`SELECT count(*)::text AS count FROM app_auth.identities WHERE user_id = $1`),
    sessions: await q(`SELECT count(*)::text AS count FROM app_auth.refresh_sessions WHERE user_id = $1`),
    resetTokens: await q(`SELECT count(*)::text AS count FROM app_auth.password_reset_tokens WHERE user_id = $1`),
    deleteEvents: await q(
      `SELECT count(*)::text AS count FROM app_auth.auth_events WHERE event_type = 'admin_deleted_user' AND user_id = '11111111-1111-1111-1111-111111111111' AND metadata->>'deleted_user_id' = $1::text`,
    ),
  };
  await client.end();
  return counts;
}

describe('issue #11: Dwarf capability flags (unit)', () => {
  it('enables individual delete and (since issue #15) scoped delete-all', () => {
    const caps = dwarfCapabilities(true, true);
    expect(caps.users.delete).toBe(true);
    // Issue #15: delete-all is on, scoped to all users except the
    // control-plane principal (jdadmin_admin_delete_all_users, ops/dwarf/005).
    expect(caps.users.deleteAll).toBe(true);
  });

  it('turns delete off without a configured admin principal', () => {
    expect(dwarfCapabilities(true, false).users.delete).toBe(false);
  });
});

describe('issue #11: Dwarf user delete (disposable DB)', () => {
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

  it('advertises delete=true / deleteAll=true; delete-all enforces the in-scope count', async () => {
    const res = await request(h.app).get('/api/apps').set('Cookie', cookie);
    const dwarf = res.body.apps.find((a: { id: string }) => a.id === 'dwarf');
    expect(dwarf.capabilities.users.delete).toBe(true);
    expect(dwarf.capabilities.users.deleteAll).toBe(true); // issue #15

    // The scope is all users EXCEPT the principal: 0 in scope here, so a
    // stale count of 1 is rejected with no delete and no audit.
    const count = await request(h.app).get('/api/apps/dwarf/users/delete-all/count').set('Cookie', cookie);
    expect(count.status).toBe(200);
    expect(count.body).toMatchObject({ count: 0, scope: 'all users except the control-plane principal' });

    const delAll = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 1,
    });
    expect(delAll.status).toBe(400);
    expect(delAll.body.error.message).toMatch(/count confirmation mismatch/i);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
  });

  it('reports truthful related counts for the confirmation dialog', async () => {
    await seedVictim(h.dbName);
    const res = await request(h.app)
      .get(`/api/apps/dwarf/users/${VICTIM}/related-counts`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({
      wallets: 1,
      portfolio_holdings: 1,
      transactions: 1,
      limit_orders: 1,
      mining_jobs: 1,
      player_action_cooldowns: 1,
      leaderboard_cache: 1,
      public_feed_anonymized: 1,
      identities: 1,
      refresh_sessions: 1,
      password_reset_tokens: 1,
    });
  });

  it('rejects a wrong confirmation username: 400, no delete, no audit', async () => {
    const res = await authed(request(h.app).delete(`/api/apps/dwarf/users/${VICTIM}`)).send({
      confirmUsername: 'NotTheVictim',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/confirmation username/i);
    const counts = await victimRowCounts(h.dbName);
    expect(counts.authUsers).toBe(1);
    expect(counts.wallets).toBe(1);
    expect((await auditRows(h, 'users.delete')).length).toBe(0);
  });

  it('rejects delete without CSRF and from a foreign origin: 403, no delete, no audit', async () => {
    const noToken = await request(h.app)
      .delete(`/api/apps/dwarf/users/${VICTIM}`)
      .set('Cookie', cookie)
      .send({ confirmUsername: 'Victim' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');

    const badOrigin = await authed(request(h.app).delete(`/api/apps/dwarf/users/${VICTIM}`))
      .set('Origin', 'https://evil.example')
      .send({ confirmUsername: 'Victim' });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('BAD_ORIGIN');

    const counts = await victimRowCounts(h.dbName);
    expect(counts.authUsers).toBe(1);
    expect((await auditRows(h, 'users.delete')).length).toBe(0);
  });

  it('404s for an unknown user without touching anything', async () => {
    const res = await authed(
      request(h.app).delete('/api/apps/dwarf/users/99999999-9999-9999-9999-999999999999'),
    ).send({ confirmUsername: 'ghost' });
    expect(res.status).toBe(404);
    expect((await auditRows(h, 'users.delete')).length).toBe(0);
  });

  it('refuses to delete the calling control-plane principal (adapter + database)', async () => {
    const res = await authed(request(h.app).delete(`/api/apps/dwarf/users/${PRINCIPAL}`)).send({
      confirmUsername: 'DwarfOne',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/calling admin principal/i);
    const get = await request(h.app).get(`/api/apps/dwarf/users/${PRINCIPAL}`).set('Cookie', cookie);
    expect(get.status).toBe(200);
    expect((await auditRows(h, 'users.delete')).length).toBe(0);

    // DB-level guard: even a direct function call as the principal raises.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [PRINCIPAL]);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_user($1)`, [PRINCIPAL]),
    ).rejects.toThrow(/calling admin principal/i);
    await client.query('ROLLBACK');
    await client.end();
  });

  it('enforces the admin-caller guard at the database for the delete function', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, ['99999999-9999-9999-9999-999999999999']);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_user($1)`, [VICTIM]),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');

    // Demoted principal over HTTP: 42501 maps to a generic 403, no internals.
    await client.query(`UPDATE public.profiles SET role = 'player' WHERE id = $1`, [PRINCIPAL]);
    const res = await authed(request(h.app).delete(`/api/apps/dwarf/users/${VICTIM}`)).send({
      confirmUsername: 'Victim',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).not.toMatch(/profiles|assert_admin/);
    await client.query(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [PRINCIPAL]);
    await client.end();

    const counts = await victimRowCounts(h.dbName);
    expect(counts.authUsers).toBe(1);
    expect((await auditRows(h, 'users.delete')).length).toBe(0);
  });

  it('rolls back completely when an unforeseen FK blocks the delete: 409, no partial delete', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    // Simulate a future app table that references auth users without CASCADE.
    await client.query(
      `CREATE TABLE public.fk_trap (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id uuid REFERENCES app_auth.users(id)
       )`,
    );
    await client.query(`INSERT INTO public.fk_trap (user_id) VALUES ($1)`, [VICTIM]);
    await client.end();

    const res = await authed(request(h.app).delete(`/api/apps/dwarf/users/${VICTIM}`)).send({
      confirmUsername: 'Victim',
    });
    try {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');

      // Everything survived, including the redacted app-side audit event the
      // function inserts before deleting (same transaction → rolled back too).
      const counts = await victimRowCounts(h.dbName);
      expect(counts).toMatchObject({
        authUsers: 1,
        profiles: 1,
        wallets: 1,
        holdings: 1,
        transactions: 1,
        limitOrders: 1,
        deleteEvents: 0,
      });
      expect((await auditRows(h, 'users.delete')).length).toBe(0);
    } finally {
      const cleanup = new pg.Client(adminUrlFor(h.dbName));
      await cleanup.connect();
      await cleanup.query(`DROP TABLE public.fk_trap`);
      await cleanup.end();
    }
  });

  it('deletes the user and every related row atomically, anonymizes feed/audit, audits redacted', async () => {
    const res = await authed(request(h.app).delete(`/api/apps/dwarf/users/${VICTIM}`)).send({
      confirmUsername: 'Victim',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deletedRelated).toMatchObject({
      wallets: 1,
      portfolio_holdings: 1,
      transactions: 1,
      limit_orders: 1,
      mining_jobs: 1,
      player_action_cooldowns: 1,
      leaderboard_cache: 1,
      public_feed_anonymized: 1,
      identities: 1,
      refresh_sessions: 1,
      password_reset_tokens: 1,
    });

    const counts = await victimRowCounts(h.dbName);
    expect(counts).toMatchObject({
      authUsers: 0,
      profiles: 0,
      wallets: 0,
      holdings: 0,
      transactions: 0,
      limitOrders: 0,
      miningJobs: 0,
      cooldowns: 0,
      leaderboard: 0,
      identities: 0,
      sessions: 0,
      resetTokens: 0,
      // Feed row survives anonymized; app-side audit event survives,
      // attributed to the calling principal.
      feedRows: 0,
      feedAnonymized: 1,
      deleteEvents: 1,
    });

    // The user is really gone through the API as well.
    const get = await request(h.app).get(`/api/apps/dwarf/users/${VICTIM}`).set('Cookie', cookie);
    expect(get.status).toBe(404);

    // JDadmin audit: previous/next present, related counts recorded. The
    // core's conservative redactor masks the count VALUES whose labels look
    // credential-ish (refresh_sessions / password_reset_tokens) — the
    // operator-facing response above still carries the truthful numbers —
    // and no credential material appears anywhere in the entry.
    const audit = await auditRows(h, 'users.delete');
    expect(audit.length).toBe(1);
    expect(audit[0]!.entity_id).toBe(VICTIM);
    expect(audit[0]!.previous).toMatchObject({ id: VICTIM, email: 'victim@example.test' });
    const auditCounts = (audit[0]!.new as { relatedCounts: Record<string, unknown> }).relatedCounts;
    expect(auditCounts).toMatchObject({ wallets: 1, transactions: 1, limit_orders: 1 });
    expect(auditCounts['refresh_sessions']).toBe('[redacted]');
    expect(auditCounts['password_reset_tokens']).toBe('[redacted]');
    const dump = JSON.stringify(audit[0]);
    expect(dump).not.toMatch(/\$argon2id\$/);
    expect(dump).not.toContain('new-dwarf-password');

    // App-side auth event is redacted: only the deleted UUID + counts, never
    // the victim's email or display name.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const ev = await client.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app_auth.auth_events WHERE event_type = 'admin_deleted_user'`,
    );
    await client.end();
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0]!.metadata).toMatchObject({ deleted_user_id: VICTIM });
    expect(JSON.stringify(ev.rows[0]!.metadata)).not.toContain('victim@example.test');
    expect(JSON.stringify(ev.rows[0]!.metadata)).not.toContain('Victim"');
  });

  it('leaves the control-plane principal and other users intact', async () => {
    const get = await request(h.app).get(`/api/apps/dwarf/users/${PRINCIPAL}`).set('Cookie', cookie);
    expect(get.status).toBe(200);
    const list = await request(h.app).get('/api/apps/dwarf/users').set('Cookie', cookie);
    expect(list.body.total).toBe(1);
  });
});

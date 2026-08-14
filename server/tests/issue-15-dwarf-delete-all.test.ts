import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dwarfCapabilities } from '../src/adapters/dwarf.js';
import { adminUrlFor, createHarness, TestHarness } from './helpers.js';

/**
 * Issue #15 regression suite: Dwarf delete-ALL users excluding the protected
 * control-plane principal, via the provisioned
 * jdadmin_admin_delete_all_users SECURITY DEFINER function (ops/dwarf/005).
 * Asserts: exact in-scope count semantics (principal never in scope), success
 * with the principal + its rows intact and the whole dependent graph
 * cascaded, truthful dependent counts, full rollback on FK surprises,
 * count-mismatch/phrase/CSRF/origin rejection with no partial delete and no
 * audit, DB-level admin-caller enforcement, and audit/app-event redaction.
 */

const PRINCIPAL = '11111111-1111-1111-1111-111111111111';
const GEM = '22222222-2222-2222-2222-222222222222';
const VICTIM_A = '33333333-3333-3333-3333-333333333333';
const VICTIM_B = '44444444-4444-4444-4444-444444444444';
const GHOST = '99999999-9999-9999-9999-999999999999';
const SCOPE_LABEL = 'all users except the control-plane principal';

async function auditRows(h: TestHarness, action: string, appId = 'dwarf') {
  const res = await h.adminDb.query<{ previous: unknown; new: unknown; entity_id: string | null }>(
    `SELECT previous, new, entity_id FROM admin_audit_log WHERE action = $1 AND app_id = $2`,
    [action, appId],
  );
  return res.rows;
}

/** Seed two victims with one row in every user-anchored table. */
async function seedVictims(dbName: string): Promise<void> {
  const client = new pg.Client(adminUrlFor(dbName));
  await client.connect();
  for (const [id, email, name] of [
    [VICTIM_A, 'victim-a@example.test', 'VictimA'],
    [VICTIM_B, 'victim-b@example.test', 'VictimB'],
  ] as const) {
    await client.query(`INSERT INTO app_auth.users (id, email, display_name, password_hash) VALUES ($1, $2, $3, '$argon2id$v=19$m=1,t=1,p=1$aaaa$bbbb')`, [id, email, name]);
    await client.query(`INSERT INTO public.profiles (id, display_name, role) VALUES ($1, $2, 'player')`, [id, name]);
    await client.query(`INSERT INTO public.wallets (user_id, dcoin_balance) VALUES ($1, 42)`, [id]);
    await client.query(`INSERT INTO public.portfolio_holdings (user_id, gem_id, amount_grams, average_buy_price) VALUES ($1, $2, 1, 100)`, [id, GEM]);
    await client.query(`INSERT INTO public.transactions (user_id, gem_id, type, amount_dcoins) VALUES ($1, $2, 'buy', 100)`, [id, GEM]);
    await client.query(`INSERT INTO public.limit_orders (user_id, gem_id, side) VALUES ($1, $2, 'buy')`, [id, GEM]);
    await client.query(`INSERT INTO public.mining_jobs (user_id, gem_id) VALUES ($1, $2)`, [id, GEM]);
    await client.query(`INSERT INTO public.player_action_cooldowns (user_id, gem_id, action) VALUES ($1, $2, 'mine')`, [id, GEM]);
    await client.query(`INSERT INTO public.leaderboard_cache (user_id, total_value) VALUES ($1, 142)`, [id]);
    await client.query(`INSERT INTO public.public_feed (user_id, gem_id, message) VALUES ($1, $2, 'victim bought')`, [id, GEM]);
    await client.query(`INSERT INTO app_auth.identities (user_id, provider, provider_subject) VALUES ($1, 'email', $2)`, [id, email]);
    await client.query(`INSERT INTO app_auth.refresh_sessions (user_id) VALUES ($1)`, [id]);
    await client.query(`INSERT INTO app_auth.password_reset_tokens (user_id, token_hash) VALUES ($1, 'x')`, [id]);
  }
  await client.end();
}

/** Whole-database counts used to prove scope, cascade, and preservation. */
async function dbCounts(dbName: string) {
  const client = new pg.Client(adminUrlFor(dbName));
  await client.connect();
  const q = async (sql: string, params: unknown[] = []) =>
    Number((await client.query<{ count: string }>(sql, params)).rows[0]!.count);
  const counts = {
    authUsers: await q(`SELECT count(*)::text AS count FROM app_auth.users`),
    principalRow: await q(`SELECT count(*)::text AS count FROM app_auth.users WHERE id = $1`, [PRINCIPAL]),
    principalPasswordless: await q(
      `SELECT count(*)::text AS count FROM app_auth.users WHERE id = $1 AND password_hash IS NULL AND legacy_password_hash IS NULL`,
      [PRINCIPAL],
    ),
    principalRole: await q(
      `SELECT count(*)::text AS count FROM public.profiles WHERE id = $1 AND role = 'admin'`,
      [PRINCIPAL],
    ),
    wallets: await q(`SELECT count(*)::text AS count FROM public.wallets`),
    holdings: await q(`SELECT count(*)::text AS count FROM public.portfolio_holdings`),
    transactions: await q(`SELECT count(*)::text AS count FROM public.transactions`),
    limitOrders: await q(`SELECT count(*)::text AS count FROM public.limit_orders`),
    miningJobs: await q(`SELECT count(*)::text AS count FROM public.mining_jobs`),
    cooldowns: await q(`SELECT count(*)::text AS count FROM public.player_action_cooldowns`),
    leaderboard: await q(`SELECT count(*)::text AS count FROM public.leaderboard_cache`),
    feedRows: await q(`SELECT count(*)::text AS count FROM public.public_feed`),
    feedAnonymized: await q(`SELECT count(*)::text AS count FROM public.public_feed WHERE user_id IS NULL`),
    identities: await q(`SELECT count(*)::text AS count FROM app_auth.identities`),
    sessions: await q(`SELECT count(*)::text AS count FROM app_auth.refresh_sessions`),
    resetTokens: await q(`SELECT count(*)::text AS count FROM app_auth.password_reset_tokens`),
    deleteAllEvents: await q(
      `SELECT count(*)::text AS count FROM app_auth.auth_events WHERE event_type = 'admin_deleted_all_users'`,
    ),
  };
  await client.end();
  return counts;
}

describe('issue #15: Dwarf delete-all capability flags (unit)', () => {
  it('enables delete-all when the admin principal is configured', () => {
    expect(dwarfCapabilities(true, true).users.deleteAll).toBe(true);
  });

  it('turns delete-all off without a configured admin principal', () => {
    expect(dwarfCapabilities(true, false).users.deleteAll).toBe(false);
  });
});

describe('issue #15: Dwarf delete-all users except the control-plane principal (disposable DB)', () => {
  let h: TestHarness;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    h = await createHarness({ withDwarf: true });
    ({ cookie, csrf } = await h.login());
    await seedVictims(h.dbName);
  });

  afterAll(async () => {
    await h.cleanup();
  });

  const authed = (r: request.Test) => r.set('Cookie', cookie).set('X-CSRF-Token', csrf);

  it('count endpoint reports the exact in-scope count, excluding the principal', async () => {
    const res = await request(h.app).get('/api/apps/dwarf/users/delete-all/count').set('Cookie', cookie);
    expect(res.status).toBe(200);
    // 3 users exist (principal + 2 victims); only the 2 victims are in scope.
    expect(res.body).toEqual({ count: 2, scope: SCOPE_LABEL });
    // The plain list total includes the principal — the scopes differ.
    const list = await request(h.app).get('/api/apps/dwarf/users').set('Cookie', cookie);
    expect(list.body.total).toBe(3);
  });

  it('rejects a count mismatch: 400, no delete, no audit, no app-side event', async () => {
    for (const expectedCount of [1, 3, 99]) {
      const res = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
        phrase: 'DELETE ALL',
        expectedCount,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/count confirmation mismatch/i);
      expect(res.body.error.message).toContain('2');
    }
    expect((await dbCounts(h.dbName)).authUsers).toBe(3);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
    expect((await dbCounts(h.dbName)).deleteAllEvents).toBe(0);
  });

  it('rejects a missing/wrong phrase: 400, no delete, no audit', async () => {
    for (const phrase of ['delete all', 'DELETE', '']) {
      const res = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
        phrase,
        expectedCount: 2,
      });
      expect(res.status).toBe(400);
    }
    expect((await dbCounts(h.dbName)).authUsers).toBe(3);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
  });

  it('rejects missing CSRF and foreign origin: 403, no delete, no audit', async () => {
    const noToken = await request(h.app)
      .post('/api/apps/dwarf/users/delete-all')
      .set('Cookie', cookie)
      .send({ phrase: 'DELETE ALL', expectedCount: 2 });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');

    const badOrigin = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all'))
      .set('Origin', 'https://evil.example')
      .send({ phrase: 'DELETE ALL', expectedCount: 2 });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('BAD_ORIGIN');

    const unauthenticated = await request(h.app)
      .post('/api/apps/dwarf/users/delete-all')
      .send({ phrase: 'DELETE ALL', expectedCount: 2 });
    expect(unauthenticated.status).toBe(401);

    expect((await dbCounts(h.dbName)).authUsers).toBe(3);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
  });

  it('enforces the admin-caller guard and the exact count at the database', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();

    // Non-admin transaction-local identity: the function refuses with 42501.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [GHOST]);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_all_users(2)`),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');

    // A non-admin real user (a victim) cannot call it either.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [VICTIM_A]);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_all_users(2)`),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');

    // Even as the admin principal, a stale expected count raises (P0001 → the
    // HTTP layer would surface it as 400) and nothing is deleted.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [PRINCIPAL]);
    await expect(
      client.query(`SELECT public.jdadmin_admin_delete_all_users(3)`),
    ).rejects.toThrow(/count confirmation mismatch/i);
    await client.query('ROLLBACK');

    await client.end();
    expect((await dbCounts(h.dbName)).authUsers).toBe(3);
    expect((await dbCounts(h.dbName)).deleteAllEvents).toBe(0);
  });

  it('a demoted principal turns HTTP delete-all into a generic 403 (no internals leak)', async () => {
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query(`UPDATE public.profiles SET role = 'player' WHERE id = $1`, [PRINCIPAL]);
    await client.end();

    const res = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 2,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).not.toMatch(/profiles|assert_admin/);

    const restore = new pg.Client(adminUrlFor(h.dbName));
    await restore.connect();
    await restore.query(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [PRINCIPAL]);
    await restore.end();

    expect((await dbCounts(h.dbName)).authUsers).toBe(3);
    expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
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
    await client.query(`INSERT INTO public.fk_trap (user_id) VALUES ($1)`, [VICTIM_A]);
    await client.end();

    const res = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 2,
    });
    try {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');

      // Everything survived — users, dependents, and even the redacted
      // app-side audit event the function inserts before deleting (same
      // transaction → rolled back too).
      const counts = await dbCounts(h.dbName);
      expect(counts).toMatchObject({
        authUsers: 3,
        wallets: 3,
        holdings: 3,
        transactions: 3,
        limitOrders: 2,
        miningJobs: 2,
        cooldowns: 2,
        leaderboard: 2,
        identities: 2,
        sessions: 2,
        resetTokens: 2,
        feedAnonymized: 0,
        deleteAllEvents: 0,
      });
      expect((await auditRows(h, 'users.delete_all')).length).toBe(0);
    } finally {
      const cleanup = new pg.Client(adminUrlFor(h.dbName));
      await cleanup.connect();
      await cleanup.query(`DROP TABLE public.fk_trap`);
      await cleanup.end();
    }
  });

  it('deletes every non-principal user and their whole graph atomically; the principal remains', async () => {
    const res = await authed(request(h.app).post('/api/apps/dwarf/users/delete-all')).send({
      phrase: 'DELETE ALL',
      expectedCount: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deletedUsers).toBe(2);
    expect(res.body.deletedRelated).toMatchObject({
      wallets: 2,
      portfolio_holdings: 2,
      transactions: 2,
      limit_orders: 2,
      mining_jobs: 2,
      player_action_cooldowns: 2,
      leaderboard_cache: 2,
      public_feed_anonymized: 2,
      identities: 2,
      refresh_sessions: 2,
      password_reset_tokens: 2,
    });

    const counts = await dbCounts(h.dbName);
    expect(counts).toMatchObject({
      // The protected control-plane principal remains — present, admin,
      // passwordless — with its wallet/holdings/ledger rows untouched.
      authUsers: 1,
      principalRow: 1,
      principalPasswordless: 1,
      principalRole: 1,
      wallets: 1,
      holdings: 1,
      transactions: 1,
      // Every victim dependent row is gone; feed rows survive anonymized.
      limitOrders: 0,
      miningJobs: 0,
      cooldowns: 0,
      leaderboard: 0,
      identities: 0,
      sessions: 0,
      resetTokens: 0,
      feedRows: 2,
      feedAnonymized: 2,
      deleteAllEvents: 1,
    });

    // The principal is still fully usable through the API (no lockout).
    const get = await request(h.app).get(`/api/apps/dwarf/users/${PRINCIPAL}`).set('Cookie', cookie);
    expect(get.status).toBe(200);
    expect(get.body.extra.role).toBe('admin');
    expect(get.body.balance).toBe(777);

    // The victims are really gone, and the in-scope count is now 0.
    const gone = await request(h.app).get(`/api/apps/dwarf/users/${VICTIM_A}`).set('Cookie', cookie);
    expect(gone.status).toBe(404);
    const count = await request(h.app).get('/api/apps/dwarf/users/delete-all/count').set('Cookie', cookie);
    expect(count.body.count).toBe(0);
  });

  it('audits redacted scope/counts only; the app-side event carries no PII', async () => {
    const audit = await auditRows(h, 'users.delete_all');
    expect(audit.length).toBe(1);
    expect(audit[0]!.entity_id).toBeNull();
    expect(audit[0]!.previous).toMatchObject({ scope: SCOPE_LABEL, confirmedCount: 2 });
    const next = audit[0]!.new as { deletedUsers: number; deletedRelated: Record<string, unknown> };
    expect(next.deletedUsers).toBe(2);
    expect(next.deletedRelated).toMatchObject({ wallets: 2, transactions: 2, limit_orders: 2 });
    // The core's conservative redactor masks count values whose labels look
    // credential-ish; no credential material appears anywhere in the entry.
    expect(next.deletedRelated['refresh_sessions']).toBe('[redacted]');
    expect(next.deletedRelated['password_reset_tokens']).toBe('[redacted]');
    const dump = JSON.stringify(audit[0]);
    expect(dump).not.toMatch(/victim-[ab]@example\.test/);
    expect(dump).not.toMatch(/Victim[AB]/);
    expect(dump).not.toMatch(/\$argon2id\$/);

    // App-side auth event: attributed to the surviving principal; metadata
    // carries only the scope label, excluded UUID, and counts — never the
    // victims' emails, display names, or hashes.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const ev = await client.query<{ user_id: string; metadata: Record<string, unknown> }>(
      `SELECT user_id, metadata FROM app_auth.auth_events WHERE event_type = 'admin_deleted_all_users'`,
    );
    await client.end();
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0]!.user_id).toBe(PRINCIPAL);
    expect(ev.rows[0]!.metadata).toMatchObject({
      scope: 'all_users_except_control_principal',
      excluded_user_id: PRINCIPAL,
      deleted_users: 2,
    });
    const metaDump = JSON.stringify(ev.rows[0]!.metadata);
    expect(metaDump).not.toMatch(/victim-[ab]@example\.test/);
    expect(metaDump).not.toMatch(/Victim[AB]/);
    expect(metaDump).not.toMatch(/\$argon2id\$/);
  });
});

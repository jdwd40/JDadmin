import argon2 from 'argon2';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dwarfCapabilities } from '../src/adapters/dwarf.js';
import { adminUrlFor, createHarness, TestHarness } from './helpers.js';

/**
 * Issue #2 regression suite: Dwarf user create / edit / disable. Create
 * delegates to the app's own registration flow via the provisioned
 * jdadmin_admin_create_user wrapper; disable uses the schema's disabled_at
 * latch plus session revocation. Delete became supported in issue #11 via
 * jdadmin_admin_delete_user (see dwarf-user-delete.test.ts); this suite only
 * asserts the capability advertisement and the self-delete guard.
 */

const PRINCIPAL = '11111111-1111-1111-1111-111111111111';

async function auditRows(h: TestHarness, action: string, appId = 'dwarf') {
  const res = await h.adminDb.query<{
    action: string;
    app_id: string;
    previous: unknown;
    new: unknown;
    meta: unknown;
  }>(`SELECT action, app_id, previous, new, meta FROM admin_audit_log WHERE action = $1 AND app_id = $2`, [
    action,
    appId,
  ]);
  return res.rows;
}

describe('Dwarf capability flags (unit)', () => {
  it('enables create/disable/update when principal + argon2 are available', () => {
    const caps = dwarfCapabilities(true, true);
    expect(caps.users.create).toBe(true);
    expect(caps.users.update).toBe(true);
    expect(caps.users.disable).toBe(true);
    expect(caps.users.resetPassword).toBe(true);
    expect(caps.users.delete).toBe(true); // issue #11: jdadmin_admin_delete_user
    // Issue #15: jdadmin_admin_delete_all_users excludes the calling principal.
    expect(caps.users.deleteAll).toBe(true);
    // Issue #10: price-history deletes are supported via provisioned wrappers.
    expect(caps.priceHistory.delete).toBe(true);
    expect(caps.priceHistory.deleteRange).toBe(true);
    expect(caps.priceHistory.reset).toBe(true);
  });

  it('degrades create/resetPassword when argon2 is unavailable', () => {
    const caps = dwarfCapabilities(false, true);
    expect(caps.users.create).toBe(false);
    expect(caps.users.resetPassword).toBe(false);
    expect(caps.users.disable).toBe(true);
  });

  it('turns everything off without a configured admin principal', () => {
    const caps = dwarfCapabilities(true, false);
    expect(caps.users.list).toBe(false);
    expect(caps.users.create).toBe(false);
    expect(caps.users.disable).toBe(false);
  });
});

describe('issue #2: Dwarf user administration (disposable DB)', () => {
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

  it('advertises honest Dwarf user capabilities', async () => {
    const res = await request(h.app).get('/api/apps').set('Cookie', cookie);
    const dwarf = res.body.apps.find((a: { id: string }) => a.id === 'dwarf');
    expect(dwarf.available).toBe(true);
    expect(dwarf.capabilities.users).toMatchObject({
      list: true,
      get: true,
      create: true,
      update: true,
      disable: true,
      resetPassword: true,
      delete: true, // issue #11
      deleteAll: true, // issue #15: all users except the control-plane principal
    });
  });

  it('creates a user through the registration flow (starter package, Argon2id, audit)', async () => {
    const res = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'NewDwarf',
      email: 'NewDwarf@Example.TEST',
      password: 'new-dwarf-password-1',
    });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('NewDwarf');
    expect(res.body.email).toBe('newdwarf@example.test'); // normalized
    expect(res.body.disabled).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('new-dwarf-password-1');
    expect(JSON.stringify(res.body)).not.toContain('$argon2id$');

    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const u = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM app_auth.users WHERE email = 'newdwarf@example.test'`,
    );
    expect(u.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(u.rows[0]!.password_hash, 'new-dwarf-password-1')).toBe(true);
    // Engine starter package ran: profile (player role) + starter wallet.
    const p = await client.query<{ role: string }>(
      `SELECT role FROM public.profiles WHERE id = $1`,
      [res.body.id],
    );
    expect(p.rows[0]!.role).toBe('player');
    const w = await client.query<{ dcoin_balance: string }>(
      `SELECT dcoin_balance::text FROM public.wallets WHERE user_id = $1`,
      [res.body.id],
    );
    expect(Number(w.rows[0]!.dcoin_balance)).toBe(1000);
    const ident = await client.query(
      `SELECT count(*)::text AS count FROM app_auth.identities WHERE user_id = $1 AND provider = 'email'`,
      [res.body.id],
    );
    expect(Number(ident.rows[0]!.count)).toBe(1);
    const events = await client.query(
      `SELECT count(*)::text AS count FROM app_auth.auth_events WHERE user_id = $1 AND event_type = 'registered'`,
      [res.body.id],
    );
    expect(Number(events.rows[0]!.count)).toBe(1);
    await client.end();

    const audit = await auditRows(h, 'users.create');
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0])).not.toContain('new-dwarf-password-1');
    expect(JSON.stringify(audit[0])).not.toContain('$argon2id$');
  });

  it('rejects duplicate email with 409', async () => {
    const res = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'Copycat',
      email: 'newdwarf@example.test',
      password: 'copycat-password-1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('validates create input: email required, balance engine-owned, short password 400', async () => {
    const noEmail = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'NoEmail',
      password: 'no-email-password-1',
    });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.message).toMatch(/email/i);

    const withBalance = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'Funded',
      email: 'funded@example.test',
      password: 'funded-password-1',
      balance: 5000,
    });
    expect(withBalance.status).toBe(403);
    expect(withBalance.body.error.code).toBe('UNSUPPORTED_CAPABILITY');

    const short = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'Shorty',
      email: 'shorty@example.test',
      password: 'short',
    });
    expect(short.status).toBe(400);

    // None of the failed attempts created rows or audit entries.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const u = await client.query(
      `SELECT count(*)::text AS count FROM app_auth.users WHERE email IN ('funded@example.test', 'shorty@example.test')`,
    );
    await client.end();
    expect(Number(u.rows[0]!.count)).toBe(0);
    expect((await auditRows(h, 'users.create')).length).toBe(1);
  });

  it('rejects create without CSRF: 403, no state change, no audit', async () => {
    const res = await request(h.app).post('/api/apps/dwarf/users').set('Cookie', cookie).send({
      username: 'CsrfVictim',
      email: 'csrf@example.test',
      password: 'csrf-password-1',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const u = await client.query(`SELECT count(*)::text AS count FROM app_auth.users WHERE email = 'csrf@example.test'`);
    await client.end();
    expect(Number(u.rows[0]!.count)).toBe(0);
    expect((await auditRows(h, 'users.create')).length).toBe(1);
  });

  it('updates display name (username alias) and audits previous/next', async () => {
    const list = await request(h.app).get('/api/apps/dwarf/users?search=newdwarf').set('Cookie', cookie);
    const id = list.body.items[0].id;

    const patch = await authed(request(h.app).patch(`/api/apps/dwarf/users/${id}`)).send({
      displayName: 'RenamedDwarf',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.displayName).toBe('RenamedDwarf');
    expect(patch.body.username).toBe('RenamedDwarf');

    // username is the same underlying field for Dwarf and must work as an alias.
    const patch2 = await authed(request(h.app).patch(`/api/apps/dwarf/users/${id}`)).send({
      username: 'RenamedAgain',
    });
    expect(patch2.status).toBe(200);
    expect(patch2.body.username).toBe('RenamedAgain');

    const audit = await auditRows(h, 'users.update');
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit[0]!.previous)).toContain('RenamedDwarf');
    expect(JSON.stringify(audit[0]!.new)).toContain('RenamedAgain');
  });

  it('rejects engine/auth-owned edits instead of silently ignoring them', async () => {
    const list = await request(h.app).get('/api/apps/dwarf/users?search=RenamedAgain').set('Cookie', cookie);
    const id = list.body.items[0].id;

    const email = await authed(request(h.app).patch(`/api/apps/dwarf/users/${id}`)).send({
      email: 'other@example.test',
    });
    expect(email.status).toBe(403);
    expect(email.body.error.code).toBe('UNSUPPORTED_CAPABILITY');

    const balance = await authed(request(h.app).patch(`/api/apps/dwarf/users/${id}`)).send({ balance: 42 });
    expect(balance.status).toBe(403);

    const mismatch = await authed(request(h.app).patch(`/api/apps/dwarf/users/${id}`)).send({
      username: 'One',
      displayName: 'Two',
    });
    expect(mismatch.status).toBe(400);
  });

  it('resets a password via the provisioned function (Argon2id, no plaintext anywhere)', async () => {
    const res = await authed(request(h.app).post(`/api/apps/dwarf/users/${PRINCIPAL}/reset-password`)).send({
      newPassword: 'principal-new-password-1',
    });
    expect(res.status).toBe(200);
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    const u = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM app_auth.users WHERE id = $1`,
      [PRINCIPAL],
    );
    await client.end();
    expect(await argon2.verify(u.rows[0]!.password_hash, 'principal-new-password-1')).toBe(true);

    const audit = await auditRows(h, 'users.reset_password');
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0])).not.toContain('principal-new-password-1');
    expect(JSON.stringify(audit[0])).not.toContain('$argon2id$');
  });

  it('disables and re-enables a user (disabled_at latch + session revocation + audit)', async () => {
    const created = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'ToggleMe',
      email: 'toggle@example.test',
      password: 'toggle-password-1',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // Live refresh session that disable must revoke.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query(`INSERT INTO app_auth.refresh_sessions (user_id) VALUES ($1)`, [id]);

    const off = await authed(request(h.app).post(`/api/apps/dwarf/users/${id}/disable`)).send({ disabled: true });
    expect(off.status).toBe(200);
    const s = await client.query<{ disabled_at: Date | null }>(
      `SELECT disabled_at FROM app_auth.users WHERE id = $1`,
      [id],
    );
    expect(s.rows[0]!.disabled_at).not.toBeNull();
    const sess = await client.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM app_auth.refresh_sessions WHERE user_id = $1`,
      [id],
    );
    expect(sess.rows[0]!.revoked_at).not.toBeNull();
    await client.end();

    const get = await request(h.app).get(`/api/apps/dwarf/users/${id}`).set('Cookie', cookie);
    expect(get.body.disabled).toBe(true);

    const on = await authed(request(h.app).post(`/api/apps/dwarf/users/${id}/disable`)).send({ disabled: false });
    expect(on.status).toBe(200);
    const get2 = await request(h.app).get(`/api/apps/dwarf/users/${id}`).set('Cookie', cookie);
    expect(get2.body.disabled).toBe(false);

    expect((await auditRows(h, 'users.disable')).length).toBe(1);
    expect((await auditRows(h, 'users.enable')).length).toBe(1);
  });

  it('refuses to disable the calling control-plane principal', async () => {
    const res = await authed(request(h.app).post(`/api/apps/dwarf/users/${PRINCIPAL}/disable`)).send({
      disabled: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/calling admin principal/i);
    const get = await request(h.app).get(`/api/apps/dwarf/users/${PRINCIPAL}`).set('Cookie', cookie);
    expect(get.body.disabled).toBe(false);
  });

  it('delete is supported since issue #11 but still refuses the calling principal', async () => {
    // Full delete coverage lives in dwarf-user-delete.test.ts; here we only
    // assert the placeholder behaviour is gone and the self-delete guard holds.
    const res = await authed(request(h.app).delete(`/api/apps/dwarf/users/${PRINCIPAL}`)).send({
      confirm: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/calling admin principal/i);
    const get = await request(h.app).get(`/api/apps/dwarf/users/${PRINCIPAL}`).set('Cookie', cookie);
    expect(get.status).toBe(200);
    expect((await auditRows(h, 'users.delete')).length).toBe(0);
  });

  it('enforces the admin-caller guard at the database (transaction-local app.user_id)', async () => {
    // A non-admin transaction-local identity must be rejected by the
    // provisioned functions themselves, independent of the adapter.
    const client = new pg.Client(adminUrlFor(h.dbName));
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, ['99999999-9999-9999-9999-999999999999']);
    await expect(
      client.query(`SELECT public.jdadmin_admin_create_user('sneaky@example.test', 'Sneaky', '$argon2id$x')`),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');

    // End-to-end over HTTP: if the configured principal loses its admin role,
    // the guard raises 42501 which maps to a generic 403 (no internals leak).
    await client.query(`UPDATE public.profiles SET role = 'player' WHERE id = $1`, [PRINCIPAL]);
    const res = await authed(request(h.app).post('/api/apps/dwarf/users')).send({
      username: 'NoRights',
      email: 'norights@example.test',
      password: 'norights-password-1',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).not.toMatch(/profiles|assert_admin/);
    await client.query(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [PRINCIPAL]);
    const u = await client.query(`SELECT count(*)::text AS count FROM app_auth.users WHERE email = 'norights@example.test'`);
    await client.end();
    expect(Number(u.rows[0]!.count)).toBe(0);
  });
});

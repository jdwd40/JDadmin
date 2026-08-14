import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TestHarness } from './helpers.js';

describe('audit log', () => {
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

  it('records mutations with actor, app, action, entity, prev/new', async () => {
    await authed(request(h.app).post('/api/apps/coins/users')).send({
      username: 'audited',
      password: 'audited-password-1',
    });
    const res = await request(h.app).get('/api/audit?appId=coins&action=users.create').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const entry = res.body.items[0];
    expect(entry.actorUsername).toBe('testadmin');
    expect(entry.appId).toBe('coins');
    expect(entry.action).toBe('users.create');
    expect(entry.entityType).toBe('user');
  });

  it('redacts password/token/hash fields in audit values', async () => {
    await authed(request(h.app).post('/api/apps/coins/users/2/reset-password')).send({
      newPassword: 'super-secret-value-99',
    });
    const res = await request(h.app).get('/api/audit?search=reset').set('Cookie', cookie);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain('super-secret-value-99');
    expect(dump).not.toContain('password_hash');
  });

  it('audit log is append-only at the database level', async () => {
    await expect(
      h.adminDb.query('UPDATE admin_audit_log SET action = $1 WHERE id = (SELECT min(id) FROM admin_audit_log)', [
        'tampered',
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.adminDb.query('DELETE FROM admin_audit_log WHERE id = (SELECT min(id) FROM admin_audit_log)'),
    ).rejects.toThrow(/append-only/);
  });

  it('supports pagination and app filter', async () => {
    const page1 = await request(h.app).get('/api/audit?page=1&pageSize=2').set('Cookie', cookie);
    expect(page1.body.items.length).toBeLessThanOrEqual(2);
    const filtered = await request(h.app).get('/api/audit?appId=admin').set('Cookie', cookie);
    for (const item of filtered.body.items) {
      expect(item.appId).toBe('admin');
    }
  });
});

describe('capability isolation and registry behavior', () => {
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

  it('lists apps with capability maps and availability', async () => {
    const res = await request(h.app).get('/api/apps').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const ids = res.body.apps.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['coins', 'dwarf', 'mock']));
    const coins = res.body.apps.find((a: { id: string }) => a.id === 'coins');
    expect(coins.available).toBe(true);
    expect(coins.capabilities.users.create).toBe(true);
    expect(coins.capabilities.users.disable).toBe(false);
    const dwarf = res.body.apps.find((a: { id: string }) => a.id === 'dwarf');
    expect(dwarf.available).toBe(true);
    expect(dwarf.capabilities.inventory.create).toBe(false);
    expect(dwarf.capabilities.users.resetPassword).toBe(true); // argon2 available in dev env
  });

  it('unknown app → 404', async () => {
    const res = await request(h.app).get('/api/apps/nope/users').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('Dwarf user delete-all is unsupported; mock user delete works (isolation)', async () => {
    const dwarfDelAll = await authed(
      request(h.app).post('/api/apps/dwarf/users/delete-all'),
    ).send({ phrase: 'DELETE ALL', expectedCount: 1 });
    expect(dwarfDelAll.status).toBe(403);
    expect(dwarfDelAll.body.error.code).toBe('UNSUPPORTED_CAPABILITY');

    const created = await authed(request(h.app).post('/api/apps/mock/users')).send({
      username: 'deleteme',
      password: 'delete-me-password-1',
    });
    const id = created.body.id;
    const ok = await authed(request(h.app).delete(`/api/apps/mock/users/${id}`)).send({
      confirmUsername: 'deleteme',
    });
    expect(ok.status).toBe(200);
  });

  it('Dwarf update accepts displayName but rejects balance writes (engine-owned)', async () => {
    const okRes = await authed(
      request(h.app).patch('/api/apps/dwarf/users/11111111-1111-1111-1111-111111111111'),
    ).send({ displayName: 'DwarfOneRenamed' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.displayName).toBe('DwarfOneRenamed');

    const badRes = await authed(
      request(h.app).patch('/api/apps/dwarf/users/11111111-1111-1111-1111-111111111111'),
    ).send({ balance: 5 });
    expect(badRes.status).toBe(403);
    expect(badRes.body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('health endpoint: liveness public, detail authed', async () => {
    const live = await request(h.app).get('/api/health');
    expect(live.status).toBe(200);
    expect(live.body.ok).toBe(true);

    const detailNoAuth = await request(h.app).get('/api/health/detail');
    expect(detailNoAuth.status).toBe(401);

    const detail = await request(h.app).get('/api/health/detail').set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.adminDb.ok).toBe(true);
    expect(detail.body.apps.coins.ok).toBe(true);
    expect(detail.body.apps.dwarf.ok).toBe(true);
  });
});

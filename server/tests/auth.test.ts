import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TestHarness } from './helpers.js';

describe('admin auth, sessions, CSRF, rate limiting', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness({ loginRateLimitMax: 3 });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('rejects bad credentials with 401 and no cookie', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ username: 'testadmin', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('logs in with valid credentials, sets httpOnly cookie, returns CSRF token', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ username: 'testadmin', password: 'test-admin-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.admin.username).toBe('testadmin');
    expect(res.body.csrfToken).toBeTruthy();
    const setCookie = res.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(res.body.admin.passwordHash).toBeUndefined();
  });

  it('rate limits repeated failed logins (429 after max attempts)', async () => {
    // Fresh username to get a fresh bucket; limit is 3/min in this harness.
    for (let i = 0; i < 3; i++) {
      const res = await request(h.app).post('/api/auth/login').send({ username: 'limited', password: 'nope-nope-nope' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(h.app).post('/api/auth/login').send({ username: 'limited', password: 'nope-nope-nope' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('requires auth for /api/apps', async () => {
    const res = await request(h.app).get('/api/apps');
    expect(res.status).toBe(401);
  });

  it('rejects mutations without CSRF token (403 CSRF_FAILED)', async () => {
    const { cookie } = await h.login();
    const res = await request(h.app)
      .post('/api/apps/mock/users')
      .set('Cookie', cookie)
      .send({ username: 'noccsrfuser', password: 'long-enough-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects mutations with wrong CSRF token', async () => {
    const { cookie } = await h.login();
    const res = await request(h.app)
      .post('/api/apps/mock/users')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'wrong')
      .send({ username: 'nocsrfuser2', password: 'long-enough-password' });
    expect(res.status).toBe(403);
  });

  it('rejects disallowed Origin header on mutations', async () => {
    const { cookie, csrf } = await h.login();
    const res = await request(h.app)
      .post('/api/apps/mock/users')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'https://evil.example')
      .send({ username: 'originuser', password: 'long-enough-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });

  it('accepts mutation with cookie + CSRF token + allowed origin', async () => {
    const { cookie, csrf } = await h.login();
    const res = await request(h.app)
      .post('/api/apps/mock/users')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:5173')
      .send({ username: 'csrfokuser', password: 'long-enough-password' });
    expect(res.status).toBe(201);
  });

  it('logout revokes the session', async () => {
    const { cookie, csrf } = await h.login();
    const out = await request(h.app).post('/api/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf);
    expect(out.status).toBe(200);
    const after = await request(h.app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('change-password verifies current password and revokes all sessions', async () => {
    const { cookie, csrf } = await h.login();
    const wrong = await request(h.app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ currentPassword: 'nope', newPassword: 'new-password-12345' });
    expect(wrong.status).toBe(401);

    const ok = await request(h.app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ currentPassword: 'test-admin-password-1', newPassword: 'new-password-12345' });
    expect(ok.status).toBe(200);
    // Old session revoked
    const after = await request(h.app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
    // New password works
    const relogin = await request(h.app).post('/api/auth/login').send({ username: 'testadmin', password: 'new-password-12345' });
    expect(relogin.status).toBe(200);
    // Hash stored is bcrypt, not plaintext, and never returned
    const row = await h.adminDb.query<{ password_hash: string }>(
      'SELECT password_hash FROM admin_users WHERE username = $1',
      ['testadmin'],
    );
    expect(row.rows[0]!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(row.rows[0]!.password_hash).not.toContain('new-password-12345');
  });

  it('validates login body (400 on missing fields)', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ username: '' });
    expect(res.status).toBe(400);
  });
});

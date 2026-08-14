#!/usr/bin/env node
/**
 * Deterministic end-to-end smoke check for Universal Admin.
 *
 * Runs the compiled server against a disposable database with the in-memory
 * mock adapter enabled, then exercises the core contract:
 *   liveness → login (cookie + CSRF) → app listing → CSRF rejection →
 *   capability-gated mutation → overview → audit trail → health detail →
 *   logout → session invalidation.
 *
 * Exits 0 on success, 1 on any failure. Requires `npm run build` first.
 * Uses the same disposable-DB pattern as the test harness: the local
 * jdadmin_test role (localhost-only, CREATEDB, disposable). Override with
 * JDADMIN_TEST_ADMIN_URL.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

// pg lives in the server workspace (hoisted to root node_modules by npm
// workspaces); resolve from the server so no root dependency is needed.
import { createRequire } from 'node:module';
const require = createRequire(path.join(SERVER, 'package.json'));
const { Client } = require('pg');

const ADMIN_URL =
  process.env.JDADMIN_TEST_ADMIN_URL ??
  'postgres://jdadmin_test:jdadmin_test_local_only@localhost:5432/postgres';
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}/api`;

const dbName = `jdadmin_smoke_${randomBytes(4).toString('hex')}`;
const adminUrlFor = (db) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

let serverProc = null;
let adminClient = null;

async function cleanup() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
  if (adminClient) {
    try {
      await adminClient.query(
        'SELECT pg_terminate_backends(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [dbName],
      );
      await adminClient.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } catch {
      /* best effort */
    }
    await adminClient.end().catch(() => undefined);
  }
}

async function request(method, url, { cookie, csrf, body, origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  // 1. Disposable database.
  adminClient = new Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${dbName}`);
  console.log(`smoke: created disposable database ${dbName}`);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    ADMIN_DATABASE_URL: adminUrlFor(dbName),
    COINS_DATABASE_URL: '',
    DWARF_DATABASE_URL: '',
    JDADMIN_ENABLE_MOCK: 'true',
    ALLOW_DESTRUCTIVE: 'true',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ADMIN_BOOTSTRAP_USERNAME: 'smoke_admin',
    ADMIN_BOOTSTRAP_PASSWORD: 'smoke-pass-12345',
  };

  // 2. Bootstrap admin (compiled script; dotenv won't override explicit env).
  await new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/scripts/create-admin.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`create-admin exited ${code}: ${out}`))));
  });
  check('create-admin bootstrap', true);

  // 3. Start the compiled server.
  serverProc = spawn('node', ['dist/index.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => (serverLog += d));
  serverProc.stderr.on('data', (d) => (serverLog += d));
  const up = await waitForHealth();
  check('liveness /api/health', up, up ? '' : serverLog.slice(-400));
  if (!up) throw new Error('server did not become healthy');

  // 4. Login.
  const login = await request('POST', `${BASE}/auth/login`, {
    body: { username: 'smoke_admin', password: 'smoke-pass-12345' },
  });
  const cookie = (login.setCookie ?? '').split(';')[0];
  const csrf = login.json?.csrfToken;
  check('login issues cookie + CSRF token', login.status === 200 && Boolean(cookie) && Boolean(csrf), `status=${login.status}`);
  if (!csrf) throw new Error('no CSRF token');

  // 5. Bad credentials rejected.
  const badLogin = await request('POST', `${BASE}/auth/login`, {
    body: { username: 'smoke_admin', password: 'wrong-password' },
  });
  check('bad credentials rejected', badLogin.status === 401, `status=${badLogin.status}`);

  // 6. App listing includes available mock.
  const apps = await request('GET', `${BASE}/apps`, { cookie });
  const mock = apps.json?.apps?.find((a) => a.id === 'mock');
  check('mock adapter registered + available', apps.status === 200 && mock?.available === true);
  const coins = apps.json?.apps?.find((a) => a.id === 'coins');
  check('unconfigured app shown unavailable (not faked)', coins && coins.available === false && Boolean(coins.availabilityError));

  // 7. CSRF enforcement.
  const noCsrf = await request('POST', `${BASE}/apps/mock/users`, {
    cookie,
    body: { username: 'nocsrfuser', password: 'password-123' },
  });
  check('mutation without CSRF header rejected', noCsrf.status === 403, `status=${noCsrf.status}`);
  const badOrigin = await request('POST', `${BASE}/apps/mock/users`, {
    cookie,
    csrf,
    origin: 'http://evil.example',
    body: { username: 'badorigin', password: 'password-123' },
  });
  check('mutation from foreign origin rejected', badOrigin.status === 403, `status=${badOrigin.status}`);

  // 8. Capability-gated mutation with CSRF succeeds.
  const created = await request('POST', `${BASE}/apps/mock/users`, {
    cookie,
    csrf,
    origin: 'http://localhost:5173',
    body: { username: 'smoke_user', email: 'smoke@example.com', password: 'password-123', balance: 10 },
  });
  check('create user via mock adapter', created.status === 201 && created.json?.username === 'smoke_user', `status=${created.status}`);

  // 9. Validation errors are 400 (not 500).
  const invalid = await request('POST', `${BASE}/apps/mock/users`, {
    cookie,
    csrf,
    body: { username: 'x' },
  });
  check('invalid body returns 400 validation error', invalid.status === 400 && invalid.json?.error?.code === 'BAD_REQUEST', `status=${invalid.status} code=${invalid.json?.error?.code}`);

  // 10. Overview + users list.
  const overview = await request('GET', `${BASE}/apps/mock/overview`, { cookie });
  check(
    'overview endpoint',
    overview.status === 200 && typeof overview.json?.users === 'number' && Array.isArray(overview.json?.assetsSparkline),
    `status=${overview.status}`,
  );
  const users = await request('GET', `${BASE}/apps/mock/users?page=1&pageSize=10`, { cookie });
  check('users list paginates', users.status === 200 && users.json?.total >= 1 && Array.isArray(users.json?.items));

  // 11. Audit trail recorded the mutation.
  const audit = await request('GET', `${BASE}/audit?appId=mock&page=1&pageSize=10`, { cookie });
  const sawCreate = audit.json?.items?.some((e) => e.action === 'users.create');
  check('audit trail records mutation', audit.status === 200 && sawCreate === true);

  // 12. Health detail (overall `ok` is false here by design: unconfigured
  // apps report unavailable, so assert the admin DB + mock specifically).
  const detail = await request('GET', `${BASE}/health/detail`, { cookie });
  check(
    'health detail ok',
    detail.status === 200 && detail.json?.adminDb?.ok === true && detail.json?.apps?.mock?.ok === true,
    `status=${detail.status}`,
  );

  // 13. Logout invalidates the session.
  const logout = await request('POST', `${BASE}/auth/logout`, { cookie, csrf });
  check('logout', logout.status === 200, `status=${logout.status}`);
  const afterLogout = await request('GET', `${BASE}/apps`, { cookie });
  check('session invalidated after logout', afterLogout.status === 401, `status=${afterLogout.status}`);
} catch (err) {
  console.error(`smoke: fatal — ${err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsmoke: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length === 0) console.log('smoke: OK');

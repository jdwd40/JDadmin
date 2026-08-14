# Universal Admin (JDadmin)

A single admin dashboard that manages multiple independent applications
(Coins, Dwarf Coins, …) through a **capability-based adapter** architecture.
The core (auth, sessions, CSRF, audit, rate limiting) is app-agnostic; each
application is a pluggable adapter that declares what it can do. The UI only
renders supported capabilities — unavailable or unsupported actions are shown
as disabled/absent, never faked.

## Repository layout

```
JDadmin/
├── server/            Express + TypeScript API (workspace @jdadmin/server)
│   ├── src/adapters/  coins.ts, dwarf.ts, mock.ts, registry.ts, types.ts
│   ├── src/core/      auth, audit, rate limit, errors
│   ├── src/http/      middleware (auth, CSRF, capability gates, errors)
│   ├── src/routes/    auth, apps, audit, health
│   ├── migrations/    admin core schema
│   └── tests/         disposable-DB integration tests (vitest)
├── web/               React + Vite SPA (workspace @jdadmin/web)
│   └── tests/         pure-logic contract tests (capabilities, pagination, confirms)
└── scripts/smoke.mjs  deterministic end-to-end smoke check
```

## Quick start (local development)

Prereqs: Node >= 20, local PostgreSQL.

```bash
npm install
cp .env.example server/.env   # fill in your values; never commit .env
                              # (server loads server/.env via dotenv at boot)

# one-off: create the disposable local test role used by the test harness
# (localhost-only role with CREATEDB, e.g. via: sudo -u postgres createuser jdadmin_test --createdb --pwprompt)

npm run migrate --workspace server        # applies server/migrations to ADMIN_DATABASE_URL
npm run create-admin --workspace server   # bootstrap first admin (env-driven)
npm run dev                               # server :4100 (tsx watch) + web :5173 (vite, /api proxied)
```

## Gates

```bash
npm test           # server integration tests (disposable DBs) + web logic tests
npm run typecheck  # tsc for both workspaces
npm run lint       # eslint (flat config at repo root)
npm run build      # server → server/dist, web → web/dist
npm run smoke      # end-to-end smoke against a disposable DB + mock adapter
```

All five must pass before deploy; `READY_FOR_DEPLOY` at the repo root records
the last verified run.

## Configuration (server/.env)

All values are read once at boot and validated with Zod (`server/src/config.ts`).
See `server/.env.example` for the full list. Key groups:

| Variable | Purpose |
|---|---|
| `PORT`, `NODE_ENV` | listen port / environment |
| `ADMIN_DATABASE_URL` | admin core DB (admin users, sessions, audit) |
| `COINS_DATABASE_URL` | Coins app DB; omit → app shown as unavailable |
| `COINS_SCHEMA` | optional schema namespace for Coins tables (defaults to search_path) |
| `DWARF_DATABASE_URL` | Dwarf Coins app DB; omit → unavailable |
| `SESSION_TTL_HOURS`, `COOKIE_SECURE`, `COOKIE_NAME` | session behaviour |
| `ALLOWED_ORIGINS` | comma-separated Origin allowlist for mutating requests |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS` | login brute-force limit |
| `ALLOW_DESTRUCTIVE` | master switch for destructive actions (delete user, price reset…) |
| `PRODUCTION_DESTRUCTIVE_ACK` | in production, destructive actions also require this exact phrase to be configured |
| `JDADMIN_ENABLE_MOCK` | enable the in-memory mock adapter (read at boot; never honoured in production) |
| `ADMIN_BOOTSTRAP_USERNAME`, `ADMIN_BOOTSTRAP_PASSWORD` | used only by `npm run create-admin` |

## Auth & session model

- httpOnly session cookie (server-side session row, revocable, TTL-bound).
- Double-submit CSRF: login returns a CSRF token kept in memory by the SPA and
  sent as `X-CSRF-Token` on every mutation. A fresh page load requires a fresh
  login — this is deliberate.
- Mutations with an `Origin` header outside `ALLOWED_ORIGINS` are rejected.
- Login is rate-limited per IP+username; all auth events are audited.
- Passwords: admin passwords are bcrypt-hashed; Coins app-user passwords are
  re-hashed with bcrypt and Dwarf's with argon2id on reset. Plaintext is never
  stored, returned, logged, or audited (audit values pass through a recursive
  redactor).

## API overview

All routes except `GET /api/health` and `POST /api/auth/login` require the
session cookie; mutations additionally require the CSRF header.

- `POST /api/auth/login` → `{ admin, csrfToken, expiresAt }`
- `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`
- `GET /api/apps` → registered apps with availability + capability sets
- `GET /api/apps/:appId/overview|assets|health`
- Users: `GET/POST /api/apps/:appId/users`, `GET/PATCH/DELETE /…/users/:id`,
  `POST /…/users/:id/disable`, `POST /…/users/:id/reset-password`,
  `GET /…/users/:id/related-counts`
- Inventory: `GET/POST /api/apps/:appId/inventory`, `PATCH/DELETE /…/inventory/:itemId`
- Transactions: `GET/POST /api/apps/:appId/transactions`
- Price history: `GET /…/price-history`, `GET /…/price-history/stats`,
  `GET /…/price-history/count`, `POST /…/price-history/delete-range`,
  `POST /…/price-history/reset`
- `GET /api/audit` (filterable, paginated; sensitive values redacted)
- `GET /api/health` (liveness), `GET /api/health/detail` (per-app DB health)

Errors are uniform: `{ error: { code, message, details? } }` with 400 for
validation failures, 401/403 for auth/CSRF, 404 unknown entity, 409 conflict,
429 rate limit, 501 unsupported capability.

## Deployment plan

1. Provision PostgreSQL databases: one admin DB plus each app DB. Create a
   least-privilege `jdadmin` role per DB (the admin DB role needs DDL for
   migrations; the app roles only need the tables the adapters touch).
2. `npm ci && npm run build`, set production env (`NODE_ENV=production`,
   `COOKIE_SECURE=true`, real URLs, `ALLOW_DESTRUCTIVE` per policy, mock OFF).
3. `npm run migrate` against the production admin DB; `npm run create-admin`
   once for the first operator account.
4. Run the API (`node server/dist/index.js`, port 4100) under a process
   manager (systemd or PM2).
5. Serve `web/dist/` from nginx; reverse-proxy `/api/` to the API. Same-site
   deployment keeps cookie auth simple (`COOKIE_SAMESITE=lax`).
6. Smoke-verify: `GET /api/health`, login round-trip, one read per app, one
   CSRF-rejection check.

## Backup / runbook

- **Backups**: `pg_dump` the admin DB (admin users, sessions, audit) and each
  app DB on the existing schedule for those apps. The admin DB is small and
  self-contained — a nightly dump is sufficient.
- **Revoke an operator**: delete their row in `admin_users` (or flip
  `disabled`) and delete their rows in `admin_sessions`.
- **Audit forensics**: everything mutating lands in `admin_audit_log` with
  actor, app, action, before/after (redacted), IP and user-agent.
- **Incident**: stop the service; sessions are server-side so stopping the DB
  instantly invalidates all access. Rotate DB credentials by updating env and
  restarting — no client state exists.
- **Recovery**: redeploy from git, restore the admin DB dump, re-run
  migrations (they are idempotent `IF NOT EXISTS`), re-create admins if needed.

## Test harness

`server/tests` uses disposable databases: each test file creates a fresh
`jdadmin_t_<rand>` database via the local `jdadmin_test` role (localhost-only,
CREATEDB, disposable — override with `JDADMIN_TEST_ADMIN_URL`), installs the
admin schema plus minimal per-app fixtures, runs the full HTTP stack against
it, and drops the database in teardown. The Coins fixture lives in a
`coins_app` schema (`COINS_SCHEMA`) so Coins and Dwarf fixtures can share one
disposable database without table-name collisions.

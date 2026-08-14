# KIMI_REPORT — Universal Admin completion pass (2026-08-14)

## What this pass did

### 1. Fixed the four issues left by the previous K3 pass

1. **`ZodError` not found in `server/src/http/middleware.ts`** — added
   `import { ZodError } from 'zod'` (value import, required for the
   `instanceof` runtime check). Typecheck now passes.
2. **Invalid Zod request bodies returned 500 instead of 400** — with the
   import fixed, the error middleware's `instanceof ZodError` branch now fires
   and maps validation failures to `400 { error: { code: 'BAD_REQUEST',
   details: [{path, message}] } }`. Verified live by the smoke script
   (invalid body → 400 BAD_REQUEST) and by the server test suite.
3. **`AdapterRegistry.close()` called `adapter.close()` on unavailable apps** —
   unavailable apps register inert stubs without lifecycle methods; `close()`
   now guards with a `Partial<AppAdapter>` capability check instead of calling
   blind. This removes the teardown cascades seen in the previous run.
4. **Test-harness schema collision (Coins + Dwarf both use `transactions`)** —
   the Coins adapter now accepts an optional, config-validated schema
   namespace (`COINS_SCHEMA`, `/^[A-Za-z_][A-Za-z0-9_]*$/`); the harness
   installs the Coins fixture into a `coins_app` schema and points the
   registry at it, so Coins and Dwarf fixtures coexist in one disposable DB.
   Raw fixture queries in tests were schema-qualified accordingly.

### 2. Completed the React frontend (`web/` workspace)

React 18 + Vite + TypeScript SPA, no router/chart dependencies:

- **Auth**: login page; httpOnly session cookie + in-memory CSRF token
  (`X-CSRF-Token` on every mutation); logout; unauthenticated requests bounce
  to login.
- **Capability-driven UI**: app selector lists registered apps including
  unavailable ones (with reason); nav items and every action button/dialog are
  rendered or disabled from the adapter's capability set — nothing is faked.
- **Pages**: Overview (stat cards, per-asset SVG sparklines, recent
  transactions), Users (search/sort/pagination, create, detail view with
  inventory + transactions tabs, edit, reset password, disable/enable,
  delete), Inventory (CRUD), Transactions (list + create buy/sell),
  Price history (list, stats, delete-range with pre-count, reset),
  Audit log (filter/paginate, previous/next JSON), Health (admin DB + per-app
  ping cards).
- **Destructive confirmations**: delete user requires typing the username
  (and shows related-record counts from `/related-counts` first);
  price-history delete-range requires an explicit confirm checkbox and shows
  the matched row count before committing; price-history reset requires typing
  `RESET`. All validators are pure functions in `web/src/lib/` and unit-tested.
- Frontend contract verified against the real server routes while building
  (response shapes for users, related-counts, price-history delete-range/reset
  bodies, health detail map, audit `{items,total}`), not assumed.

### 3. Docs

- `README.md` — architecture, quick start, gates, full env reference
  (verified against `server/src/config.ts`), auth/session model, API overview,
  deployment plan, backup/runbook, test-harness notes.
- `docs/ADAPTERS.md` — adapter contract rules, the real capability matrix for
  Coins/Dwarf/Mock (verified against adapter source), how to add a new app,
  mock adapter purpose.
- `.env.example` — added `COINS_SCHEMA` and `JDADMIN_ENABLE_MOCK`.

### 4. Smoke script

`scripts/smoke.mjs` (`npm run smoke`): creates a disposable database via the
local test role, bootstraps an admin, starts the **compiled** server with the
mock adapter, and runs 16 contract checks: liveness, login/CSRF issuance, bad
credentials, app availability honesty, CSRF + origin rejection, capability
gated mutation, 400-on-invalid-body, overview, pagination, audit trail, health
detail, logout and session invalidation. Cleans up process + database on
exit. Non-zero exit on any failure.

## Gate results (this pass, all from real runs)

| Gate | Result |
|---|---|
| `npm test --workspace server` | 48/48 passed (7 files, disposable-DB integration) |
| `npm test --workspace web` | 15/15 passed (capabilities, pagination, confirms) |
| `npm run typecheck` (both workspaces) | clean |
| `npm run lint` (both workspaces, ESLint 9 + typescript-eslint flat config) | clean |
| `npm run build` | server `dist/` + web `dist/` (182.9 kB JS, 55 kB gzip) |
| `npm run smoke` | 16/16 checks passed |

## Not done / deliberate exclusions

- No push, no deploy, no live-system changes, no secrets read (per task).
- The web UI has no component-level rendering tests; coverage is via
  pure-logic contract tests (selector, capability nav, confirmations,
  pagination) plus the end-to-end smoke script. Adding jsdom/testing-library
  render tests is a reasonable follow-up but not required by the task gates.
- `web/dist` is built but not wired into any live nginx config — deployment
  steps are documented in README.

## Notes for the reviewer

- The disposable-DB harness and smoke script use the local `jdadmin_test`
  PostgreSQL role (localhost-only, CREATEDB, disposable). Override with
  `JDADMIN_TEST_ADMIN_URL`.
- Tooling note: this repo's lockfile had a stale `web/node_modules/vite@6`
  entry conflicting with the hoisted vite@5 from vitest; the lock entry was
  removed so vite dedupes to 5.4.21 (fixed the `tsc -b` config-type clash).

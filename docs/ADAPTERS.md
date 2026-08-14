# Adapter contract

Every managed application implements `AppAdapter`
(`server/src/adapters/types.ts`). The core gates **every** call on the
adapter's declared `capabilities` before invoking it, so an adapter can never
be called for something it said it cannot do.

## Rules for adapters

1. **Static identifiers only.** Table/column mappings are hardcoded constants;
   request input only ever lands in parameterized values. Optional schema
   names come from validated server configuration (`/^[A-Za-z_][A-Za-z0-9_]*$/`),
   never from requests.
2. **Capabilities are honest.** Set a flag `false` and omit (or throw from)
   the matching method. The UI renders exactly what the flags declare.
3. **Capability probes.** `ping()` must be cheap and must not mutate.
4. **Resource probes (issue #4).** Optional `resourceUsage()` returns read-only
   storage/memory samples with an explicit scope label (app database, app
   process, host-wide, …). Every sample has a status: `ok`, `stale` (last good
   values after a failed refresh), or `unavailable` (all byte fields null +
   sanitized reason). Unavailable is never represented as zero, and raw
   driver/OS error text never reaches the response (fixed reason vocabulary:
   `permission denied`, `malformed measurement`, `measurement failed`).
   Probes use static SQL / fixed system paths only, and the health route
   caches measurements for 30s to bound cost.
5. **Audit is the core's job.** Adapters return data; routes record the audit
   entry with actor, app, action, previous/next (auto-redacted).
6. **Destructive gates.** Delete/reset methods additionally pass through
   `requireDestructiveEnabled` (ALLOW_DESTRUCTIVE) and per-route confirmation
   schemas in the HTTP layer.

## Current capability matrix

| Capability | Coins | Dwarf Coins | Mock |
|---|---|---|---|
| overview | ✓ | ✓ | ✓ |
| users list/get/update/resetPassword | ✓ | ✓ | ✓ |
| users create | ✓ | ✓ (provisioned `jdadmin_admin_create_user` → `app_auth.register_user`, the app's own registration flow) | ✓ |
| users disable | ✗ (no column; schema must not be migrated) | ✓ (`app_auth.users.disabled_at` + refresh-session revocation) | ✓ |
| users delete (+ related counts) | ✓ cascade | ✗ (engine/auth FK graph cascades into the append-only ledger; no safe function exists — disable instead) | ✓ |
| users deleteAll (transactional, phrase + exact-count confirmed) | ✓ one transaction over portfolios → transactions → users, full rollback on FK errors | ✗ (same FK graph as user delete) | ✓ |
| inventory list | ✓ portfolios | ✓ holdings (read-only) | ✓ |
| inventory create/update/delete | ✓ | ✗ (engine owns writes) | ✓ |
| transactions list | ✓ | ✓ (read-only) | ✓ |
| transactions create | ✓ (funds + holding in one tx) | ✗ | ✓ |
| transactions update/delete | ✗ (ledger integrity) | ✗ | ✗ |
| priceHistory list/stats | ✓ | ✓ | ✓ |
| priceHistory delete (individual record) | ✓ | ✓ (provisioned `jdadmin_admin_delete_price_point`) | ✓ |
| priceHistory deleteRange/reset | ✓ (reset requires exact-count confirmation) | ✓ (provisioned `jdadmin_admin_delete_price_history_range` / `jdadmin_admin_reset_price_history`; range refuses unfiltered calls) | ✓ |

Dwarf's `users.resetPassword` and `users.create` degrade to false at runtime
if the optional `argon2` dependency cannot be loaded (capability computed at
boot). `users.create`/`users.disable`/`users.resetPassword` additionally
require the Dwarf-side provisioning scripts `ops/dwarf/001_jdadmin_principal.sql`
and `ops/dwarf/002_jdadmin_user_admin.sql` to have been applied by the Dwarf
owner role; they create the SECURITY DEFINER control-plane functions the
adapter calls (granted to `dc_api` only). Dwarf's `priceHistory.delete`/
`deleteRange`/`reset` additionally require `ops/dwarf/003_jdadmin_price_history_admin.sql`
(issue #10); those wrappers re-check `public.assert_admin_caller()` and mirror
the engine's own `prune_old_data` retention deletes — engine-owned OHLC
aggregates and the transactions ledger are never touched.

Issue #10 delete-all operations (`users.deleteAll`, `priceHistory.reset`) are
never unfiltered at the HTTP layer: they require the destructive guard, an
exact confirmation phrase, and the exact current in-scope row count, which the
server re-validates immediately before executing inside one transaction.

Unavailable apps (missing DB URL or failed registration) appear in
`GET /api/apps` with `available: false` and an `availabilityError`; their
adapter is an inert stub with all capabilities off.

## Adding a new application

1. Create `server/src/adapters/<app>.ts` implementing `AppAdapter`. Reuse
   `sql.ts` helpers (`AppPool`, `orderByClause`, `pageClause`) — they keep
   identifiers static and values parameterized.
2. Register it in `AdapterRegistry.build` (guarded by its env URL; register an
   "unavailable" stub otherwise).
3. Add the env var to `server/src/config.ts` (Zod) and `server/.env.example`.
4. Add a minimal schema fixture to `server/tests/helpers.ts` (own schema if
   table names could collide) plus integration tests for every capability.
5. The web UI needs **no changes** — it renders from the capability set.

## The mock adapter

`mock.ts` is an in-memory adapter with full capabilities, enabled only when
`JDADMIN_ENABLE_MOCK=true` and `NODE_ENV !== 'production'`. It exists for
frontend development, the smoke script, and as the reference implementation
for the capability contract.

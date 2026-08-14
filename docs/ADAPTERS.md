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
4. **Audit is the core's job.** Adapters return data; routes record the audit
   entry with actor, app, action, previous/next (auto-redacted).
5. **Destructive gates.** Delete/reset methods additionally pass through
   `requireDestructiveEnabled` (ALLOW_DESTRUCTIVE) and per-route confirmation
   schemas in the HTTP layer.

## Current capability matrix

| Capability | Coins | Dwarf Coins | Mock |
|---|---|---|---|
| overview | ✓ | ✓ | ✓ |
| users list/get/update/resetPassword | ✓ | ✓ | ✓ |
| users create | ✓ | ✗ (app registration flow owns it) | ✓ |
| users disable | ✗ (no column; schema must not be migrated) | ✗ (no concept) | ✓ |
| users delete (+ related counts) | ✓ cascade | ✗ (engine/auth FK graph) | ✓ |
| inventory list | ✓ portfolios | ✓ holdings (read-only) | ✓ |
| inventory create/update/delete | ✓ | ✗ (engine owns writes) | ✓ |
| transactions list | ✓ | ✓ (read-only) | ✓ |
| transactions create | ✓ (funds + holding in one tx) | ✗ | ✓ |
| transactions update/delete | ✗ (ledger integrity) | ✗ | ✗ |
| priceHistory list/stats | ✓ | ✓ | ✓ |
| priceHistory deleteRange/reset | ✓ | ✗ | ✓ |

Dwarf's `users.resetPassword` degrades to false at runtime if the optional
`argon2` dependency cannot be loaded (capability computed at boot).

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

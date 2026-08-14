# Universal Admin Dashboard — Kimi K3 implementation brief

## Mission
Build a working standalone Universal Admin application in `/home/jd/work/JDadmin` for Coins and Dwarf Coins. The repository currently has an empty GitHub remote; create the complete project locally. Use one shared admin core plus registered app adapters. Do not build two separate dashboards.

## Evidence already inspected (read source repositories yourself before coding)
- Coins frontend: `/home/jd/work/fcoins_y`, Vite React TS, `/coins/`; backend: `/home/jd/work/back_coins_x`, Express/Node/pg/JWT/bcrypt, port 3000/PM2. Legacy tables: `users(user_id,username,email,password_hash,funds,created_at,updated_at)`, `coins`, `portfolios(user_id,coin_id,quantity,...)`, `transactions`, `price_history`; migration target uses Supabase `coins.profiles`, `coins.wallets`, `coins.holdings`, immutable `coins.trades`, `coins.price_ticks`, `coins.price_candles`, etc. Existing working databases must not be redesigned.
- Dwarf Coins source: `/home/jd/work/dwarf-gem-exchange-kimi/repo`; production route `/dc/`, bespoke backend has `backend/src/modules/admin/routes.ts`, auth is Argon2id plus short-lived access/rotating sessions, current schema includes `public.profiles`, `public.portfolio_holdings`, `public.transactions`, `public.price_history`, `public.gems`, and `app_auth.users`. Existing Dwarf admin API is incomplete for this dashboard; preserve application behavior.
- Deployment evidence: Coins backend auto-deploys on push to main, frontend on master; Dwarf uses systemd/Nginx and `/dc/`. Do not touch those deployments during this implementation.

## Required architecture
- React + TypeScript frontend, Node.js backend/API, PostgreSQL (`pg`), responsive desktop-first SaaS admin UI.
- Admin core owns auth, sessions, CSRF, rate limiting, validation, audit log, routing, capability discovery, pagination, confirmation flows.
- Adapters are isolated modules with a clear interface (users, inventory, transactions, price history, overview, optional capabilities). UI renders only supported capabilities. Register Coins and Dwarf Coins; adding a future adapter must not require core/UI rewrite.
- Prefer server-side direct DB adapters using separate read/write connection configuration per app; never expose DB URLs to frontend. Make table/schema mappings explicit and avoid arbitrary SQL endpoints. All SQL parameterized; identifiers come only from static adapter definitions.
- Admin auth is separate from application users: no public registration; admin credentials stored in an admin database table with Argon2id/bcrypt hash, secure httpOnly sameSite session cookie, CSRF protection, authentication rate limiting. Password reset/change never displays or logs hashes/plaintext.
- Audit log is append-only / not editable in UI; record actor, app, action, entity, previous/new safe values, timestamp, request metadata where safe. Redact passwords/tokens.
- Destructive actions: authorization, validation, explicit confirmation and RESET phrase for price-history reset; count before deletion; transactional deletes; no production destructive actions during dev.

## Functional acceptance
Overview cards and lightweight charts; app selector; paginated/searchable/sortable/filterable users; create/edit/delete/disable/enable/reset password where adapter capability supports; user detail tabs with inventory and transactions; CRUD inventory; transaction CRUD only through adapter transaction methods that preserve consistency or reject unsafe direct edits; price history stats/filtered inspection/selective deletion/reset only history; audit log; system/database health. Show related-data consequences before delete. Dwarf capabilities can initially be read-only for unsupported operations but the app must clearly show capability state, not fake success.

## Safety/non-goals
- Do not read secrets, production env values, private keys, or mutate live databases, services, firewall, Nginx, DNS, Coins/Dwarf repos, or deployments. Do not push. Do not add generic arbitrary SQL.
- Use local disposable PostgreSQL or a deterministic in-memory/mock adapter test harness. Add `.env.example`, production configuration docs, backup/runbook instructions, and guards refusing destructive operations unless `NODE_ENV=production` plus explicit config and confirmation.
- Do not make unnecessary migrations in Coins or Dwarf. The admin app may have its own additive schema for admins, sessions, audit logs.

## Tests/gates required before declaring ready
- Backend tests for admin auth, rate limit/permission, CSRF, users, password change/reset hashing, inventory CRUD, transaction consistency/rollback, price stats/reset isolation, adapter capability isolation, audit logging, destructive confirmations.
- Frontend tests or contract checks for selector, capability-aware navigation, confirmation dialogs and pagination.
- `npm test`, typecheck/lint, production build; health endpoint and a deterministic smoke script against a disposable test DB/mock adapters. README with exact local setup, env names, migration and deployment plan. Ensure no secrets tracked.

## Deliverables
Complete source, migrations, tests, health endpoint, smoke test, README, adapter docs, and a `READY_FOR_DEPLOY` marker only after independent gates pass. Leave changes local/unpushed. Report files, commands/results, known limitations, and exact credentials/configuration still required for a separately approved deployment.

## Work style
Take ownership and implement end-to-end without stopping for minor decisions. Inspect existing repos/schema/auth/deployment evidence before coding. Do not create speculative production migrations. If genuinely blocked by missing credentials or an unsafe ambiguity, write `BLOCKED.md` with evidence and stop.

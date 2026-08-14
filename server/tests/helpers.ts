import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import type { Express } from 'express';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { buildApp } from '../src/app.js';
import { AppConfig, loadConfig } from '../src/config.js';
import { AdminDb } from '../src/db/adminDb.js';

/**
 * Disposable-database test harness. Uses the local jdadmin_test role
 * (CREATEDB) to create a throwaway database per test file, installs the
 * admin schema plus minimal Coins/Dwarf app schemas, and builds the app.
 */

const ADMIN_URL =
  process.env.JDADMIN_TEST_ADMIN_URL ??
  'postgres://jdadmin_test:jdadmin_test_local_only@localhost:5432/postgres';

export function adminUrlFor(dbName: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Schema the Coins fixture is installed into; raw test queries must qualify with it. */
export const COINS_SCHEMA = 'coins_app';

export async function createDisposableDb(): Promise<string> {
  const name = `jdadmin_t_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client(ADMIN_URL);
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  return name;
}

export async function dropDisposableDb(name: string): Promise<void> {
  const client = new pg.Client(ADMIN_URL);
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.end();
}

/** Minimal legacy Coins schema (mirrors back_coins_x migrations). */
export const COINS_SCHEMA_SQL = `
CREATE TABLE users (
  user_id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  funds DECIMAL(18, 2) DEFAULT 1000.00 NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE coins (
  coin_id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  symbol VARCHAR(10) UNIQUE NOT NULL,
  current_price DECIMAL(18, 2) NOT NULL,
  supply INT NOT NULL,
  market_cap DECIMAL(18, 2) NOT NULL,
  date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);
CREATE TABLE portfolios (
  portfolio_id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
  coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
  quantity DECIMAL(18, 2) DEFAULT 0,
  average_purchase_price DECIMAL(18, 2) DEFAULT 0,
  UNIQUE(user_id, coin_id)
);
CREATE TABLE transactions (
  transaction_id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
  coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
  type VARCHAR(10) CHECK (type IN ('BUY', 'SELL', 'buy', 'sell')) NOT NULL,
  quantity DECIMAL(18, 2) NOT NULL,
  price DECIMAL(18, 2) NOT NULL,
  total_amount DECIMAL(18, 2) NOT NULL,
  transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE price_history (
  history_id SERIAL PRIMARY KEY,
  coin_id INT REFERENCES coins(coin_id) ON DELETE CASCADE,
  price DECIMAL(18, 2) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO users (username, email, password_hash, funds) VALUES
  ('alice', 'alice@example.test', '$2a$12$placeholderplaceholderplaceholderplaceholderplaceholde', 500),
  ('bob', 'bob@example.test', '$2a$12$placeholderplaceholderplaceholderplaceholderplaceholde', 2500);
INSERT INTO coins (name, symbol, current_price, supply, market_cap) VALUES
  ('Alpha Coin', 'ALPHA', 10, 1000, 10000),
  ('Beta Coin', 'BETA', 20, 500, 10000);
INSERT INTO portfolios (user_id, coin_id, quantity, average_purchase_price) VALUES
  (1, 1, 5, 9.5),
  (2, 2, 3, 18);
INSERT INTO transactions (user_id, coin_id, type, quantity, price, total_amount) VALUES
  (1, 1, 'BUY', 5, 9.5, 47.5),
  (2, 2, 'BUY', 3, 18, 54);
INSERT INTO price_history (coin_id, price, recorded_at) VALUES
  (1, 9.0, '2026-01-01T00:00:00Z'),
  (1, 9.5, '2026-01-02T00:00:00Z'),
  (1, 10.0, '2026-01-03T00:00:00Z'),
  (2, 19.0, '2026-01-01T00:00:00Z'),
  (2, 20.0, '2026-01-02T00:00:00Z');
`;

/** Minimal Dwarf bespoke schema (mirrors dwarf-gem-exchange-kimi baseline). */
export const DWARF_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app_auth;
CREATE TABLE app_auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  display_name text,
  password_hash text,
  legacy_password_hash text,
  password_changed_at timestamptz,
  confirmed_at timestamptz,
  disabled_at timestamptz,
  password_reset_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE TABLE app_auth.refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_auth.auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES app_auth.users(id) ON DELETE CASCADE,
  display_name text,
  role text NOT NULL DEFAULT 'player',
  bankruptcy_count integer NOT NULL DEFAULT 0,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  dcoin_balance numeric NOT NULL DEFAULT 0,
  loan_debt numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.gems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  symbol text NOT NULL,
  base_price numeric NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.portfolio_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gem_id uuid NOT NULL,
  amount_grams numeric NOT NULL DEFAULT 0,
  average_buy_price numeric NOT NULL DEFAULT 0,
  reserved_grams numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gem_id uuid,
  type text NOT NULL,
  amount_dcoins numeric NOT NULL,
  amount_grams numeric,
  execution_price numeric,
  fee_amount numeric,
  trade_source text DEFAULT 'market',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gem_id uuid NOT NULL,
  price numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_auth.users (id, email, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'dwarf1@example.test', 'DwarfOne');
INSERT INTO public.profiles (id, display_name, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'DwarfOne', 'admin');
INSERT INTO public.wallets (user_id, dcoin_balance) VALUES
  ('11111111-1111-1111-1111-111111111111', 777);
INSERT INTO public.gems (id, name, symbol, base_price, sort_order) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Ruby', 'RUBY', 100, 1);
INSERT INTO public.portfolio_holdings (user_id, gem_id, amount_grams, average_buy_price) VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 10, 95);
INSERT INTO public.transactions (user_id, gem_id, type, amount_dcoins, amount_grams, execution_price) VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'buy', 950, 10, 95);
INSERT INTO public.price_history (gem_id, price, recorded_at) VALUES
  ('22222222-2222-2222-2222-222222222222', 95, '2026-01-01T00:00:00Z'),
  ('22222222-2222-2222-2222-222222222222', 100, '2026-01-02T00:00:00Z');
`;

/**
 * Minimal mirrors of the Dwarf engine/auth functions the adapter relies on,
 * plus the JDadmin-provisioned control-plane functions (ops/dwarf/001 + 002).
 * Kept faithful to the real bodies so tests exercise the actual guard logic:
 * transaction-local app.user_id → profiles.role='admin' enforcement,
 * Argon2id-only hash acceptance, starter-package creation via the engine hook,
 * and disabled_at + session-revocation semantics.
 */
export const DWARF_FUNCTIONS_SQL = `
CREATE FUNCTION public.current_player_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO pg_catalog
AS $fn$
DECLARE
  v_raw text := nullif(pg_catalog.current_setting('app.user_id', true), '');
BEGIN
  IF v_raw IS NULL THEN
    RAISE EXCEPTION 'Player identity is not set for this transaction' USING ERRCODE = '42501';
  END IF;
  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Player identity is invalid' USING ERRCODE = '42501';
  END;
END;
$fn$;

CREATE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_uid uuid;
BEGIN
  BEGIN
    v_uid := public.current_player_id();
  EXCEPTION
    WHEN insufficient_privilege OR invalid_text_representation THEN
      RETURN false;
  END;
  RETURN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role = 'admin');
END;
$fn$;

CREATE FUNCTION public.assert_admin_caller() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog, public
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;
END;
$fn$;

-- Engine hook: creates the starter profile + wallet for the transaction-local
-- user (fixture version of the real starter package).
CREATE FUNCTION public.create_player_starter_package() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public, app_auth
AS $fn$
DECLARE
  v_uid uuid := public.current_player_id();
BEGIN
  INSERT INTO public.profiles (id, display_name, role)
    SELECT u.id, u.display_name, 'player' FROM app_auth.users u WHERE u.id = v_uid
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.wallets (user_id, dcoin_balance) VALUES (v_uid, 1000)
    ON CONFLICT (user_id) DO NOTHING;
END;
$fn$;

CREATE FUNCTION app_auth.public_user(p_user app_auth.users) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path TO pg_catalog, app_auth
AS $fn$
  SELECT jsonb_build_object(
    'id', p_user.id,
    'email', p_user.email,
    'display_name', p_user.display_name,
    'confirmed_at', p_user.confirmed_at,
    'created_at', p_user.created_at,
    'updated_at', p_user.updated_at
  );
$fn$;

-- The real registration flow (mirrors 1784057600000_self_hosted_auth.sql).
CREATE FUNCTION app_auth.register_user(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_password_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, app_auth, public
AS $fn$
DECLARE
  created_user app_auth.users;
BEGIN
  IF p_user_id IS NULL
     OR p_email IS NULL
     OR p_email <> lower(btrim(p_email))
     OR length(p_email) > 254 THEN
    RAISE EXCEPTION 'Invalid normalized email' USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NOT NULL
     AND (btrim(p_display_name) = '' OR length(p_display_name) > 80) THEN
    RAISE EXCEPTION 'Invalid display name' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash !~ '^\\$argon2id\\$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_auth.users (
    id, email, display_name, confirmed_at, password_hash,
    password_changed_at, created_at, updated_at
  ) VALUES (
    p_user_id, p_email, NULLIF(btrim(p_display_name), ''), now(), p_password_hash,
    now(), now(), now()
  )
  RETURNING * INTO created_user;

  INSERT INTO app_auth.identities (user_id, provider, provider_subject)
  VALUES (p_user_id, 'email', p_email);

  PERFORM set_config('app.user_id', p_user_id::text, true);
  PERFORM public.create_player_starter_package();

  INSERT INTO app_auth.auth_events (user_id, event_type)
  VALUES (p_user_id, 'registered');

  RETURN app_auth.public_user(created_user);
END;
$fn$;

CREATE FUNCTION app_auth.revoke_user_sessions_admin(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, app_auth
AS $fn$
DECLARE
  v_count integer;
BEGIN
  UPDATE app_auth.refresh_sessions
     SET revoked_at = now(),
         revocation_reason = COALESCE(revocation_reason, 'admin_disable')
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$fn$;

-- ops/dwarf/001_jdadmin_principal.sql
CREATE FUNCTION public.jdadmin_admin_reset_password(p_user_id uuid, p_password_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, app_auth, pg_catalog
AS $fn$
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_password_hash IS NULL OR p_password_hash !~ '^\\$argon2id\\$' THEN
    RAISE EXCEPTION 'Only Argon2id password hashes are accepted';
  END IF;
  UPDATE app_auth.users
     SET password_hash = p_password_hash,
         legacy_password_hash = NULL,
         password_changed_at = now(),
         password_reset_required = false,
         updated_at = now()
   WHERE id = p_user_id;
  RETURN FOUND;
END;
$fn$;

-- ops/dwarf/002_jdadmin_user_admin.sql
CREATE FUNCTION public.jdadmin_admin_create_user(
  p_email text,
  p_display_name text,
  p_password_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, app_auth, pg_catalog
AS $fn$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_email IS NULL OR p_email <> lower(btrim(p_email)) OR length(p_email) > 254 THEN
    RAISE EXCEPTION 'Invalid normalized email';
  END IF;
  IF p_display_name IS NOT NULL
     AND (btrim(p_display_name) = '' OR length(p_display_name) > 80) THEN
    RAISE EXCEPTION 'Invalid display name';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash !~ '^\\$argon2id\\$' THEN
    RAISE EXCEPTION 'Only Argon2id password hashes are accepted';
  END IF;
  RETURN app_auth.register_user(v_id, p_email, p_display_name, p_password_hash);
END;
$fn$;

CREATE FUNCTION public.jdadmin_admin_set_user_disabled(p_user_id uuid, p_disabled boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, app_auth, pg_catalog
AS $fn$
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_disabled AND p_user_id = public.current_player_id() THEN
    RAISE EXCEPTION 'Refusing to disable the calling admin principal';
  END IF;
  UPDATE app_auth.users
     SET disabled_at = CASE WHEN p_disabled THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_disabled THEN
    PERFORM app_auth.revoke_user_sessions_admin(p_user_id);
  END IF;
  RETURN true;
END;
$fn$;
`;

export interface TestHarness {
  dbName: string;
  app: Express;
  adminDb: AdminDb;
  registry: AdapterRegistry;
  config: AppConfig;
  cleanup: () => Promise<void>;
  /** Logs in as the seeded admin and returns cookie + CSRF token. */
  login: () => Promise<{ cookie: string; csrf: string }>;
}

export interface HarnessOptions {
  withCoins?: boolean;
  withDwarf?: boolean;
  withMock?: boolean;
  allowDestructive?: boolean;
  loginRateLimitMax?: number;
  adminUsername?: string;
  adminPassword?: string;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<TestHarness> {
  const dbName = await createDisposableDb();
  const url = adminUrlFor(dbName);
  const adminDb = new AdminDb(url);
  await adminDb.migrate();

  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '4199',
    ADMIN_DATABASE_URL: url,
    COINS_DATABASE_URL: opts.withCoins ? url : undefined,
    COINS_SCHEMA: opts.withCoins ? COINS_SCHEMA : undefined,
    DWARF_DATABASE_URL: opts.withDwarf ? url : undefined,
    DWARF_ADMIN_PRINCIPAL_ID: opts.withDwarf ? '11111111-1111-1111-1111-111111111111' : undefined,
    ALLOW_DESTRUCTIVE: opts.allowDestructive === false ? 'false' : 'true',
    LOGIN_RATE_LIMIT_MAX: String(opts.loginRateLimitMax ?? 5),
    LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
    COOKIE_SECURE: 'false',
  });

  // Install app schemas into the same disposable DB when requested. Coins goes
  // into its own schema so its `transactions`/`price_history` tables cannot
  // collide with the Dwarf `public.transactions`/`public.price_history`.
  const client = new pg.Client(url);
  await client.connect();
  if (opts.withCoins) {
    await client.query(`CREATE SCHEMA ${COINS_SCHEMA}`);
    await client.query(`SET search_path TO ${COINS_SCHEMA}, public`);
    await client.query(COINS_SCHEMA_SQL);
    await client.query('SET search_path TO public');
  }
  if (opts.withDwarf) {
    await client.query(DWARF_SCHEMA_SQL);
    await client.query(DWARF_FUNCTIONS_SQL);
  }
  await client.end();

  const registry = await AdapterRegistry.build({ ...config, enableMock: opts.withMock ?? true });
  const { app, ctx } = buildApp({ config, adminDb, registry });

  const username = opts.adminUsername ?? 'testadmin';
  const password = opts.adminPassword ?? 'test-admin-password-1';
  await ctx.auth.createUser(username, password);

  return {
    dbName,
    app,
    adminDb,
    registry,
    config,
    cleanup: async () => {
      await registry.close();
      await adminDb.close();
      await dropDisposableDb(dbName);
    },
    login: async () => {
      const res = await request(app).post('/api/auth/login').send({ username, password });
      if (res.status !== 200) throw new Error(`login failed in harness: ${res.status} ${JSON.stringify(res.body)}`);
      const setCookie = res.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
      return { cookie, csrf: res.body.csrfToken as string };
    },
  };
}

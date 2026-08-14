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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
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
  if (opts.withDwarf) await client.query(DWARF_SCHEMA_SQL);
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

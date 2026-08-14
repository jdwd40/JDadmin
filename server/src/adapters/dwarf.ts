import { ApiError } from '../core/errors.js';
import { AppPool, num, orderByClause, pageClause } from './sql.js';
import type {
  AppAdapter,
  AppHealth,
  AssetInfo,
  CapabilitySet,
  ListQuery,
  OverviewData,
  Paged,
  PriceHistoryQuery,
  PricePoint,
  PriceStats,
  TransactionItem,
  UserCreateInput,
  UserDetail,
  UserSummary,
  UserUpdateInput,
} from './types.js';

/**
 * Dwarf Coins adapter — targets the bespoke self-hosted schema (read-only
 * inspection of /home/jd/work/dwarf-gem-exchange-kimi/repo/database/baseline
 * and backend/migrations/1784057600000_self_hosted_auth.sql):
 *   public.profiles(id uuid, display_name, role, ...)
 *   public.wallets(id, user_id, dcoin_balance, loan_debt, ...)
 *   public.portfolio_holdings(id, user_id, gem_id, amount_grams, average_buy_price, ...)
 *   public.transactions(id uuid, user_id, gem_id, type, amount_dcoins, amount_grams, ...)
 *   public.price_history(id, gem_id, price, recorded_at)
 *   public.gems(id, name, symbol, base_price, ...)
 *   app_auth.users(id, email, display_name, password_hash(argon2id), ...)
 *
 * The market engine owns wallets/holdings/ledger via PostgreSQL functions and
 * locking. Direct writes would bypass those invariants, so inventory and
 * transactions are deliberately READ-ONLY here. User profile display_name
 * update and password reset are safe.
 *
 * User creation is supported via the provisioned SECURITY DEFINER wrapper
 * public.jdadmin_admin_create_user (ops/dwarf/002_jdadmin_user_admin.sql),
 * which delegates to app_auth.register_user — the app's own registration flow
 * (engine starter package, identity rows, registration event). Passwords are
 * hashed server-side with Argon2id; plaintext never reaches the database.
 *
 * Disable/enable is supported via app_auth.users.disabled_at (the schema's
 * own access latch honoured by every login/session path) plus refresh-session
 * revocation, through public.jdadmin_admin_set_user_disabled.
 *
 * User deletion remains UNSUPPORTED: profiles.id anchors engine-owned wallets,
 * holdings, limit orders and the append-only transactions ledger via cascading
 * FKs, and Dwarf has no delete-user function. Deleting would destroy financial
 * history, so the capability stays false instead of being faked.
 */

const T = {
  profiles: 'public.profiles',
  wallets: 'public.wallets',
  holdings: 'public.portfolio_holdings',
  transactions: 'public.transactions',
  priceHistory: 'public.price_history',
  gems: 'public.gems',
  authUsers: 'app_auth.users',
} as const;

export function dwarfCapabilities(argon2Available: boolean, adminPrincipalConfigured = true): CapabilitySet {
  const enabled = adminPrincipalConfigured;
  return {
    users: {
      list: enabled,
      get: enabled,
      // Via provisioned jdadmin_admin_create_user → app_auth.register_user
      // (the real registration flow). Needs server-side Argon2id hashing.
      create: enabled && argon2Available,
      update: enabled, // display_name only
      // Via jdadmin_admin_set_user_disabled → app_auth.users.disabled_at
      // plus refresh-session revocation.
      disable: enabled,
      resetPassword: enabled && argon2Available,
      delete: false, // engine/auth FK graph: would cascade into the append-only ledger
    },
    inventory: { list: enabled, create: false, update: false, delete: false },
    transactions: { list: enabled, create: false, update: false, delete: false },
    priceHistory: { list: enabled, stats: enabled, deleteRange: false, reset: false },
    overview: enabled,
    health: enabled,
  };
}

const USER_SORTS: Record<string, string> = {
  id: 'p.id',
  username: 'p.display_name',
  email: 'au.email',
  balance: 'w.dcoin_balance',
  createdAt: 'p.created_at',
};

const TX_SORTS: Record<string, string> = {
  createdAt: 't.created_at',
  type: 't.type',
  totalAmount: 't.amount_dcoins',
};

export class DwarfAdapter implements AppAdapter {
  readonly id = 'dwarf';
  readonly label = 'Dwarf Coins';
  readonly capabilities: CapabilitySet;

  private readonly db: AppPool;
  private readonly argon2: typeof import('argon2') | null;
  private readonly adminPrincipalId?: string;

  constructor(connectionString: string, argon2: typeof import('argon2') | null, adminPrincipalId?: string) {
    this.db = new AppPool(connectionString);
    this.argon2 = argon2;
    this.adminPrincipalId = adminPrincipalId;
    this.capabilities = dwarfCapabilities(Boolean(argon2), Boolean(adminPrincipalId));
  }

  private async query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(text: string, params?: unknown[]) {
    if (!this.adminPrincipalId) {
      throw new ApiError(503, 'APP_UNAVAILABLE', 'DWARF_ADMIN_PRINCIPAL_ID is not configured');
    }
    return this.db.transactionAsPlayer(this.adminPrincipalId, (client) => client.query<T>(text, params));
  }

  async ping(): Promise<AppHealth> {
    const start = Date.now();
    try {
      const version = await this.query<{ version: string }>('SELECT version()');
      const counts: Record<string, number> = {};
      for (const [label, table] of Object.entries({
        profiles: T.profiles,
        wallets: T.wallets,
        holdings: T.holdings,
        transactions: T.transactions,
        gems: T.gems,
      })) {
        const res = await this.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        counts[label] = Number(res.rows[0]?.count ?? 0);
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        serverVersion: version.rows[0]?.version,
        tables: counts,
      };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }

  async overview(): Promise<OverviewData> {
    const [users, gems, txs, balances, recent] = await Promise.all([
      this.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${T.profiles}`),
      this.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${T.gems}`),
      this.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${T.transactions}`),
      this.query<{ total: string | null }>(
        `SELECT sum(dcoin_balance)::text AS total FROM ${T.wallets}`,
      ),
      this.query(
        `SELECT t.*, g.symbol AS gem_symbol FROM ${T.transactions} t
         LEFT JOIN ${T.gems} g ON g.id = t.gem_id
         ORDER BY t.created_at DESC LIMIT 10`,
      ),
    ]);
    const gemRows = await this.query<{ id: string; symbol: string }>(
      `SELECT id, symbol FROM ${T.gems} ORDER BY sort_order, symbol`,
    );
    const assetsSparkline: OverviewData['assetsSparkline'] = [];
    for (const gem of gemRows.rows) {
      const pts = await this.query<{ price: string }>(
        `SELECT price::text FROM ${T.priceHistory} WHERE gem_id = $1 ORDER BY recorded_at DESC LIMIT 30`,
        [gem.id],
      );
      const latest = await this.query<{ price: string }>(
        `SELECT price::text FROM ${T.priceHistory} WHERE gem_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [gem.id],
      );
      assetsSparkline.push({
        assetId: gem.id,
        symbol: gem.symbol,
        latestPrice: num(latest.rows[0]?.price),
        points: pts.rows.map((p) => Number(p.price)).reverse(),
      });
    }
    return {
      users: Number(users.rows[0]?.count ?? 0),
      assets: Number(gems.rows[0]?.count ?? 0),
      transactions: Number(txs.rows[0]?.count ?? 0),
      totalBalance: num(balances.rows[0]?.total),
      assetsSparkline,
      recentTransactions: recent.rows.map((r) => this.toTransaction(r)),
    };
  }

  async listAssets(): Promise<AssetInfo[]> {
    const res = await this.query<{ id: string; name: string; symbol: string; base_price: string }>(
      `SELECT id, name, symbol, base_price::text FROM ${T.gems} ORDER BY sort_order, symbol`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      symbol: r.symbol,
      currentPrice: num(r.base_price),
    }));
  }

  async listUsers(query: ListQuery): Promise<Paged<UserSummary>> {
    const params: unknown[] = [];
    let where = '';
    if (query.search) {
      params.push(`%${query.search}%`);
      where = `WHERE p.display_name ILIKE $1 OR au.email ILIKE $1`;
    }
    const fromSql = `FROM ${T.profiles} p
       LEFT JOIN ${T.authUsers} au ON au.id = p.id
       LEFT JOIN ${T.wallets} w ON w.user_id = p.id`;
    const total = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${T.profiles} p
       LEFT JOIN ${T.authUsers} au ON au.id = p.id ${where}`,
      params,
    );
    const orderBy = orderByClause(query, USER_SORTS, 'createdAt');
    const page = pageClause(query, params);
    const res = await this.query<{
      id: string;
      display_name: string | null;
      email: string | null;
      role: string;
      disabled_at: Date | null;
      dcoin_balance: string | null;
      created_at: Date;
    }>(
      `SELECT p.id, p.display_name, au.email, p.role, au.disabled_at, w.dcoin_balance::text, p.created_at
       ${fromSql} ${where} ${orderBy} ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        username: r.display_name ?? r.email ?? r.id,
        email: r.email,
        displayName: r.display_name,
        balance: num(r.dcoin_balance),
        disabled: r.disabled_at != null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getUser(id: string): Promise<UserDetail> {
    const res = await this.query<{
      id: string;
      display_name: string | null;
      email: string | null;
      role: string;
      bankruptcy_count: number;
      disabled_at: Date | null;
      dcoin_balance: string | null;
      loan_debt: string | null;
      created_at: Date;
      last_active_at: Date | null;
    }>(
      `SELECT p.id, p.display_name, au.email, p.role, p.bankruptcy_count, au.disabled_at,
              w.dcoin_balance::text, w.loan_debt::text, p.created_at, p.last_active_at
         FROM ${T.profiles} p
         LEFT JOIN ${T.authUsers} au ON au.id = p.id
         LEFT JOIN ${T.wallets} w ON w.user_id = p.id
        WHERE p.id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    return {
      id: row.id,
      username: row.display_name ?? row.email ?? row.id,
      email: row.email,
      displayName: row.display_name,
      balance: num(row.dcoin_balance),
      disabled: row.disabled_at != null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      extra: {
        role: row.role,
        bankruptcyCount: row.bankruptcy_count,
        loanDebt: num(row.loan_debt),
        lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
      },
    };
  }

  /**
   * Create a Dwarf user through the app's own registration flow. `username`
   * maps to the profile display name; email is required because it is the
   * Dwarf login identity. Initial balances are engine-owned (starter package),
   * so `balance` is rejected rather than silently ignored.
   */
  async createUser(input: UserCreateInput): Promise<UserDetail> {
    if (!this.argon2) {
      throw new ApiError(403, 'UNSUPPORTED_CAPABILITY', 'argon2 module unavailable on server');
    }
    if (input.balance !== undefined) {
      throw new ApiError(
        403,
        'UNSUPPORTED_CAPABILITY',
        'Dwarf adapter does not set balances on create (the engine starter package owns initial funds).',
      );
    }
    const email = input.email?.trim().toLowerCase();
    if (!email) {
      throw new ApiError(400, 'BAD_REQUEST', 'Dwarf user creation requires an email (the Dwarf login identity).');
    }
    const hash = await this.argon2.hash(input.password, { type: this.argon2.argon2id });
    const res = await this.query<{ u: { id: string } }>(
      `SELECT public.jdadmin_admin_create_user($1, $2, $3) AS u`,
      [email, input.username, hash],
    );
    const id = res.rows[0]?.u?.id;
    if (!id) throw new ApiError(500, 'INTERNAL', 'Dwarf registration flow returned no user id');
    return this.getUser(id);
  }

  async updateUser(id: string, patch: UserUpdateInput): Promise<UserDetail> {
    // username is the profile display name for Dwarf, so accept it as an
    // alias; anything engine/auth-owned is rejected rather than ignored.
    if (patch.email !== undefined || patch.balance !== undefined) {
      throw new ApiError(
        403,
        'UNSUPPORTED_CAPABILITY',
        'Dwarf adapter supports updating displayName/username only (email/balance are engine- or auth-owned).',
      );
    }
    if (
      patch.username !== undefined &&
      patch.displayName !== undefined &&
      patch.username !== patch.displayName
    ) {
      throw new ApiError(400, 'BAD_REQUEST', 'username and displayName are the same Dwarf field and must match.');
    }
    const displayName = patch.displayName ?? patch.username;
    if (displayName === undefined) {
      return this.getUser(id);
    }
    await this.getUser(id);
    await this.query(
      `UPDATE ${T.profiles} SET display_name = $1, updated_at = now() WHERE id = $2`,
      [displayName, id],
    );
    return this.getUser(id);
  }

  async setUserDisabled(id: string, disabled: boolean): Promise<void> {
    await this.getUser(id);
    const res = await this.query<{ ok: boolean }>(
      `SELECT public.jdadmin_admin_set_user_disabled($1, $2) AS ok`,
      [id, disabled],
    );
    if (!res.rows[0]?.ok) throw new ApiError(404, 'NOT_FOUND', 'Auth user not found');
  }

  async resetUserPassword(id: string, newPassword: string): Promise<void> {
    if (!this.argon2) {
      throw new ApiError(403, 'UNSUPPORTED_CAPABILITY', 'argon2 module unavailable on server');
    }
    await this.getUser(id);
    const hash = await this.argon2.hash(newPassword, { type: this.argon2.argon2id });
    const res = await this.query<{ ok: boolean }>(
      `SELECT public.jdadmin_admin_reset_password($1, $2) AS ok`,
      [id, hash],
    );
    if (!res.rows[0]?.ok) throw new ApiError(404, 'NOT_FOUND', 'Auth user not found');
  }

  async listInventory(userId: string | undefined, query: ListQuery): Promise<Paged<import('./types.js').InventoryItem>> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (userId) {
      params.push(userId);
      where.push(`h.user_id = $${params.length}`);
    }
    if (query.filters.assetId) {
      params.push(query.filters.assetId);
      where.push(`h.gem_id = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`(g.name ILIKE $${params.length} OR g.symbol ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM ${T.holdings} h JOIN ${T.gems} g ON g.id = h.gem_id`;
    const total = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count ${fromSql} ${whereSql}`,
      params,
    );
    const page = pageClause(query, params);
    const res = await this.query(
      `SELECT h.id, h.user_id, h.gem_id, h.amount_grams::text, h.average_buy_price::text,
              h.reserved_grams::text, g.name, g.symbol
         ${fromSql} ${whereSql} ORDER BY h.created_at DESC ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        assetId: r.gem_id,
        assetName: r.name,
        assetSymbol: r.symbol,
        quantity: Number(r.amount_grams),
        averagePrice: num(r.average_buy_price),
        extra: { reservedGrams: num(r.reserved_grams) },
      })),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private toTransaction(r: Record<string, unknown>): TransactionItem {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      assetId: r.gem_id != null ? String(r.gem_id) : null,
      assetSymbol: (r.gem_symbol as string | null) ?? null,
      type: String(r.type),
      quantity: num(r.amount_grams),
      price: num(r.execution_price),
      totalAmount: num(r.amount_dcoins),
      createdAt: new Date(r.created_at as string).toISOString(),
      extra: { fee: num(r.fee_amount), tradeSource: r.trade_source ?? null },
    };
  }

  async listTransactions(query: ListQuery & { userId?: string }): Promise<Paged<TransactionItem>> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.userId) {
      params.push(query.userId);
      where.push(`t.user_id = $${params.length}`);
    }
    if (query.filters.assetId) {
      params.push(query.filters.assetId);
      where.push(`t.gem_id = $${params.length}`);
    }
    if (query.filters.type) {
      params.push(query.filters.type);
      where.push(`t.type = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`(g.symbol ILIKE $${params.length} OR g.name ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM ${T.transactions} t LEFT JOIN ${T.gems} g ON g.id = t.gem_id`;
    const total = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count ${fromSql} ${whereSql}`,
      params,
    );
    const orderBy = orderByClause(query, TX_SORTS, 'createdAt');
    const page = pageClause(query, params);
    const res = await this.query(
      `SELECT t.*, g.symbol AS gem_symbol ${fromSql} ${whereSql} ${orderBy} ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => this.toTransaction(r)),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listPriceHistory(query: PriceHistoryQuery): Promise<Paged<PricePoint>> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.assetId) {
      params.push(query.assetId);
      where.push(`gem_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`recorded_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`recorded_at <= $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${T.priceHistory} ${whereSql}`,
      params,
    );
    const page = pageClause(
      { page: query.page, pageSize: query.pageSize, order: 'desc', filters: {} },
      params,
    );
    const res = await this.query<{ id: string; gem_id: string; price: string; recorded_at: Date }>(
      `SELECT id, gem_id, price::text, recorded_at FROM ${T.priceHistory}
         ${whereSql} ORDER BY recorded_at DESC ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        assetId: r.gem_id,
        price: Number(r.price),
        recordedAt: new Date(r.recorded_at).toISOString(),
      })),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async priceHistoryStats(assetId?: string): Promise<PriceStats[]> {
    const params: unknown[] = [];
    let where = '';
    if (assetId) {
      params.push(assetId);
      where = `WHERE ph.gem_id = $1`;
    }
    const res = await this.query<{
      gem_id: string;
      symbol: string;
      count: string;
      min: string | null;
      max: string | null;
      avg: string | null;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `SELECT ph.gem_id, g.symbol, count(*)::text AS count,
              min(ph.price)::text AS min, max(ph.price)::text AS max, avg(ph.price)::text AS avg,
              min(ph.recorded_at) AS first_at, max(ph.recorded_at) AS last_at
         FROM ${T.priceHistory} ph JOIN ${T.gems} g ON g.id = ph.gem_id
         ${where} GROUP BY ph.gem_id, g.symbol ORDER BY g.symbol`,
      params,
    );
    return res.rows.map((r) => ({
      assetId: r.gem_id,
      assetSymbol: r.symbol,
      count: Number(r.count),
      min: num(r.min),
      max: num(r.max),
      avg: num(r.avg),
      firstAt: r.first_at ? new Date(r.first_at).toISOString() : null,
      lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    }));
  }

  async countPriceHistory(filter: { assetId?: string; from?: string; to?: string }): Promise<number> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.assetId) {
      params.push(filter.assetId);
      where.push(`gem_id = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`recorded_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`recorded_at <= $${params.length}`);
    }
    if (!where.length) throw new ApiError(400, 'BAD_REQUEST', 'A filter is required');
    const res = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${T.priceHistory} WHERE ${where.join(' AND ')}`,
      params,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

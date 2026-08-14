import { ApiError } from '../core/errors.js';
import { measureDatabaseStorage, unavailableSample } from '../core/resources.js';
import { AppPool, num, orderByClause, pageClause } from './sql.js';
import type {
  AppAdapter,
  AppHealth,
  AppResourceUsage,
  AssetInfo,
  CapabilitySet,
  DeleteAllUsersResult,
  ListQuery,
  OverviewData,
  Paged,
  PriceHistoryQuery,
  PricePoint,
  PriceStats,
  RelatedCounts,
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
 * User deletion IS supported (issue #11) via the provisioned SECURITY DEFINER
 * function public.jdadmin_admin_delete_user (ops/dwarf/004_jdadmin_user_delete.sql).
 * The self-hosted FK graph was verified before enabling this: profiles.id ->
 * app_auth.users(id) ON DELETE CASCADE, and every FK referencing profiles(id)
 * is ON DELETE CASCADE (wallets, holdings, transactions ledger, limit orders,
 * mining jobs, cooldowns, leaderboard cache); public_feed.user_id and
 * app_auth.auth_events.user_id are ON DELETE SET NULL, so feed rows and the
 * append-only auth audit survive anonymized. The product owner explicitly
 * accepts destroying the deleted user's related history/financial records.
 * The wrapper counts dependents first (truthful counts), records a redacted
 * app-side auth event, refuses to delete the calling control-plane principal,
 * and the whole graph deletes atomically in the caller's transaction.
 *
 * Delete-ALL users IS supported (issue #15) via the provisioned SECURITY
 * DEFINER function public.jdadmin_admin_delete_all_users
 * (ops/dwarf/005_jdadmin_user_delete_all.sql), with one structural exclusion:
 * the calling control-plane principal (DWARF_ADMIN_PRINCIPAL_ID) is never in
 * scope — deleting it would remove the identity required to call the
 * controlled functions and lock out the admin. The function derives the
 * exclusion from the transaction-local caller identity (never from a
 * caller-supplied id), re-checks assert_admin_caller(), re-validates the
 * exact in-scope count database-side, counts dependents first (truthful
 * counts), records a redacted 'admin_deleted_all_users' auth event, and
 * deletes the whole verified FK graph atomically in the caller's transaction.
 * The operation is IRREVERSIBLE: every deleted user's wallet, holdings,
 * transactions/ledger, orders, mining jobs, cooldowns and leaderboard rows
 * are destroyed (the product owner explicitly accepts this); public_feed and
 * auth_events rows survive anonymized via ON DELETE SET NULL.
 *
 * Price-history deletion IS supported (issue #10) via the provisioned
 * SECURITY DEFINER functions in ops/dwarf/003_jdadmin_price_history_admin.sql.
 * Deleting chart snapshots is an operation Dwarf itself performs
 * (public.prune_old_data retention sweep), so it breaks no engine invariant;
 * the wrappers re-check public.assert_admin_caller() and are granted to
 * dc_api only. Long-term OHLC aggregates are engine-owned and untouched.
 */

const T = {
  profiles: 'public.profiles',
  wallets: 'public.wallets',
  holdings: 'public.portfolio_holdings',
  transactions: 'public.transactions',
  limitOrders: 'public.limit_orders',
  miningJobs: 'public.mining_jobs',
  cooldowns: 'public.player_action_cooldowns',
  leaderboard: 'public.leaderboard_cache',
  publicFeed: 'public.public_feed',
  priceHistory: 'public.price_history',
  gems: 'public.gems',
  authUsers: 'app_auth.users',
  identities: 'app_auth.identities',
  refreshSessions: 'app_auth.refresh_sessions',
  passwordResetTokens: 'app_auth.password_reset_tokens',
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
      // Via jdadmin_admin_delete_user → app_auth.users DELETE with the
      // verified CASCADE/SET NULL FK graph (issue #11, ops/dwarf/004).
      delete: enabled,
      // Via jdadmin_admin_delete_all_users (issue #15, ops/dwarf/005):
      // every user EXCEPT the calling control-plane principal, which the
      // function excludes structurally from the caller identity.
      deleteAll: enabled,
    },
    inventory: { list: enabled, create: false, update: false, delete: false },
    transactions: { list: enabled, create: false, update: false, delete: false },
    // Via provisioned jdadmin_admin_*_price_* functions (ops/dwarf/003);
    // mirrors the engine's own prune_old_data retention deletes.
    priceHistory: {
      list: enabled,
      stats: enabled,
      delete: enabled,
      deleteRange: enabled,
      reset: enabled,
    },
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

  /**
   * Read-only resource probe. Storage is the on-disk size of the app's
   * PostgreSQL database (app-data scope, one static statement issued directly
   * on the pool — no RLS principal needed for pg_database_size). The Dwarf
   * server process runs outside this admin host and cannot be measured over a
   * SQL connection, so process memory reports 'unavailable' rather than zero.
   */
  async resourceUsage(): Promise<AppResourceUsage> {
    return {
      collectedAt: new Date().toISOString(),
      storage: await measureDatabaseStorage((text) => this.db.query(text)),
      memory: unavailableSample(
        'app process',
        'app process memory is not measurable over a SQL connection',
      ),
    };
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

  /**
   * Issue #11: counts of every dependent row the cascading delete removes
   * (or anonymizes, for public_feed). Shown to the operator in the delete
   * confirmation and recorded in the audit log alongside the deletion.
   */
  async userRelatedCounts(id: string): Promise<RelatedCounts> {
    await this.getUser(id);
    const tables: Array<[string, string]> = [
      ['wallets', T.wallets],
      ['portfolio_holdings', T.holdings],
      ['transactions', T.transactions],
      ['limit_orders', T.limitOrders],
      ['mining_jobs', T.miningJobs],
      ['player_action_cooldowns', T.cooldowns],
      ['leaderboard_cache', T.leaderboard],
      ['public_feed_anonymized', T.publicFeed],
      ['identities', T.identities],
      ['refresh_sessions', T.refreshSessions],
      ['password_reset_tokens', T.passwordResetTokens],
    ];
    const counts: Record<string, number> = {};
    for (const [label, table] of tables) {
      const res = await this.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`,
        [id],
      );
      counts[label] = Number(res.rows[0]?.count ?? 0);
    }
    return counts;
  }

  /**
   * Issue #11: controlled hard delete via the provisioned
   * jdadmin_admin_delete_user SECURITY DEFINER function. The function
   * re-checks assert_admin_caller(), refuses self-delete of the control-plane
   * principal, records a redacted app-side auth event, and deletes the whole
   * verified FK graph atomically in the transaction-local admin context; any
   * failure raises and rolls everything back (surfaced as 4xx by the core).
   */
  async deleteUser(id: string): Promise<void> {
    if (this.adminPrincipalId && id === this.adminPrincipalId) {
      throw new ApiError(400, 'BAD_REQUEST', 'Refusing to delete the calling admin principal');
    }
    await this.getUser(id);
    await this.query(`SELECT public.jdadmin_admin_delete_user($1)`, [id]);
  }

  /**
   * Issue #15: the delete-all scope is every app user EXCEPT the calling
   * control-plane principal. The label is declared so routes/audit/UI state
   * the exact exclusion truthfully.
   */
  readonly deleteAllUsersScopeLabel = 'all users except the control-plane principal';

  /**
   * Issue #15: exact current in-scope count (app users minus the calling
   * principal). Used by the route and UI for the exact-count confirmation;
   * the database function re-validates the same count at delete time.
   */
  async deleteAllUsersCount(): Promise<number> {
    const res = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${T.authUsers} WHERE id <> $1`,
      [this.adminPrincipalId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  /**
   * Issue #15: IRREVERSIBLE delete of every user except the control-plane
   * principal via the provisioned jdadmin_admin_delete_all_users SECURITY
   * DEFINER function. The in-scope count is recomputed inside the same
   * transaction and passed to the function, which re-validates it
   * database-side and rolls everything back on any mismatch or FK/business
   * failure — no partial delete is possible. Returns truthful dependent
   * counts computed by the function before deletion.
   */
  async deleteAllUsers(): Promise<DeleteAllUsersResult> {
    if (!this.adminPrincipalId) {
      throw new ApiError(503, 'APP_UNAVAILABLE', 'DWARF_ADMIN_PRINCIPAL_ID is not configured');
    }
    return this.db.transactionAsPlayer(this.adminPrincipalId, async (client) => {
      const scope = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${T.authUsers} WHERE id <> $1`,
        [this.adminPrincipalId],
      );
      const res = await client.query<{ result: { deleted_users: number; related_counts: RelatedCounts } }>(
        `SELECT public.jdadmin_admin_delete_all_users($1) AS result`,
        [Number(scope.rows[0]?.count ?? 0)],
      );
      const result = res.rows[0]?.result;
      if (!result) throw new ApiError(500, 'INTERNAL', 'Dwarf delete-all returned no result');
      return { users: Number(result.deleted_users), related: result.related_counts };
    });
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
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${T.priceHistory} ${whereSql}`,
      params,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  /**
   * Issue #10: individual price-history record delete via the provisioned
   * jdadmin_admin_delete_price_point function. Returns the deleted point.
   */
  async deletePricePoint(id: string): Promise<PricePoint> {
    const existing = await this.query<{ id: string; gem_id: string; price: string; recorded_at: Date }>(
      `SELECT id, gem_id, price::text, recorded_at FROM ${T.priceHistory} WHERE id = $1`,
      [id],
    );
    const row = existing.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Price history record not found');
    const res = await this.query<{ ok: boolean }>(
      `SELECT public.jdadmin_admin_delete_price_point($1) AS ok`,
      [id],
    );
    if (!res.rows[0]?.ok) throw new ApiError(404, 'NOT_FOUND', 'Price history record not found');
    return {
      id: row.id,
      assetId: row.gem_id,
      price: Number(row.price),
      recordedAt: new Date(row.recorded_at).toISOString(),
    };
  }

  /**
   * Issue #10: filtered range delete via jdadmin_admin_delete_price_history_range.
   * At least one filter is mandatory — unfiltered deletion is the reset path.
   */
  async deletePriceHistoryRange(filter: { assetId?: string; from?: string; to?: string }): Promise<number> {
    if (!filter.assetId && !filter.from && !filter.to) {
      throw new ApiError(400, 'BAD_REQUEST', 'A filter (asset or date range) is required');
    }
    const res = await this.query<{ deleted: string }>(
      `SELECT public.jdadmin_admin_delete_price_history_range($1, $2, $3)::text AS deleted`,
      [filter.assetId ?? null, filter.from ?? null, filter.to ?? null],
    );
    return Number(res.rows[0]?.deleted ?? 0);
  }

  /** Issue #10: confirmed delete-all (optionally scoped to one gem). */
  async resetPriceHistory(assetId?: string): Promise<number> {
    const res = await this.query<{ deleted: string }>(
      `SELECT public.jdadmin_admin_reset_price_history($1)::text AS deleted`,
      [assetId ?? null],
    );
    return Number(res.rows[0]?.deleted ?? 0);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

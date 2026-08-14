import bcrypt from 'bcryptjs';
import { ApiError } from '../core/errors.js';
import {
  APP_PROCESS_IDENTITIES,
  measureAppProcessMemory,
  measureDatabaseStorage,
} from '../core/resources.js';
import { AppPool, num, orderByClause, pageClause } from './sql.js';
import type {
  AppAdapter,
  AppHealth,
  AppResourceUsage,
  AssetInfo,
  CapabilitySet,
  DeleteAllUsersResult,
  InventoryInput,
  InventoryItem,
  ListQuery,
  OverviewData,
  Paged,
  PriceHistoryQuery,
  PricePoint,
  PriceStats,
  RelatedCounts,
  TransactionCreateInput,
  TransactionItem,
  UserCreateInput,
  UserDetail,
  UserSummary,
  UserUpdateInput,
} from './types.js';

/**
 * Coins adapter — targets the legacy Coins schema (production-shaped, verified
 * against /home/jd/work/back_coins_x seed.js + migrations 002–006):
 *   users(user_id, username, email, password_hash, funds, created_at, updated_at)
 *   coins(coin_id, name, symbol, current_price, supply, market_cap, date_added, description)
 *   portfolios(portfolio_id, user_id, coin_id, quantity, average_purchase_price)
 *   transactions(transaction_id, user_id, coin_id, type, quantity, price, total_amount, created_at)
 *   price_history(history_id, coin_id, price, created_at)
 * Identifiers are static; all values are parameterized.
 *
 * Issue #17: production coins_x.transactions has created_at, NOT the obsolete
 * transaction_date — every transaction timestamp reference below uses created_at.
 */

const BASE_TABLES = {
  users: 'users',
  coins: 'coins',
  portfolios: 'portfolios',
  transactions: 'transactions',
  priceHistory: 'price_history',
} as const;

/** Schema identifiers are configuration, never request input; validate strictly. */
const SCHEMA_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const USER_SORTS: Record<string, string> = {
  id: 'u.user_id',
  username: 'u.username',
  email: 'u.email',
  balance: 'u.funds',
  createdAt: 'u.created_at',
};

const TX_SORTS: Record<string, string> = {
  id: 't.transaction_id',
  createdAt: 't.created_at',
  quantity: 't.quantity',
  price: 't.price',
  totalAmount: 't.total_amount',
};

const PH_SORTS: Record<string, string> = {
  id: 'ph.history_id',
  recordedAt: 'ph.created_at',
  price: 'ph.price',
};

const INV_SORTS: Record<string, string> = {
  id: 'p.portfolio_id',
  quantity: 'p.quantity',
  averagePrice: 'p.average_purchase_price',
  assetSymbol: 'c.symbol',
};

export const coinsCapabilities: CapabilitySet = {
  users: {
    list: true,
    get: true,
    create: true,
    update: true,
    // Legacy schema has no disabled flag and we must not migrate it: unsupported.
    disable: false,
    resetPassword: true,
    delete: true,
    // Transactional delete-all across users + portfolios + transactions.
    deleteAll: true,
  },
  inventory: { list: true, create: true, update: true, delete: true },
  transactions: {
    list: true,
    // Created only via consistency-preserving method (funds + portfolio in one tx).
    create: true,
    // Editing/deleting ledger rows would silently break funds/holdings: unsupported.
    update: false,
    delete: false,
  },
  priceHistory: { list: true, stats: true, delete: true, deleteRange: true, reset: true },
  overview: true,
  health: true,
};

interface UserRow {
  user_id: number;
  username: string;
  email: string;
  funds: string;
  created_at: Date;
  updated_at: Date;
}

function toUserSummary(r: UserRow): UserSummary {
  return {
    id: String(r.user_id),
    username: r.username,
    email: r.email,
    balance: num(r.funds),
    disabled: null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

export class CoinsAdapter implements AppAdapter {
  readonly id = 'coins';
  readonly label = 'Coins';
  readonly capabilities = coinsCapabilities;

  private readonly db: AppPool;
  private readonly T: Record<keyof typeof BASE_TABLES, string>;

  constructor(connectionString: string, schema?: string) {
    if (schema && !SCHEMA_IDENT.test(schema)) {
      throw new Error(`Invalid schema identifier in configuration: ${schema}`);
    }
    const prefix = schema ? `${schema}.` : '';
    this.T = Object.fromEntries(
      Object.entries(BASE_TABLES).map(([k, v]) => [k, prefix + v]),
    ) as Record<keyof typeof BASE_TABLES, string>;
    this.db = new AppPool(connectionString);
  }

  async ping(): Promise<AppHealth> {
    const start = Date.now();
    try {
      const version = await this.db.query<{ version: string }>('SELECT version()');
      const counts: Record<string, number> = {};
      for (const [label, table] of Object.entries(this.T)) {
        const res = await this.db.query<{ count: string }>(
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
   * PostgreSQL database (app-data scope, one static statement). Memory is the
   * Coins backend process RSS: the PM2 process runs on this same host with a
   * fixed entry path, so it is discovered by exact argv matching under /proc
   * (issue #18). If the process is absent, ambiguous, or unreadable the
   * sample reports 'unavailable' with a sanitized reason — never zero.
   */
  async resourceUsage(): Promise<AppResourceUsage> {
    return {
      collectedAt: new Date().toISOString(),
      storage: await measureDatabaseStorage((text) => this.db.query(text)),
      memory: await measureAppProcessMemory(APP_PROCESS_IDENTITIES.coins),
    };
  }

  async overview(): Promise<OverviewData> {
    const [users, assets, txs, funds, spark, recent] = await Promise.all([
      this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${this.T.users}`),
      this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${this.T.coins}`),
      this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${this.T.transactions}`),
      this.db.query<{ total: string | null }>(`SELECT sum(funds)::text AS total FROM ${this.T.users}`),
      this.db.query<{ coin_id: number; symbol: string; current_price: string }>(
        `SELECT coin_id, symbol, current_price::text FROM ${this.T.coins} ORDER BY symbol`,
      ),
      this.db.query(
        `SELECT t.*, c.symbol AS coin_symbol FROM ${this.T.transactions} t
         LEFT JOIN ${this.T.coins} c ON c.coin_id = t.coin_id
         ORDER BY t.created_at DESC LIMIT 10`,
      ),
    ]);
    const assetsSparkline = [] as OverviewData['assetsSparkline'];
    for (const coin of spark.rows) {
      const pts = await this.db.query<{ price: string }>(
        `SELECT price::text FROM ${this.T.priceHistory} WHERE coin_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [coin.coin_id],
      );
      assetsSparkline.push({
        assetId: String(coin.coin_id),
        symbol: coin.symbol,
        latestPrice: num(coin.current_price),
        points: pts.rows.map((p) => Number(p.price)).reverse(),
      });
    }
    return {
      users: Number(users.rows[0]?.count ?? 0),
      assets: Number(assets.rows[0]?.count ?? 0),
      transactions: Number(txs.rows[0]?.count ?? 0),
      totalBalance: num(funds.rows[0]?.total),
      assetsSparkline,
      recentTransactions: recent.rows.map((r) => this.toTransaction(r)),
    };
  }

  async listAssets(): Promise<AssetInfo[]> {
    const res = await this.db.query<{
      coin_id: number;
      name: string;
      symbol: string;
      current_price: string;
    }>(`SELECT coin_id, name, symbol, current_price::text FROM ${this.T.coins} ORDER BY symbol`);
    return res.rows.map((r) => ({
      id: String(r.coin_id),
      name: r.name,
      symbol: r.symbol,
      currentPrice: num(r.current_price),
    }));
  }

  async listUsers(query: ListQuery): Promise<Paged<UserSummary>> {
    const params: unknown[] = [];
    let where = '';
    if (query.search) {
      params.push(`%${query.search}%`);
      where = `WHERE u.username ILIKE $1 OR u.email ILIKE $1`;
    }
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.T.users} u ${where}`,
      params,
    );
    const orderBy = orderByClause(query, USER_SORTS, 'id');
    const page = pageClause(query, params);
    const res = await this.db.query<UserRow>(
      `SELECT u.* FROM ${this.T.users} u ${where} ${orderBy} ${page}`,
      params,
    );
    return {
      items: res.rows.map(toUserSummary),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getUser(id: string): Promise<UserDetail> {
    const res = await this.db.query<UserRow>(
      `SELECT user_id, username, email, funds::text, created_at, updated_at FROM ${this.T.users} WHERE user_id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    return {
      ...toUserSummary(row),
      extra: { updatedAt: new Date(row.updated_at).toISOString() },
    };
  }

  async createUser(input: UserCreateInput): Promise<UserDetail> {
    const hash = bcrypt.hashSync(input.password, 12);
    try {
      const res = await this.db.query<UserRow>(
        `INSERT INTO ${this.T.users} (username, email, password_hash, funds)
         VALUES ($1, $2, $3, $4) RETURNING user_id, username, email, funds::text, created_at, updated_at`,
        [input.username, input.email ?? `${input.username}@local`, hash, input.balance ?? 1000],
      );
      return { ...toUserSummary(res.rows[0] as UserRow), extra: {} };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError(409, 'CONFLICT', 'Username or email already exists');
      }
      throw err;
    }
  }

  async updateUser(id: string, patch: UserUpdateInput): Promise<UserDetail> {
    await this.getUser(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.username !== undefined) {
      params.push(patch.username);
      sets.push(`username = $${params.length}`);
    }
    if (patch.email !== undefined) {
      params.push(patch.email);
      sets.push(`email = $${params.length}`);
    }
    if (patch.balance !== undefined) {
      params.push(patch.balance);
      sets.push(`funds = $${params.length}`);
    }
    if (sets.length === 0) return this.getUser(id);
    params.push(id);
    try {
      await this.db.query(
        `UPDATE ${this.T.users} SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${params.length}`,
        params,
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError(409, 'CONFLICT', 'Username or email already exists');
      }
      throw err;
    }
    return this.getUser(id);
  }

  async resetUserPassword(id: string, newPassword: string): Promise<void> {
    await this.getUser(id);
    await this.db.query(
      `UPDATE ${this.T.users} SET password_hash = $1, updated_at = now() WHERE user_id = $2`,
      [bcrypt.hashSync(newPassword, 12), id],
    );
  }

  async userRelatedCounts(id: string): Promise<RelatedCounts> {
    const [portfolios, transactions] = await Promise.all([
      this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${this.T.portfolios} WHERE user_id = $1`,
        [id],
      ),
      this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${this.T.transactions} WHERE user_id = $1`,
        [id],
      ),
    ]);
    return {
      portfolios: Number(portfolios.rows[0]?.count ?? 0),
      transactions: Number(transactions.rows[0]?.count ?? 0),
    };
  }

  async deleteUser(id: string): Promise<void> {
    await this.getUser(id);
    await this.db.transaction(async (client) => {
      await client.query(`DELETE FROM ${this.T.portfolios} WHERE user_id = $1`, [id]);
      await client.query(`DELETE FROM ${this.T.transactions} WHERE user_id = $1`, [id]);
      await client.query(`DELETE FROM ${this.T.users} WHERE user_id = $1`, [id]);
    });
  }

  /**
   * Issue #10: transactional delete-all of every user and their related
   * portfolios/transactions. One atomic transaction — any FK or business
   * error rolls back the whole operation with no partial delete.
   */
  async deleteAllUsers(): Promise<DeleteAllUsersResult> {
    return this.db.transaction(async (client) => {
      const portfolios = await client.query(`DELETE FROM ${this.T.portfolios}`);
      const transactions = await client.query(`DELETE FROM ${this.T.transactions}`);
      const users = await client.query(`DELETE FROM ${this.T.users}`);
      return {
        users: users.rowCount ?? 0,
        related: {
          portfolios: portfolios.rowCount ?? 0,
          transactions: transactions.rowCount ?? 0,
        },
      };
    });
  }

  private toInventory(r: Record<string, unknown>): InventoryItem {
    return {
      id: String(r.portfolio_id),
      userId: String(r.user_id),
      assetId: String(r.coin_id),
      assetName: String(r.name ?? ''),
      assetSymbol: String(r.symbol ?? ''),
      quantity: Number(r.quantity),
      averagePrice: num(r.average_purchase_price),
    };
  }

  async listInventory(userId: string | undefined, query: ListQuery): Promise<Paged<InventoryItem>> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (userId) {
      params.push(userId);
      where.push(`p.user_id = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`(c.name ILIKE $${params.length} OR c.symbol ILIKE $${params.length})`);
    }
    if (query.filters.assetId) {
      params.push(query.filters.assetId);
      where.push(`p.coin_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.T.portfolios} p JOIN ${this.T.coins} c ON c.coin_id = p.coin_id ${whereSql}`,
      params,
    );
    const orderBy = orderByClause(query, INV_SORTS, 'id');
    const page = pageClause(query, params);
    const res = await this.db.query(
      `SELECT p.portfolio_id, p.user_id, p.coin_id, p.quantity::text, p.average_purchase_price::text,
              c.name, c.symbol
         FROM ${this.T.portfolios} p JOIN ${this.T.coins} c ON c.coin_id = p.coin_id
         ${whereSql} ${orderBy} ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => this.toInventory(r)),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async getInventoryRow(id: string): Promise<InventoryItem> {
    const res = await this.db.query(
      `SELECT p.portfolio_id, p.user_id, p.coin_id, p.quantity::text, p.average_purchase_price::text,
              c.name, c.symbol
         FROM ${this.T.portfolios} p JOIN ${this.T.coins} c ON c.coin_id = p.coin_id
        WHERE p.portfolio_id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Inventory item not found');
    return this.toInventory(row);
  }

  async createInventory(input: InventoryInput): Promise<InventoryItem> {
    try {
      const res = await this.db.query<{ portfolio_id: number }>(
        `INSERT INTO ${this.T.portfolios} (user_id, coin_id, quantity, average_purchase_price)
         VALUES ($1, $2, $3, $4) RETURNING portfolio_id`,
        [input.userId, input.assetId, input.quantity, input.averagePrice ?? 0],
      );
      return this.getInventoryRow(String((res.rows[0] as { portfolio_id: number }).portfolio_id));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') throw new ApiError(409, 'CONFLICT', 'Holding already exists for this user/asset');
      if (code === '23503') throw new ApiError(400, 'BAD_REQUEST', 'Unknown user or asset');
      throw err;
    }
  }

  async updateInventory(id: string, patch: Partial<InventoryInput>): Promise<InventoryItem> {
    await this.getInventoryRow(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.quantity !== undefined) {
      params.push(patch.quantity);
      sets.push(`quantity = $${params.length}`);
    }
    if (patch.averagePrice !== undefined) {
      params.push(patch.averagePrice);
      sets.push(`average_purchase_price = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await this.db.query(
        `UPDATE ${this.T.portfolios} SET ${sets.join(', ')} WHERE portfolio_id = $${params.length}`,
        params,
      );
    }
    return this.getInventoryRow(id);
  }

  async deleteInventory(id: string): Promise<void> {
    await this.getInventoryRow(id);
    await this.db.query(`DELETE FROM ${this.T.portfolios} WHERE portfolio_id = $1`, [id]);
  }

  private toTransaction(r: Record<string, unknown>): TransactionItem {
    return {
      id: String(r.transaction_id),
      userId: String(r.user_id),
      assetId: r.coin_id != null ? String(r.coin_id) : null,
      assetSymbol: (r.coin_symbol as string | null) ?? null,
      type: String(r.type).toLowerCase(),
      quantity: num(r.quantity),
      price: num(r.price),
      totalAmount: num(r.total_amount),
      createdAt: new Date(r.created_at as string).toISOString(),
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
      where.push(`t.coin_id = $${params.length}`);
    }
    if (query.filters.type) {
      params.push(query.filters.type.toLowerCase());
      where.push(`lower(t.type) = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(
        `(u.username ILIKE $${params.length} OR c.symbol ILIKE $${params.length} OR c.name ILIKE $${params.length})`,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const fromSql = `FROM ${this.T.transactions} t
       LEFT JOIN ${this.T.users} u ON u.user_id = t.user_id
       LEFT JOIN ${this.T.coins} c ON c.coin_id = t.coin_id`;
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count ${fromSql} ${whereSql}`,
      params,
    );
    const orderBy = orderByClause(query, TX_SORTS, 'createdAt');
    const page = pageClause(query, params);
    const res = await this.db.query(
      `SELECT t.*, c.symbol AS coin_symbol ${fromSql} ${whereSql} ${orderBy} ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => this.toTransaction(r)),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Consistency-preserving transaction creation: inserts the ledger row and
   * adjusts user funds + portfolio holdings in one database transaction.
   * Any invariant violation (insufficient funds/holdings) rolls everything back.
   */
  async createTransaction(input: TransactionCreateInput): Promise<TransactionItem> {
    const totalAmount = input.quantity * input.price;
    return this.db.transaction(async (client) => {
      const userRes = await client.query<{ funds: string }>(
        `SELECT funds::text FROM ${this.T.users} WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      const user = userRes.rows[0];
      if (!user) throw new ApiError(400, 'BAD_REQUEST', 'Unknown user');
      const coinRes = await client.query<{ coin_id: number }>(
        `SELECT coin_id FROM ${this.T.coins} WHERE coin_id = $1`,
        [input.assetId],
      );
      if (!coinRes.rows[0]) throw new ApiError(400, 'BAD_REQUEST', 'Unknown asset');

      const funds = Number(user.funds);
      const type = input.type;
      if (type === 'buy' && funds < totalAmount) {
        throw new ApiError(409, 'CONFLICT', 'Insufficient funds for buy');
      }

      const holdingRes = await client.query<{ portfolio_id: number; quantity: string; average_purchase_price: string }>(
        `SELECT portfolio_id, quantity::text, average_purchase_price::text
           FROM ${this.T.portfolios} WHERE user_id = $1 AND coin_id = $2 FOR UPDATE`,
        [input.userId, input.assetId],
      );
      const holding = holdingRes.rows[0];
      const heldQty = holding ? Number(holding.quantity) : 0;
      if (type === 'sell' && heldQty < input.quantity) {
        throw new ApiError(409, 'CONFLICT', 'Insufficient holdings for sell');
      }

      const newFunds = type === 'buy' ? funds - totalAmount : funds + totalAmount;
      await client.query(`UPDATE ${this.T.users} SET funds = $1, updated_at = now() WHERE user_id = $2`, [
        newFunds,
        input.userId,
      ]);

      if (type === 'buy') {
        const newQty = heldQty + input.quantity;
        const newAvg =
          newQty > 0
            ? (heldQty * (holding ? Number(holding.average_purchase_price) : 0) + totalAmount) / newQty
            : 0;
        if (holding) {
          await client.query(
            `UPDATE ${this.T.portfolios} SET quantity = $1, average_purchase_price = $2 WHERE portfolio_id = $3`,
            [newQty, newAvg, holding.portfolio_id],
          );
        } else {
          await client.query(
            `INSERT INTO ${this.T.portfolios} (user_id, coin_id, quantity, average_purchase_price)
             VALUES ($1, $2, $3, $4)`,
            [input.userId, input.assetId, newQty, newAvg],
          );
        }
      } else {
        const newQty = heldQty - input.quantity;
        await client.query(`UPDATE ${this.T.portfolios} SET quantity = $1 WHERE portfolio_id = $2`, [
          newQty,
          holding!.portfolio_id,
        ]);
      }

      const txRes = await client.query<{ transaction_id: number }>(
        `INSERT INTO ${this.T.transactions} (user_id, coin_id, type, quantity, price, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id`,
        [input.userId, input.assetId, type.toUpperCase(), input.quantity, input.price, totalAmount],
      );
      const id = String((txRes.rows[0] as { transaction_id: number }).transaction_id);
      const row = await client.query(
        `SELECT t.*, c.symbol AS coin_symbol FROM ${this.T.transactions} t
         LEFT JOIN ${this.T.coins} c ON c.coin_id = t.coin_id WHERE t.transaction_id = $1`,
        [id],
      );
      return this.toTransaction(row.rows[0] as Record<string, unknown>);
    });
  }

  async listPriceHistory(query: PriceHistoryQuery): Promise<Paged<PricePoint>> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.assetId) {
      params.push(query.assetId);
      where.push(`ph.coin_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`ph.created_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`ph.created_at <= $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.T.priceHistory} ph ${whereSql}`,
      params,
    );
    const orderBy = orderByClause(
      { page: query.page, pageSize: query.pageSize, order: 'desc', filters: {}, sort: 'recordedAt' },
      PH_SORTS,
      'recordedAt',
    );
    const page = pageClause(
      { page: query.page, pageSize: query.pageSize, order: 'desc', filters: {} },
      params,
    );
    const res = await this.db.query<{
      history_id: number;
      coin_id: number;
      price: string;
      created_at: Date;
    }>(
      `SELECT ph.history_id, ph.coin_id, ph.price::text, ph.created_at
         FROM ${this.T.priceHistory} ph ${whereSql} ${orderBy} ${page}`,
      params,
    );
    return {
      items: res.rows.map((r) => ({
        id: String(r.history_id),
        assetId: String(r.coin_id),
        price: Number(r.price),
        recordedAt: new Date(r.created_at).toISOString(),
      })),
      total: Number(total.rows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private priceFilterSql(filter: { assetId?: string; from?: string; to?: string }, params: unknown[]): string {
    const where: string[] = [];
    if (filter.assetId) {
      params.push(filter.assetId);
      where.push(`coin_id = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`created_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`created_at <= $${params.length}`);
    }
    return where.length ? `WHERE ${where.join(' AND ')}` : '';
  }

  async priceHistoryStats(assetId?: string): Promise<PriceStats[]> {
    const params: unknown[] = [];
    let where = '';
    if (assetId) {
      params.push(assetId);
      where = `WHERE ph.coin_id = $1`;
    }
    const res = await this.db.query<{
      coin_id: number;
      symbol: string;
      count: string;
      min: string | null;
      max: string | null;
      avg: string | null;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `SELECT ph.coin_id, c.symbol, count(*)::text AS count,
              min(ph.price)::text AS min, max(ph.price)::text AS max, avg(ph.price)::text AS avg,
              min(ph.created_at) AS first_at, max(ph.created_at) AS last_at
         FROM ${this.T.priceHistory} ph JOIN ${this.T.coins} c ON c.coin_id = ph.coin_id
         ${whereSql()} GROUP BY ph.coin_id, c.symbol ORDER BY c.symbol`,
      params,
    );
    function whereSql() {
      return where;
    }
    return res.rows.map((r) => ({
      assetId: String(r.coin_id),
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
    const where = this.priceFilterSql(filter, params);
    const res = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.T.priceHistory} ${where}`,
      params,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  /** Issue #10: individual price-history record delete; returns the deleted point. */
  async deletePricePoint(id: string): Promise<PricePoint> {
    const res = await this.db.query<{
      history_id: number;
      coin_id: number;
      price: string;
      created_at: Date;
    }>(
      `DELETE FROM ${this.T.priceHistory} WHERE history_id = $1
       RETURNING history_id, coin_id, price::text, created_at`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Price history record not found');
    return {
      id: String(row.history_id),
      assetId: String(row.coin_id),
      price: Number(row.price),
      recordedAt: new Date(row.created_at).toISOString(),
    };
  }

  async deletePriceHistoryRange(filter: { assetId?: string; from?: string; to?: string }): Promise<number> {
    const params: unknown[] = [];
    const where = this.priceFilterSql(filter, params);
    if (!where) throw new ApiError(400, 'BAD_REQUEST', 'A filter (asset or date range) is required');
    const res = await this.db.query(`DELETE FROM ${this.T.priceHistory} ${where}`, params);
    return res.rowCount ?? 0;
  }

  async resetPriceHistory(assetId?: string): Promise<number> {
    const params: unknown[] = [];
    let where = '';
    if (assetId) {
      params.push(assetId);
      where = 'WHERE coin_id = $1';
    }
    const res = await this.db.query(`DELETE FROM ${this.T.priceHistory} ${where}`, params);
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

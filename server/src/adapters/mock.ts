import { ApiError } from '../core/errors.js';
import type {
  AppAdapter,
  AppHealth,
  AppResourceUsage,
  AssetInfo,
  CapabilitySet,
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
 * Deterministic in-memory adapter with full capabilities. Used for tests,
 * frontend development without app databases, and as executable documentation
 * of the adapter contract. Data resets on process restart.
 */

interface MockUser {
  id: string;
  username: string;
  email: string;
  balance: number;
  disabled: boolean;
  createdAt: string;
  password: string; // demo harness only; never logged/audited
}

const fullCapabilities: CapabilitySet = {
  users: { list: true, get: true, create: true, update: true, disable: true, resetPassword: true, delete: true },
  inventory: { list: true, create: true, update: true, delete: true },
  transactions: { list: true, create: true, update: false, delete: false },
  priceHistory: { list: true, stats: true, deleteRange: true, reset: true },
  overview: true,
  health: true,
};

function applyList<T>(items: T[], query: ListQuery, searchFn: (t: T) => string, sortKey: (t: T, k: string) => unknown): Paged<T> {
  let out = items;
  if (query.search) {
    const s = query.search.toLowerCase();
    out = out.filter((i) => searchFn(i).toLowerCase().includes(s));
  }
  const key = query.sort ?? 'id';
  out = [...out].sort((a, b) => {
    const va = sortKey(a, key);
    const vb = sortKey(b, key);
    if (va === vb) return 0;
    const cmp = va! < vb! ? -1 : 1;
    return query.order === 'asc' ? cmp : -cmp;
  });
  const total = out.length;
  const start = (query.page - 1) * query.pageSize;
  return { items: out.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize };
}

export class MockAdapter implements AppAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities = fullCapabilities;

  private seq = 100;
  private users: MockUser[] = [];
  private assets: AssetInfo[] = [];
  private inventory: InventoryItem[] = [];
  private transactions: TransactionItem[] = [];
  private prices: PricePoint[] = [];

  constructor(id = 'mock', seed = true) {
    this.id = id;
    this.label = 'Mock Demo App';
    if (seed) this.seed();
  }

  private nextId(): string {
    return String(++this.seq);
  }

  private seed(): void {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    this.assets = [
      { id: 'a1', name: 'Alpha Coin', symbol: 'ALPHA', currentPrice: 10 },
      { id: 'a2', name: 'Beta Gem', symbol: 'BETA', currentPrice: 42.5 },
    ];
    for (let i = 1; i <= 25; i++) {
      this.users.push({
        id: `u${i}`,
        username: `user${i}`,
        email: `user${i}@example.test`,
        balance: 1000 + i * 10,
        disabled: i % 7 === 0,
        createdAt: new Date(base + i * 86_400_000).toISOString(),
        password: 'seeded',
      });
    }
    this.inventory = [
      { id: 'i1', userId: 'u1', assetId: 'a1', assetName: 'Alpha Coin', assetSymbol: 'ALPHA', quantity: 5, averagePrice: 9.5 },
      { id: 'i2', userId: 'u1', assetId: 'a2', assetName: 'Beta Gem', assetSymbol: 'BETA', quantity: 2, averagePrice: 40 },
      { id: 'i3', userId: 'u2', assetId: 'a1', assetName: 'Alpha Coin', assetSymbol: 'ALPHA', quantity: 12, averagePrice: 10.1 },
    ];
    this.transactions = [
      { id: 't1', userId: 'u1', assetId: 'a1', assetSymbol: 'ALPHA', type: 'buy', quantity: 5, price: 9.5, totalAmount: 47.5, createdAt: new Date(base + 3600_000).toISOString() },
      { id: 't2', userId: 'u1', assetId: 'a2', assetSymbol: 'BETA', type: 'buy', quantity: 2, price: 40, totalAmount: 80, createdAt: new Date(base + 7200_000).toISOString() },
      { id: 't3', userId: 'u2', assetId: 'a1', assetSymbol: 'ALPHA', type: 'sell', quantity: 1, price: 10.5, totalAmount: 10.5, createdAt: new Date(base + 10_800_000).toISOString() },
    ];
    for (let i = 0; i < 40; i++) {
      this.prices.push({
        id: `p${i}`,
        assetId: i % 2 === 0 ? 'a1' : 'a2',
        price: 10 + Math.sin(i / 3) * 2 + (i % 2 === 0 ? 0 : 30),
        recordedAt: new Date(base + i * 3_600_000).toISOString(),
      });
    }
  }

  async ping(): Promise<AppHealth> {
    return {
      ok: true,
      latencyMs: 0,
      serverVersion: 'mock-in-memory',
      tables: {
        users: this.users.length,
        assets: this.assets.length,
        inventory: this.inventory.length,
        transactions: this.transactions.length,
        priceHistory: this.prices.length,
      },
    };
  }

  /** Deterministic simulated resource usage so the UI can exercise every state. */
  async resourceUsage(): Promise<AppResourceUsage> {
    return {
      collectedAt: new Date().toISOString(),
      storage: {
        status: 'ok',
        scope: 'mock app data (simulated)',
        usedBytes: 128 * 1024 * 1024,
        availableBytes: null,
        totalBytes: null,
        percentUsed: null,
        reason: null,
      },
      memory: {
        status: 'ok',
        scope: 'mock app process (simulated)',
        usedBytes: 64 * 1024 * 1024,
        availableBytes: 448 * 1024 * 1024,
        totalBytes: 512 * 1024 * 1024,
        percentUsed: 12.5,
        reason: null,
      },
    };
  }

  async overview(): Promise<OverviewData> {
    return {
      users: this.users.length,
      assets: this.assets.length,
      transactions: this.transactions.length,
      totalBalance: this.users.reduce((s, u) => s + u.balance, 0),
      assetsSparkline: this.assets.map((a) => ({
        assetId: a.id,
        symbol: a.symbol,
        latestPrice: a.currentPrice,
        points: this.prices.filter((p) => p.assetId === a.id).slice(-30).map((p) => p.price),
      })),
      recentTransactions: this.transactions.slice(-10).reverse(),
    };
  }

  async listAssets(): Promise<AssetInfo[]> {
    return this.assets;
  }

  private toSummary(u: MockUser): UserSummary {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      balance: u.balance,
      disabled: u.disabled,
      createdAt: u.createdAt,
    };
  }

  async listUsers(query: ListQuery): Promise<Paged<UserSummary>> {
    return applyList(this.users.map((u) => this.toSummary(u)), query, (u) => `${u.username} ${u.email}`, (u, k) => (u as unknown as Record<string, unknown>)[k]);
  }

  async getUser(id: string): Promise<UserDetail> {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    return { ...this.toSummary(u), extra: {} };
  }

  async createUser(input: UserCreateInput): Promise<UserDetail> {
    if (this.users.some((u) => u.username.toLowerCase() === input.username.toLowerCase())) {
      throw new ApiError(409, 'CONFLICT', 'Username already exists');
    }
    const u: MockUser = {
      id: this.nextId(),
      username: input.username,
      email: input.email ?? `${input.username}@example.test`,
      balance: input.balance ?? 1000,
      disabled: false,
      createdAt: new Date().toISOString(),
      password: input.password,
    };
    this.users.push(u);
    return { ...this.toSummary(u), extra: {} };
  }

  async updateUser(id: string, patch: UserUpdateInput): Promise<UserDetail> {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    if (patch.username) u.username = patch.username;
    if (patch.email) u.email = patch.email;
    if (patch.balance !== undefined) u.balance = patch.balance;
    return { ...this.toSummary(u), extra: {} };
  }

  async setUserDisabled(id: string, disabled: boolean): Promise<void> {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    u.disabled = disabled;
  }

  async resetUserPassword(id: string, newPassword: string): Promise<void> {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    u.password = newPassword;
  }

  async userRelatedCounts(id: string): Promise<RelatedCounts> {
    return {
      inventory: this.inventory.filter((i) => i.userId === id).length,
      transactions: this.transactions.filter((t) => t.userId === id).length,
    };
  }

  async deleteUser(id: string): Promise<void> {
    const idx = this.users.findIndex((x) => x.id === id);
    if (idx < 0) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    this.users.splice(idx, 1);
    this.inventory = this.inventory.filter((i) => i.userId !== id);
    this.transactions = this.transactions.filter((t) => t.userId !== id);
  }

  async listInventory(userId: string | undefined, query: ListQuery): Promise<Paged<InventoryItem>> {
    let items = this.inventory;
    if (userId) items = items.filter((i) => i.userId === userId);
    if (query.filters.assetId) items = items.filter((i) => i.assetId === query.filters.assetId);
    return applyList(items, query, (i) => `${i.assetName} ${i.assetSymbol}`, (i, k) => (i as unknown as Record<string, unknown>)[k]);
  }

  async createInventory(input: InventoryInput): Promise<InventoryItem> {
    const asset = this.assets.find((a) => a.id === input.assetId);
    if (!asset) throw new ApiError(400, 'BAD_REQUEST', 'Unknown asset');
    if (!this.users.some((u) => u.id === input.userId)) throw new ApiError(400, 'BAD_REQUEST', 'Unknown user');
    const item: InventoryItem = {
      id: this.nextId(),
      userId: input.userId,
      assetId: input.assetId,
      assetName: asset.name,
      assetSymbol: asset.symbol,
      quantity: input.quantity,
      averagePrice: input.averagePrice ?? null,
    };
    this.inventory.push(item);
    return item;
  }

  async updateInventory(id: string, patch: Partial<InventoryInput>): Promise<InventoryItem> {
    const item = this.inventory.find((i) => i.id === id);
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Inventory item not found');
    if (patch.quantity !== undefined) item.quantity = patch.quantity;
    if (patch.averagePrice !== undefined) item.averagePrice = patch.averagePrice;
    return item;
  }

  async deleteInventory(id: string): Promise<void> {
    const idx = this.inventory.findIndex((i) => i.id === id);
    if (idx < 0) throw new ApiError(404, 'NOT_FOUND', 'Inventory item not found');
    this.inventory.splice(idx, 1);
  }

  async listTransactions(query: ListQuery & { userId?: string }): Promise<Paged<TransactionItem>> {
    let items = this.transactions;
    if (query.userId) items = items.filter((t) => t.userId === query.userId);
    if (query.filters.type) items = items.filter((t) => t.type === query.filters.type);
    if (query.filters.assetId) items = items.filter((t) => t.assetId === query.filters.assetId);
    return applyList(items, query, (t) => `${t.type} ${t.assetSymbol ?? ''}`, (t, k) => (t as unknown as Record<string, unknown>)[k]);
  }

  async createTransaction(input: TransactionCreateInput): Promise<TransactionItem> {
    const u = this.users.find((x) => x.id === input.userId);
    const asset = this.assets.find((a) => a.id === input.assetId);
    if (!u || !asset) throw new ApiError(400, 'BAD_REQUEST', 'Unknown user or asset');
    const total = input.quantity * input.price;
    if (input.type === 'buy') {
      if (u.balance < total) throw new ApiError(409, 'CONFLICT', 'Insufficient funds');
      u.balance -= total;
    } else {
      const held = this.inventory.filter((i) => i.userId === u.id && i.assetId === asset.id).reduce((s, i) => s + i.quantity, 0);
      if (held < input.quantity) throw new ApiError(409, 'CONFLICT', 'Insufficient holdings');
      u.balance += total;
    }
    const tx: TransactionItem = {
      id: this.nextId(),
      userId: u.id,
      assetId: asset.id,
      assetSymbol: asset.symbol,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      totalAmount: total,
      createdAt: new Date().toISOString(),
    };
    this.transactions.push(tx);
    return tx;
  }

  async listPriceHistory(query: PriceHistoryQuery): Promise<Paged<PricePoint>> {
    let items = this.prices;
    if (query.assetId) items = items.filter((p) => p.assetId === query.assetId);
    if (query.from) items = items.filter((p) => p.recordedAt >= query.from!);
    if (query.to) items = items.filter((p) => p.recordedAt <= query.to!);
    const sorted = [...items].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
    const total = sorted.length;
    const start = (query.page - 1) * query.pageSize;
    return { items: sorted.slice(start, start + query.pageSize), total, page: query.page, pageSize: query.pageSize };
  }

  async priceHistoryStats(assetId?: string): Promise<PriceStats[]> {
    const groups = new Map<string, PricePoint[]>();
    for (const p of this.prices) {
      if (assetId && p.assetId !== assetId) continue;
      const arr = groups.get(p.assetId) ?? [];
      arr.push(p);
      groups.set(p.assetId, arr);
    }
    return [...groups.entries()].map(([id, pts]) => {
      const asset = this.assets.find((a) => a.id === id);
      const values = pts.map((p) => p.price);
      const times = pts.map((p) => p.recordedAt).sort();
      return {
        assetId: id,
        assetSymbol: asset?.symbol ?? id,
        count: pts.length,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((s, v) => s + v, 0) / values.length,
        firstAt: times[0] ?? null,
        lastAt: times[times.length - 1] ?? null,
      };
    });
  }

  async countPriceHistory(filter: { assetId?: string; from?: string; to?: string }): Promise<number> {
    return this.prices.filter(
      (p) =>
        (!filter.assetId || p.assetId === filter.assetId) &&
        (!filter.from || p.recordedAt >= filter.from) &&
        (!filter.to || p.recordedAt <= filter.to),
    ).length;
  }

  async deletePriceHistoryRange(filter: { assetId?: string; from?: string; to?: string }): Promise<number> {
    const n = await this.countPriceHistory(filter);
    this.prices = this.prices.filter(
      (p) =>
        !(
          (!filter.assetId || p.assetId === filter.assetId) &&
          (!filter.from || p.recordedAt >= filter.from) &&
          (!filter.to || p.recordedAt <= filter.to)
        ),
    );
    return n;
  }

  async resetPriceHistory(assetId?: string): Promise<number> {
    const n = assetId ? this.prices.filter((p) => p.assetId === assetId).length : this.prices.length;
    this.prices = assetId ? this.prices.filter((p) => p.assetId !== assetId) : [];
    return n;
  }

  async close(): Promise<void> {
    // no-op
  }
}

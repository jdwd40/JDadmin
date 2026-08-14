/**
 * Universal Admin adapter contract.
 *
 * One shared admin core drives many application adapters. Each adapter owns
 * its table/schema mappings (statically defined, never from request input),
 * declares the capabilities it supports, and the core/UI render only those
 * capabilities. Adding a new app means adding a new adapter module and a
 * registry entry — no core or UI changes.
 */

export interface CapabilitySet {
  users: {
    list: boolean;
    get: boolean;
    create: boolean;
    update: boolean;
    disable: boolean;
    resetPassword: boolean;
    delete: boolean;
  };
  inventory: {
    list: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  };
  transactions: {
    list: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  };
  priceHistory: {
    list: boolean;
    stats: boolean;
    deleteRange: boolean;
    reset: boolean;
  };
  overview: boolean;
  health: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListQuery {
  page: number;
  pageSize: number;
  search?: string;
  sort?: string;
  order: 'asc' | 'desc';
  filters: Record<string, string>;
}

export interface UserSummary {
  id: string;
  username: string;
  email: string | null;
  displayName?: string | null;
  balance?: number | null;
  disabled: boolean | null; // null = app has no disable concept
  createdAt: string | null;
}

export interface UserDetail extends UserSummary {
  extra: Record<string, unknown>;
}

export interface UserCreateInput {
  username: string;
  email?: string;
  password: string;
  balance?: number;
}

export interface UserUpdateInput {
  username?: string;
  email?: string;
  displayName?: string;
  balance?: number;
}

export interface InventoryItem {
  id: string;
  userId: string;
  assetId: string;
  assetName: string;
  assetSymbol: string;
  quantity: number;
  averagePrice: number | null;
  extra?: Record<string, unknown>;
}

export interface InventoryInput {
  userId: string;
  assetId: string;
  quantity: number;
  averagePrice?: number;
}

export interface TransactionItem {
  id: string;
  userId: string;
  assetId: string | null;
  assetSymbol?: string | null;
  type: string;
  quantity: number | null;
  price: number | null;
  totalAmount: number | null;
  createdAt: string;
  extra?: Record<string, unknown>;
}

export interface TransactionCreateInput {
  userId: string;
  assetId: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
}

export interface AssetInfo {
  id: string;
  name: string;
  symbol: string;
  currentPrice: number | null;
}

export interface PricePoint {
  id: string;
  assetId: string;
  price: number;
  recordedAt: string;
}

export interface PriceHistoryQuery {
  assetId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface PriceStats {
  assetId: string;
  assetSymbol: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface OverviewData {
  users: number;
  assets: number;
  transactions: number;
  totalBalance?: number | null;
  assetsSparkline: Array<{
    assetId: string;
    symbol: string;
    latestPrice: number | null;
    points: number[];
  }>;
  recentTransactions: TransactionItem[];
}

export interface AppHealth {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  tables?: Record<string, number>;
  error?: string;
}

/**
 * Resource-usage contract (issue #4). A sample is either 'ok' with real byte
 * values, 'stale' (last good values after a failed refresh), or 'unavailable'
 * with every byte field null and a sanitized reason. Unavailable is never
 * represented as zero. `scope` is a human-readable label stating whether the
 * value is app-specific, database-scoped, process-scoped, or host-wide.
 */
export type MetricStatus = 'ok' | 'unavailable' | 'stale';

export interface MetricSample {
  status: MetricStatus;
  scope: string;
  usedBytes: number | null;
  availableBytes: number | null;
  totalBytes: number | null;
  /** 0–100 (one decimal) when a meaningful total exists, else null. */
  percentUsed: number | null;
  /** Fixed-vocabulary reason when status is not 'ok'; never raw driver errors. */
  reason: string | null;
}

export interface AppResourceUsage {
  /** ISO timestamp of when the underlying values were collected. */
  collectedAt: string;
  storage: MetricSample;
  memory: MetricSample;
}

export interface HostResourceUsage {
  collectedAt: string;
  memory: MetricSample;
  storage: MetricSample;
  processMemory: MetricSample;
}

export interface RelatedCounts {
  [relation: string]: number;
}

export type CapabilityPath =
  | 'users.list'
  | 'users.get'
  | 'users.create'
  | 'users.update'
  | 'users.disable'
  | 'users.resetPassword'
  | 'users.delete'
  | 'inventory.list'
  | 'inventory.create'
  | 'inventory.update'
  | 'inventory.delete'
  | 'transactions.list'
  | 'transactions.create'
  | 'transactions.update'
  | 'transactions.delete'
  | 'priceHistory.list'
  | 'priceHistory.stats'
  | 'priceHistory.deleteRange'
  | 'priceHistory.reset'
  | 'overview'
  | 'health';

export function capabilityOf(caps: CapabilitySet, path: CapabilityPath): boolean {
  const [group, key] = path.split('.') as [keyof CapabilitySet, string];
  const g = caps[group];
  return typeof g === 'boolean' ? g : Boolean((g as Record<string, boolean>)[key]);
}

/**
 * Adapter interface. Optional methods must be absent (or throw) when the
 * matching capability flag is false; the core gates every call on the
 * declared capability before invoking the adapter.
 */
export interface AppAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: CapabilitySet;

  /** Lightweight connectivity probe used for availability + health. */
  ping(): Promise<AppHealth>;
  /**
   * Read-only resource usage probe (issue #4). Optional; adapters that cannot
   * measure safely must omit it (the core then reports 'unavailable').
   * Unavailable metrics report status + reason, never zero.
   */
  resourceUsage?(): Promise<AppResourceUsage>;
  overview(): Promise<OverviewData>;
  listAssets(): Promise<AssetInfo[]>;

  listUsers(query: ListQuery): Promise<Paged<UserSummary>>;
  getUser(id: string): Promise<UserDetail>;
  createUser?(input: UserCreateInput): Promise<UserDetail>;
  updateUser?(id: string, patch: UserUpdateInput): Promise<UserDetail>;
  setUserDisabled?(id: string, disabled: boolean): Promise<void>;
  resetUserPassword?(id: string, newPassword: string): Promise<void>;
  /** Counts of related records shown to the operator before deletion. */
  userRelatedCounts?(id: string): Promise<RelatedCounts>;
  deleteUser?(id: string): Promise<void>;

  listInventory(userId: string | undefined, query: ListQuery): Promise<Paged<InventoryItem>>;
  createInventory?(input: InventoryInput): Promise<InventoryItem>;
  updateInventory?(id: string, patch: Partial<InventoryInput>): Promise<InventoryItem>;
  deleteInventory?(id: string): Promise<void>;

  listTransactions(query: ListQuery & { userId?: string }): Promise<Paged<TransactionItem>>;
  createTransaction?(input: TransactionCreateInput): Promise<TransactionItem>;
  updateTransaction?(id: string, patch: Partial<TransactionCreateInput>): Promise<TransactionItem>;
  deleteTransaction?(id: string): Promise<void>;

  listPriceHistory(query: PriceHistoryQuery): Promise<Paged<PricePoint>>;
  priceHistoryStats(assetId?: string): Promise<PriceStats[]>;
  /** Returns number of rows that would be deleted (preview/count step). */
  countPriceHistory(filter: { assetId?: string; from?: string; to?: string }): Promise<number>;
  deletePriceHistoryRange?(filter: { assetId?: string; from?: string; to?: string }): Promise<number>;
  resetPriceHistory?(assetId?: string): Promise<number>;

  close(): Promise<void>;
}

export interface RegisteredApp {
  adapter: AppAdapter;
  available: boolean;
  availabilityError?: string;
}

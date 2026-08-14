/**
 * Shared API types for the Universal Admin frontend.
 * Mirrors server/src/adapters/types.ts — keep in sync when the contract changes.
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
    /** Transactional delete-all of every user + related rows (issue #10). */
    deleteAll: boolean;
  };
  inventory: { list: boolean; create: boolean; update: boolean; delete: boolean };
  transactions: { list: boolean; create: boolean; update: boolean; delete: boolean };
  priceHistory: { list: boolean; stats: boolean; delete: boolean; deleteRange: boolean; reset: boolean };
  overview: boolean;
  health: boolean;
}

export type CapabilityPath =
  | 'users.list' | 'users.get' | 'users.create' | 'users.update' | 'users.disable'
  | 'users.resetPassword' | 'users.delete' | 'users.deleteAll'
  | 'inventory.list' | 'inventory.create' | 'inventory.update' | 'inventory.delete'
  | 'transactions.list' | 'transactions.create' | 'transactions.update' | 'transactions.delete'
  | 'priceHistory.list' | 'priceHistory.stats' | 'priceHistory.delete' | 'priceHistory.deleteRange' | 'priceHistory.reset'
  | 'overview' | 'health';

export interface AppInfo {
  id: string;
  label: string;
  available: boolean;
  availabilityError?: string;
  capabilities: CapabilitySet;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserSummary {
  id: string;
  username: string;
  email: string | null;
  displayName?: string | null;
  balance?: number | null;
  disabled: boolean | null;
  createdAt: string | null;
}

export interface UserDetail extends UserSummary {
  extra: Record<string, unknown>;
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

/** Mirrors the server resource-usage contract (issue #4). */
export type MetricStatus = 'ok' | 'unavailable' | 'stale';

export interface MetricSample {
  status: MetricStatus;
  scope: string;
  usedBytes: number | null;
  availableBytes: number | null;
  totalBytes: number | null;
  percentUsed: number | null;
  reason: string | null;
}

export interface AppResourceUsage {
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

export interface AuditEntry {
  id: number;
  actorId: string | null;
  actorUsername: string;
  appId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  previous: unknown;
  next: unknown;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  username: string;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

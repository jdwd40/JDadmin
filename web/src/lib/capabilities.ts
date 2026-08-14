import type { AppInfo, CapabilityPath, CapabilitySet } from '../types';

/** Read a dotted capability path ('users.create') from a capability set. */
export function capabilityOf(caps: CapabilitySet | undefined, path: CapabilityPath): boolean {
  if (!caps) return false;
  const [group, key] = path.split('.') as [keyof CapabilitySet, string];
  const g = caps[group];
  return typeof g === 'boolean' ? g : Boolean((g as Record<string, boolean>)[key]);
}

export interface NavItem {
  key: string;
  label: string;
  /** Capability required to use the page; undefined = always available. */
  requires?: CapabilityPath;
}

/** Static nav definition — the same for every app; enabled state is derived. */
export const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: 'Overview', requires: 'overview' },
  { key: 'users', label: 'Users', requires: 'users.list' },
  { key: 'inventory', label: 'Inventory', requires: 'inventory.list' },
  { key: 'transactions', label: 'Transactions', requires: 'transactions.list' },
  { key: 'price-history', label: 'Price History', requires: 'priceHistory.list' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'health', label: 'System Health' },
];

export interface ResolvedNavItem extends NavItem {
  enabled: boolean;
}

/**
 * Resolve nav items for the selected app. Unsupported capabilities stay
 * visible but disabled so capability state is explicit, never hidden.
 */
export function resolveNav(app: AppInfo | undefined): ResolvedNavItem[] {
  return NAV_ITEMS.map((item) => ({
    ...item,
    enabled:
      !item.requires ||
      Boolean(app && app.available && capabilityOf(app.capabilities, item.requires)),
  }));
}

/** Apps that can be selected (registered), unavailable ones first-flagged. */
export function selectableApps(apps: AppInfo[]): AppInfo[] {
  return [...apps].sort((a, b) => Number(b.available) - Number(a.available) || a.id.localeCompare(b.id));
}

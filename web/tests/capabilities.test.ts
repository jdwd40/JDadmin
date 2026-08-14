import { describe, expect, it } from 'vitest';
import type { AppInfo, CapabilitySet } from '../src/types';
import { capabilityOf, NAV_ITEMS, resolveNav, selectableApps } from '../src/lib/capabilities';

const full: CapabilitySet = {
  users: { list: true, get: true, create: true, update: true, disable: true, resetPassword: true, delete: true },
  inventory: { list: true, create: true, update: true, delete: true },
  transactions: { list: true, create: true, update: false, delete: false },
  priceHistory: { list: true, stats: true, deleteRange: true, reset: true },
  overview: true,
  health: true,
};

const none: CapabilitySet = {
  users: { list: false, get: false, create: false, update: false, disable: false, resetPassword: false, delete: false },
  inventory: { list: false, create: false, update: false, delete: false },
  transactions: { list: false, create: false, update: false, delete: false },
  priceHistory: { list: false, stats: false, deleteRange: false, reset: false },
  overview: false,
  health: false,
};

const mkApp = (id: string, caps: CapabilitySet, available = true): AppInfo => ({
  id,
  label: id,
  available,
  capabilities: caps,
});

describe('capabilityOf', () => {
  it('reads dotted group.key paths', () => {
    expect(capabilityOf(full, 'users.create')).toBe(true);
    expect(capabilityOf(full, 'transactions.update')).toBe(false);
    expect(capabilityOf(full, 'overview')).toBe(true);
  });

  it('returns false for undefined capability sets', () => {
    expect(capabilityOf(undefined, 'users.list')).toBe(false);
  });
});

describe('resolveNav (capability-aware navigation)', () => {
  it('enables gated items only when the app supports them', () => {
    const nav = resolveNav(mkApp('mock', full));
    const byKey = Object.fromEntries(nav.map((n) => [n.key, n.enabled]));
    expect(byKey['overview']).toBe(true);
    expect(byKey['users']).toBe(true);
    expect(byKey['audit']).toBe(true); // always available
    expect(byKey['health']).toBe(true);
  });

  it('keeps unsupported items visible but disabled (honest capability state)', () => {
    const nav = resolveNav(mkApp('dwarf', none));
    expect(nav).toHaveLength(NAV_ITEMS.length); // nothing hidden
    expect(nav.find((n) => n.key === 'users')?.enabled).toBe(false);
    expect(nav.find((n) => n.key === 'audit')?.enabled).toBe(true);
  });

  it('disables gated items for unavailable apps', () => {
    const nav = resolveNav(mkApp('coins', full, false));
    expect(nav.find((n) => n.key === 'overview')?.enabled).toBe(false);
  });
});

describe('destructive capability gating (issue #1)', () => {
  // Mirrors the server-side Coins vs Dwarf capability split.
  const dwarfLike: CapabilitySet = {
    ...full,
    users: { ...full.users, delete: false, disable: false, create: false },
    priceHistory: { list: true, stats: true, deleteRange: false, reset: false },
  };

  it('delete/reset paths gate on the declared capability', () => {
    expect(capabilityOf(full, 'users.delete')).toBe(true);
    expect(capabilityOf(full, 'priceHistory.deleteRange')).toBe(true);
    expect(capabilityOf(full, 'priceHistory.reset')).toBe(true);
    expect(capabilityOf(dwarfLike, 'users.delete')).toBe(false);
    expect(capabilityOf(dwarfLike, 'priceHistory.deleteRange')).toBe(false);
    expect(capabilityOf(dwarfLike, 'priceHistory.reset')).toBe(false);
  });
});

describe('selectableApps (app selector ordering)', () => {
  it('sorts available apps first, then by id', () => {
    const apps = [
      mkApp('zzz', none, false),
      mkApp('dwarf', full),
      mkApp('coins', full),
    ];
    expect(selectableApps(apps).map((a) => a.id)).toEqual(['coins', 'dwarf', 'zzz']);
  });
});

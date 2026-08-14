import type { AppConfig } from '../config.js';
import { CoinsAdapter } from './coins.js';
import { DwarfAdapter } from './dwarf.js';
import { MockAdapter } from './mock.js';
import type { AppAdapter, RegisteredApp } from './types.js';

async function loadArgon2(): Promise<typeof import('argon2') | null> {
  try {
    const mod = await import('argon2');
    return mod;
  } catch {
    return null;
  }
}

/**
 * Registry: builds adapters from config, probes availability, and exposes
 * lookup for the API layer. Apps without configuration register as
 * unavailable so the UI can show capability state honestly.
 * In non-production, a deterministic mock adapter is available via
 * JDADMIN_ENABLE_MOCK=true for UI development/contract checks.
 */
export class AdapterRegistry {
  private readonly apps = new Map<string, RegisteredApp>();

  static async build(config: AppConfig & { enableMock?: boolean }): Promise<AdapterRegistry> {
    const registry = new AdapterRegistry();
    const argon2 = await loadArgon2();

    if (config.coinsDatabaseUrl) {
      await registry.register(new CoinsAdapter(config.coinsDatabaseUrl, config.coinsSchema));
    } else {
      registry.registerUnavailable('coins', 'Coins', 'COINS_DATABASE_URL not configured');
    }

    if (config.dwarfDatabaseUrl) {
      await registry.register(new DwarfAdapter(config.dwarfDatabaseUrl, argon2));
    } else {
      registry.registerUnavailable('dwarf', 'Dwarf Coins', 'DWARF_DATABASE_URL not configured');
    }

    if (config.enableMock) {
      await registry.register(new MockAdapter());
    }
    return registry;
  }

  private async register(adapter: AppAdapter): Promise<void> {
    try {
      const health = await adapter.ping();
      this.apps.set(adapter.id, {
        adapter,
        available: health.ok,
        availabilityError: health.ok ? undefined : health.error,
      });
    } catch (err) {
      this.apps.set(adapter.id, {
        adapter,
        available: false,
        availabilityError: (err as Error).message,
      });
    }
  }

  private registerUnavailable(id: string, label: string, reason: string): void {
    this.apps.set(id, {
      adapter: {
        id,
        label,
        capabilities: {
          users: { list: false, get: false, create: false, update: false, disable: false, resetPassword: false, delete: false },
          inventory: { list: false, create: false, update: false, delete: false },
          transactions: { list: false, create: false, update: false, delete: false },
          priceHistory: { list: false, stats: false, deleteRange: false, reset: false },
          overview: false,
          health: false,
        },
      } as unknown as AppAdapter,
      available: false,
      availabilityError: reason,
    });
  }

  get(id: string): RegisteredApp | undefined {
    return this.apps.get(id);
  }

  /** Direct adapter access for internal (non-request) callers. */
  entries(): Array<{ id: string; registered: RegisteredApp }> {
    return [...this.apps.entries()].map(([id, registered]) => ({ id, registered }));
  }

  list(): Array<{ id: string; label: string; available: boolean; availabilityError?: string; capabilities: unknown }> {
    return [...this.apps.values()].map(({ adapter, available, availabilityError }) => ({
      id: adapter.id,
      label: adapter.label,
      available,
      availabilityError,
      capabilities: adapter.capabilities,
    }));
  }

  async close(): Promise<void> {
    for (const { adapter } of this.apps.values()) {
      // Unavailable apps register a stub without lifecycle methods.
      const closable = adapter as Partial<AppAdapter>;
      if (typeof closable.close === 'function') {
        await closable.close()!.catch(() => undefined);
      }
    }
  }
}

import { Router } from 'express';
import type { AppAdapter, AppResourceUsage, HostResourceUsage } from '../adapters/types.js';
import {
  measureHostMemory,
  measureHostStorage,
  measureProcessMemory,
  MetricsCache,
  unavailableSample,
} from '../core/resources.js';
import { getCtx, requireAuth } from '../http/middleware.js';

/** Resource probes are bounded: values are served fresh for 30s, then re-measured. */
const METRICS_FRESH_MS = 30_000;

function unavailableUsage(reason: string): AppResourceUsage {
  return {
    collectedAt: new Date().toISOString(),
    storage: unavailableSample('app database (PostgreSQL, whole database)', reason),
    memory: unavailableSample('app process', reason),
  };
}

/**
 * Per-app resource usage, cached per metric. A failed refresh degrades the
 * last good values to 'stale'; an app with no successful measurement reports
 * 'unavailable' (never zero).
 */
async function appResources(
  cache: MetricsCache,
  id: string,
  adapter: AppAdapter,
): Promise<AppResourceUsage> {
  if (typeof adapter.resourceUsage !== 'function') {
    return unavailableUsage('adapter does not support resource measurement');
  }
  const probe = adapter.resourceUsage.bind(adapter);
  let loaded: AppResourceUsage | null = null;
  const load = async (): Promise<AppResourceUsage> => {
    if (!loaded) loaded = await probe();
    return loaded;
  };
  const safeLoad = async (
    pick: (u: AppResourceUsage) => AppResourceUsage['storage'],
    scope: string,
  ) => {
    try {
      return pick(await load());
    } catch {
      return unavailableSample(scope, 'measurement failed');
    }
  };
  const [storage, memory] = await Promise.all([
    cache.sample(`app:${id}:storage`, () =>
      safeLoad((u) => u.storage, 'app database (PostgreSQL, whole database)')),
    cache.sample(`app:${id}:memory`, () => safeLoad((u) => u.memory, 'app process')),
  ]);
  return {
    collectedAt: new Date(Math.max(storage.at, memory.at)).toISOString(),
    storage: storage.sample,
    memory: memory.sample,
  };
}

export function healthRouter(): Router {
  const r = Router();
  const metrics = new MetricsCache(METRICS_FRESH_MS);

  /** Liveness: no auth, no sensitive data. */
  r.get('/', async (_req, res) => {
    res.json({ ok: true, service: 'jdadmin', time: new Date().toISOString() });
  });

  /** Detailed per-app DB health: authenticated. */
  r.get('/detail', requireAuth, async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      const apps: Record<string, unknown> = {};
      for (const { id, registered } of ctx.registry.entries()) {
        if (!registered.available) {
          apps[id] = {
            ok: false,
            error: registered.availabilityError,
            resources: unavailableUsage('app is unavailable'),
          };
          continue;
        }
        let ping: Record<string, unknown>;
        try {
          ping = (await registered.adapter.ping()) as unknown as Record<string, unknown>;
        } catch (err) {
          ping = { ok: false, error: (err as Error).message };
        }
        apps[id] = { ...ping, resources: await appResources(metrics, id, registered.adapter) };
      }
      let adminDb: { ok: boolean; error?: string } = { ok: true };
      try {
        await ctx.audit.list({ page: 1, pageSize: 1 });
      } catch (err) {
        adminDb = { ok: false, error: (err as Error).message };
      }
      const [memory, storage, processMemory] = await Promise.all([
        metrics.sample('host:memory', measureHostMemory),
        metrics.sample('host:storage', () => measureHostStorage()),
        metrics.sample('host:process', async () => measureProcessMemory()),
      ]);
      const host: HostResourceUsage = {
        collectedAt: new Date(Math.max(memory.at, storage.at, processMemory.at)).toISOString(),
        memory: memory.sample,
        storage: storage.sample,
        processMemory: processMemory.sample,
      };
      res.json({
        ok: adminDb.ok && Object.values(apps).every((a) => (a as { ok: boolean }).ok),
        adminDb,
        apps,
        host,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

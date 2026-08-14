import { Router } from 'express';
import { getCtx, requireAuth } from '../http/middleware.js';

export function healthRouter(): Router {
  const r = Router();

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
          apps[id] = { ok: false, error: registered.availabilityError };
          continue;
        }
        try {
          apps[id] = await registered.adapter.ping();
        } catch (err) {
          apps[id] = { ok: false, error: (err as Error).message };
        }
      }
      let adminDb: { ok: boolean; error?: string } = { ok: true };
      try {
        await ctx.audit.list({ page: 1, pageSize: 1 });
      } catch (err) {
        adminDb = { ok: false, error: (err as Error).message };
      }
      res.json({
        ok: adminDb.ok && Object.values(apps).every((a) => (a as { ok: boolean }).ok),
        adminDb,
        apps,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

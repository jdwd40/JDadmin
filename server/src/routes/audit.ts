import { Router } from 'express';
import { z } from 'zod';
import { getCtx } from '../http/middleware.js';

const auditQuerySchema = z.object({
  appId: z.string().max(50).optional(),
  action: z.string().max(80).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function auditRouter(): Router {
  const r = Router();
  r.get('/', async (req, res, next) => {
    try {
      const q = auditQuerySchema.parse(req.query);
      res.json(await getCtx(req).audit.list(q));
    } catch (err) {
      next(err);
    }
  });
  return r;
}

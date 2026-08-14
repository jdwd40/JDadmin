import { Router } from 'express';
import { z } from 'zod';
import type { ListQuery } from '../adapters/types.js';
import { errors } from '../core/errors.js';
import {
  clientMeta,
  getCtx,
  requireAdapter,
  requireCapability,
  requireDestructiveEnabled,
} from '../http/middleware.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(200).optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  assetId: z.string().max(64).optional(),
  type: z.string().max(30).optional(),
  userId: z.string().max(64).optional(),
});

function toListQuery(raw: unknown): ListQuery & { userId?: string } {
  const q = listQuerySchema.parse(raw);
  const filters: Record<string, string> = {};
  if (q.assetId) filters.assetId = q.assetId;
  if (q.type) filters.type = q.type;
  return {
    page: q.page,
    pageSize: q.pageSize,
    search: q.search,
    sort: q.sort,
    order: q.order,
    filters,
    userId: q.userId,
  };
}

const userCreateSchema = z.object({
  username: z.string().min(2).max(50).regex(/^[\w.@+-]+$/, 'Invalid username characters'),
  email: z.string().email().max(100).optional(),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  balance: z.coerce.number().min(0).max(1e12).optional(),
});

const userUpdateSchema = z.object({
  username: z.string().min(2).max(50).regex(/^[\w.@+-]+$/).optional(),
  email: z.string().email().max(100).optional(),
  displayName: z.string().min(1).max(80).optional(),
  balance: z.coerce.number().min(0).max(1e12).optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

const disableSchema = z.object({ disabled: z.boolean() });

const inventorySchema = z.object({
  userId: z.string().min(1).max(64),
  assetId: z.string().min(1).max(64),
  quantity: z.coerce.number().min(0).max(1e12),
  averagePrice: z.coerce.number().min(0).max(1e12).optional(),
});

const inventoryPatchSchema = z.object({
  quantity: z.coerce.number().min(0).max(1e12).optional(),
  averagePrice: z.coerce.number().min(0).max(1e12).optional(),
});

const transactionCreateSchema = z.object({
  userId: z.string().min(1).max(64),
  assetId: z.string().min(1).max(64),
  type: z.enum(['buy', 'sell']),
  quantity: z.coerce.number().positive().max(1e12),
  price: z.coerce.number().positive().max(1e12),
});

const priceDeleteSchema = z.object({
  assetId: z.string().max(64).optional(),
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
  confirm: z.literal(true, { errorMap: () => ({ message: 'Explicit confirmation required' }) }),
});

const priceResetSchema = z.object({
  assetId: z.string().max(64).optional(),
  phrase: z.literal('RESET', { errorMap: () => ({ message: 'Type RESET to confirm' }) }),
  // Delete-all requires confirming the exact number of rows in scope (issue #10).
  expectedCount: z.number().int().min(0),
});

const userDeleteSchema = z.object({
  confirmUsername: z.string().min(1),
});

/** Bulk delete-all users: exact phrase + exact current user count (issue #10). */
const userDeleteAllSchema = z.object({
  phrase: z.literal('DELETE ALL', { errorMap: () => ({ message: 'Type DELETE ALL to confirm' }) }),
  expectedCount: z.number().int().min(0),
});

export function appsRouter(): Router {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      res.json({ apps: getCtx(req).registry.list() });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/overview', requireCapability('overview'), async (req, res, next) => {
    try {
      res.json(await requireAdapter(req).overview());
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/assets', async (req, res, next) => {
    try {
      res.json({ assets: await requireAdapter(req).listAssets() });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/health', requireCapability('health'), async (req, res, next) => {
    try {
      res.json(await requireAdapter(req).ping());
    } catch (err) {
      next(err);
    }
  });

  // --- users ---

  r.get('/:appId/users', requireCapability('users.list'), async (req, res, next) => {
    try {
      res.json(await requireAdapter(req).listUsers(toListQuery(req.query)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/users', requireCapability('users.create'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.createUser) throw errors.unsupported('users.create');
      const body = userCreateSchema.parse(req.body);
      const created = await adapter.createUser(body);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'users.create',
        entityType: 'user',
        entityId: created.id,
        next: { ...created, password: undefined },
        meta: clientMeta(req),
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/users/:userId', requireCapability('users.get'), async (req, res, next) => {
    try {
      res.json(await requireAdapter(req).getUser(req.params.userId!));
    } catch (err) {
      next(err);
    }
  });

  r.patch('/:appId/users/:userId', requireCapability('users.update'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.updateUser) throw errors.unsupported('users.update');
      const body = userUpdateSchema.parse(req.body);
      const before = await adapter.getUser(req.params.userId!);
      const updated = await adapter.updateUser(req.params.userId!, body);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'users.update',
        entityType: 'user',
        entityId: updated.id,
        previous: before,
        next: updated,
        meta: clientMeta(req),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/users/:userId/disable', requireCapability('users.disable'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.setUserDisabled) throw errors.unsupported('users.disable');
      const { disabled } = disableSchema.parse(req.body);
      await adapter.setUserDisabled(req.params.userId!, disabled);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: disabled ? 'users.disable' : 'users.enable',
        entityType: 'user',
        entityId: req.params.userId!,
        meta: clientMeta(req),
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/users/:userId/reset-password', requireCapability('users.resetPassword'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.resetUserPassword) throw errors.unsupported('users.resetPassword');
      const { newPassword } = resetPasswordSchema.parse(req.body);
      await adapter.resetUserPassword(req.params.userId!, newPassword);
      // Values deliberately omitted: never audit/log password material.
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'users.reset_password',
        entityType: 'user',
        entityId: req.params.userId!,
        meta: clientMeta(req),
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/users/:userId/related-counts', requireCapability('users.get'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.userRelatedCounts) throw errors.unsupported('users.relatedCounts');
      res.json({ counts: await adapter.userRelatedCounts(req.params.userId!) });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:appId/users/:userId', requireCapability('users.delete'), async (req, res, next) => {
    try {
      requireDestructiveEnabled(req);
      const adapter = requireAdapter(req);
      if (!adapter.deleteUser || !adapter.userRelatedCounts) throw errors.unsupported('users.delete');
      const { confirmUsername } = userDeleteSchema.parse(req.body);
      const before = await adapter.getUser(req.params.userId!);
      if (confirmUsername !== before.username) {
        throw errors.badRequest('Confirmation username does not match the user being deleted');
      }
      const counts = await adapter.userRelatedCounts(req.params.userId!);
      await adapter.deleteUser(req.params.userId!);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'users.delete',
        entityType: 'user',
        entityId: req.params.userId!,
        previous: before,
        next: { relatedCounts: counts },
        meta: clientMeta(req),
      });
      res.json({ ok: true, deletedRelated: counts });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Issue #10: bulk delete-all users. Requires the destructive guard, the
   * exact phrase DELETE ALL, and the exact current user count so an
   * unfiltered production-wide delete can never run accidentally. The
   * adapter performs the delete as one atomic transaction; FK/business
   * failures roll everything back and surface as 409/400 with no audit entry.
   */
  r.post('/:appId/users/delete-all', requireCapability('users.deleteAll'), async (req, res, next) => {
    try {
      requireDestructiveEnabled(req);
      const adapter = requireAdapter(req);
      if (!adapter.deleteAllUsers) throw errors.unsupported('users.deleteAll');
      const body = userDeleteAllSchema.parse(req.body);
      const scope = await adapter.listUsers({ page: 1, pageSize: 1, order: 'asc', filters: {} });
      if (body.expectedCount !== scope.total) {
        throw errors.badRequest(
          `Count confirmation mismatch: the app currently has ${scope.total} users; re-check the scope and confirm the exact total.`,
        );
      }
      const result = await adapter.deleteAllUsers();
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'users.delete_all',
        entityType: 'user',
        entityId: null,
        previous: { scope: 'all users', confirmedCount: body.expectedCount },
        next: { deletedUsers: result.users, deletedRelated: result.related },
        meta: clientMeta(req),
      });
      res.json({ ok: true, deletedUsers: result.users, deletedRelated: result.related });
    } catch (err) {
      next(err);
    }
  });

  // --- inventory ---

  r.get('/:appId/inventory', requireCapability('inventory.list'), async (req, res, next) => {
    try {
      const q = toListQuery(req.query);
      res.json(await requireAdapter(req).listInventory(q.userId, q));
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/inventory', requireCapability('inventory.create'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.createInventory) throw errors.unsupported('inventory.create');
      const body = inventorySchema.parse(req.body);
      const created = await adapter.createInventory(body);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'inventory.create',
        entityType: 'inventory',
        entityId: created.id,
        next: created,
        meta: clientMeta(req),
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/:appId/inventory/:itemId', requireCapability('inventory.update'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.updateInventory) throw errors.unsupported('inventory.update');
      const body = inventoryPatchSchema.parse(req.body);
      const updated = await adapter.updateInventory(req.params.itemId!, body);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'inventory.update',
        entityType: 'inventory',
        entityId: req.params.itemId!,
        next: updated,
        meta: clientMeta(req),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:appId/inventory/:itemId', requireCapability('inventory.delete'), async (req, res, next) => {
    try {
      requireDestructiveEnabled(req);
      const adapter = requireAdapter(req);
      if (!adapter.deleteInventory) throw errors.unsupported('inventory.delete');
      await adapter.deleteInventory(req.params.itemId!);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'inventory.delete',
        entityType: 'inventory',
        entityId: req.params.itemId!,
        meta: clientMeta(req),
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- transactions ---

  r.get('/:appId/transactions', requireCapability('transactions.list'), async (req, res, next) => {
    try {
      res.json(await requireAdapter(req).listTransactions(toListQuery(req.query)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/transactions', requireCapability('transactions.create'), async (req, res, next) => {
    try {
      const adapter = requireAdapter(req);
      if (!adapter.createTransaction) throw errors.unsupported('transactions.create');
      const body = transactionCreateSchema.parse(req.body);
      const created = await adapter.createTransaction(body);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'transactions.create',
        entityType: 'transaction',
        entityId: created.id,
        next: created,
        meta: clientMeta(req),
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // --- price history ---

  r.get('/:appId/price-history', requireCapability('priceHistory.list'), async (req, res, next) => {
    try {
      const q = listQuerySchema.extend({
        from: z.string().optional(),
        to: z.string().optional(),
      }).parse(req.query);
      res.json(
        await requireAdapter(req).listPriceHistory({
          assetId: q.assetId,
          from: q.from,
          to: q.to,
          page: q.page,
          pageSize: q.pageSize,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/price-history/stats', requireCapability('priceHistory.stats'), async (req, res, next) => {
    try {
      const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
      res.json({ stats: await requireAdapter(req).priceHistoryStats(assetId) });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:appId/price-history/count', requireCapability('priceHistory.stats'), async (req, res, next) => {
    try {
      const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      res.json({ count: await requireAdapter(req).countPriceHistory({ assetId, from, to }) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Issue #10: individual price-history record delete. Destructive guard +
   * capability gate; the deleted row is recorded (redacted) in the audit log.
   */
  r.delete('/:appId/price-history/:pointId', requireCapability('priceHistory.delete'), async (req, res, next) => {
    try {
      requireDestructiveEnabled(req);
      const adapter = requireAdapter(req);
      if (!adapter.deletePricePoint) throw errors.unsupported('priceHistory.delete');
      const deleted = await adapter.deletePricePoint(req.params.pointId!);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'price_history.delete',
        entityType: 'price_history',
        entityId: req.params.pointId!,
        previous: deleted,
        meta: clientMeta(req),
      });
      res.json({ ok: true, deleted });
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/price-history/delete-range', requireCapability('priceHistory.deleteRange'), async (req, res, next) => {
    try {
      requireDestructiveEnabled(req);
      const adapter = requireAdapter(req);
      if (!adapter.deletePriceHistoryRange) throw errors.unsupported('priceHistory.deleteRange');
      const body = priceDeleteSchema.parse(req.body);
      // Unfiltered deletes must go through the count-confirmed reset path.
      if (!body.assetId && !body.from && !body.to) {
        throw errors.badRequest('A filter (asset or date range) is required for delete-range');
      }
      const count = await adapter.countPriceHistory(body);
      const deleted = await adapter.deletePriceHistoryRange(body);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'price_history.delete_range',
        entityType: 'price_history',
        entityId: body.assetId ?? 'all',
        previous: { filter: { assetId: body.assetId, from: body.from, to: body.to }, matchedCount: count },
        next: { deleted },
        meta: clientMeta(req),
      });
      res.json({ ok: true, matched: count, deleted });
    } catch (err) {
      next(err);
    }
  });

  r.post('/:appId/price-history/reset', requireCapability('priceHistory.reset'), async (req, res, next) => {
    try {
      requireDestructiveEnabled(req);
      const adapter = requireAdapter(req);
      if (!adapter.resetPriceHistory) throw errors.unsupported('priceHistory.reset');
      const body = priceResetSchema.parse(req.body);
      // Delete-all is only allowed when the operator confirms the exact
      // number of rows currently in scope (issue #10).
      const scopeCount = await adapter.countPriceHistory({ assetId: body.assetId });
      if (body.expectedCount !== scopeCount) {
        throw errors.badRequest(
          `Count confirmation mismatch: ${scopeCount} price-history rows are in scope; re-check the scope and confirm the exact total.`,
        );
      }
      const deleted = await adapter.resetPriceHistory(body.assetId);
      await getCtx(req).audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: adapter.id,
        action: 'price_history.reset',
        entityType: 'price_history',
        entityId: body.assetId ?? 'all',
        previous: { scope: body.assetId ?? 'all', confirmedCount: body.expectedCount },
        next: { deleted },
        meta: clientMeta(req),
      });
      res.json({ ok: true, deleted });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

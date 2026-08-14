import { Router } from 'express';
import { z } from 'zod';
import { errors } from '../core/errors.js';
import {
  clearSessionCookie,
  clientMeta,
  getCtx,
  requireAuth,
  requireCsrf,
  sessionCookie,
} from '../http/middleware.js';

const credentialsSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

export function authRouter(): Router {
  const router = Router();

  router.post('/login', async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      const body = credentialsSchema.parse(req.body);
      const key = `${req.ip ?? 'unknown'}:${body.username.toLowerCase()}`;
      if (!ctx.loginLimiter.allow(key)) {
        throw errors.tooMany('Too many login attempts; try again later');
      }
      const user = await ctx.auth.verifyLogin(body.username, body.password);
      if (!user) {
        await ctx.audit.record({
          actorId: null,
          actorUsername: body.username,
          appId: 'admin',
          action: 'auth.login_failed',
          entityType: 'admin_user',
          meta: clientMeta(req),
        });
        throw errors.unauthorized('Invalid credentials');
      }
      ctx.loginLimiter.reset(key);
      const session = await ctx.auth.createSession(
        user.id,
        req.ip ?? undefined,
        typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : undefined,
      );
      await ctx.audit.record({
        actorId: user.id,
        actorUsername: user.username,
        appId: 'admin',
        action: 'auth.login',
        entityType: 'admin_user',
        entityId: user.id,
        meta: clientMeta(req),
      });
      res.setHeader('Set-Cookie', sessionCookie(ctx.config, session.token, ctx.config.sessionTtlMs));
      res.json({ admin: user, csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      await ctx.auth.logout(req.sessionId!);
      await ctx.audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: 'admin',
        action: 'auth.logout',
        entityType: 'admin_user',
        entityId: req.admin!.id,
        meta: clientMeta(req),
      });
      res.setHeader('Set-Cookie', clearSessionCookie(ctx.config));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, async (req, res, next) => {
    try {
      // Re-issue the CSRF token only at login; /me confirms session state.
      // The SPA keeps the token in memory from the login response; a fresh
      // page load must re-login (documented behavior).
      res.json({ admin: req.admin });
    } catch (err) {
      next(err);
    }
  });

  router.post('/change-password', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const ctx = getCtx(req);
      const body = changePasswordSchema.parse(req.body);
      const ok = await ctx.auth.changePassword(req.admin!.id, body.currentPassword, body.newPassword);
      if (!ok) throw errors.unauthorized('Current password incorrect');
      await ctx.audit.record({
        actorId: req.admin!.id,
        actorUsername: req.admin!.username,
        appId: 'admin',
        action: 'auth.change_password',
        entityType: 'admin_user',
        entityId: req.admin!.id,
        meta: clientMeta(req),
      });
      // All sessions (including this one) were revoked; clear the cookie.
      res.setHeader('Set-Cookie', clearSessionCookie(ctx.config));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

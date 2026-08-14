import express, { Express } from 'express';
import type { AdapterRegistry } from './adapters/registry.js';
import type { AppConfig } from './config.js';
import { AuditService } from './core/audit.js';
import { AuthService } from './core/auth.js';
import { RateLimiter } from './core/rateLimit.js';
import type { AdminDb } from './db/adminDb.js';
import {
  AppContext,
  contextMiddleware,
  errorHandler,
  requireAuth,
  requireCsrf,
} from './http/middleware.js';
import { appsRouter } from './routes/apps.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';

export interface BuildAppOptions {
  config: AppConfig;
  adminDb: AdminDb;
  registry: AdapterRegistry;
}

export function buildApp({ config, adminDb, registry }: BuildAppOptions): { app: Express; ctx: AppContext } {
  const ctx: AppContext = {
    config,
    auth: new AuthService(adminDb, config),
    audit: new AuditService(adminDb),
    registry,
    loginLimiter: new RateLimiter({
      max: config.loginRateLimit.max,
      windowMs: config.loginRateLimit.windowMs,
    }),
    mutationLimiter: new RateLimiter({ max: 120, windowMs: 60_000 }),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(contextMiddleware(ctx));

  // Security headers (small, dependency-free).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // CSRF gate for every mutating API call (mounted before routers).
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    if (req.path === '/auth/login') {
      // Login has its own rate limit and establishes the session+CSRF pair.
      next();
      return;
    }
    requireAuth(req, res, (err?: unknown) => {
      if (err) next(err);
      else requireCsrf(req, res, next);
    });
  });

  app.use('/api/health', healthRouter());
  app.use('/api/auth', authRouter());
  app.use('/api/apps', requireAuth, appsRouter());
  app.use('/api/audit', requireAuth, auditRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  app.use(errorHandler);

  return { app, ctx };
}

import { ZodError } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { AppAdapter, CapabilityPath } from '../adapters/types.js';
import { capabilityOf } from '../adapters/types.js';
import type { AppConfig } from '../config.js';
import type { AuditService } from '../core/audit.js';
import type { AdminUser, AuthService } from '../core/auth.js';
import { ApiError, errors } from '../core/errors.js';
import type { RateLimiter } from '../core/rateLimit.js';

export interface AppContext {
  config: AppConfig;
  auth: AuthService;
  audit: AuditService;
  registry: AdapterRegistry;
  loginLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: AppContext;
    admin?: AdminUser;
    sessionId?: string;
  }
}

export function getCtx(req: Request): AppContext {
  if (!req.ctx) throw new Error('context not attached');
  return req.ctx;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(config: AppConfig, token: string, maxAgeMs: number): string {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(config: AppConfig): string {
  return `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Attaches context and resolves the session (if any) onto the request. */
export function contextMiddleware(ctx: AppContext) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.ctx = ctx;
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[ctx.config.cookieName];
    const session = await ctx.auth.resolveSession(token);
    if (session) {
      req.admin = session.user;
      req.sessionId = session.sessionId;
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.admin || !req.sessionId) {
    next(errors.unauthorized());
    return;
  }
  next();
}

/** Origin check + double-submit CSRF token for all mutating methods. */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  const ctx = getCtx(req);
  const origin = req.headers.origin;
  if (origin && !ctx.config.allowedOrigins.includes(origin)) {
    next(errors.forbidden('Origin not allowed', 'BAD_ORIGIN'));
    return;
  }
  const token = req.headers['x-csrf-token'];
  void ctx.auth
    .verifyCsrf(req.sessionId!, typeof token === 'string' ? token : undefined)
    .then((ok) => {
      if (!ok) next(errors.forbidden('CSRF token missing or invalid', 'CSRF_FAILED'));
      else next();
    })
    .catch(next);
}

export function requireCapability(path: CapabilityPath) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const adapter = requireAdapter(req);
      if (!capabilityOf(adapter.capabilities, path)) {
        next(errors.unsupported(`${adapter.id}:${path}`));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAdapter(req: Request): AppAdapter {
  const ctx = getCtx(req);
  const appId = req.params.appId ?? '';
  const registered = ctx.registry.get(appId);
  if (!registered) throw errors.notFound(`Unknown app: ${appId}`);
  if (!registered.available) {
    throw new ApiError(503, 'APP_UNAVAILABLE', `App ${appId} is unavailable: ${registered.availabilityError}`);
  }
  return registered.adapter;
}

export function requireDestructiveEnabled(req: Request): void {
  if (!getCtx(req).config.destructiveEnabled) throw errors.destructiveDisabled();
}

export function clientMeta(req: Request): Record<string, unknown> {
  return {
    ip: req.ip ?? req.socket.remoteAddress ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null,
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    return;
  }
  // PostgreSQL integrity/business-function failures must surface as clear 4xx,
  // never as a generic silent 500.
  const pgCode = (err as { code?: unknown }).code;
  if (pgCode === '23503') {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message:
          'Operation blocked by referential integrity: related records exist that this action does not remove.',
      },
    });
    return;
  }
  if (pgCode === '23505') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these values already exists.' } });
    return;
  }
  if (pgCode === 'P0001') {
    // RAISE EXCEPTION from an application/business function: the message is
    // app-authored guidance for operators; stack and internals stay hidden.
    const message = err instanceof Error && err.message ? err.message : 'Rejected by application rule';
    res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    return;
  }
  if (pgCode === '42501') {
    // insufficient_privilege from a guard function (e.g. assert_admin_caller)
    // or a missing grant: the PG message can name internal objects, so respond
    // generically.
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Operation not permitted for the configured database principal.' },
    });
    return;
  }
  // Never leak internals.
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

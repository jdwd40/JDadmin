import type { AdminDb } from '../db/adminDb.js';

const SENSITIVE_KEY = /pass(word)?|token|secret|hash|credential|cookie|session/i;

/** Deep-redact sensitive fields before persisting audit values. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  /** Null for unauthenticated events (e.g. failed logins). */
  actorId: string | null;
  actorUsername: string;
  appId: string;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  previous?: unknown;
  next?: unknown;
  meta?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly db: AdminDb) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_audit_log
        (actor_id, actor_username, app_id, action, entity_type, entity_id, previous, new, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.actorId,
        entry.actorUsername,
        entry.appId,
        entry.action,
        entry.entityType,
        entry.entityId != null ? String(entry.entityId) : null,
        entry.previous === undefined ? null : JSON.stringify(redact(entry.previous)),
        entry.next === undefined ? null : JSON.stringify(redact(entry.next)),
        JSON.stringify(redact(entry.meta ?? {})),
      ],
    );
  }

  async list(query: {
    appId?: string;
    action?: string;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: unknown[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.appId) {
      params.push(query.appId);
      where.push(`app_id = $${params.length}`);
    }
    if (query.action) {
      params.push(query.action);
      where.push(`action = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(
        `(actor_username ILIKE $${params.length} OR action ILIKE $${params.length} OR entity_type ILIKE $${params.length} OR entity_id ILIKE $${params.length})`,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit_log ${whereSql}`,
      params,
    );
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.db.query(
      `SELECT id, actor_id, actor_username, app_id, action, entity_type, entity_id,
              previous, new, meta, created_at
         FROM admin_audit_log ${whereSql}
        ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorUsername: r.actor_username,
        appId: r.app_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        previous: r.previous,
        next: r.new,
        meta: r.meta,
        createdAt: r.created_at,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }
}

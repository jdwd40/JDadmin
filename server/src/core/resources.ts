import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { MetricSample } from '../adapters/types.js';

/**
 * Safe, bounded, read-only resource measurements for the System Health view.
 *
 * Guarantees:
 * - No shelling out and no request-controlled input anywhere; every probe is a
 *   static SQL statement, a fixed /proc path, or a runtime API.
 * - Unavailable / permission-denied measurements report status + a sanitized
 *   reason and never masquerade as zero (all byte fields stay null).
 * - Raw driver/OS error messages are never propagated (they can leak users,
 *   hosts, or paths); callers get a fixed reason vocabulary instead.
 */

/** Coerce an unknown measurement to a safe non-negative integer byte count. */
export function sanitizeBytes(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Math.round(n);
}

/** Map an arbitrary probe failure to a safe, fixed reason string. */
export function sanitizeMetricError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '42501' || code === 'EACCES' || code === 'EPERM') return 'permission denied';
  return 'measurement failed';
}

export function unavailableSample(scope: string, reason: string): MetricSample {
  return {
    status: 'unavailable',
    scope,
    usedBytes: null,
    availableBytes: null,
    totalBytes: null,
    percentUsed: null,
    reason,
  };
}

/**
 * Build an 'ok' sample from raw parts. Any malformed part degrades the whole
 * sample to 'unavailable' rather than emitting a partial/zero reading.
 */
export function okSample(
  scope: string,
  used: unknown,
  available: unknown,
  total: unknown,
): MetricSample {
  const usedBytes = sanitizeBytes(used);
  const availableBytes = available === null || available === undefined ? null : sanitizeBytes(available);
  const totalBytes = total === null || total === undefined ? null : sanitizeBytes(total);
  if (usedBytes === null || (available !== null && available !== undefined && availableBytes === null)
    || (total !== null && total !== undefined && totalBytes === null)) {
    return unavailableSample(scope, 'malformed measurement');
  }
  const percentUsed =
    usedBytes !== null && totalBytes !== null && totalBytes > 0
      ? Math.round((usedBytes / totalBytes) * 1000) / 10
      : null;
  return { status: 'ok', scope, usedBytes, availableBytes, totalBytes, percentUsed, reason: null };
}

interface Row {
  bytes: unknown;
}

/**
 * App-specific storage: on-disk size of the PostgreSQL database the app lives
 * in. One static, read-only statement; scope is the app database (a database
 * may be shared, which the scope label makes explicit).
 */
export async function measureDatabaseStorage(
  runQuery: (text: string) => Promise<{ rows: Row[] }>,
  scope = 'app database (PostgreSQL, whole database)',
): Promise<MetricSample> {
  try {
    const res = await runQuery('SELECT pg_database_size(current_database())::text AS bytes');
    return okSample(scope, res.rows[0]?.bytes, null, null);
  } catch (err) {
    return unavailableSample(scope, sanitizeMetricError(err));
  }
}

/** Parse a `Key: 123 kB` line from /proc/meminfo content; null when absent/malformed. */
export function parseMeminfoBytes(content: string, key: string): number | null {
  const m = content.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB\\s*$`, 'm'));
  return m ? sanitizeBytes(Number(m[1]) * 1024) : null;
}

/**
 * Host-wide memory of the machine JDadmin runs on (NOT the app processes).
 * Prefers Linux /proc/meminfo MemAvailable; falls back to os.freemem().
 */
export async function measureHostMemory(): Promise<MetricSample> {
  const scope = 'admin host memory (host-wide)';
  try {
    const content = await fs.readFile('/proc/meminfo', 'utf8');
    const total = parseMeminfoBytes(content, 'MemTotal');
    const available = parseMeminfoBytes(content, 'MemAvailable');
    if (total !== null && available !== null && total > 0) {
      return okSample(scope, total - available, available, total);
    }
  } catch {
    // fall through to the portable os module probe
  }
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (!Number.isFinite(total) || total <= 0) return unavailableSample(scope, 'malformed measurement');
    return okSample(scope, total - free, free, total);
  } catch (err) {
    return unavailableSample(scope, sanitizeMetricError(err));
  }
}

/** Host-wide filesystem usage for the volume `path` resides on. */
export async function measureHostStorage(path = '/'): Promise<MetricSample> {
  const scope = 'admin host filesystem (deployment volume)';
  try {
    const s = await fs.statfs(path);
    const total = sanitizeBytes(s.blocks * s.bsize);
    const available = sanitizeBytes(s.bavail * s.bsize);
    if (total === null || available === null || total <= 0) {
      return unavailableSample(scope, 'malformed measurement');
    }
    return okSample(scope, total - available, available, total);
  } catch (err) {
    return unavailableSample(scope, sanitizeMetricError(err));
  }
}

/** Resident set size of the JDadmin server process itself. */
export function measureProcessMemory(): MetricSample {
  const scope = 'jdadmin process (RSS)';
  try {
    return okSample(scope, process.memoryUsage().rss, null, null);
  } catch (err) {
    return unavailableSample(scope, sanitizeMetricError(err));
  }
}

/**
 * Small TTL cache that bounds measurement frequency and degrades honestly:
 * a failed refresh with a previously-good value is served as 'stale' (values
 * preserved, original collection time kept); with no history it stays
 * 'unavailable'. Never converts a failure into zeros.
 */
export class MetricsCache {
  private readonly entries = new Map<string, { at: number; sample: MetricSample }>();

  constructor(
    private readonly freshMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async sample(
    key: string,
    measure: () => Promise<MetricSample>,
  ): Promise<{ at: number; sample: MetricSample }> {
    const hit = this.entries.get(key);
    if (hit && hit.sample.status === 'ok' && this.now() - hit.at < this.freshMs) {
      return hit;
    }
    const next = await measure();
    if (next.status === 'ok') {
      const entry = { at: this.now(), sample: next };
      this.entries.set(key, entry);
      return entry;
    }
    if (hit && hit.sample.status === 'ok') {
      return { at: hit.at, sample: { ...hit.sample, status: 'stale', reason: next.reason } };
    }
    return { at: this.now(), sample: next };
  }
}

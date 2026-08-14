import type { MetricSample } from '../types';

/**
 * Presentation helpers for System Health resource metrics (issue #4).
 * The key rule: an unavailable metric must never render as "0 B" — zero is a
 * real measurement, unavailable is a state.
 */

/** Human-readable binary byte size; null/invalid → em dash (never a fake 0). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

export interface MetricDisplay {
  /** Primary value line, e.g. "128 MiB used of 512 MiB (25%)" or "unavailable". */
  text: string;
  /** Secondary line: scope label, plus reason for non-ok states. */
  detail: string;
  /** Suggested text tone class. */
  tone: 'ok-text' | 'warn-text' | 'muted';
}

/** Describe a metric sample for display; distinguishes ok / stale / unavailable. */
export function describeMetric(m: MetricSample): MetricDisplay {
  if (m.status === 'unavailable') {
    return {
      text: 'unavailable',
      detail: `${m.scope}${m.reason ? ` — ${m.reason}` : ''}`,
      tone: 'muted',
    };
  }
  const used = formatBytes(m.usedBytes);
  const parts = [`${used} used`];
  if (m.totalBytes !== null) parts.push(`of ${formatBytes(m.totalBytes)}`);
  if (m.availableBytes !== null) parts.push(`(${formatBytes(m.availableBytes)} available)`);
  if (m.percentUsed !== null) parts.push(`— ${m.percentUsed}%`);
  if (m.status === 'stale') {
    return {
      text: `${parts.join(' ')} (stale)`,
      detail: `${m.scope}${m.reason ? ` — last good value; refresh failed: ${m.reason}` : ''}`,
      tone: 'warn-text',
    };
  }
  return { text: parts.join(' '), detail: m.scope, tone: 'ok-text' };
}

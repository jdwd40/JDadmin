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

/**
 * Visual gauge view-model for System Health resource metrics (issue #9).
 * Larger card + meter presentation. Same core rules as describeMetric:
 * unavailable/stale never render as zero or 0%, and status is carried by
 * explicit text (statusLabel), never by color alone.
 */

/** Percent used at or above which an ok metric is flagged near capacity. */
export const NEAR_CAPACITY_PERCENT = 90;

export type GaugeLevel = 'normal' | 'near-capacity' | 'stale' | 'unavailable';

export interface MetricGauge {
  /** Visual severity bucket driving pill/meter classes. */
  level: GaugeLevel;
  /** Text status label shown on the card — status is never color-only. */
  statusLabel: string;
  /** Big percentage readout, e.g. "42%" — em dash when the metric has no percent. */
  percentText: string;
  /** Determinate meter fill fraction 0..1, or null when unknown/unavailable. */
  fillRatio: number | null;
  /** Integer 0..100 for aria-valuenow, or null when the meter is indeterminate. */
  ariaValueNow: number | null;
  /** Meter fill tone class suffix: ok | warn | muted. */
  meterTone: 'ok' | 'warn' | 'muted';
  /** Secondary numeric readouts (em dash when unknown, never a fake zero). */
  usedText: string;
  totalText: string | null;
  availableText: string | null;
  /** Explicit metric scope (database, host filesystem, host memory, process RSS…). */
  scope: string;
  /** Optional reason text for unavailable/stale states. */
  reason: string | null;
}

/** Clamp a percent value to a 0..1 fill fraction. */
function fillFromPercent(percentUsed: number | null): number | null {
  if (percentUsed === null || !Number.isFinite(percentUsed)) return null;
  return Math.min(1, Math.max(0, percentUsed / 100));
}

/** Build the visual gauge model for a metric sample. */
export function describeGauge(m: MetricSample): MetricGauge {
  const usedText = formatBytes(m.usedBytes);
  const totalText = m.totalBytes === null ? null : formatBytes(m.totalBytes);
  const availableText = m.availableBytes === null ? null : formatBytes(m.availableBytes);

  if (m.status === 'unavailable') {
    return {
      level: 'unavailable',
      statusLabel: 'Unavailable',
      percentText: '—',
      fillRatio: null,
      ariaValueNow: null,
      meterTone: 'muted',
      usedText,
      totalText,
      availableText,
      scope: m.scope,
      reason: m.reason,
    };
  }

  const fillRatio = fillFromPercent(m.percentUsed);
  const percentText = m.percentUsed === null ? '—' : `${m.percentUsed}%`;

  if (m.status === 'stale') {
    return {
      level: 'stale',
      statusLabel: 'Stale',
      percentText,
      fillRatio,
      ariaValueNow: fillRatio === null ? null : Math.round(fillRatio * 100),
      meterTone: 'warn',
      usedText,
      totalText,
      availableText,
      scope: m.scope,
      reason: m.reason ? `Last good value; refresh failed: ${m.reason}` : 'Last good value; refresh failed',
    };
  }

  const nearCapacity = m.percentUsed !== null && m.percentUsed >= NEAR_CAPACITY_PERCENT;
  return {
    level: nearCapacity ? 'near-capacity' : 'normal',
    statusLabel: nearCapacity ? 'Near capacity' : 'OK',
    percentText,
    fillRatio,
    ariaValueNow: fillRatio === null ? null : Math.round(fillRatio * 100),
    meterTone: nearCapacity ? 'warn' : 'ok',
    usedText,
    totalText,
    availableText,
    scope: m.scope,
    reason: m.reason,
  };
}

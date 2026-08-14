import { describe, expect, it } from 'vitest';
import { describeMetric, formatBytes } from '../src/lib/format';
import type { MetricSample } from '../src/types';

const base: MetricSample = {
  status: 'ok',
  scope: 'test scope',
  usedBytes: null,
  availableBytes: null,
  totalBytes: null,
  percentUsed: null,
  reason: null,
};

describe('formatBytes', () => {
  it('formats binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(128 * 1024 * 1024)).toBe('128 MiB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GiB');
  });

  it('renders null/invalid as a dash, never a fake zero', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('describeMetric', () => {
  it('renders a normal value with total, availability, and percent', () => {
    const d = describeMetric({
      ...base,
      usedBytes: 64 * 1024 * 1024,
      availableBytes: 448 * 1024 * 1024,
      totalBytes: 512 * 1024 * 1024,
      percentUsed: 12.5,
    });
    expect(d.tone).toBe('ok-text');
    expect(d.text).toBe('64 MiB used of 512 MiB (448 MiB available) — 12.5%');
    expect(d.detail).toBe('test scope');
  });

  it('renders genuine zero usage as zero (a real measurement)', () => {
    const d = describeMetric({ ...base, usedBytes: 0 });
    expect(d.tone).toBe('ok-text');
    expect(d.text).toContain('0 B');
    expect(d.text).not.toContain('unavailable');
  });

  it('renders unavailable as a state, never as zero', () => {
    const d = describeMetric({
      ...base,
      status: 'unavailable',
      scope: 'app process',
      reason: 'permission denied',
    });
    expect(d.text).toBe('unavailable');
    expect(d.text).not.toContain('0 B');
    expect(d.detail).toContain('app process');
    expect(d.detail).toContain('permission denied');
    expect(d.tone).toBe('muted');
  });

  it('marks stale values and preserves the last good numbers', () => {
    const d = describeMetric({
      ...base,
      status: 'stale',
      usedBytes: 1024,
      reason: 'measurement failed',
    });
    expect(d.tone).toBe('warn-text');
    expect(d.text).toContain('1 KiB');
    expect(d.text).toContain('stale');
    expect(d.detail).toContain('last good value');
  });
});

import { describe, expect, it } from 'vitest';
import { describeGauge, NEAR_CAPACITY_PERCENT } from '../src/lib/format';
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

describe('describeGauge (issue #9 visual health)', () => {
  it('renders a normal metric with percent, fill ratio, scope and numbers', () => {
    const g = describeGauge({
      ...base,
      scope: 'database file',
      usedBytes: 256 * 1024 * 1024,
      availableBytes: 768 * 1024 * 1024,
      totalBytes: 1024 * 1024 * 1024,
      percentUsed: 25,
    });
    expect(g.level).toBe('normal');
    expect(g.statusLabel).toBe('OK');
    expect(g.percentText).toBe('25%');
    expect(g.fillRatio).toBe(0.25);
    expect(g.ariaValueNow).toBe(25);
    expect(g.meterTone).toBe('ok');
    expect(g.usedText).toBe('256 MiB');
    expect(g.totalText).toBe('1 GiB');
    expect(g.availableText).toBe('768 MiB');
    expect(g.scope).toBe('database file');
  });

  it('renders genuine zero usage as 0% with an empty-but-real meter', () => {
    const g = describeGauge({ ...base, usedBytes: 0, percentUsed: 0 });
    expect(g.level).toBe('normal');
    expect(g.percentText).toBe('0%');
    expect(g.fillRatio).toBe(0);
    expect(g.ariaValueNow).toBe(0);
    expect(g.usedText).toBe('0 B');
  });

  it('renders unavailable as an indeterminate state, never zero or 0%', () => {
    const g = describeGauge({
      ...base,
      status: 'unavailable',
      scope: 'host memory',
      reason: 'permission denied',
    });
    expect(g.level).toBe('unavailable');
    expect(g.statusLabel).toBe('Unavailable');
    expect(g.percentText).toBe('—');
    expect(g.percentText).not.toContain('0');
    expect(g.fillRatio).toBeNull();
    expect(g.ariaValueNow).toBeNull();
    expect(g.meterTone).toBe('muted');
    expect(g.usedText).toBe('—');
    expect(g.reason).toBe('permission denied');
    expect(g.scope).toBe('host memory');
  });

  it('renders stale with last-good numbers, warn tone, and refresh-failed reason', () => {
    const g = describeGauge({
      ...base,
      status: 'stale',
      usedBytes: 1024 * 1024,
      percentUsed: 40,
      reason: 'df timed out',
    });
    expect(g.level).toBe('stale');
    expect(g.statusLabel).toBe('Stale');
    expect(g.percentText).toBe('40%');
    expect(g.fillRatio).toBe(0.4);
    expect(g.meterTone).toBe('warn');
    expect(g.usedText).toBe('1 MiB');
    expect(g.reason).toContain('Last good value');
    expect(g.reason).toContain('df timed out');
  });

  it('flags near-capacity metrics at the threshold with warn tone and text label', () => {
    const g = describeGauge({ ...base, percentUsed: NEAR_CAPACITY_PERCENT });
    expect(g.level).toBe('near-capacity');
    expect(g.statusLabel).toBe('Near capacity');
    expect(g.meterTone).toBe('warn');
    expect(g.percentText).toBe(`${NEAR_CAPACITY_PERCENT}%`);

    const below = describeGauge({ ...base, percentUsed: NEAR_CAPACITY_PERCENT - 0.1 });
    expect(below.level).toBe('normal');
    expect(below.meterTone).toBe('ok');
  });

  it('clamps out-of-range percentages into a valid meter fill', () => {
    expect(describeGauge({ ...base, percentUsed: 150 }).fillRatio).toBe(1);
    expect(describeGauge({ ...base, percentUsed: -10 }).fillRatio).toBe(0);
    expect(describeGauge({ ...base, percentUsed: 150 }).ariaValueNow).toBe(100);
  });

  it('handles ok metrics with no percent: big readout is a dash, meter indeterminate', () => {
    const g = describeGauge({ ...base, usedBytes: 2048 });
    expect(g.level).toBe('normal');
    expect(g.percentText).toBe('—');
    expect(g.fillRatio).toBeNull();
    expect(g.ariaValueNow).toBeNull();
    expect(g.usedText).toBe('2 KiB');
  });
});

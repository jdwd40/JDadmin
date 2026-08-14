import { describe, expect, it } from 'vitest';
import { canNext, canPrev, clampPage, nextSort, pageCount, pageWindowLabel } from '../src/lib/pagination';

describe('pagination', () => {
  it('computes page count with a minimum of 1', () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(137, 25)).toBe(6);
  });

  it('clamps out-of-range pages', () => {
    expect(clampPage(0, 100, 25)).toBe(1);
    expect(clampPage(-3, 100, 25)).toBe(1);
    expect(clampPage(99, 100, 25)).toBe(4);
    expect(clampPage(2, 100, 25)).toBe(2);
  });

  it('prev/next bounds', () => {
    expect(canPrev(1)).toBe(false);
    expect(canPrev(2)).toBe(true);
    expect(canNext(4, 100, 25)).toBe(false);
    expect(canNext(3, 100, 25)).toBe(true);
  });

  it('renders window labels', () => {
    expect(pageWindowLabel(1, 25, 0)).toBe('0 of 0');
    expect(pageWindowLabel(2, 25, 137)).toBe('26–50 of 137');
    expect(pageWindowLabel(6, 25, 137)).toBe('126–137 of 137');
  });

  it('toggles sort direction on repeat column, resets on new column', () => {
    expect(nextSort({ sort: undefined, order: 'asc' }, 'username')).toEqual({ sort: 'username', order: 'asc' });
    expect(nextSort({ sort: 'username', order: 'asc' }, 'username')).toEqual({ sort: 'username', order: 'desc' });
    expect(nextSort({ sort: 'username', order: 'desc' }, 'balance')).toEqual({ sort: 'balance', order: 'asc' });
  });
});

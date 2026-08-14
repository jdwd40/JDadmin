/** Pure pagination helpers shared by all list pages. */

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a requested page into the valid range for the given result size. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const max = pageCount(total, pageSize);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), max);
}

export function canPrev(page: number): boolean {
  return page > 1;
}

export function canNext(page: number, total: number, pageSize: number): boolean {
  return page < pageCount(total, pageSize);
}

/** Human label: "21–40 of 137". */
export function pageWindowLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return '0 of 0';
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return `${start}–${end} of ${total}`;
}

/** Toggle a sort column: same column flips direction, new column starts asc. */
export function nextSort(
  current: { sort?: string; order: 'asc' | 'desc' },
  column: string,
): { sort: string; order: 'asc' | 'desc' } {
  if (current.sort !== column) return { sort: column, order: 'asc' };
  return { sort: column, order: current.order === 'asc' ? 'desc' : 'asc' };
}

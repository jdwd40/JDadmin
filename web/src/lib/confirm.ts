/**
 * Pure destructive-action confirmation validators. The UI blocks submission
 * until these pass; the server independently re-validates every one.
 */

/** Price-history reset requires the exact phrase RESET. */
export function resetPhraseOk(input: string): boolean {
  return input.trim() === 'RESET';
}

/** Range delete requires an explicit confirmation checkbox. */
export function confirmChecked(checked: boolean): boolean {
  return checked === true;
}

export interface DeleteRangeForm {
  assetId?: string;
  from?: string;
  to?: string;
  confirm: boolean;
}

/** A range delete needs at least one filter plus confirmation. */
export function deleteRangeValid(form: DeleteRangeForm): boolean {
  const hasFilter = Boolean(form.assetId || form.from || form.to);
  return hasFilter && confirmChecked(form.confirm);
}

/** Delete-all users requires the exact phrase DELETE ALL. */
export function deleteAllPhraseOk(input: string): boolean {
  return input.trim() === 'DELETE ALL';
}

/**
 * Unfiltered destructive operations additionally require typing the exact
 * number of rows currently in scope (issue #10). The server re-checks the
 * count at execution time.
 */
export function countConfirmOk(input: string, expected: number): boolean {
  return /^\d+$/.test(input.trim()) && Number(input.trim()) === expected;
}

/**
 * Pure destructive-action confirmation validators. The UI blocks submission
 * until these pass; the server independently re-validates every one.
 */

/** Price-history reset requires the exact phrase RESET. */
export function resetPhraseOk(input: string): boolean {
  return input.trim() === 'RESET';
}

/** User delete requires typing the exact username of the user being deleted. */
export function usernameConfirmOk(input: string, expectedUsername: string): boolean {
  return input === expectedUsername;
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

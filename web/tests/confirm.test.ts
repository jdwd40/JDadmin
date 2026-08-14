import { describe, expect, it } from 'vitest';
import {
  confirmChecked,
  deleteRangeValid,
  resetPhraseOk,
  usernameConfirmOk,
} from '../src/lib/confirm';

describe('destructive confirmation dialogs', () => {
  it('price reset accepts only the exact phrase RESET', () => {
    expect(resetPhraseOk('RESET')).toBe(true);
    expect(resetPhraseOk('reset')).toBe(false);
    expect(resetPhraseOk(' RESET ')).toBe(true); // surrounding whitespace tolerated
    expect(resetPhraseOk('RESET!')).toBe(false);
    expect(resetPhraseOk('')).toBe(false);
  });

  it('user delete requires the exact username (no trimming tolerance)', () => {
    expect(usernameConfirmOk('alice', 'alice')).toBe(true);
    expect(usernameConfirmOk('Alice', 'alice')).toBe(false);
    expect(usernameConfirmOk('alice ', 'alice')).toBe(false);
    expect(usernameConfirmOk('', 'alice')).toBe(false);
  });

  it('range delete needs at least one filter and explicit confirmation', () => {
    expect(deleteRangeValid({ assetId: '1', confirm: true })).toBe(true);
    expect(deleteRangeValid({ from: '2026-01-01', confirm: true })).toBe(true);
    expect(deleteRangeValid({ confirm: true })).toBe(false); // no filter
    expect(deleteRangeValid({ assetId: '1', confirm: false })).toBe(false);
  });

  it('confirm checkbox must be exactly true', () => {
    expect(confirmChecked(true)).toBe(true);
    expect(confirmChecked(false)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  confirmChecked,
  countConfirmOk,
  deleteAllPhraseOk,
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

  it('delete-all users accepts only the exact phrase DELETE ALL (issue #10)', () => {
    expect(deleteAllPhraseOk('DELETE ALL')).toBe(true);
    expect(deleteAllPhraseOk(' DELETE ALL ')).toBe(true); // surrounding whitespace tolerated
    expect(deleteAllPhraseOk('delete all')).toBe(false);
    expect(deleteAllPhraseOk('DELETE')).toBe(false);
    expect(deleteAllPhraseOk('')).toBe(false);
  });

  it('count confirmation requires typing the exact in-scope total (issue #10)', () => {
    expect(countConfirmOk('42', 42)).toBe(true);
    expect(countConfirmOk(' 42 ', 42)).toBe(true);
    expect(countConfirmOk('0', 0)).toBe(true);
    expect(countConfirmOk('41', 42)).toBe(false);
    expect(countConfirmOk('42.0', 42)).toBe(false);
    expect(countConfirmOk('-1', -1)).toBe(false);
    expect(countConfirmOk('abc', 42)).toBe(false);
    expect(countConfirmOk('', 0)).toBe(false);
  });
});

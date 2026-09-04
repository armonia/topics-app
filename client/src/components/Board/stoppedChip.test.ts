/**
 * The rose 'stopped' badge, and the one column it must never appear in.
 *
 * `dispatchError` outlives the turn that wrote it. With no live chip on the row
 * both the card and the drawer drew a failure badge out of it, status unread:
 * 44 cards sat in Done wearing one. The work had landed - somebody approved it
 * - and the card said it had stopped.
 */
import { describe, expect, test } from 'bun:test';
import { showsStoppedChip } from './stoppedChip';

describe('showsStoppedChip', () => {
  const error = 'Il turno è terminato senza arrivare a review dopo 2 tentativi.';   // allow-italian: the exact sentence the rows carry

  test('a done card renders nothing, whatever it carries', () => {
    expect(showsStoppedChip({ status: 'done', dispatchError: error })).toBe(false);
    expect(showsStoppedChip({ status: 'done', dispatchError: error, dispatchState: null })).toBe(false);
  });

  test('everywhere else the reason is still true, and it is said', () => {
    for (const status of ['todo', 'backlog', 'in_progress', 'review']) {
      expect(showsStoppedChip({ status, dispatchError: error }), status).toBe(true);
    }
  });

  test('a live chip wins: that one is the state of NOW, this is a leftover', () => {
    expect(showsStoppedChip({ status: 'todo', dispatchState: 'queued', dispatchError: error })).toBe(false);
    expect(showsStoppedChip({ status: 'in_progress', dispatchState: 'working', dispatchError: error })).toBe(false);
  });

  test('no reason, no badge', () => {
    expect(showsStoppedChip({ status: 'todo' })).toBe(false);
    expect(showsStoppedChip({ status: 'todo', dispatchError: null })).toBe(false);
    expect(showsStoppedChip({ status: 'todo', dispatchError: '' })).toBe(false);
  });
});

/**
 * THE BOARD TAB COUNTS THE LIT CARDS (tasks.md 1.13, ATTN-16, BOARD-1).
 *
 * The number on a board tab and on the Board row is the number of lit `task:`
 * subjects of that board (every board for the general one): a card in review,
 * a parked card, and a card whose agent asks something mid-turn. Before, it
 * counted the cards in review only, so a parked card lit the Dock and not the
 * tab, and a card asking for a permission was nowhere.
 *
 * @covers ATTN-16, CHROME-COUNT-01
 */
import { describe, test, expect } from 'bun:test';
import { boardAttention } from '../../state/attentionRollups';
import { chromeAttentionTotal } from '../../state/attentionTotal';
import type { AttentionSnapshot } from '../../../../shared/attention';

function card(id: string, over: Partial<AttentionSnapshot>): AttentionSnapshot {
  return {
    subject: `task:${id}`, state: 'idle', reason: null, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
    epoch: 1, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}

const rowsOf = (...rows: AttentionSnapshot[]) => new Map(rows.map((r) => [r.subject, r]));
const cards = [{ id: 'r', projectId: 'p1' }, { id: 'k', projectId: 'p1' }, { id: 'w', projectId: 'p2' }, { id: 'q', projectId: 'p1' }];

describe('board tab: review + parked + a wait mid-turn', () => {
  test('one board in review, one parked, one asking a permission: the general board says 3, its projects their own', () => {
    const rows = rowsOf(
      card('r', { state: 'needs-you', reason: 'review', lit: true }),
      card('k', { state: 'needs-you', reason: 'parked', lit: true }),
      card('w', { state: 'needs-you', reason: 'permission', lit: true }),
      card('q', { state: 'idle' }),
    );
    expect(boardAttention(rows, cards, null)).toEqual({ tier: 'needs-you', count: 3 });
    expect(boardAttention(rows, cards, 'p1')).toEqual({ tier: 'needs-you', count: 2 });
    expect(boardAttention(rows, cards, 'p2')).toEqual({ tier: 'needs-you', count: 1 });
  });

  test('the parked card put back in the queue: the tab drops to 1', () => {
    const before = rowsOf(card('r', { state: 'needs-you', reason: 'review', lit: true }), card('k', { state: 'needs-you', reason: 'parked', lit: true }));
    const after = rowsOf(card('r', { state: 'needs-you', reason: 'review', lit: true }), card('k', { state: 'idle' }));
    expect([boardAttention(before, cards, 'p1').count, boardAttention(after, cards, 'p1').count]).toEqual([2, 1]);
  });

  test('the general board counts the same cards the Dock counts', () => {
    const rows = rowsOf(card('r', { state: 'needs-you', reason: 'review', lit: true }), card('w', { state: 'needs-you', reason: 'question', lit: true }));
    expect(boardAttention(rows, cards, null).count).toBe(chromeAttentionTotal(rows, {}));
  });

  test('a card the list does not hold yet counts on the general board only', () => {
    const rows = rowsOf(card('new', { state: 'needs-you', reason: 'review', lit: true }));
    expect([boardAttention(rows, cards, null).count, boardAttention(rows, cards, 'p1').count]).toEqual([1, 0]);
  });
});

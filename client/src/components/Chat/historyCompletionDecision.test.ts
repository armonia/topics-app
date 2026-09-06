/**
 * @covers CHAT-HIST-01
 */
import { describe, expect, test } from 'bun:test';
import { decideHistoryCompletion, type HistoryCompletionSituation } from './historyCompletionDecision';

const base: HistoryCompletionSituation = {
  paneHidden: false,
  streaming: false,
  userScrolled: false,
  anchoredAtBottom: true,
};

describe('decideHistoryCompletion: when the rest of the thread may be merged', () => {
  test('a pane on screen waits, even anchored at the bottom and untouched', () => {
    expect(decideHistoryCompletion(base)).toEqual({ action: 'wait' });
  });

  test('a pane on screen that the reader has scrolled waits: the row at the top is the way', () => {
    expect(decideHistoryCompletion({ ...base, userScrolled: true, anchoredAtBottom: false })).toEqual({ action: 'wait' });
  });

  test('a hidden pane resting at the bottom completes and goes back to the bottom', () => {
    expect(decideHistoryCompletion({ ...base, paneHidden: true })).toEqual({ action: 'complete', restore: 'bottom' });
  });

  test('a hidden pane the reader had scrolled completes and keeps the row they were on', () => {
    expect(decideHistoryCompletion({ ...base, paneHidden: true, userScrolled: true, anchoredAtBottom: false })).toEqual({
      action: 'complete',
      restore: 'top-item',
    });
    // Away from the bottom without a gesture (a palette jump landed there):
    // still the row, not the bottom.
    expect(decideHistoryCompletion({ ...base, paneHidden: true, anchoredAtBottom: false })).toEqual({
      action: 'complete',
      restore: 'top-item',
    });
  });

  test('a streaming turn waits even when the pane is hidden', () => {
    expect(decideHistoryCompletion({ ...base, paneHidden: true, streaming: true })).toEqual({ action: 'wait' });
  });
});

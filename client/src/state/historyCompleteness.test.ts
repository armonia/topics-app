/**
 * @covers CHAT-HIST-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetHistoryCompleteness,
  getHistoryCompleteness,
  isHistoryIncomplete,
  markHistoryComplete,
  markHistoryPartial,
  markHistoryStaged,
  registerHistoryCompleter,
  requestHistoryCompletion,
  resetHistoryCompleteness,
} from './historyCompleteness';
import type { ChatMessage } from '../types';

afterEach(() => __resetHistoryCompleteness());

const row = (id: string): ChatMessage => ({ id, role: 'user', content: id, timestamp: '2026-09-05T10:00:00.000Z' });

describe('historyCompleteness: what the store knows about a thread', () => {
  test('a session never loaded is unknown, not complete', () => {
    expect(getHistoryCompleteness('s1')).toEqual({ state: 'unknown' });
    expect(isHistoryIncomplete(getHistoryCompleteness('s1'))).toBe(false);
  });

  test('partial carries the boundary and the count of what is missing', () => {
    markHistoryPartial('s1', { boundaryId: 'm81', missing: 80 });
    expect(getHistoryCompleteness('s1')).toEqual({ state: 'partial', boundaryId: 'm81', missing: 80 });
    expect(isHistoryIncomplete(getHistoryCompleteness('s1'))).toBe(true);
    markHistoryComplete('s1');
    expect(getHistoryCompleteness('s1')).toEqual({ state: 'complete' });
    resetHistoryCompleteness('s1');
    expect(getHistoryCompleteness('s1')).toEqual({ state: 'unknown' });
  });

  test('staged rows wait with their boundary; an answer for another boundary is dropped', () => {
    markHistoryPartial('s1', { boundaryId: 'm81', missing: 80 });
    markHistoryStaged('s1', 'm40', [row('m1')]);
    expect(getHistoryCompleteness('s1').state).toBe('partial');
    markHistoryStaged('s1', 'm81', [row('m1'), row('m2')]);
    expect(getHistoryCompleteness('s1')).toEqual({ state: 'staged', boundaryId: 'm81', missing: 80, rows: [row('m1'), row('m2')] });
    expect(isHistoryIncomplete(getHistoryCompleteness('s1'))).toBe(true);
    // Staging is only a step out of partial: a complete session ignores it.
    markHistoryComplete('s1');
    markHistoryStaged('s1', 'm81', [row('m1')]);
    expect(getHistoryCompleteness('s1')).toEqual({ state: 'complete' });
  });

  test('a completer runs only for an incomplete session, with the mode asked, and only when one is registered', async () => {
    const asked: string[] = [];
    await requestHistoryCompletion('s1', 'apply');
    expect(asked).toEqual([]);
    const off = registerHistoryCompleter(async (k, mode) => { asked.push(`${k}:${mode}`); });
    await requestHistoryCompletion('s1', 'apply');
    expect(asked).toEqual([]);
    markHistoryPartial('s1', { boundaryId: 'm81', missing: 80 });
    await requestHistoryCompletion('s1', 'stage');
    markHistoryStaged('s1', 'm81', [row('m1')]);
    await requestHistoryCompletion('s1', 'apply');
    expect(asked).toEqual(['s1:stage', 's1:apply']);
    off();
    await requestHistoryCompletion('s1', 'apply');
    expect(asked).toEqual(['s1:stage', 's1:apply']);
  });

  test('an identical partial mark does not produce a new snapshot', () => {
    markHistoryPartial('s1', { boundaryId: 'm81', missing: 80 });
    const first = getHistoryCompleteness('s1');
    markHistoryPartial('s1', { boundaryId: 'm81', missing: 80 });
    expect(getHistoryCompleteness('s1')).toBe(first);
  });
});

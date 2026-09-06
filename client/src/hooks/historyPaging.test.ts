/**
 * @covers CHAT-HIST-01
 */
import { describe, expect, test } from 'bun:test';
import { mergeHistoryPage, mergeOlderHistory, pageOverlapsExisting } from './historyPaging';
import { decideCacheWrite } from './messageCacheWrite';
import { HISTORY_FIRST_PAGE } from '../../../shared/history-paging';
import { CLIENT_MESSAGE_ID_PREFIX } from './streamCatchupMerge';
import type { ChatMessage } from '../types';

const T0 = Date.parse('2026-09-05T10:00:00.000Z');
/** A server row: durable id, timestamp `n` seconds after T0. */
const row = (n: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${n}`,
  role: n % 2 ? 'user' : 'assistant',
  content: `message ${n}`,
  timestamp: new Date(T0 + n * 1000).toISOString(),
  ...extra,
});
const ids = (list: ChatMessage[]) => list.map((m) => m.id);
const thread = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

describe('mergeHistoryPage: the first page over what the pane holds', () => {
  test('an empty pane takes the page as is', () => {
    const page = thread(81, 120);
    expect(mergeHistoryPage([], page)).toBe(page);
  });

  test('a cache older than the page stays IN FRONT, in order', () => {
    // The cache was written from the settled tail while message 120 was still
    // streaming: it holds 80..119, the raw tail the server sends is 81..120.
    const cached = thread(80, 119);
    const page = thread(81, 120);
    const out = mergeHistoryPage(cached, page);
    expect(ids(out)).toEqual(ids(thread(80, 120)));
  });

  test('a row that landed over the wire during the fetch stays at the END', () => {
    const cached = [...thread(81, 120), row(121)];
    const page = thread(81, 120);
    expect(ids(mergeHistoryPage(cached, page))).toEqual(ids(thread(81, 121)));
  });

  test('an optimistic bubble the page already carries is dropped, not doubled', () => {
    const optimistic: ChatMessage = { ...row(120), id: `${CLIENT_MESSAGE_ID_PREFIX}abc` };
    const cached = [...thread(81, 119), optimistic];
    const page = thread(81, 120);
    expect(ids(mergeHistoryPage(cached, page))).toEqual(ids(thread(81, 120)));
  });

  test('a cache entirely older than the page is kept in front by timestamp', () => {
    // More than a page landed while this pane was away: nothing in common.
    const cached = thread(1, 40);
    const page = thread(81, 120);
    const out = mergeHistoryPage(cached, page);
    expect(ids(out)).toEqual([...ids(thread(1, 40)), ...ids(thread(81, 120))]);
  });

  test('page rows win over the local copy of the same id', () => {
    const stale = { ...row(100), content: 'old text' };
    const cached = [stale, ...thread(101, 120)];
    const page = thread(81, 120);
    const out = mergeHistoryPage(cached, page);
    expect(out.find((m) => m.id === 'm100')?.content).toBe('message 100');
  });
});

describe('pageOverlapsExisting: does the pane already hold a row of the page?', () => {
  test('yes when one id is shared, no when the two are disjoint or one side is empty', () => {
    expect(pageOverlapsExisting(thread(1, 120), thread(81, 120))).toBe(true);
    expect(pageOverlapsExisting(thread(1, 40), thread(81, 120))).toBe(false);
    expect(pageOverlapsExisting([], thread(81, 120))).toBe(false);
    expect(pageOverlapsExisting(thread(1, 40), [])).toBe(false);
  });
});

describe('mergeOlderHistory: the rest of the thread under the first page', () => {
  test('the older rows go before the boundary, the pane keeps everything from it on', () => {
    const existing = thread(81, 120);
    const older = thread(1, 80);
    expect(ids(mergeOlderHistory(existing, older, 'm81'))).toEqual(ids(thread(1, 120)));
  });

  test('what the pane held before the boundary is replaced by the server rows', () => {
    // The cache had 79..80 and a row the server has since deleted.
    const existing = [row(79), row(80), row(999), ...thread(81, 120)];
    const older = thread(1, 80);
    expect(ids(mergeOlderHistory(existing, older, 'm81'))).toEqual(ids(thread(1, 120)));
  });

  test('older rows the pane already holds from the boundary on are dropped (dedup by id)', () => {
    // Unknown boundary on the server: it answered with the WHOLE thread.
    const existing = thread(81, 120);
    const older = thread(1, 120);
    expect(ids(mergeOlderHistory(existing, older, 'm81'))).toEqual(ids(thread(1, 120)));
  });

  test('a compaction marker anchored in the head lands on the right row: order is the server order', () => {
    // The head arrives in server order and is not re-sorted: a marker keyed by
    // `afterMessageId` finds its row exactly where the server put it.
    const existing = thread(81, 120);
    const older = thread(1, 80);
    const out = mergeOlderHistory(existing, older, 'm81');
    expect(out.findIndex((m) => m.id === 'm40')).toBe(39);
    expect(out.findIndex((m) => m.id === 'm81')).toBe(80);
  });

  test('a boundary no longer in the list means a stale answer: the list is returned untouched', () => {
    const existing = thread(1, 120);
    expect(mergeOlderHistory(existing, thread(1, 40), 'gone')).toBe(existing);
  });

  test('nothing to add and nothing to replace: same array', () => {
    const existing = thread(1, 120);
    expect(mergeOlderHistory(existing, [], 'm1')).toBe(existing);
  });
});

describe('the local copy is the first page', () => {
  test('the cache keeps exactly HISTORY_FIRST_PAGE messages, the last ones', () => {
    // The server answers `{ limit: HISTORY_FIRST_PAGE }` with the last N rows;
    // the cache must hold the same N so the first frame IS the first page.
    const settled = thread(1, 120);
    const d = decideCacheWrite({ settled, previous: null, maxMessages: HISTORY_FIRST_PAGE, maxBytes: 10 * 1024 * 1024 });
    expect(d.action).toBe('write');
    if (d.action !== 'write') return;
    expect(d.kept).toBe(HISTORY_FIRST_PAGE);
    expect(ids(JSON.parse(d.payload) as ChatMessage[])).toEqual(ids(settled.slice(-HISTORY_FIRST_PAGE)));
  });

  test('the byte cap is a guard, not the target: it shortens the tail only when the page does not fit', () => {
    const settled = thread(1, 120);
    const oneRow = JSON.stringify([row(1)]).length;
    const d = decideCacheWrite({ settled, previous: null, maxMessages: HISTORY_FIRST_PAGE, maxBytes: oneRow * 12 });
    expect(d.action).toBe('write');
    if (d.action !== 'write') return;
    expect(d.kept).toBeLessThan(HISTORY_FIRST_PAGE);
    expect(d.kept).toBeGreaterThan(0);
  });
});

/**
 * F21 - ONE FROZEN TREE, FOUR SURFACES THAT MUST AGREE.
 *
 * The frame is authoritative and carries the whole list: the store therefore has
 * to REPLACE rather than merge (a thaw arrives as an absence, not as an event),
 * and a card, a sidebar row, a tab and a pane have to reach the same entry from
 * the three different identities they each happen to know.
 *
 * @covers KANBAN-85
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { _adoptForTests, _readForTests, _resetForTests, _subscribeForTests, pickSwapFreeze, type SwapFreezeView } from './swapFreeze';

const view = (over: Partial<SwapFreezeView> = {}): SwapFreezeView => ({
  id: 'tree-1',
  sessionKey: 'topic:3ddb9fb9',
  topicId: '3ddb9fb9',
  terminalId: 'term-7',
  taskId: 'task-9',
  command: 'bun batteria.ts',
  footprintGB: 2.1,
  pagesReadBackPerS: 33.6,
  debtGBPerMin: 8.8,
  frozenAt: 1_760_000_000_000,
  thawBy: 1_760_000_600_000,
  n: 1,
  ...over,
});

const frame = (views: SwapFreezeView[]) => ({ type: 'swap-freeze:state', views });

afterEach(() => { _resetForTests(); });

describe('the list is replaced, never merged', () => {
  it('adopts a frame and drops what the next one no longer carries', () => {
    _adoptForTests(frame([view(), view({ id: 'tree-2', topicId: 'other', terminalId: null, taskId: null })]));
    expect(_readForTests()).toHaveLength(2);
    _adoptForTests(frame([view()]));
    expect(_readForTests().map((v) => v.id)).toEqual(['tree-1']);
    _adoptForTests(frame([]));
    expect(_readForTests(), 'a thaw arrives as an absence').toEqual([]);
  });

  it('a frame that changes nothing does not wake the surfaces', () => {
    let announced = 0;
    const off = _subscribeForTests(() => { announced++; });
    _adoptForTests(frame([view()]));
    expect(announced).toBe(1);
    _adoptForTests(frame([view()]));
    expect(announced, 'the same freeze, again: nothing re-renders').toBe(1);
    _adoptForTests(frame([view({ id: 'tree-2' })]));
    expect(announced).toBe(2);
    off();
  });

  it('a frame of another kind, or a malformed one, is ignored', () => {
    _adoptForTests({ type: 'provider:hold', untilMs: 1 });
    expect(_readForTests()).toEqual([]);
    _adoptForTests(frame([{ nonsense: true } as unknown as SwapFreezeView]));
    expect(_readForTests()).toEqual([]);
  });
});

describe('every surface finds its own freeze', () => {
  const list = [view()];

  it('a pane finds it by terminal id, a chat and a row by topic, a card by its task', () => {
    expect(pickSwapFreeze(list, { terminalId: 'term-7' })?.id).toBe('tree-1');
    expect(pickSwapFreeze(list, { topicId: '3ddb9fb9' })?.id).toBe('tree-1');
    expect(pickSwapFreeze(list, { taskId: 'task-9' })?.id).toBe('tree-1');
  });

  it('a session key is accepted where a topic id is expected: the two spellings coexist on the wire', () => {
    expect(pickSwapFreeze(list, { topicId: 'topic:3ddb9fb9' })?.id).toBe('tree-1');
  });

  it('somebody else\'s topic, tab or card gets nothing', () => {
    expect(pickSwapFreeze(list, { topicId: 'another' })).toBeNull();
    expect(pickSwapFreeze(list, { terminalId: 'term-8' })).toBeNull();
    expect(pickSwapFreeze(list, { taskId: 'task-1' })).toBeNull();
    expect(pickSwapFreeze([], { topicId: '3ddb9fb9' })).toBeNull();
  });

  it('the terminal match wins over the topic one: two panes of one topic are two answers', () => {
    const two = [view({ id: 'a', terminalId: 'term-7' }), view({ id: 'b', terminalId: 'term-8' })];
    expect(pickSwapFreeze(two, { topicId: '3ddb9fb9', terminalId: 'term-8' })?.id).toBe('b');
  });
});

/**
 * A WINDOW NOBODY IS LOOKING AT DOES NOT RE-READ THE BOARD.
 *
 * `useGlobalBoard` is mounted unconditionally in `App`, and it re-read the
 * whole cross-project feed on every `task:created|updated|deleted` and on every
 * WS reconnect. The board moves because AGENTS move it: a night of eight cards
 * is hundreds of frames, and the feed is a synchronous SQLite read plus 1.6 MB
 * of JSON - per open window, for pixels behind a minimised window or a hidden
 * tab. On Bun's single event loop that read is streaming, WS, PTY and browser
 * panes standing still.
 *
 * The gate is `document.hidden`, and NOT the focus predicate of
 * `isWindowAwake`: an app merely behind another window still shows its board,
 * and a board that quietly stopped updating while you can read it is worse than
 * the cost. What the gate must not do is LOSE the update: the debt is recorded
 * and paid with one read when the window comes back.
 *
 * jsdom is not a dependency of this project (see the header of
 * `test/reactHarness.ts`), so `document` here is the two members the hook
 * actually touches.
 * @covers KANBAN-06
 */
import { describe, expect, test, afterEach, beforeEach, jest } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';
import { boardApi, type BoardTask } from '../lib/board';
import { dispatchLifecycle } from '../lib/wsFrameBus';
import { __resetBoardTasks, getBoardTasks } from '../lib/boardTasksStore';
import { useGlobalBoard } from './useGlobalBoard';
import type { WSMessage } from '../types';

const realListAll = boardApi.listAll;
let reads = 0;
let listeners: Array<() => void> = [];
let hidden = false;

/** The slice of `document` the hook reads. Restored after each test. */
const fakeDocument = {
  get hidden() { return hidden; },
  addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.push(fn); },
  removeEventListener: (type: string, fn: () => void) => {
    if (type === 'visibilitychange') listeners = listeners.filter((l) => l !== fn);
  },
};
const realDocument = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  jest.useFakeTimers();
  reads = 0;
  listeners = [];
  hidden = false;
  (globalThis as { document?: unknown }).document = fakeDocument;
  boardApi.listAll = (() => { reads++; return Promise.resolve([] as BoardTask[]); }) as typeof boardApi.listAll;
});

afterEach(() => {
  jest.useRealTimers();
  boardApi.listAll = realListAll;
  if (realDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = realDocument;
});

/** Mounts the hook and hands back the WS pump it subscribed to. */
function mountBoard() {
  let emit: ((msg: WSMessage) => void) | null = null;
  const onMessage = (handler: (msg: WSMessage) => void) => {
    emit = handler;
    return () => { emit = null; };
  };
  const Probe = (): null => { useGlobalBoard(onMessage); return null; };
  const h = mount(createElement(Probe));
  return {
    taskEvent: () => emit?.({ type: 'task:updated' } as unknown as WSMessage),
    /** A frame with a payload: what the server actually sends. */
    send: (msg: Record<string, unknown>) => emit?.(msg as unknown as WSMessage),
    visibilityChanged: () => { for (const l of [...listeners]) l(); },
    unmount: () => h.unmount(),
  };
}

/** Lets the coalescer's window close, so a pending read would leave. */
function flushCoalescer(): void {
  jest.advanceTimersByTime(500);
}

describe('useGlobalBoard: the hidden window does not read the feed', () => {
  test('a task:updated on a hidden window costs zero reads', () => {
    const b = mountBoard();
    expect(reads, 'the first read, on mount, is not gated').toBe(1);

    hidden = true;
    b.taskEvent();
    b.taskEvent();
    b.taskEvent();
    flushCoalescer();
    expect(reads, 'a burst of agent moves behind a hidden window').toBe(1);
    b.unmount();
  });

  test('coming back into view pays ONE read for the whole burst', () => {
    const b = mountBoard();
    hidden = true;
    b.taskEvent();
    b.taskEvent();
    flushCoalescer();
    expect(reads).toBe(1);

    hidden = false;
    b.visibilityChanged();
    flushCoalescer();
    expect(reads, 'one read, not one per missed event').toBe(2);

    // And a second visibilitychange with nothing owed reads nothing.
    b.visibilityChanged();
    flushCoalescer();
    expect(reads).toBe(2);
    b.unmount();
  });

  test('a reconnect while hidden is a debt, not a read', () => {
    const b = mountBoard();
    hidden = true;
    dispatchLifecycle('open');
    flushCoalescer();
    expect(reads).toBe(1);

    hidden = false;
    b.visibilityChanged();
    flushCoalescer();
    expect(reads, 'the hole the socket left is filled when somebody looks').toBe(2);
    b.unmount();
  });

  test('with the window in view nothing changed: every event still reads', () => {
    const b = mountBoard();
    b.taskEvent();
    flushCoalescer();
    expect(reads).toBe(2);
    b.taskEvent();
    flushCoalescer();
    expect(reads).toBe(3);
    b.unmount();
  });
});

/**
 * A READ THAT ANSWERS A CHANGE REACHES THE SERVER.
 *
 * `listAll` goes through the app-wide fetch coalescer with a 2 s window, so
 * that the mount read and the first socket-open re-read (~700 ms apart at
 * boot) cost one request. Put on EVERY read, that window handed a `task:*`
 * re-read the answer from before the event: the tail read of a burst — the
 * one whose job is to be later than the last event — got the pre-burst
 * snapshot, and the board stayed behind with nothing left to correct it.
 *
 * What is asserted is the second argument of `listAll`: the boot reads carry
 * the window, the reads that answer an event, a reader's ask or a reconnect
 * carry none.
 * @covers KANBAN-06 BOOT-NET-01
 */
describe('useGlobalBoard: only the boot reads may share the coalescer window', () => {
  let windows: Array<{ ttlMs: number } | undefined> = [];
  beforeEach(() => {
    windows = [];
    boardApi.listAll = ((_status?: unknown, read?: { ttlMs: number }) => {
      reads++;
      windows.push(read);
      return Promise.resolve([] as BoardTask[]);
    }) as typeof boardApi.listAll;
  });

  test('the mount read rides the window; a task:* read does not, nor does the tail of its burst', () => {
    const b = mountBoard();
    expect(windows).toEqual([{ ttlMs: 2000 }]);
    // The mount read opens the coalescer's own 400 ms window: an event inside
    // it would fold into that window's tail. Closed first, so that the burst
    // below is measured as a burst of its own (leading read + one tail).
    flushCoalescer();
    expect(reads).toBe(1);

    b.taskEvent();
    expect(reads, 'the leading read of the burst leaves at once').toBe(2);
    expect(windows[1], 'and it does not ride the window').toBeUndefined();
    b.taskEvent();
    b.taskEvent();
    flushCoalescer();
    expect(reads).toBe(3);
    expect(windows[2], 'the TAIL read: the one that must be later than the last event').toBeUndefined();
    b.unmount();
  });

  test('the debt of a hidden window is paid with a fresh read', () => {
    const b = mountBoard();
    hidden = true;
    b.taskEvent();
    flushCoalescer();
    hidden = false;
    b.visibilityChanged();
    flushCoalescer();
    expect(reads).toBe(2);
    expect(windows[1]).toBeUndefined();
    b.unmount();
  });

  test('a re-open of the socket is a hole: its read does not ride the window', () => {
    const b = mountBoard();
    // The bus counts the opens for the whole life of the module, and the tests
    // above have opened it already: every `open` from here on is a RE-open.
    // (The first open of a page riding the window is what keeps the boot at
    // one read, and BOARD-19 counts that on the real page.)
    dispatchLifecycle('open');
    flushCoalescer();
    expect(reads).toBe(2);
    expect(windows[1], 'the hole the socket left is filled from the server').toBeUndefined();
    b.unmount();
  });
});

/**
 * A FRAME THAT CARRIES ITS ROW IS NOT A REASON TO RE-READ THE FEED.
 *
 * Measured on the live log (2026-09-07, 95 minutes, ONE client): 1194 reads of
 * `/api/all-boards/tasks` against 152 HTTP writes on tasks, 73 KB each, 112 s
 * of the server's single loop. The other thousand came from the dispatcher
 * re-emitting the same row every few seconds while an agent works, and every
 * one of those frames already contained the row the read went to fetch.
 *
 * What still reads: an id the store does not have, a status that moved, a
 * creation, a deletion, a reconnect, a return to view - and, rarely, a timer,
 * because `queueReason` of the SIBLING cards is computed over the whole batch.
 * @covers KANBAN-06
 */
describe('useGlobalBoard: the frame is the answer', () => {
  const row = (id: string, over: Partial<BoardTask> = {}): BoardTask =>
    ({ id, projectId: 'p1', text: id, status: 'todo', kanbanOrder: 0, parentTaskId: null, ...over } as BoardTask);
  const realNow = Date.now;

  /** Lets the mount read land in the store (it resolves on the microtask queue). */
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

  beforeEach(() => {
    __resetBoardTasks();
    boardApi.listAll = (() => { reads++; return Promise.resolve([row('a'), row('b')] as BoardTask[]); }) as typeof boardApi.listAll;
  });
  afterEach(() => { Date.now = realNow; __resetBoardTasks(); });

  test('N updates of a known row at an unchanged status cost ZERO reads', async () => {
    const b = mountBoard();
    await settle();
    expect(reads, 'the mount read').toBe(1);

    b.send({ type: 'task:updated', projectId: 'p1', task: row('a', { text: 'agent at work' }) });
    b.send({ type: 'task:updated', projectId: 'p1', task: row('a', { text: 'still at work' }) });
    b.send({ type: 'task:updated', projectId: 'p1', task: row('b') });
    flushCoalescer();
    await settle();
    expect(reads, 'the store absorbed all three').toBe(1);
    expect(getBoardTasks().map((t) => t.text)).toEqual(['still at work', 'b']);
    b.unmount();
  });

  test('a status that moved, and an id nobody has, still read', async () => {
    const b = mountBoard();
    await settle();
    b.send({ type: 'task:updated', projectId: 'p1', task: row('a', { status: 'in_progress' }) });
    flushCoalescer();
    await settle();
    expect(reads, 'a card that changed column moves other cards too').toBe(2);

    b.send({ type: 'task:updated', projectId: 'p1', task: row('zz') });
    flushCoalescer();
    await settle();
    expect(reads, 'an unknown id can only be read in').toBe(3);

    b.send({ type: 'task:created', projectId: 'p1', task: row('cc') });
    flushCoalescer();
    await settle();
    expect(reads, 'a creation is a read').toBe(4);

    b.send({ type: 'task:deleted', projectId: 'p1', taskId: 'a' });
    flushCoalescer();
    await settle();
    expect(reads, 'so is a deletion').toBe(5);
    b.unmount();
  });

  test('after a minute of absorbed frames one read leaves anyway', async () => {
    const b = mountBoard();
    await settle();
    expect(reads).toBe(1);
    b.send({ type: 'task:updated', projectId: 'p1', task: row('a') });
    expect(reads).toBe(1);

    Date.now = () => realNow() + 61_000;
    b.send({ type: 'task:updated', projectId: 'p1', task: row('a') });
    flushCoalescer();
    await settle();
    expect(reads, 'the waiting reason of the OTHER cards has an expiry').toBe(2);
    b.unmount();
  });
});

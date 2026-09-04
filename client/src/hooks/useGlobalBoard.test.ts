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

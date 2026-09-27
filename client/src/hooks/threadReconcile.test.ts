/**
 * THE THREAD RECONCILE OF AN OPEN PANE, from the frame on the socket to the read.
 *
 * A `topic:updated` that says rows changed out of band (`threadChanged`) must
 * reach `loadHistory` as a `fresh` read, or the history dedup drops it in a
 * window that read the chat in the last 5 s: at boot, every window (card
 * edf3c4db). The reconcile is debounced per session, so the flag has to
 * survive a plain `topic:updated` arriving after it inside the debounce.
 *
 * Driven through the subscription usePanelLifecycle installs (WS Cluster 1),
 * with frames emitted on a fake `onWSMessage`.
 *
 * @covers INTERRUPT-01, RESUME-02
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { subscribeThreadReconcile } from './threadReconcile';
import type { WSMessage } from '../types';

const SK = 'topic:reconcile';
const TOPIC = { id: 'reconcile-1', sessionKey: SK };

function socket() {
  const handlers = new Set<(msg: WSMessage) => void>();
  return {
    onWSMessage: (h: (msg: WSMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    emit: (frame: Record<string, unknown>) => { for (const h of handlers) h(frame as unknown as WSMessage); },
    get listeners() { return handlers.size; },
  };
}

function paneWith(opts: { open?: boolean; ownStream?: boolean; streaming?: boolean } = {}) {
  const ws = socket();
  const reads: Array<[string, { fresh?: boolean } | undefined]> = [];
  const stop = subscribeThreadReconcile(ws.onWSMessage, {
    isOpen: (id) => (opts.open ?? true) && id === TOPIC.id,
    isOwnStream: () => opts.ownStream ?? false,
    isSessionStreaming: () => opts.streaming ?? false,
    loadHistory: (sk, o) => { reads.push([sk, o]); },
  });
  return { ws, reads, stop };
}

const changed = { type: 'topic:updated', topic: TOPIC, threadChanged: true };
const plain = { type: 'topic:updated', topic: TOPIC };

describe('the reconcile of an open pane', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('rows changed out of band: one read, past the dedup', () => {
    const { ws, reads } = paneWith();
    ws.emit(changed);
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([[SK, { fresh: true }]]);
  });

  test('a plain frame inside the debounce does not drop the flag', () => {
    const { ws, reads } = paneWith();
    ws.emit(changed);
    jest.advanceTimersByTime(200);
    ws.emit(plain);
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([[SK, { fresh: true }]]);
  });

  test('a plain frame is a plain read, one per burst', () => {
    const { ws, reads } = paneWith();
    ws.emit(plain);
    ws.emit(plain);
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([[SK, undefined]]);
  });

  test('a chat this window does not hold open, or another frame type, is not read', () => {
    const closed = paneWith({ open: false });
    closed.ws.emit(changed);
    const open = paneWith();
    open.ws.emit({ ...changed, type: 'topic:created' });
    jest.advanceTimersByTime(400);
    expect(closed.reads).toEqual([]);
    expect(open.reads).toEqual([]);
  });

  test("the window's own stream, or a turn streaming into it, is left to its frames", () => {
    const own = paneWith({ ownStream: true });
    own.ws.emit(changed);
    const live = paneWith({ streaming: true });
    live.ws.emit(changed);
    jest.advanceTimersByTime(400);
    expect(own.reads).toEqual([]);
    expect(live.reads).toEqual([]);
  });

  test('unsubscribed: nothing pending fires, and no handler is left on the socket', () => {
    const { ws, reads, stop } = paneWith();
    ws.emit(changed);
    stop();
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([]);
    expect(ws.listeners).toBe(0);
  });
});

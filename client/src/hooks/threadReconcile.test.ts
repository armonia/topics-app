/**
 * THE THREAD RECONCILE OF AN OPEN PANE, between `topic:updated` and the read.
 *
 * A frame that says rows changed out of band (`threadChanged`) must reach
 * `loadHistory` as a `fresh` read, or the history dedup drops it in a window
 * that read the chat in the last 5 s: at boot, every window (card edf3c4db).
 * The reconcile is debounced per session, so the flag has to survive a plain
 * `topic:updated` arriving after it inside the debounce.
 *
 * @covers INTERRUPT-01, RESUME-02
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createThreadReconcile } from './threadReconcile';

const SK = 'topic:reconcile';

function reconcileWith(opts: { ownStream?: boolean; streaming?: boolean } = {}) {
  const reads: Array<[string, { fresh?: boolean } | undefined]> = [];
  const reconcile = createThreadReconcile({
    isOwnStream: () => opts.ownStream ?? false,
    isSessionStreaming: () => opts.streaming ?? false,
    loadHistory: (sk, o) => { reads.push([sk, o]); },
  });
  return { reconcile, reads };
}

describe('the reconcile of an open pane', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('rows changed out of band: one read, past the dedup', () => {
    const { reconcile, reads } = reconcileWith();
    reconcile.request(SK, true);
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([[SK, { fresh: true }]]);
  });

  test('a plain frame inside the debounce does not drop the flag', () => {
    const { reconcile, reads } = reconcileWith();
    reconcile.request(SK, true);
    jest.advanceTimersByTime(200);
    reconcile.request(SK, false);
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([[SK, { fresh: true }]]);
  });

  test('a plain frame is a plain read, one per burst', () => {
    const { reconcile, reads } = reconcileWith();
    reconcile.request(SK, false);
    reconcile.request(SK, false);
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([[SK, undefined]]);
  });

  test("the window's own stream, or a turn streaming into it, is left to its frames", () => {
    const own = reconcileWith({ ownStream: true });
    own.reconcile.request(SK, true);
    const live = reconcileWith({ streaming: true });
    live.reconcile.request(SK, true);
    jest.advanceTimersByTime(400);
    expect(own.reads).toEqual([]);
    expect(live.reads).toEqual([]);
  });

  test('disposed: nothing pending fires', () => {
    const { reconcile, reads } = reconcileWith();
    reconcile.request(SK, true);
    reconcile.dispose();
    jest.advanceTimersByTime(400);
    expect(reads).toEqual([]);
  });
});

import { describe, test, expect } from 'bun:test';
import {
  TerminalInputQueue,
  TERMINAL_INPUT_QUEUE_MAX_AGE_MS,
  TERMINAL_INPUT_QUEUE_MAX_BYTES,
  INPUT_LOSS_MESSAGE_KEY,
  nextInputBands,
  type InputQueueState,
} from './inputQueue';

/**
 * The keys typed between a reload and the attach.
 *
 * Without the queue this file is red by construction: the old bridge was a bare
 * `if (ws.readyState === OPEN) ws.send(data)`, so every assertion about what
 * arrives after the socket comes back asserts nothing arrived.
 *
 * @covers TERM-11
 */
function harness(opts: { maxBytes?: number; maxAgeMs?: number } = {}) {
  const sent: string[] = [];
  const states: InputQueueState[] = [];
  let clock = 1_000;
  let readyState = 1;
  let attached = true;
  const socket = { get readyState() { return readyState; }, send: (d: string) => { sent.push(d); } };
  // Fake timers on the same fake clock: the expiry has to be observable
  // WITHOUT a keystroke, which is the whole point of block 3.
  type Pending = { at: number; fn: () => void };
  const timers = new Map<number, Pending>();
  let nextTimerId = 1;
  const queue = new TerminalInputQueue({
    socket: () => socket,
    attached: () => attached,
    onStateChange: (s) => states.push({ ...s }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { at: clock + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => { timers.delete(id as unknown as number); },
    ...opts,
  });
  const runDueTimers = () => {
    for (const [id, p] of [...timers]) {
      if (p.at <= clock) { timers.delete(id); p.fn(); }
    }
  };
  return {
    queue,
    sent,
    states,
    /** Move the clock AND let any timer that came due actually fire. */
    advance(ms: number) { clock += ms; runDueTimers(); },
    pendingTimers: () => timers.size,
    /** Fire every armed timer whatever its deadline says. `setTimeout` counts
     *  monotonic milliseconds while the queue reads the wall clock, so a real
     *  wake-up can land before the queue agrees the entry is old enough. */
    fireTimersEarly() { for (const [id, p] of [...timers]) { timers.delete(id); p.fn(); } },
    /** The socket is gone and the attach with it: this is what a reload does. */
    drop() { readyState = 3; attached = false; },
    /** The socket is back but the session has not proven it is alive yet. */
    reopen() { readyState = 1; attached = false; },
    /** `replay-end` arrived: the attach is real. */
    attach() { readyState = 1; attached = true; },
  };
}

describe('TerminalInputQueue', () => {
  test('an attached socket is written to directly, nothing is held', () => {
    const h = harness();
    expect(h.queue.send('l')).toBe('sent');
    expect(h.sent).toEqual(['l']);
    expect(h.queue.state.pendingBytes).toBe(0);
  });

  test('three keys typed while the socket is down arrive in order and once', () => {
    const h = harness();
    h.drop();
    expect(h.queue.send('a')).toBe('queued');
    expect(h.queue.send('b')).toBe('queued');
    expect(h.queue.send('c')).toBe('queued');
    expect(h.sent).toEqual([]);
    h.attach();
    expect(h.queue.flush()).toBe(3);
    expect(h.sent).toEqual(['a', 'b', 'c']);
    // A second attach must not deliver them again.
    h.queue.flush();
    expect(h.sent).toEqual(['a', 'b', 'c']);
  });

  test('an open socket without a proven attach still holds the input', () => {
    const h = harness();
    h.reopen();
    expect(h.queue.send('x')).toBe('queued');
    expect(h.sent).toEqual([]);
    h.attach();
    h.queue.flush();
    expect(h.sent).toEqual(['x']);
  });

  test('past the byte ceiling the whole queue goes, and it says so', () => {
    // Not just the overflowing key: keeping the prefix and dropping the middle
    // delivers a mutilated command line. Nothing is delivered at all.
    const h = harness({ maxBytes: 4 });
    h.drop();
    h.queue.send('abcd');
    expect(h.queue.send('e')).toBe('discarded');
    expect(h.queue.state.lostReason).toBe('tooLong');
    h.attach();
    h.queue.flush();
    expect(h.sent).toEqual([]);
  });

  test('input older than the age limit takes the whole queue with it', () => {
    // The survivor is not innocent: it is the TAIL of the line whose head just
    // expired, and delivering it alone is how `sudo ` becomes `rm -rf build`.
    const h = harness({ maxAgeMs: 1_000 });
    h.drop();
    h.queue.send('old');
    h.advance(1_500);
    h.queue.send('new');
    h.attach();
    h.queue.flush();
    expect(h.sent).toEqual([]);
    expect(h.queue.state.lostReason).toBe('expired');
  });

  test('a flush with no socket drops the queue rather than keeping it for later', () => {
    const h = harness();
    h.drop();
    h.queue.send('a');
    expect(h.queue.flush()).toBe(0);
    expect(h.queue.state.pendingBytes).toBe(0);
    expect(h.queue.state.lostReason).toBe('disconnected');
  });

  test('the state is published so the pane can say input is being held', () => {
    const h = harness();
    h.drop();
    h.queue.send('ab');
    expect(h.states.at(-1)).toEqual({ pendingBytes: 2, lostReason: null });
    h.queue.clear();
    expect(h.states.at(-1)).toEqual({ pendingBytes: 0, lostReason: null });
  });

  test('acknowledging the loss clears the warning without touching the queue', () => {
    const h = harness({ maxBytes: 1 });
    h.drop();
    h.queue.send('a');
    h.queue.send('b');
    expect(h.queue.state.lostReason).toBe('tooLong');
    h.queue.acknowledgeLoss();
    // The warning is down, the queue stays empty and poisoned: telling the
    // reader is not the same as pretending the loss did not happen.
    expect(h.queue.state).toEqual({ pendingBytes: 0, lostReason: null });
    expect(h.queue.send('c')).toBe('discarded');
  });

  test('the shipped limits are the ones the pane relies on', () => {
    expect(TERMINAL_INPUT_QUEUE_MAX_BYTES).toBe(8192);
    expect(TERMINAL_INPUT_QUEUE_MAX_AGE_MS).toBe(15_000);
  });

  // ---- The adversarial review of PR #55: the limits themselves did damage.

  test('a command straddling the expiry delivers NOTHING, not its tail', () => {
    // The one that matters: `sudo ` expires, `rm -rf build\r` survives, and an
    // age filter that keeps the young entries hands the shell the tail alone.
    const h = harness({ maxAgeMs: 10_000 });
    h.drop();
    h.queue.send('sudo ');
    h.advance(9_000);
    h.queue.send('rm -rf build\r');
    h.advance(2_500);
    h.attach();
    expect(h.queue.flush()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test('a discard poisons the queue: the keys after it are refused, not stitched on', () => {
    // 8185 bytes held, 101 more discarded for the ceiling, then Enter: keeping
    // the Enter means running whatever the hole left behind.
    const h = harness({ maxBytes: 8192 });
    h.drop();
    h.queue.send('x'.repeat(8185));
    expect(h.queue.send('y'.repeat(101))).toBe('discarded');
    expect(h.queue.send('\r')).toBe('discarded');
    h.attach();
    expect(h.queue.flush()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test('the attach un-poisons the queue, so the next line is held normally', () => {
    const h = harness({ maxBytes: 16 });
    h.drop();
    h.queue.send('x'.repeat(20));
    h.attach();
    h.queue.flush();
    h.drop();
    expect(h.queue.send('ls\r')).toBe('queued');
    h.attach();
    expect(h.queue.flush()).toBe(3);
    expect(h.sent).toEqual(['ls\r']);
  });

  test('the expiry fires on its own, ON the limit and not a millisecond past it', () => {
    // The band promised delivery for 30 s because nothing re-read the clock.
    // The clock is advanced by EXACTLY the limit, which is the instant the
    // timer is scheduled for: with a `<` comparison the wake-up found nothing
    // stale at its own deadline, dropped the timer and left the queue held for
    // good, so the band promised a delivery that could never come. The old
    // test advanced 15_001 ms and walked straight past the only tick that
    // matters.
    const h = harness({ maxAgeMs: 15_000 });
    h.drop();
    h.queue.send('ls\r');
    expect(h.queue.state).toEqual({ pendingBytes: 3, lostReason: null });
    h.advance(15_000);
    expect(h.queue.state).toEqual({ pendingBytes: 0, lostReason: 'expired' });
  });

  test('a wake-up that lands early re-arms, instead of leaving the queue held for good', () => {
    // `setTimeout` is monotonic, `Date.now()` is the wall clock: they disagree
    // by a tick, and the queue only ever gets ONE timer. Firing a hair early
    // used to end the surveillance altogether - no expiry, no band change, the
    // promise of delivery left standing for as long as the pane is open.
    const h = harness({ maxAgeMs: 15_000 });
    h.drop();
    h.queue.send('ls\r');
    h.advance(14_999);
    h.fireTimersEarly();
    // Right call: nothing is stale yet, so nothing is thrown away...
    expect(h.queue.state).toEqual({ pendingBytes: 3, lostReason: null });
    // ...but the watch has to continue.
    expect(h.pendingTimers()).toBe(1);
    h.advance(1);
    expect(h.queue.state).toEqual({ pendingBytes: 0, lostReason: 'expired' });
  });

  test('each way of losing input says WHICH one it was', () => {
    // One boolean for three causes made the pane say "too old to send" for an
    // 8 KB paste refused on the spot, and for a socket that was simply gone.
    const expired = harness({ maxAgeMs: 1_000 });
    expired.drop();
    expired.queue.send('old');
    expired.advance(1_000);
    expect(expired.queue.state.lostReason).toBe('expired');

    const tooLong = harness({ maxBytes: 4 });
    tooLong.drop();
    tooLong.queue.send('abcd');
    tooLong.queue.send('e');
    expect(tooLong.queue.state.lostReason).toBe('tooLong');

    const gone = harness();
    gone.drop();
    gone.queue.send('a');
    gone.queue.flush();
    expect(gone.queue.state.lostReason).toBe('disconnected');
  });

  test('the three causes do not share one sentence', () => {
    const keys = Object.values(INPUT_LOSS_MESSAGE_KEY);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('nothing is left ticking once the queue is emptied', () => {
    const h = harness();
    h.drop();
    h.queue.send('ls\r');
    h.queue.clear();
    expect(h.pendingTimers()).toBe(0);
  });

  test('the pane bands follow the queue: a loss replaces the promise of delivery', () => {
    // This is the pane<->queue wiring. Without it nothing went red when the
    // callback simply forgot to raise a band.
    expect(nextInputBands({ pendingBytes: 0, lostReason: null }, { held: false, lost: null }))
      .toEqual({ held: false, lost: null });
    expect(nextInputBands({ pendingBytes: 3, lostReason: null }, { held: false, lost: null }))
      .toEqual({ held: true, lost: null });
    // Delivered: the promise comes down.
    expect(nextInputBands({ pendingBytes: 0, lostReason: null }, { held: true, lost: null }))
      .toEqual({ held: false, lost: null });
    // Lost: the promise comes down and the loss goes up, never both, and the
    // band carries the cause it will have to explain.
    expect(nextInputBands({ pendingBytes: 0, lostReason: 'tooLong' }, { held: true, lost: null }))
      .toEqual({ held: false, lost: 'tooLong' });
    // The loss survives the states that follow it: only a delivered keystroke
    // takes it down, and that is the pane's call, not this function's.
    expect(nextInputBands({ pendingBytes: 0, lostReason: null }, { held: false, lost: 'expired' }))
      .toEqual({ held: false, lost: 'expired' });
  });

  test('the age limit clears the measured reattach window', () => {
    // ~11,5 s of server restart plus up to 3 s of reconnect backoff: an expiry
    // under that would throw away input the attach was about to deliver.
    expect(TERMINAL_INPUT_QUEUE_MAX_AGE_MS).toBeGreaterThanOrEqual(14_500);
  });
});

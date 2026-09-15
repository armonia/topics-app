import { describe, test, expect } from 'bun:test';
import {
  TerminalInputQueue,
  TERMINAL_INPUT_QUEUE_MAX_AGE_MS,
  TERMINAL_INPUT_QUEUE_MAX_BYTES,
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
  const queue = new TerminalInputQueue({
    socket: () => socket,
    attached: () => attached,
    onStateChange: (s) => states.push({ ...s }),
    now: () => clock,
    ...opts,
  });
  return {
    queue,
    sent,
    states,
    advance(ms: number) { clock += ms; },
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

  test('past the byte ceiling the extra input is discarded, and it says so', () => {
    const h = harness({ maxBytes: 4 });
    h.drop();
    h.queue.send('abcd');
    expect(h.queue.send('e')).toBe('discarded');
    expect(h.queue.state.discarded).toBe(true);
    h.attach();
    h.queue.flush();
    expect(h.sent).toEqual(['abcd']);
  });

  test('input older than the age limit is dropped instead of delivered late', () => {
    const h = harness({ maxAgeMs: 1_000 });
    h.drop();
    h.queue.send('old');
    h.advance(1_500);
    h.queue.send('new');
    h.attach();
    h.queue.flush();
    expect(h.sent).toEqual(['new']);
    expect(h.queue.state.discarded).toBe(true);
  });

  test('a flush with no socket drops the queue rather than keeping it for later', () => {
    const h = harness();
    h.drop();
    h.queue.send('a');
    expect(h.queue.flush()).toBe(0);
    expect(h.queue.state.pendingBytes).toBe(0);
    expect(h.queue.state.discarded).toBe(true);
  });

  test('the state is published so the pane can say input is being held', () => {
    const h = harness();
    h.drop();
    h.queue.send('ab');
    expect(h.states.at(-1)).toEqual({ pendingBytes: 2, discarded: false });
    h.queue.clear();
    expect(h.states.at(-1)).toEqual({ pendingBytes: 0, discarded: false });
  });

  test('acknowledging the loss clears the warning without touching the queue', () => {
    const h = harness({ maxBytes: 1 });
    h.drop();
    h.queue.send('a');
    h.queue.send('b');
    expect(h.queue.state.discarded).toBe(true);
    h.queue.acknowledgeDiscarded();
    expect(h.queue.state).toEqual({ pendingBytes: 1, discarded: false });
  });

  test('the shipped limits are the ones the pane relies on', () => {
    expect(TERMINAL_INPUT_QUEUE_MAX_BYTES).toBe(8192);
    expect(TERMINAL_INPUT_QUEUE_MAX_AGE_MS).toBe(10_000);
  });
});

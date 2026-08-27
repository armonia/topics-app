/**
 * COUNTER BENCH: the reconnect timer and the listeners of `useWebSocket`.
 *
 * An inspection of the code says what SHOULD happen; a counter says what does.
 * So this file does not read the cleanup: it drives the real hook through N
 * full mount / connect / drop / unmount cycles with the timers and the two
 * event targets replaced by counting fakes, and asserts that every counter is
 * back to the value it had before the first mount.
 *
 * The cycle deliberately unmounts while a reconnect is PENDING (the socket is
 * dropped first, which arms the backoff timeout and the offline timeout): that
 * is the only moment at which an uncancelled timer can survive the component,
 * so a cycle that unmounts a quiet hook would prove nothing.
 *
 * Baseline is taken AFTER a first warm-up cycle, not at zero: module-level
 * state that a first mount installs once and legitimately keeps is not a leak,
 * growth per cycle is. The assertion is therefore "the third cycle costs the
 * same as the second", which is the derivative a leak shows up in.
 *
 * @covers LEAK-01
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useWebSocket } from './useWebSocket';

const g = globalThis as unknown as Record<string, unknown>;

/** Hand-driven socket: no network, no real events. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(): void { /* the frames are not what this bench measures */ }
  close(): void { this.readyState = FakeSocket.CLOSING; }
  /** The server accepted: this is where the hook arms the ping interval. */
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  /** The wire went down while the app is still mounted. */
  drop(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

let sockets: FakeSocket[] = [];
/** Highest listener count seen while a hook was alive, over the whole run. */
let peakListeners = 0;
/** Live timeout handles: set on schedule, deleted on clear or on fire. */
let pendingTimeouts = new Map<number, () => void>();
/** Live interval handles: only a clearInterval removes one. */
let pendingIntervals = new Map<number, () => void>();

/** An event target that counts the listeners currently registered on it. */
function countingTarget(extra: Record<string, unknown> = {}) {
  const live = new Set<string>();
  let seq = 0;
  const keys = new Map<unknown, string>();
  const keyOf = (type: string, fn: unknown): string => {
    let k = keys.get(fn);
    if (!k) { k = `fn${++seq}`; keys.set(fn, k); }
    return `${type}:${k}`;
  };
  return {
    ...extra,
    addEventListener(type: string, fn: unknown) { live.add(keyOf(type, fn)); },
    removeEventListener(type: string, fn: unknown) { live.delete(keyOf(type, fn)); },
    liveListenerCount: () => live.size,
  };
}

type CountingTarget = ReturnType<typeof countingTarget>;
let fakeWindow: CountingTarget;
let fakeDocument: CountingTarget;

const saved: Record<string, unknown> = {};
const realDateNow = Date.now;

beforeEach(() => {
  sockets = [];
  peakListeners = 0;
  pendingTimeouts = new Map();
  pendingIntervals = new Map();

  for (const k of ['WebSocket', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'window', 'document']) {
    saved[k] = g[k];
  }

  fakeWindow = countingTarget({ location: { protocol: 'http:', host: '127.0.0.1:3333' } });
  fakeDocument = countingTarget({ hidden: false });
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.WebSocket = FakeSocket;

  let seq = 0;
  g.setTimeout = (fn: () => void) => { pendingTimeouts.set(++seq, fn); return seq; };
  g.clearTimeout = (id: number) => { pendingTimeouts.delete(id); };
  g.setInterval = (fn: () => void) => { pendingIntervals.set(++seq, fn); return seq; };
  g.clearInterval = (id: number) => { pendingIntervals.delete(id); };
  Date.now = () => 1_700_000_000_000;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k]; else g[k] = v;
  }
  Date.now = realDateNow;
});

function Probe(): null {
  useWebSocket();
  return null;
}

/**
 * One full life of the hook, ending on an unmount with a reconnect pending.
 * Returns how many timeouts were armed while it was still mounted: a cycle
 * that armed nothing would make the assertion below unfailable.
 */
function cycle(): number {
  const harness = mount(React.createElement(Probe));
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('useWebSocket did not open a socket');
  socket.open();
  // The wire dies: this arms the offline timeout AND the backoff reconnect.
  socket.drop();
  const armed = pendingTimeouts.size;
  peakListeners = Math.max(peakListeners, fakeWindow.liveListenerCount() + fakeDocument.liveListenerCount());
  harness.unmount();
  return armed;
}

interface Counters { timeouts: number; intervals: number; windowListeners: number; documentListeners: number }

function read(): Counters {
  return {
    timeouts: pendingTimeouts.size,
    intervals: pendingIntervals.size,
    windowListeners: fakeWindow.liveListenerCount(),
    documentListeners: fakeDocument.liveListenerCount(),
  };
}

/** The one line the aggregator of this card parses out of the test output. */
function report(counter: string, before: number, after: number, cycles: number): void {
  const verdict = after <= before ? 'ok' : 'LEAK';
  console.log(`LEAK-COUNTER reconnect-timer | useWebSocket ${counter} | before=${before} after=${after} cycles=${cycles} | ${verdict}`);
}

describe('useWebSocket leak counters', () => {
  test('N mount/drop/unmount cycles leave no timer and no listener behind', () => {
    const CYCLES = 25;

    // Warm-up cycle: whatever a first mount installs once for the page life is
    // not growth. Everything measured below is what the NEXT cycles add.
    cycle();
    const before = read();

    let armedWhileMounted = 0;
    for (let i = 0; i < CYCLES; i++) armedWhileMounted += cycle();
    const after = read();

    // The bench has to be able to go red: each cycle must really arm timers
    // while the hook is alive, otherwise "zero left behind" is free.
    expect(armedWhileMounted).toBeGreaterThanOrEqual(CYCLES);
    expect(peakListeners).toBeGreaterThan(0);

    report('pending timeouts', before.timeouts, after.timeouts, CYCLES);
    report('pending intervals', before.intervals, after.intervals, CYCLES);
    report('window listeners', before.windowListeners, after.windowListeners, CYCLES);
    report('document listeners', before.documentListeners, after.documentListeners, CYCLES);

    expect(after).toEqual(before);
    // And the absolute value, so a baseline that was already leaking cannot
    // hide inside a stable derivative.
    expect(after).toEqual({ timeouts: 0, intervals: 0, windowListeners: 0, documentListeners: 0 });
  });
});

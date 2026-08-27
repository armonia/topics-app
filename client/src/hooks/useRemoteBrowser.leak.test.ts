/**
 * COUNTER BENCH: the reconnect timer and the wake listeners of
 * `useRemoteBrowser` (the hook behind the browser pane).
 *
 * Same rule as the sibling bench on `useWebSocket`: no reading of the cleanup,
 * a count. The pane is opened and closed N times, and each time the socket is
 * dropped BEFORE the unmount so a backoff reconnect is pending exactly when the
 * component goes away. What is asserted is that the number of live timeouts and
 * of listeners on the shared `window` is the same after N cycles as before.
 *
 * @covers LEAK-01
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';

// `bun test` does not resolve the `@/` alias of the client tsconfig, and this
// hook imports `@/lib/shell/net` for the WS base URL. Registering the module
// under that exact specifier is what lets the REAL hook be imported and driven
// here, instead of falling back to asserting on its source text.
mock.module('@/lib/shell/net', () => ({
  serverWsBase: () => 'ws://127.0.0.1:3333',
  serverHttpBase: () => 'http://127.0.0.1:3333',
  apiUrl: (p: string) => `http://127.0.0.1:3333${p}`,
}));

const { useRemoteBrowser } = await import('./useRemoteBrowser');

const g = globalThis as unknown as Record<string, unknown>;

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
  binaryType = 'arraybuffer';
  constructor(readonly url: string) { sockets.push(this); }
  send(): void { /* frames are not what this bench measures */ }
  close(): void { this.readyState = FakeSocket.CLOSING; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  drop(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

let sockets: FakeSocket[] = [];
/** Highest listener count seen while a hook was alive, over the whole run. */
let peakListeners = 0;
let pendingTimeouts = new Map<number, () => void>();
let pendingIntervals = new Map<number, () => void>();

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

beforeEach(() => {
  sockets = [];
  peakListeners = 0;
  pendingTimeouts = new Map();
  pendingIntervals = new Map();

  for (const k of ['WebSocket', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'window', 'document', 'fetch', 'RTCPeerConnection', 'devicePixelRatio']) {
    saved[k] = g[k];
  }

  fakeWindow = countingTarget({
    location: { protocol: 'http:', host: '127.0.0.1:3333' },
    devicePixelRatio: 1,
  });
  fakeDocument = countingTarget({ hidden: false, visibilityState: 'visible' });
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.WebSocket = FakeSocket;
  // The pane asks the server for the context info on connect. It must not hit
  // the network, and it must not reject in a way the hook does not expect.
  g.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });

  let seq = 0;
  g.setTimeout = (fn: () => void) => { pendingTimeouts.set(++seq, fn); return seq; };
  g.clearTimeout = (id: number) => { pendingTimeouts.delete(id); };
  g.setInterval = (fn: () => void) => { pendingIntervals.set(++seq, fn); return seq; };
  g.clearInterval = (id: number) => { pendingIntervals.delete(id); };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k]; else g[k] = v;
  }
});

function Probe({ contextId }: { contextId: string }): null {
  useRemoteBrowser(contextId, true);
  return null;
}

/** One pane life: mount, connect, lose the wire, unmount with a retry pending. */
function cycle(i: number): number {
  const harness = mount(React.createElement(Probe, { contextId: `ctx-${i}` }));
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('useRemoteBrowser did not open a socket');
  socket.open();
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

function report(counter: string, before: number, after: number, cycles: number): void {
  const verdict = after <= before ? 'ok' : 'LEAK';
  console.log(`LEAK-COUNTER reconnect-timer | useRemoteBrowser ${counter} | before=${before} after=${after} cycles=${cycles} | ${verdict}`);
}

describe('useRemoteBrowser leak counters', () => {
  test('N open/drop/close cycles of the pane leave no timer and no listener behind', () => {
    const CYCLES = 25;

    cycle(0);
    const before = read();

    let armedWhileMounted = 0;
    for (let i = 1; i <= CYCLES; i++) armedWhileMounted += cycle(i);
    const after = read();

    report('pending timeouts', before.timeouts, after.timeouts, CYCLES);
    report('pending intervals', before.intervals, after.intervals, CYCLES);
    report('window listeners', before.windowListeners, after.windowListeners, CYCLES);
    report('document listeners', before.documentListeners, after.documentListeners, CYCLES);

    // The bench must be able to go red: every cycle really arms a backoff.
    expect(armedWhileMounted).toBeGreaterThanOrEqual(CYCLES);
    expect(peakListeners).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });
});

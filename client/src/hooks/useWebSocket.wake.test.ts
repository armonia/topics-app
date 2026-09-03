/**
 * WAKING UP: one handshake per wake, and a half-open socket gets probed.
 *
 * Two defects, both on the phone/Tailscale path the wake handlers exist for.
 *
 *   1. Two overlapping sets of `visibilitychange`/`online`/`focus` listeners:
 *      the first opened a socket (`CONNECTING`), the second saw "not OPEN" and
 *      called `reconnect()`, which closed it and opened another. Measured on
 *      the live server: two handshakes and a "closed before the connection is
 *      established" warning per wake.
 *   2. A socket that survived sleep as `OPEN` was trusted as such. The peer may
 *      be long gone; the 30s pulse noticed after 30-105s, during which the
 *      status bar said connected and the chat looked alive.
 *
 * Driven through the real hook with a hand-driven socket and captured timers,
 * as in `useWebSocket.test.ts`. Window and document listeners are captured
 * here (the sibling file stubs them out) so the wake burst can be dispatched.
 * @covers RUNTIME-12
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useWebSocket } from './useWebSocket';

const g = globalThis as unknown as Record<string, unknown>;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  closes = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(d: string): void { this.sent.push(d); }
  close(): void { this.closes += 1; this.readyState = FakeSocket.CLOSING; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  /** The wire died and the browser noticed: `onclose` fires, readyState CLOSED. */
  die(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  types(): string[] { return this.sent.map((s) => (JSON.parse(s) as { type: string }).type); }
}

let sockets: FakeSocket[] = [];
let timeouts = new Map<number, { fn: () => void; ms: number }>();
let intervals = new Map<number, () => void>();
let clock = 0;
const listeners = new Map<string, Set<() => void>>();

const saved: Record<string, unknown> = {};
const savedWin: Record<string, unknown> = {};
const savedDoc: Record<string, unknown> = {};
const realDateNow = Date.now;

function on(name: string, fn: () => void): void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
}
function off(name: string, fn: () => void): void { listeners.get(name)?.delete(fn); }
function fire(name: string): void { for (const fn of [...(listeners.get(name) ?? [])]) fn(); }

beforeEach(() => {
  sockets = [];
  timeouts = new Map();
  intervals = new Map();
  listeners.clear();
  clock = 1_700_000_000_000;
  for (const k of ['WebSocket', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'window', 'document']) saved[k] = g[k];

  const w = (g.window as Record<string, unknown> | undefined) ?? {};
  for (const k of ['location', 'addEventListener', 'removeEventListener']) savedWin[k] = w[k];
  w.location ??= { protocol: 'http:', host: '127.0.0.1:3333' };
  w.addEventListener = on;
  w.removeEventListener = off;
  g.window = w;
  const d = (g.document as Record<string, unknown> | undefined) ?? {};
  for (const k of ['hidden', 'addEventListener', 'removeEventListener']) savedDoc[k] = d[k];
  d.hidden = false;
  d.addEventListener = on;
  d.removeEventListener = off;
  g.document = d;

  g.WebSocket = FakeSocket;
  let seq = 0;
  g.setInterval = (fn: () => void) => { intervals.set(++seq, fn); return seq; };
  g.clearInterval = (id: number) => { intervals.delete(id); };
  let seqT = 0;
  g.setTimeout = (fn: () => void, ms?: number) => { timeouts.set(++seqT, { fn, ms: ms ?? 0 }); return seqT; };
  g.clearTimeout = (id: number) => { timeouts.delete(id); };
  Date.now = () => clock;
});

afterEach(() => {
  const w = g.window as Record<string, unknown>;
  const d = g.document as Record<string, unknown>;
  for (const [k, v] of Object.entries(savedWin)) { if (v === undefined) delete w[k]; else w[k] = v; }
  for (const [k, v] of Object.entries(savedDoc)) { if (v === undefined) delete d[k]; else d[k] = v; }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  Date.now = realDateNow;
});

/** The wake burst as browsers deliver it: the three events back to back. */
function wake(): void { fire('online'); fire('focus'); fire('visibilitychange'); }

/** Fires the timeouts armed with exactly this delay, once each. */
function fireTimeouts(ms: number): number {
  const due = [...timeouts.entries()].filter(([, t]) => t.ms === ms);
  for (const [id] of due) timeouts.delete(id);
  for (const [, t] of due) t.fn();
  return due.length;
}

function drive(): { unmount: () => void } {
  function Probe(): null {
    useWebSocket();
    return null;
  }
  const h = mount(React.createElement(Probe));
  return { unmount: () => h.unmount() };
}

describe('coming back to the app', () => {
  test('a dead socket is replaced by ONE socket, not two', () => {
    const d = drive();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    sockets[0].die();

    wake();

    // Before the fix: the first handler opened #2, the second handler found it
    // CONNECTING, closed it and opened #3.
    expect(sockets).toHaveLength(2);
    expect(sockets[1].closes).toBe(0);
    d.unmount();
  });

  test('a socket that is OPEN on paper gets probed, and is closed when no pong comes back', () => {
    const d = drive();
    const s = sockets[0];
    s.open();
    expect(s.types()).toEqual(['hello']);
    // The device slept for a while: the opening handshake is old news.
    clock += 60_000;

    wake();

    // One probe for the whole burst, and no new socket: the old one is asked first.
    expect(s.types()).toEqual(['hello', 'ping']);
    expect(sockets).toHaveLength(1);

    // Silence past the probe deadline: the socket is declared half-open.
    clock += 8_000 + 1;
    expect(fireTimeouts(8_000)).toBe(1);
    expect(s.closes).toBe(1);
    // ...and the reconnect path is armed without waiting for `onclose`
    // (which never comes on a half-open socket): the backoff timer exists.
    expect([...timeouts.values()].some((t) => t.ms === 1000)).toBe(true);
    d.unmount();
  });

  test('a socket that answers the probe is left alone', () => {
    const d = drive();
    const s = sockets[0];
    s.open();
    clock += 60_000;

    wake();
    expect(s.types()).toEqual(['hello', 'ping']);
    clock += 100;
    s.deliver({ type: 'pong' });

    clock += 8_000;
    expect(fireTimeouts(8_000)).toBe(1);
    expect(s.closes).toBe(0);
    expect(sockets).toHaveLength(1);
    d.unmount();
  });

  test('unmount leaves no probe timer behind', () => {
    const d = drive();
    sockets[0].open();
    wake();
    expect([...timeouts.values()].some((t) => t.ms === 8_000)).toBe(true);
    d.unmount();
    expect([...timeouts.values()].some((t) => t.ms === 8_000)).toBe(false);
  });
});

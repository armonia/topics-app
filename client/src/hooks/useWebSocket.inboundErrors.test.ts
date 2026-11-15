/**
 * @covers CLIENT-SILENT-ERR-01
 * Three silent swallows in the inbound frame path, closed by card
 * `4c8d4432-5742-4f9f-aad8-995221c6b7eb`:
 *
 *   - a malformed frame (JSON.parse throws) used to vanish with no log;
 *   - a registered handler that throws used to vanish with no log, and could
 *     stop every handler registered after it from running;
 *   - the two failures are now told apart (`console.warn` for parse/dispatch,
 *     `console.error` for a handler that throws).
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
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(): void { /* not exercised here */ }
  close(): void { this.readyState = FakeSocket.CLOSING; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
}

let sockets: FakeSocket[] = [];
const saved: Record<string, unknown> = {};
const savedWin: Record<string, unknown> = {};
const savedDoc: Record<string, unknown> = {};

beforeEach(() => {
  sockets = [];
  for (const k of ['WebSocket', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'window', 'document']) saved[k] = g[k];
  const w = (g.window as Record<string, unknown> | undefined) ?? {};
  for (const k of ['location', 'addEventListener', 'removeEventListener']) savedWin[k] = w[k];
  w.location ??= { protocol: 'http:', host: '127.0.0.1:3333' };
  w.addEventListener = () => {};
  w.removeEventListener = () => {};
  g.window = w;
  const d = (g.document as Record<string, unknown> | undefined) ?? {};
  for (const k of ['hidden', 'addEventListener', 'removeEventListener', 'hasFocus']) savedDoc[k] = d[k];
  d.hidden = false;
  d.addEventListener = () => {};
  d.removeEventListener = () => {};
  d.hasFocus = () => true;
  g.document = d;
  g.WebSocket = FakeSocket;
  g.setInterval = () => 0;
  g.clearInterval = () => {};
  g.setTimeout = () => 0;
  g.clearTimeout = () => {};
});

afterEach(() => {
  const w = g.window as Record<string, unknown>;
  const d = g.document as Record<string, unknown>;
  for (const [k, v] of Object.entries(savedWin)) { if (v === undefined) delete w[k]; else w[k] = v; }
  for (const [k, v] of Object.entries(savedDoc)) { if (v === undefined) delete d[k]; else d[k] = v; }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
});

describe('useWebSocket inbound frame failures are logged, not swallowed', () => {
  test('a malformed frame is warned about, not thrown past onmessage', () => {
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    function Probe(): null { useWebSocket(); return null; }
    const h = mount(React.createElement(Probe));
    try {
      sockets[0].open();
      expect(() => sockets[0].onmessage?.({ data: 'not json' })).not.toThrow();
      expect(warnCalls.some((args) => String(args[1] ?? args[0]).length > 0 && String(args[0]).includes('failed to parse frame'))).toBe(true);
      expect(warnCalls.some((args) => String(args[0]).includes('failed to dispatch frame'))).toBe(false);
    } finally {
      console.warn = realWarn;
      h.unmount();
    }
  });

  test('a failure while dispatching a well-formed frame is warned about as a dispatch failure, not a parse failure', () => {
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    function Probe(): null { useWebSocket(); return null; }
    const h = mount(React.createElement(Probe));
    try {
      sockets[0].open();
      (g.window as Record<string, unknown>).dispatchEvent = () => { throw new Error('dispatch boom'); };
      const frame = JSON.stringify({ type: 'auth:pair-requested' });
      expect(() => sockets[0].onmessage?.({ data: frame })).not.toThrow();
      expect(warnCalls.some((args) => String(args[0]).includes('failed to dispatch frame'))).toBe(true);
      expect(warnCalls.some((args) => String(args[0]).includes('failed to parse frame'))).toBe(false);
    } finally {
      console.warn = realWarn;
      h.unmount();
    }
  });

  test('a handler that throws is logged with console.error and does not block the next handler', () => {
    const errorCalls: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    let secondHandlerRan = false;
    function Probe(): null {
      const { onMessage } = useWebSocket();
      React.useEffect(() => {
        const offFirst = onMessage(() => { throw new Error('boom'); });
        const offSecond = onMessage(() => { secondHandlerRan = true; });
        return () => { offFirst(); offSecond(); };
      }, [onMessage]);
      return null;
    }
    const h = mount(React.createElement(Probe));
    try {
      sockets[0].open();
      expect(() => sockets[0].onmessage?.({ data: JSON.stringify({ type: 'custom:probe-frame' }) })).not.toThrow();
      expect(errorCalls.some((args) => String(args[0]).includes('[WS:inbound]'))).toBe(true);
      expect(secondHandlerRan).toBe(true);
    } finally {
      console.error = realError;
      h.unmount();
    }
  });
});

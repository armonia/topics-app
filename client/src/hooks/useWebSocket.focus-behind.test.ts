/**
 * A window BEHIND another app is in front of nobody (notifications/spec.md,
 * the chat focused in a window behind another app SHALL light up and count),
 * live native browser view or not.
 *
 * Review 2 of notifications-redesign, surfaces B2: the `focus` frame said
 * `awake: isWindowAwake()`, which fails open while the page owns live
 * WKWebView children, so a Tauri window with a browser pane told the server
 * it was awake behind another app. The server took that for "in front of the
 * person" and the chat's end was born seen: no banner, no push, no Dock.
 *
 * Driven through the real hook with a hand-driven socket, as in
 * `useWebSocket.wake.test.ts`; the person switches app: `blur` fires and
 * `document.hasFocus()` turns false while the page stays visible.
 * @covers ATTN-06
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useWebSocket } from './useWebSocket';
import { holdSubjectInFront, isSubjectInFront } from '../state/chatInView';
import { markBrowserViewDead, markBrowserViewLive } from '../lib/shell/nativeBrowserRoster';

const g = globalThis as unknown as Record<string, unknown>;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(d: string): void { this.sent.push(d); }
  close(): void { this.readyState = FakeSocket.CLOSING; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
}

let sockets: FakeSocket[] = [];
const listeners = new Map<string, Set<() => void>>();
const saved: Record<string, unknown> = {};
const savedWin: Record<string, unknown> = {};
const savedDoc: Record<string, unknown> = {};
let hasFocus = true;

function on(name: string, fn: () => void): void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
}
function off(name: string, fn: () => void): void { listeners.get(name)?.delete(fn); }
function fire(name: string): void { for (const fn of [...(listeners.get(name) ?? [])]) fn(); }

beforeEach(() => {
  sockets = [];
  listeners.clear();
  hasFocus = true;
  for (const k of ['WebSocket', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'window', 'document']) saved[k] = g[k];
  const w = (g.window as Record<string, unknown> | undefined) ?? {};
  for (const k of ['location', 'addEventListener', 'removeEventListener']) savedWin[k] = w[k];
  w.location ??= { protocol: 'http:', host: '127.0.0.1:3333' };
  w.addEventListener = on;
  w.removeEventListener = off;
  g.window = w;
  const d = (g.document as Record<string, unknown> | undefined) ?? {};
  for (const k of ['hidden', 'addEventListener', 'removeEventListener', 'hasFocus']) savedDoc[k] = d[k];
  d.hidden = false;
  d.addEventListener = on;
  d.removeEventListener = off;
  d.hasFocus = () => hasFocus;
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
  markBrowserViewDead('browser-pane-behind');
});

function lastFocus(s: FakeSocket): { subject: string | null; awake: boolean } | null {
  const frames = s.sent.map((x) => JSON.parse(x) as { type: string; subject: string | null; awake: boolean }).filter((m) => m.type === 'focus');
  return frames.length ? frames[frames.length - 1] : null;
}

describe('a window behind another app is in front of nobody', () => {
  for (const withBrowserView of [false, true]) {
    test(`the focus frame says awake:false once the window goes behind (native browser view live: ${withBrowserView})`, () => {
      if (withBrowserView) markBrowserViewLive('browser-pane-behind');
      const release = holdSubjectInFront('topic:c1');
      function Probe(): null { useWebSocket(); return null; }
      const h = mount(React.createElement(Probe));
      try {
        sockets[0].open();
        expect(lastFocus(sockets[0])).toMatchObject({ subject: 'topic:c1', awake: true });
        expect(isSubjectInFront('topic:c1')).toBe(true);
        hasFocus = false;
        fire('blur');
        expect(lastFocus(sockets[0])).toMatchObject({ subject: 'topic:c1', awake: false });
        expect(isSubjectInFront('topic:c1')).toBe(false);
      } finally {
        release();
        h.unmount();
      }
    });
  }
});

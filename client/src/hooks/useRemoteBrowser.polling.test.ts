/**
 * TWO BUGS, in `fallback-http` mode (the HTTP-polling floor the pane falls
 * back to once the WS has been down past the fallback grace window): a
 * cancelled-but-pending `fetchInfo()` re-arming the poll loop after unmount,
 * and the REST screenshot `<img>` writing a path-relative `src` that
 * resolves to `tauri://localhost` under the desktop shell instead of the
 * data server's origin.
 *
 * `setTimeout`/`clearTimeout` are faked (a id→callback map, fired by hand)
 * so the fallback grace timer and the poll loop's own re-arm both run on the
 * test's own clock, with every transition happening OUTSIDE of React's
 * render call stack — exactly as a real browser's macrotask queue would.
 *
 * @covers POLL-CANCEL-01, SNAPSHOT-URL-01
 */
import { describe, expect, test, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';

// Same rationale as `useRemoteBrowser.leak.test.ts`: the hook imports
// `@/lib/shell/net`, which `bun test` cannot resolve without a mock, and the
// mock must carry every real export forward or later files see `undefined`.
const {
  serverHttpBase: realServerHttpBase,
  isAppLoopbackOrigin: realIsAppLoopbackOrigin,
  serverWsBase: realServerWsBase,
  __resetNetShimForTests: realResetNetShim,
  installNetShim: realInstallNetShim,
} = await import('../lib/shell/net');
const realNet = {
  serverHttpBase: realServerHttpBase,
  isAppLoopbackOrigin: realIsAppLoopbackOrigin,
  serverWsBase: realServerWsBase,
  __resetNetShimForTests: realResetNetShim,
  installNetShim: realInstallNetShim,
};
const FAKE_HTTP_BASE = 'http://127.0.0.1:3333';
mock.module('@/lib/shell/net', () => ({
  ...realNet,
  serverWsBase: () => 'ws://127.0.0.1:3333',
  serverHttpBase: () => FAKE_HTTP_BASE,
}));

afterAll(() => { mock.module('@/lib/shell/net', () => realNet); });

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
  send(): void { /* not what this test drives */ }
  close(): void { this.readyState = FakeSocket.CLOSING; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  drop(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';
  get src(): string { return this._src; }
  set src(v: string) { this._src = v; imageSrcs.push(v); }
}

let sockets: FakeSocket[] = [];
let imageSrcs: string[] = [];
let infoFetchCount = 0;
let pendingInfoResolvers: Array<(v: unknown) => void> = [];
let pendingTimeouts = new Map<number, { fn: () => void; delay: number }>();

const okInfoResponse = { ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') };
const notFoundResponse = { ok: false, status: 404, json: () => Promise.resolve(null), text: () => Promise.resolve('') };

/** Only the context-info GET the polling loop drives (`/api/browsers/<id>`,
 *  no trailing path) is held pending or counted; every other endpoint this
 *  hook also fires on mount (`/engines`, `/framable`, …) resolves at once so
 *  it never muddies what this test is measuring. */
function fetchRouter(infoUrlSuffix: string, controlInfo: boolean) {
  return (url: string) => {
    if (!url.endsWith(infoUrlSuffix)) return Promise.resolve(notFoundResponse);
    infoFetchCount++;
    if (controlInfo) return new Promise((resolve) => { pendingInfoResolvers.push(resolve); });
    return Promise.resolve(okInfoResponse);
  };
}

const saved: Record<string, unknown> = {};

beforeEach(() => {
  sockets = [];
  imageSrcs = [];
  infoFetchCount = 0;
  pendingInfoResolvers = [];
  pendingTimeouts = new Map();

  for (const k of ['WebSocket', 'window', 'document', 'fetch', 'Image', 'setTimeout', 'clearTimeout', 'devicePixelRatio']) {
    saved[k] = g[k];
  }
  g.window = {
    location: { protocol: 'http:', host: '127.0.0.1:3333' },
    devicePixelRatio: 1,
    addEventListener() { /* this file doesn't assert on wake listeners */ },
    removeEventListener() { /* no-op */ },
  };
  g.document = { hidden: false, visibilityState: 'visible' };
  g.WebSocket = FakeSocket;
  g.Image = FakeImage;

  let seq = 0;
  g.setTimeout = (fn: () => void, delay = 0) => { pendingTimeouts.set(++seq, { fn, delay }); return seq; };
  g.clearTimeout = (id: number) => { pendingTimeouts.delete(id); };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k]; else g[k] = v;
  }
});

const flush = async (times = 10): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

/** Fires every timer armed so far in DELAY order (a real clock reaches the
 *  1s reconnect attempt before the 2s fallback grace window, not in the
 *  order the two `setTimeout` calls happened to run): the reconnect timer
 *  flips the pane back to `connecting` first, and the fallback timer's
 *  "fallback-http unless connected" check still lands on fallback-http
 *  right after, same as a real clock would settle it. */
async function fireArmedTimers(): Promise<void> {
  const entries = [...pendingTimeouts.values()].sort((a, b) => a.delay - b.delay);
  pendingTimeouts.clear();
  for (const { fn } of entries) fn();
  await flush();
}

function Probe({ contextId }: { contextId: string }): null {
  useRemoteBrowser(contextId, true);
  return null;
}

/** Mount, drop the socket before it ever opens (the WS `onopen` handler
 *  itself fires a one-off `fetchInfo()`, which would otherwise muddy the
 *  count this file is measuring), and fire the armed timers until the pane
 *  settles in `fallback-http` and fires its first poll. */
async function mountInFallbackHttp(contextId: string): Promise<ReturnType<typeof mount>> {
  const harness = mount(React.createElement(Probe, { contextId }));
  await flush();
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('useRemoteBrowser did not open a socket');
  socket.drop();
  await fireArmedTimers(); // fallback grace timer -> fallback-http -> first poll() fired
  return harness;
}

describe('useRemoteBrowser HTTP polling (fallback-http)', () => {
  test('a fetchInfo() in flight at unmount does not re-arm the poll loop', async () => {
    const contextId = 'ctx-poll';
    g.fetch = fetchRouter(`/api/browsers/${encodeURIComponent(contextId)}`, true);

    const harness = await mountInFallbackHttp(contextId);
    expect(infoFetchCount).toBe(1);
    expect(pendingInfoResolvers.length).toBe(1);

    harness.unmount();

    // Resolve the in-flight fetchInfo AFTER unmount: a cancelled poll loop
    // must stop right there, with no screenshot fetch and no next cycle
    // (no new setTimeout armed either).
    pendingInfoResolvers[0]!(okInfoResponse);
    await flush();

    expect(imageSrcs.length).toBe(0);
    expect(infoFetchCount).toBe(1);
    expect(pendingTimeouts.size).toBe(0);
  });

  test('the REST screenshot fallback points at the data server origin, not a relative path', async () => {
    const contextId = 'ctx-shot';
    g.fetch = fetchRouter(`/api/browsers/${encodeURIComponent(contextId)}`, false);

    const harness = await mountInFallbackHttp(contextId);
    harness.unmount();

    expect(imageSrcs.length).toBeGreaterThan(0);
    for (const src of imageSrcs) {
      expect(src.startsWith(`${FAKE_HTTP_BASE}/api/browsers/`)).toBe(true);
    }
  });
});

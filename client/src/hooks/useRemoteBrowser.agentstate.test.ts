/**
 * A DEAD SOCKET IS NOT REPORTING AN AGENT ANY MORE.
 *
 * THE DEFECT (review of the card that removed the darkening overlay). Since the
 * overlay went away, "an agent is driving" is said by ONE 11px glyph in the tab
 * and by a transparent layer over the page that swallows the first click. Both
 * read `agentActive`, and `agentActive` goes back to false only when the server
 * broadcasts `agent_active=false` from the lock's finally block - over the very
 * socket that just died. A server restart in the middle of an agent turn (the
 * file watcher does it several times an hour) therefore left the flag true
 * forever: the tab drew the robot INSTEAD of the broken-link glyph, which it
 * outranks, and the invisible layer went on eating clicks on behalf of a turn
 * nobody was driving.
 *
 * The native pane already read it this way (`nativeExecutorSocket` reports
 * false from `onDead`); this pins the same reading on the streaming pane.
 *
 * @covers BROWSER-CHAT-04
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';

// Same reason as the sibling benches on this hook: `bun test` does not resolve
// the `@/` alias, and the real module is taken first so that a whole-module
// mock does not blank out the exports other files need.
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
mock.module('@/lib/shell/net', () => ({
  ...realNet,
  serverWsBase: () => 'ws://127.0.0.1:3333',
  serverHttpBase: () => 'http://127.0.0.1:3333',
}));
afterAll(() => { mock.module('@/lib/shell/net', () => realNet); });

const { useRemoteBrowser } = await import('./useRemoteBrowser');

const g = globalThis as unknown as Record<string, unknown>;

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = 'arraybuffer';
  readonly frames: string[] = [];
  constructor(readonly url: string) { sockets.push(this); }
  send(payload: string): void { this.frames.push(payload); }
  close(): void { this.readyState = FakeSocket.CLOSED; }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  /** The server went away without a goodbye frame: exactly a restart. */
  die(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

let sockets: FakeSocket[] = [];
let mounted: { unmount(): void }[] = [];
let pane: ReturnType<typeof useRemoteBrowser> | null = null;

function inert() {
  return {
    addEventListener() { /* nothing listens in this test */ },
    removeEventListener() { /* nothing listens in this test */ },
  };
}

const saved: Record<string, unknown> = {};

beforeEach(() => {
  sockets = [];
  pane = null;
  mounted = [];
  for (const k of ['WebSocket', 'window', 'document', 'fetch', 'ResizeObserver', 'RTCPeerConnection', 'devicePixelRatio', 'sessionStorage']) {
    saved[k] = g[k];
  }
  const cells = new Map<string, string>();
  g.sessionStorage = {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value); },
  };
  g.window = { ...inert(), location: { protocol: 'http:', host: '127.0.0.1:3333' }, devicePixelRatio: 1 };
  g.document = { ...inert(), hidden: false, visibilityState: 'visible' };
  g.WebSocket = FakeSocket;
  g.devicePixelRatio = 1;
  g.ResizeObserver = class {
    observe(): void { /* no measure is needed here */ }
    disconnect(): void { /* nothing to tear down */ }
  };
  g.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
});

afterEach(() => {
  // A pane left mounted keeps the hook's timers alive past this file, and they
  // then fail inside whatever runs next, with no test name attached.
  for (const h of mounted) h.unmount();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k]; else g[k] = v;
  }
});

function openPane(): FakeSocket {
  function Probe(): null {
    const api = useRemoteBrowser('ctx-agent', true);
    React.useEffect(() => { pane = api; }, [api]);
    return null;
  }
  mounted.push(mount(React.createElement(Probe)));
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('useRemoteBrowser did not open a socket');
  socket.open();
  return socket;
}

test('the server restarting mid-turn ends the agent state, it does not freeze it', () => {
  const socket = openPane();
  socket.deliver({ type: 'agent_active', active: true, action: 'Navigating to example.com' });
  expect(pane?.agentActive, 'the pane ignored the agent broadcast').toBe(true);

  // The server goes down. No goodbye frame: there is no code path that sends
  // one, which is the whole point.
  socket.die();

  expect(pane?.agentActive, 'the tab would keep drawing the robot over a dead link').toBe(false);
  expect(pane?.agentAction).toBe(null);
});

/**
 * THE PANE ANSWERS WHEN THE SERVER ASKS FOR ITS SIZE.
 *
 * Half of the viewport arbitration lives here, on the client, and it is the
 * half no server test can see. The pane deduplicates the size it streams (the
 * same 60 bytes on every observer callback, so the guard is right), which means
 * the pane that INHERITS the viewport when the driver leaves would never say
 * its size again on its own: it said it once, at connect, when it was refused.
 * The server therefore asks (`viewport_request`), and the answer has to skip
 * the dedup guard. Delete that case from the message switch and the shared page
 * simply keeps the size of whoever just left, silently.
 *
 * The REAL hook is driven here, with a fake socket and a fake container: what
 * is asserted is the FRAME that leaves, because that frame is the contract the
 * server is waiting for.
 *
 * @covers TOPIC-BROWSER-05
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';

// Same reason as the sibling bench on this hook: `bun test` does not resolve
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

/** The pane's container, 900x600, which is the size the server should hear. */
const PANE_WIDTH = 900;
const PANE_HEIGHT = 600;

const PANE_CONTAINER = {
  getBoundingClientRect: () => ({ width: PANE_WIDTH, height: PANE_HEIGHT }),
} as unknown as HTMLElement;

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
}

let sockets: FakeSocket[] = [];

/**
 * The mounted pane's handle, captured from the effect that attaches the
 * container: reaching it out of the render to poke it would be a mutation
 * during render, and the compiler refuses that.
 */
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
  for (const k of ['WebSocket', 'window', 'document', 'fetch', 'ResizeObserver', 'RTCPeerConnection', 'devicePixelRatio', 'sessionStorage']) {
    saved[k] = g[k];
  }
  // One webview, one storage: this is what makes the pane keep its name across
  // its sockets, and the name is what the arbiter recognises it by.
  const cells = new Map<string, string>();
  g.sessionStorage = {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value); },
  };
  g.window = { ...inert(), location: { protocol: 'http:', host: '127.0.0.1:3333' }, devicePixelRatio: 1 };
  g.document = { ...inert(), hidden: false, visibilityState: 'visible' };
  g.WebSocket = FakeSocket;
  g.devicePixelRatio = 1;
  // Observed once, on attach: the hook measures the container itself when it
  // wires the observer, and that first measure is the size the server refuses
  // while somebody else is driving.
  g.ResizeObserver = class {
    observe(): void { /* the test drives the measures it needs */ }
    disconnect(): void { /* nothing to tear down */ }
  };
  g.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k]; else g[k] = v;
  }
});

/** The frames the pane sent, decoded, in order. */
function resizeFrames(socket: FakeSocket): { width: number; height: number; driving?: boolean }[] {
  return socket.frames
    .map((raw) => JSON.parse(raw) as { type: string; width: number; height: number; driving?: boolean })
    .filter((msg) => msg.type === 'resize');
}

/** The `?client=` the pane put in its socket URL. */
function paneName(socket: FakeSocket): string {
  return new URL(socket.url.replace('ws://', 'http://')).searchParams.get('client') ?? '';
}

/**
 * Mount the pane, open its socket, attach a container of a known size.
 *
 * Returns the socket, already carrying the first `resize` the pane streams on
 * attach: the state this test is about starts AFTER that one.
 */
function openPane(): FakeSocket {
  // The container is attached from an EFFECT, the way a rendered pane attaches
  // it: reaching the hook's handle out of the render to poke it from here is a
  // mutation during render, and the compiler refuses it.
  function Probe(): null {
    const api = useRemoteBrowser('ctx-shared', true);
    React.useEffect(() => {
      pane = api;
      api.containerRef(PANE_CONTAINER);
      return () => { api.containerRef(null); };
    }, [api]);
    return null;
  }
  mount(React.createElement(Probe));
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('useRemoteBrowser did not open a socket');
  // The size goes out on open: while the socket was still connecting there was
  // nowhere to put it.
  socket.open();
  return socket;
}

test("the pane streams its size once: saying it again is up to the server", () => {
  const socket = openPane();
  const streamed = resizeFrames(socket);
  expect(streamed.length, "la pane non ha mandato la misura del contenitore").toBeGreaterThan(0);
  expect(streamed[streamed.length - 1]).toMatchObject({ width: PANE_WIDTH, height: PANE_HEIGHT });

  // The guard this test exists for: the same size, offered again, does not
  // leave. If this ever stops being true the `viewport_request` answer is not
  // needed any more, and this whole file can go.
  const before = resizeFrames(socket).length;
  socket.deliver({ type: 'url', url: 'https://example.org/' });
  expect(resizeFrames(socket).length).toBe(before);
});

test("viewport_request: the heir says its size again, dedup guard and all", () => {
  const socket = openPane();
  const before = resizeFrames(socket).length;

  socket.deliver({ type: 'viewport_request' });

  const after = resizeFrames(socket);
  expect(
    after.length,
    "la pane ha ignorato la richiesta di misura: la pagina condivisa resta della misura di chi e' uscito",
  ).toBe(before + 1);
  expect(after[after.length - 1]).toMatchObject({ width: PANE_WIDTH, height: PANE_HEIGHT });
});

test('the pane gives the server the same name on a second connection', () => {
  // The whole arbitration rests on this: a pane that comes back is recognised.
  // Every other test in this family passes that name in by hand, so this is the
  // only place where the promise is actually kept or broken. If the name is
  // reinvented per socket, the Mac reconnecting is a stranger and a phone that
  // is merely watching keeps the shared page at its own size.
  const first = openPane();
  expect(paneName(first), "la pane non dice il suo nome al server").toBeTruthy();

  // A reconnection: the socket dropped and the same webview opens another one.
  first.close();
  const second = openPane();
  expect(second).not.toBe(first);
  expect(paneName(second), 'la pane si reinventa il nome ad ogni socket').toBe(paneName(first));
});

test('using the page claims its viewport: the resize after an input says driving', () => {
  const socket = openPane();
  const before = resizeFrames(socket).length;

  // A click on a pane that is only watching. The size has not changed, so the
  // dedup guard would swallow this frame: the claim is what has to get through,
  // because it is the only thing that tells the server the page changed hands.
  // On the DataChannel there is no `input` frame at all, and then this is the
  // ONLY thing that says it.
  pane?.sendInput('click', { x: 12, y: 34 });

  const frames = resizeFrames(socket);
  expect(frames.length, "l'input non ha rivendicato il viewport").toBe(before + 1);
  expect(frames[frames.length - 1]).toMatchObject({
    width: PANE_WIDTH, height: PANE_HEIGHT, driving: true,
  });

  // Moving the cursor to READ is not using the page: it must not reflow under
  // the hands of whoever is typing.
  const quiet = resizeFrames(socket).length;
  pane?.sendInput('mousemove', { x: 13, y: 35 });
  expect(resizeFrames(socket).length, 'il mouse che passa rivendica la pagina').toBe(quiet);
});

/**
 * A ROW CHANGED OUT OF BAND REACHES A WINDOW THAT READ THE THREAD A MOMENT AGO.
 *
 * Two server sweeps change rows no turn's frames carry: the end of a boot
 * reattach leg closes the row it left open and writes the cut, and the resume
 * sweep traces a row whose resend the route refused. Both announce the chat
 * with a `topic:updated`, and an open pane answers with `loadHistory`. That
 * read skipped any session read in the last 5 s (HISTORY_DEDUP_MS), and at
 * boot every window has just read its chats on reconnect: the announcement was
 * dropped and the bubble stayed open with no notice (card edf3c4db). A read
 * already in flight, started before the write, swallowed it the same way.
 *
 * Driven through the real hook (`useChat` on the hook harness), with the
 * history route stubbed at `fetch`; the last block starts from the frame, on
 * the subscription an open pane installs (`subscribeThreadReconcile`).
 *
 * @covers INTERRUPT-01, RESUME-02
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useChat } from './useChat';
import { subscribeThreadReconcile } from './threadReconcile';
import { __setQueueStorage } from '../state/chatQueue';
import type { ChatMessage, WSMessage } from '../types';

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const g = globalThis as unknown as Record<string, unknown>;
// Process-wide globals: put back what this file found once it is done, or the
// next file in the same `bun test` process meets a partial window.
const found = { window: g.window, requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame };
afterAll(() => {
  for (const [k, v] of Object.entries(found)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});
const w = (g.window as Record<string, unknown> | undefined) ?? {};
w.localStorage ??= new MemStorage();
w.addEventListener ??= () => {};
w.removeEventListener ??= () => {};
w.dispatchEvent ??= () => true;
g.window = w;
g.requestAnimationFrame ??= (cb: () => void) => { cb(); return 0; };
g.cancelAnimationFrame ??= () => {};

const realSetTimeout = globalThis.setTimeout;
/** Lets the fetch stub and the hook's own microtasks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => realSetTimeout(r, 0));
}

type Chat = ReturnType<typeof useChat>;

let seq = 0;
function drive(): { chat: Chat; sk: string; last(): ChatMessage | undefined; unmount(): void } {
  const sk = `topic:thread-changed-${++seq}`;
  const box: { current: Chat | null } = { current: null };
  function Probe(): null {
    const live = useChat();
    React.useEffect(() => { box.current = live; });
    return null;
  }
  const harness = mount(React.createElement(Probe));
  const api = (): Chat => {
    if (!box.current) throw new Error('useChat did not mount');
    return box.current;
  };
  return {
    get chat() { return api(); },
    sk,
    last: () => api().getSessionMessages(sk).at(-1),
    unmount: () => harness.unmount(),
  };
}

const TS = '2026-09-27T08:00:00.000Z';
const CUT = 'Turno interrotto: il server si è riavviato mentre la risposta era in corso.';
/** The rows as the window read them on reconnect: the leg's row still open. */
const OPEN = [
  { id: 'u1', role: 'user', content: 'misura la ripresa', timestamp: TS },
  { id: 'a1', role: 'assistant', content: 'sto misurando', partial: true, blocks: [{ kind: 'text', text: 'sto misurando' }], timestamp: TS },
];
/** The same rows once the leg's end closed the row and wrote the cut. */
const CLOSED = [
  OPEN[0],
  { ...OPEN[1], partial: false, blocks: [{ kind: 'text', text: 'sto misurando' }, { kind: 'error', text: CUT }] },
];

// Put back, or every file after this one in the same process asks this stub
// for the network.
const REAL_FETCH = globalThis.fetch;
let serverRows: unknown[] = OPEN;
/** While set, a history read holds its answer until the test releases it. */
let gate: Promise<void> | null = null;

beforeEach(() => {
  __setQueueStorage(null);
  serverRows = OPEN;
  gate = null;
  g.fetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/history/')) {
      // Read when the request reaches the route, answered when the gate opens:
      // a read in flight describes the rows as they were when it started.
      const rows = serverRows;
      if (gate) await gate;
      return json({ messages: rows, total: rows.length, isStreaming: false });
    }
    return json({ ok: true });
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

const cutOf = (m: ChatMessage | undefined) => m?.blocks?.find((b) => b.kind === 'error');

describe('a row changed out of band, in a window that just read the thread', () => {
  test('the announcement reads the thread again inside the dedup window', async () => {
    const d = drive();
    await d.chat.loadHistory(d.sk);
    expect(d.last()?.partial).toBe(true);

    serverRows = CLOSED;
    // A plain read inside the window is still skipped: a remount must not refetch.
    await d.chat.loadHistory(d.sk);
    expect(cutOf(d.last())).toBeUndefined();

    await d.chat.loadHistory(d.sk, { fresh: true });
    expect(d.last()?.partial).toBeFalsy();
    expect(cutOf(d.last())).toMatchObject({ kind: 'error', text: CUT });
    d.unmount();
  });

  test('a read in flight that started before the change is followed by one more', async () => {
    const d = drive();
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const first = d.chat.loadHistory(d.sk);
    await settle();

    serverRows = CLOSED;
    await d.chat.loadHistory(d.sk, { fresh: true });
    gate = null;
    release();
    await first;
    await settle();

    expect(d.last()?.partial).toBeFalsy();
    expect(cutOf(d.last())).toMatchObject({ kind: 'error', text: CUT });
    d.unmount();
  });
});

/**
 * FROM THE FRAME. The pieces above, wired as an open pane wires them: the
 * server's `topic:updated` lands on the socket, the pane's reconcile debounces
 * it and asks `useChat` for the thread. Only the frame's `threadChanged` takes
 * that read past the dedup; the same frame without it is the announcement the
 * windows dropped.
 */
describe('from the frame on the socket, in a window that read the thread a moment ago', () => {
  const TOPIC_ID = 'thread-changed-pane';
  function openPane(d: ReturnType<typeof drive>) {
    const handlers = new Set<(msg: WSMessage) => void>();
    const stop = subscribeThreadReconcile((h) => { handlers.add(h); return () => { handlers.delete(h); }; }, {
      isOpen: (id) => id === TOPIC_ID,
      isOwnStream: (sk) => d.chat.isOwnStream(sk),
      isSessionStreaming: (sk) => d.chat.isSessionStreaming(sk),
      loadHistory: (sk, opts) => { void d.chat.loadHistory(sk, opts); },
    });
    const emit = (frame: Record<string, unknown>) => {
      for (const h of handlers) h({ type: 'topic:updated', topic: { id: TOPIC_ID, sessionKey: d.sk }, ...frame } as unknown as WSMessage);
    };
    return { emit, stop };
  }

  /** Past the pane's 400 ms debounce, on real time: bun's fake timers also stop `settle`. */
  const pastDebounce = () => new Promise<void>((r) => realSetTimeout(r, 450));

  test('the thread-changed announcement closes the row and shows the cut, with no reload', async () => {
    const d = drive();
    const pane = openPane(d);
    await d.chat.loadHistory(d.sk);
    expect(d.last()?.partial).toBe(true);

    serverRows = CLOSED;
    pane.emit({ threadChanged: true });
    await pastDebounce();
    await settle();

    expect(d.last()?.partial).toBeFalsy();
    expect(cutOf(d.last())).toMatchObject({ kind: 'error', text: CUT });
    pane.stop();
    d.unmount();
  });

  test('the same frame without the flag falls in the dedup, and the row stays open', async () => {
    const d = drive();
    const pane = openPane(d);
    await d.chat.loadHistory(d.sk);

    serverRows = CLOSED;
    pane.emit({});
    await pastDebounce();
    await settle();

    expect(d.last()?.partial).toBe(true);
    expect(cutOf(d.last())).toBeUndefined();
    pane.stop();
    d.unmount();
  });
});

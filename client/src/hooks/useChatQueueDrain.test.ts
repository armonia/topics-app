/**
 * THE QUEUE DRAINS ON EVERY AUTHORITATIVE "TURN SETTLED" SIGNAL, not only on a
 * `stream:end` this client happens to see.
 *
 * The defect: `drainTurnQueue` was called from the WS `stream:end` case and from
 * the end of a local SSE send, and from nowhere else. Type a follow-up while an
 * agent works, then reload the app, relaunch Topics, or lose the socket for the
 * second in which the turn ends: the dashed "to send" bubble sat in the
 * transcript forever, the turn never started, and the only way out was to copy
 * the text, delete the bubble and retype it.
 *
 * Driven through the real hook (`useChat` on the hook harness) because the
 * defect is WIRING: the drain itself was correct, it was simply never asked.
 * The three signals below are the three ways a turn ends without a
 * `stream:end` reaching this window:
 *
 *   - hydrate: `loadHistory` comes back with `isStreaming: false` (reload,
 *     relaunch, pane remount after the turn ended);
 *   - orphan reconciler: the server no longer lists the session as streaming;
 *   - watchdog: three minutes of silence and the server says "not streaming".
 *
 * @covers CHAT-01
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useChat } from './useChat';
import { __setQueueStorage, enqueueTurn, getQueue } from '../state/chatQueue';
import type { WSMessage } from '../types';

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

const frames = new Map<number, () => void>();
let frameSeq = 0;
g.requestAnimationFrame = (cb: () => void) => { frames.set(++frameSeq, cb); return frameSeq; };
g.cancelAnimationFrame = (id: number) => { frames.delete(id); };
function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const cb of queued) cb();
}

const realSetTimeout = globalThis.setTimeout;
/** Lets the fetch mock and the drain's own microtasks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => realSetTimeout(r, 0));
}

type Chat = ReturnType<typeof useChat>;

let seq = 0;
function drive(): { chat: Chat; sk: string; ws(frame: Record<string, unknown>): void; unmount(): void } {
  const sk = `topic:drain-${++seq}`;
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
    ws(frame) {
      api().onWSMessage({ sessionKey: sk, ...frame } as unknown as WSMessage);
      flushFrames();
      harness.rerender();
    },
    unmount: () => harness.unmount(),
  };
}

// THE FAKE `fetch` IS PUT BACK, or the files after this one pay for it.
//
// `bun test` runs the WHOLE suite in ONE process: a stub planted on
// `globalThis` and never restored does not end with this file, it stays on
// every file that comes after. Measured on 03/09: 54 failures spread over
// `relay-proxy`, the native MCP fleet, `web_fetch` and the real server's
// WebSocket registries. All of them green on their own, all of them red in the
// suite, because they were asking this stub for the network. The restore is one
// line; without it, somebody else reads the failure as theirs.
const REAL_FETCH = globalThis.fetch;

/** Every body POSTed to /api/chat, in order: the proof that a queued turn went out. */
let sent: { sessionKey: string; content: string }[] = [];

function installFetch(): void {
  g.fetch = async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/history/')) return json({ messages: [], isStreaming: false });
    if (url.includes('/api/topics/streaming')) return json({ sessions: [] });
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(init?.body ?? '{}') as { sessionKey: string; messages: { content: string }[] };
      sent.push({ sessionKey: body.sessionKey, content: body.messages.at(-1)?.content ?? '' });
      // An SSE body that ends at once: the turn is over as soon as it started.
      return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    }
    return json({ ok: true });
  };
}

const LIVE = 'a1b2c3d4-0000-4000-8000-00000000d0a1';
const FOLLOW_UP = 'e poi guarda anche i test';

beforeEach(() => {
  sent = [];
  __setQueueStorage(null);
  installFetch();
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('a queued turn is not stranded when the stream:end never reaches this window', () => {
  test('hydrate: history says nothing is running, so the queue goes out', async () => {
    const d = drive();
    // The follow-up survived a reload in storage; the turn it waited for is over.
    enqueueTurn(d.sk, FOLLOW_UP);
    expect(getQueue(d.sk)).toHaveLength(1);

    await d.chat.loadHistory(d.sk);
    await settle();

    // Before the fix: `sent` stayed empty and the bubble stayed dashed forever.
    expect(sent.map((s) => s.content)).toEqual([FOLLOW_UP]);
    expect(getQueue(d.sk)).toHaveLength(0);
    d.unmount();
  });

  test('hydrate: a session the server still runs keeps its queue', async () => {
    const d = drive();
    enqueueTurn(d.sk, FOLLOW_UP);
    g.fetch = async () => new Response(JSON.stringify({ messages: [], isStreaming: true }), { status: 200, headers: { 'content-type': 'application/json' } });

    await d.chat.loadHistory(d.sk);
    await settle();

    expect(sent).toHaveLength(0);
    expect(getQueue(d.sk)).toHaveLength(1);
    d.unmount();
  });

  test('orphan reconciler: the turn the server forgot is a finished turn', async () => {
    const d = drive();
    // Another window ran the turn; this one only watched it over the socket and
    // queued a follow-up meanwhile.
    d.ws({ type: 'stream:start', messageId: LIVE });
    enqueueTurn(d.sk, FOLLOW_UP);

    // Two consecutive polls without the session: the production condition.
    d.chat.reconcileServerStreams(new Set<string>());
    d.chat.reconcileServerStreams(new Set<string>());
    await settle();

    expect(sent.map((s) => s.content)).toEqual([FOLLOW_UP]);
    d.unmount();
  });

  test('watchdog: three minutes of silence confirmed by the server is a finished turn', async () => {
    const armed = new Map<number, { cb: () => void; ms: number }>();
    let timerSeq = 0;
    const savedSetTimeout = g.setTimeout;
    const savedClearTimeout = g.clearTimeout;
    g.setTimeout = (cb: () => void, ms?: number) => { armed.set(++timerSeq, { cb, ms: ms ?? 0 }); return timerSeq; };
    g.clearTimeout = (id: number) => { armed.delete(id); };
    try {
      const d = drive();
      d.ws({ type: 'stream:start', messageId: LIVE });
      enqueueTurn(d.sk, FOLLOW_UP);

      const watchdog = [...armed.values()].filter((t) => t.ms === 3 * 60 * 1000).pop();
      expect(watchdog, 'the stream must arm the watchdog').toBeDefined();
      watchdog!.cb();
      await settle();

      expect(sent.map((s) => s.content)).toEqual([FOLLOW_UP]);
      d.unmount();
    } finally {
      g.setTimeout = savedSetTimeout;
      g.clearTimeout = savedClearTimeout;
    }
  });
});

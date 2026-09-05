/**
 * A SEND ERROR BELONGS TO ITS SESSION.
 *
 * `useChat` is mounted once for the whole app and its `error` was one string:
 * a failed send in topic A painted a red line under the composer of every chat
 * tiled next to it, and the next action in B (a delete, a history load, a
 * send) cleared A's notice before A's user could read why the message did not
 * go. Keyed by sessionKey, like `streaming` and `loading` already are.
 *
 * @covers CHAT-01
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useChat } from './useChat';
import { __setQueueStorage } from '../state/chatQueue';

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

type Chat = ReturnType<typeof useChat>;

function drive(): { chat: Chat; unmount(): void } {
  const box: { current: Chat | null } = { current: null };
  function Probe(): null {
    const live = useChat();
    React.useEffect(() => { box.current = live; });
    return null;
  }
  const harness = mount(React.createElement(Probe));
  return {
    get chat() {
      if (!box.current) throw new Error('useChat did not mount');
      return box.current;
    },
    unmount: () => harness.unmount(),
  };
}

const A = 'topic:err-a';
const B = 'topic:err-b';

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

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  __setQueueStorage(null);
  g.fetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    // The send fails with a server error: not a network drop, so nothing is
    // queued and the message is reported to the user.
    if (url.endsWith('/api/chat')) return new Response('server on fire', { status: 500 });
    return okJson({ messages: [] });
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('send errors are keyed by session', () => {
  test('a failed send in A is visible in A only, and B clearing its own does not touch it', async () => {
    const d = drive();

    const ok = await d.chat.sendMessage(A, 'ciao');
    expect(ok).toBe(false);
    expect(d.chat.error[A]).toBe('server on fire');
    // Before the fix `error` was a string for the whole app: B would have shown
    // A's failure under its own composer.
    expect(d.chat.error[B] ?? null).toBeNull();

    // B does something that clears ITS error slot. A's notice must survive.
    await d.chat.deleteMessage(B, 'm-1');
    expect(d.chat.error[A]).toBe('server on fire');
    expect(d.chat.error[B] ?? null).toBeNull();

    // A moves on: its own slot is cleared at the start of the next action.
    await d.chat.deleteMessage(A, 'm-2');
    expect(d.chat.error[A] ?? null).toBeNull();
    d.unmount();
  });
});

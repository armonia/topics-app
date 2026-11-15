/**
 * @covers CLIENT-SILENT-ERR-01
 * Two silent swallows closed by card `4c8d4432-5742-4f9f-aad8-995221c6b7eb`:
 *
 *   - a registered WS handler that throws used to vanish with no log, and
 *     could stop handlers registered after it from running too;
 *   - a failed history reload after a stream ended used to leave the session
 *     neither hydrated nor warned about.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useChat } from './useChat';
import { __setQueueStorage } from '../state/chatQueue';
import { getHistoryCompleteness, resetHistoryCompleteness } from '../state/historyCompleteness';

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

const REAL_FETCH = globalThis.fetch;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const realSetTimeout = globalThis.setTimeout;
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => realSetTimeout(r, 0));
}

beforeEach(() => {
  __setQueueStorage(null);
  g.fetch = async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    if (url.includes('/history')) return new Response('boom', { status: 500 });
    if (url.endsWith('/api/chat')) return new Response('data: [DONE]\n\n', { status: 200 });
    return okJson({ messages: [] });
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('useChat ws handler failures are logged, not swallowed', () => {
  test('a registered handler that throws is logged and does not block the next handler', () => {
    const errorCalls: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    const d = drive();
    let secondRan = false;
    try {
      const offFirst = d.chat.registerWSHandler(() => { throw new Error('boom'); });
      const offSecond = d.chat.registerWSHandler(() => { secondRan = true; });
      expect(() => d.chat.onWSMessage({ type: 'pong' } as never)).not.toThrow();
      expect(errorCalls.some((args) => String(args[0]).includes('[chat] ws handler threw'))).toBe(true);
      expect(secondRan).toBe(true);
      offFirst();
      offSecond();
    } finally {
      console.error = realError;
      d.unmount();
    }
  });
});

describe('useChat history reload after a stream is logged, not swallowed', () => {
  test('a failed history reload warns and leaves the session not hydrated', async () => {
    const warnCalls: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    const d = drive();
    resetHistoryCompleteness('topic:history-reload-fail');
    try {
      const ok = await d.chat.sendMessage('topic:history-reload-fail', 'ciao');
      await settle();
      expect(ok).toBe(true);
      expect(getHistoryCompleteness('topic:history-reload-fail').state).not.toBe('complete');
      expect(warnCalls.some((args) => String(args[0]).includes('[chat] history reload after stream failed'))).toBe(true);
    } finally {
      console.warn = realWarn;
      d.unmount();
    }
  });
});

describe('Stop at full localStorage quota still stops', () => {
  test('stopSession resolves without throwing when every setItem throws', async () => {
    const warn = console.warn;
    console.warn = () => {};
    const d = drive();
    try {
      __setQueueStorage({
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceededError'); },
        removeItem: () => {},
      });
      await d.chat.sendMessage('topic:stop-full', 'ciao');
      await expect(d.chat.stopSession('topic:stop-full')).resolves.toBeDefined();
    } finally {
      console.warn = warn;
      d.unmount();
    }
  });
});

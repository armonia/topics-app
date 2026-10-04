/**
 * A TERMINAL CLOSED FROM THE SIDEBAR, WITH THE PAGE GOING AWAY INSIDE ITS
 * COUNTDOWN, STILL RETIRES ITS SERVER SESSION.
 *
 * The sidebar row's close is a 3 s countdown (`close-terminal` in App.tsx),
 * and its commit is `handleCloseTerminal`, whose server half is
 * `deleteTerminalSession`. A reload inside the countdown commits the close
 * from the exit handler (`flushAtPageExit`), while the document is going away:
 * the DELETE leaves during the unload, and only a `keepalive` request is sure
 * to outlive it. Without it the PTY of a closed shell stays up on the server
 * (a shell is never parked) and the next roster read brings the tab back.
 *
 * The pending-action provider is the real one; the commit is the server half
 * of the real commit, because mounting the whole panel lifecycle to reach
 * `handleCloseTerminal` would test that hook's dependencies instead.
 *
 * @covers TERM-WARM-01
 */
import { describe, test, expect, afterAll, afterEach } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  key(): string | null { return null; }
  get length(): number { return this.m.size; }
}
const gg = globalThis as Record<string, unknown>;
const saved = { window: gg.window, localStorage: gg.localStorage };
const storage = new MemoryStorage();
gg.localStorage = storage;
gg.window = {
  innerWidth: 1280,
  localStorage: storage,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete gg[k];
    else gg[k] = v;
  }
});

const { PendingActionProvider, enqueuePendingAction, tickPendingAction } = await import('../contexts/PendingActionContext');
const { flushAtPageExit } = await import('./pageExitFlush');
const { deleteTerminalSession } = await import('./terminalRosterRetry');

describe('a sidebar terminal close the page goes away inside', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('sends exactly one keepalive DELETE of its session on the exit flush', async () => {
    const calls: { url: string; method?: string; keepalive?: boolean }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, keepalive: init?.keepalive });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const h = mount(createElement(PendingActionProvider, null, null));
    try {
      // What App's `handleCloseTerminalDeferred` queues: enqueue, then tick.
      enqueuePendingAction({
        key: 'close-terminal:sess-sidebar',
        kind: 'close-terminal',
        label: 'Terminal',
        commit: () => { deleteTerminalSession('sess-sidebar'); },
      });
      tickPendingAction('close-terminal:sess-sidebar');
      h.rerender();
      // Still counting down: nothing has reached the server yet.
      expect(calls).toEqual([]);

      flushAtPageExit();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([
        { url: '/api/terminal/sessions/sess-sidebar', method: 'DELETE', keepalive: true },
      ]);
    } finally {
      h.unmount();
    }
  });
});

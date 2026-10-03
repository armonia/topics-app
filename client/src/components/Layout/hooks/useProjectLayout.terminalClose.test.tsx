/**
 * CLOSING A TERMINAL TAB IN A PROJECT WINDOW ENDS ITS SESSION.
 *
 * The close site in `useProjectLayout` (`handleClosePaneNow`) schedules
 * `closedTerminalCleanup(sessionId)` after the grace window. The pieces are
 * tested on their own (`closedTabRecord.test.ts`), the call that joins them
 * was not: replaced with nothing, every test stayed green while each closed
 * tab left its shell running on the server, and a reload inside the window
 * left no DELETE behind either.
 *
 * Driven through the real hook: close the tab, then the page goes away inside
 * the grace window (`flushTerminalCleanups`, the `pagehide` path), which runs
 * the scheduled cleanup at once as the one `keepalive` DELETE that outlives an
 * unload.
 *
 * @covers CMD-03, TERM-01
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { createElement, useEffect } from 'react';
import { mount } from '../../../test/reactHarness';
import type { Pane, PaneGroup } from '../../../types';

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
const saved = { window: gg.window, localStorage: gg.localStorage, fetch: gg.fetch };
const storage = new MemoryStorage();
gg.localStorage = storage;
gg.window = {
  innerWidth: 1280,
  localStorage: storage,
  location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};
/** Every request the page made, method and path. */
const requests: Array<{ method: string; url: string; keepalive: boolean }> = [];
gg.fetch = async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input as { url: string }).url;
  requests.push({ method: init?.method ?? 'GET', url, keepalive: init?.keepalive === true });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete gg[k];
    else gg[k] = v;
  }
});

const { useProjectLayout } = await import('./useProjectLayout');
const { flushTerminalCleanups } = await import('../../../state/pane/adapters/closedTabRecord');
type Layout = ReturnType<typeof useProjectLayout>;

describe('a terminal tab closed in a project window', () => {
  test('schedules the end of its session: a page leaving inside the grace window sends the DELETE', async () => {
    const SESSION = 'sess-close-site-1';
    const terminal = { id: `terminal:${SESSION}`, type: 'terminal', title: 'Shell', preview: false } as Pane;
    const file = { id: 'file:a', type: 'file', title: 'a', preview: false, filePath: '/p/a' } as Pane;
    const group = { id: 'g1', type: 'terminal', paneIds: [file.id, terminal.id], activePaneId: terminal.id } as unknown as PaneGroup;
    const box: { layout: Layout | null } = { layout: null };

    function Probe() {
      const layout = useProjectLayout({
        projectPath: '/p',
        topics: {},
        initial: { nonChatPanes: [file, terminal], openChatTopicIds: [], groups: [group], rows: [{ groupIds: ['g1'], widths: [1] }] },
        focusedPanelId: null,
        onWSMessage: () => () => {},
        claudeSkipPermissions: false,
        onFocusPanel: () => {},
        pushClosedTab: () => {},
        removeClosedTab: () => {},
        isSessionStreaming: () => false,
        stopSession: async () => true,
        onOpenPaneSettings: () => {},
        gateRefs: { initialChatsSyncedRef: { current: true } },
      });
      useEffect(() => { box.layout = layout; });
      return null;
    }

    const h = mount(createElement(Probe));
    try {
      box.layout!.handlers.closeNow('g1', terminal.id);
      h.rerender();
      expect(box.layout!.state.panes.some((p) => p.id === terminal.id)).toBe(false);
      const deletes = () => requests.filter((r) => r.method === 'DELETE' && r.url.endsWith(`/api/terminal/sessions/${SESSION}`));
      // Inside the grace window nothing is deleted yet: ⌘Z can still bring it back.
      expect(deletes()).toEqual([]);

      flushTerminalCleanups();
      await Promise.resolve();
      // Before: with the call at the close site gone, nothing was scheduled and no DELETE left.
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]!.keepalive).toBe(true);
    } finally {
      h.unmount();
    }
  });
});

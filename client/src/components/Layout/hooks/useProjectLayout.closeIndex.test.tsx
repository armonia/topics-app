/**
 * A COUNTDOWN CLOSE RECORDS THE TAB WHERE IT IS AT COMMIT, NOT WHERE IT WAS.
 *
 * `handleClosePane` queues `commit: () => handleClosePaneNow(groupId, paneId)`
 * with the callback of THAT render, and three seconds later the close read
 * the pane's group from its own closure. A reorder during the countdown made
 * `groupIndex` stale, and ⌘Z put the tab back in the wrong slot.
 *
 * Reproduced by calling the `closeNow` of an EARLIER render after a reorder:
 * that is exactly the callback the countdown holds.
 *
 * @covers CMD-03
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { createElement, useEffect } from 'react';
import { mount } from '../../../test/reactHarness';
import type { ClosedTabRecord } from '../../../state/pane/adapters';
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

const { useProjectLayout } = await import('./useProjectLayout');
type Layout = ReturnType<typeof useProjectLayout>;

const view = (id: string): Pane => ({ id, type: 'file', title: id, preview: false, filePath: `/p/${id}` } as Pane);

describe('countdown close and a reorder in between', () => {
  test('the undo record carries the index the tab has at commit', () => {
    const panes = [view('file:a'), view('file:b'), view('file:c')];
    const group: PaneGroup = { id: 'g1', type: 'file', paneIds: panes.map(p => p.id), activePaneId: 'file:a' } as PaneGroup;
    const records: ClosedTabRecord[] = [];
    const box: { layout: Layout | null } = { layout: null };

    function Probe() {
      const layout = useProjectLayout({
        projectPath: '/p',
        topics: {},
        initial: { nonChatPanes: panes, openChatTopicIds: [], groups: [group], rows: [{ groupIds: ['g1'], widths: [1] }] },
        focusedPanelId: null,
        onWSMessage: () => () => {},
        claudeSkipPermissions: false,
        onFocusPanel: () => {},
        pushClosedTab: (r) => { records.push(r); },
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
      const staleCloseNow = box.layout!.handlers.closeNow;
      // During the countdown the user drags `b` to the end: a, c, b.
      box.layout!.handlers.reorderGroupPanes('g1', ['file:a', 'file:c', 'file:b']);
      h.rerender();
      expect(box.layout!.state.groups.find(g => g.id === 'g1')?.paneIds).toEqual(['file:a', 'file:c', 'file:b']);
      // The countdown commits with the callback it captured.
      staleCloseNow('g1', 'file:b');
      expect(records).toHaveLength(1);
      expect(records[0].groupIndex).toBe(2);
    } finally {
      h.unmount();
    }
  });
});

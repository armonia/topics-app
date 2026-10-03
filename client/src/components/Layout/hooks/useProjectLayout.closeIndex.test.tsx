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
 * Reading from the refs let `handleClosePaneNow` memoize on stable deps, and
 * its redo then called the `handleClosePane` of the first render: for a tab
 * opened after mount, ⌘⇧Z after ⌘Z found no pane and did nothing.
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
const { undo, redo } = await import('../../../contexts/UndoContext');
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

describe('redo of a close, for a tab opened after mount', () => {
  test('re-enters the close pipeline instead of finding no pane', async () => {
    const panes = [view('file:a')];
    const group: PaneGroup = { id: 'g1', type: 'file', paneIds: ['file:a'], activePaneId: 'file:a' } as PaneGroup;
    const box: { layout: Layout | null } = { layout: null };
    // Stable across renders, as in ProjectWindow (useClosedTabs memoizes on []).
    const stable = {
      initial: { nonChatPanes: panes, openChatTopicIds: [], groups: [group], rows: [{ groupIds: ['g1'], widths: [1] }] },
      topics: {},
      onWSMessage: () => () => {},
      onFocusPanel: () => {},
      pushClosedTab: () => {},
      removeClosedTab: () => {},
      isSessionStreaming: () => false,
      stopSession: async () => true,
      onOpenPaneSettings: () => {},
      gateRefs: { initialChatsSyncedRef: { current: true } },
    };

    function Probe() {
      const layout = useProjectLayout({ ...stable, projectPath: '/p', focusedPanelId: null, claudeSkipPermissions: false });
      useEffect(() => { box.layout = layout; });
      return null;
    }

    const h = mount(createElement(Probe));
    const warns: string[] = [];
    const origWarn = console.warn;
    try {
      box.layout!.handlers.openFile('/p/new.txt');
      h.rerender();
      const opened = box.layout!.state.panes.find(p => p.filePath === '/p/new.txt');
      expect(opened).toBeTruthy();
      box.layout!.handlers.closeNow('g1', opened!.id);
      h.rerender();
      await undo();
      h.rerender();
      expect(box.layout!.state.panes.some(p => p.id === opened!.id)).toBe(true);
      // No provider is mounted here, so reaching the countdown shows up as the
      // pending-action API's "enqueue called before <PendingActionProvider>".
      console.warn = (...a: unknown[]) => { warns.push(String(a[0])); };
      await redo();
      expect(warns.some(w => w.includes('enqueue called before'))).toBe(true);
    } finally {
      console.warn = origWarn;
      h.unmount();
    }
  });
});

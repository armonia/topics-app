/**
 * A PROJECT VIEW IS THE SAME PANE ON EVERY DEVICE.
 *
 * Git, Files and Board are singletons of a project. They were born with a
 * random id, so two devices named the same view differently and the sync hid
 * the copy by type. The id now comes from the project and the view: both doors
 * that open a pane mint it, an open one is focused instead of opened twice,
 * and a legacy id is migrated at mount keeping its rendering key.
 *
 * @covers PANE-AUTH-04
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
type Initial = Parameters<typeof useProjectLayout>[0]['initial'];

const GIT_ID = `git:${encodeURIComponent('/p')}`;
const file = (id: string): Pane => ({ id, type: 'file', title: id, preview: false, filePath: `/p/${id}` } as Pane);
const git = (id: string): Pane => ({ id, type: 'git', title: 'Git', preview: false } as Pane);
const group = (id: string, paneIds: string[]): PaneGroup =>
  ({ id, type: 'utility', paneIds, activePaneId: paneIds[0] } as PaneGroup);

function mountLayout(initial: Initial) {
  storage.clear();
  const box: { layout: Layout | null } = { layout: null };
  function Probe() {
    const layout = useProjectLayout({
      projectPath: '/p', topics: {}, initial,
      focusedPanelId: null, onWSMessage: () => () => {}, claudeSkipPermissions: false,
      onFocusPanel: () => {}, pushClosedTab: () => {}, removeClosedTab: () => {},
      isSessionStreaming: () => false, stopSession: async () => true, onOpenPaneSettings: () => {},
      gateRefs: { initialChatsSyncedRef: { current: true } },
    });
    useEffect(() => { box.layout = layout; });
    return null;
  }
  const h = mount(createElement(Probe));
  return {
    h,
    get layout(): Layout {
      if (!box.layout) throw new Error('useProjectLayout did not mount');
      return box.layout;
    },
  };
}

describe('project singleton views', () => {
  test('opening Git mints the project id, not a random one', async () => {
    const a = file('file:a');
    const t = mountLayout({ nonChatPanes: [a], openChatTopicIds: [], groups: [group('g1', [a.id])], rows: [{ groupIds: ['g1'], widths: [1] }] });
    try {
      const id = await t.layout.handlers.addToGroup('g1', 'git');
      t.h.rerender();
      expect(id).toBe(GIT_ID);
      expect(t.layout.state.panes.filter(p => p.type === 'git').map(p => p.id)).toEqual([GIT_ID]);
    } finally {
      t.h.unmount();
    }
  });

  test('the empty project door mints the same id', async () => {
    const t = mountLayout(null);
    try {
      await t.layout.handlers.addWhenEmpty('git');
      t.h.rerender();
      expect(t.layout.state.panes.filter(p => p.type === 'git').map(p => p.id)).toEqual([GIT_ID]);
    } finally {
      t.h.unmount();
    }
  });

  test('opening Git while it is open in another group focuses that one', async () => {
    const a = file('file:a');
    const t = mountLayout({
      nonChatPanes: [git('git:legacy'), a], openChatTopicIds: [],
      groups: [group('g1', ['git:legacy']), group('g2', [a.id])],
      rows: [{ groupIds: ['g1', 'g2'], widths: [0.5, 0.5] }],
    });
    try {
      const id = await t.layout.handlers.addToGroup('g2', 'git');
      t.h.rerender();
      expect(id).toBe(GIT_ID);
      expect(t.layout.state.panes.filter(p => p.type === 'git')).toHaveLength(1);
      expect(t.layout.state.focusedGroupId).toBe('g1');
      expect(t.layout.state.groups.find(g => g.id === 'g2')?.paneIds).toEqual([a.id]);
    } finally {
      t.h.unmount();
    }
  });

  test('a legacy id is migrated at mount and keeps its rendering key', () => {
    const t = mountLayout({ nonChatPanes: [git('git:legacy')], openChatTopicIds: [], groups: [group('g1', ['git:legacy'])], rows: [{ groupIds: ['g1'], widths: [1] }] });
    try {
      const view = t.layout.state.panes.find(p => p.type === 'git');
      expect(view?.id).toBe(GIT_ID);
      expect(view?.stableKey ?? view?.id).toBe('git:legacy');
      expect(t.layout.state.groups.find(g => g.id === 'g1')?.paneIds).toEqual([GIT_ID]);
    } finally {
      t.h.unmount();
    }
  });
});

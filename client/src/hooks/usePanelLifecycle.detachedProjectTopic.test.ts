/**
 * A DETACHED window (`?topic=<id>`, see `App.tsx`'s `detachedTopicIds`) hosts
 * exactly that topic — but the validation effect that converts a project-bound
 * topic into its project pane (`opensAsProjectPane`) is SKIPPED for `isDetached`.
 * A project-bound, non-standalone topic therefore sits in `openPanels` as a
 * bare id that nothing renders: the grid stays empty. This is exactly what the
 * preview-worktree seed hit (card 79ab687d, 27/11) — the fix moved the seeded
 * topic to standalone, which this test also covers as the working case.
 *
 * @covers card bdc41478-19ab-4d81-b8a9-5d39d1a4d2bd
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { usePanelLifecycle, type UsePanelLifecycleArgs } from './usePanelLifecycle';
import { usePaneStore } from '../state/pane/store';
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
const found = { window: g.window, fetch: g.fetch };
afterAll(() => {
  if (found.window === undefined) delete g.window;
  else g.window = found.window;
  g.fetch = found.fetch;
});

const PROJECT_TOPIC = { id: 'proj-topic-1', sessionKey: 'topic:proj-topic-1', name: 'In project', projectPath: '/work/app', standalone: false };
const STANDALONE_TOPIC = { id: 'standalone-topic-1', sessionKey: 'topic:standalone-topic-1', name: 'Loose chat' };

function mountDetached(hostedId: string, topics: Record<string, unknown>) {
  const args = {
    isDetached: true, detachedTopicId: hostedId, detachedTopicIds: [hostedId], isMobile: false,
    topics, topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
    archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
    workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids,
    terminalOps: { markRecentlyCreated: () => {}, addOptimisticSession: () => {} },
    onWSMessage: (_h: (msg: WSMessage) => void) => () => {},
    sendWS: () => {}, windowId: 'detached-window',
    chatStreamHandlers: { isOwnStream: () => false, isSessionStreaming: () => false, loadHistory: () => {} },
    setSidebarCollapsed: () => {}, removeClosedTab: () => {}, closedTabs: [],
  } as unknown as UsePanelLifecycleArgs;
  const seen: Array<ReturnType<typeof usePanelLifecycle>> = [];
  function Pane(): null {
    seen.push(usePanelLifecycle(args));
    return null;
  }
  const harness: Harness = mount(React.createElement(Pane));
  return {
    get: () => seen[seen.length - 1]!,
    unmount: () => harness.unmount(),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('detached window hosting a single topic', () => {
  const store = usePaneStore.getState();
  let life: ReturnType<typeof mountDetached> | null = null;
  beforeEach(() => {
    g.window = {
      localStorage: new MemStorage(),
      location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    g.fetch = () => Promise.resolve(new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
  afterEach(() => {
    life?.unmount();
    life = null;
    usePaneStore.setState(store, true);
  });

  test('a project-bound topic stays a bare, unrendered id — never promoted to its project pane', async () => {
    life = mountDetached(PROJECT_TOPIC.id, { [PROJECT_TOPIC.id]: PROJECT_TOPIC });
    await settle();
    expect(life.get().state.openPanels).toEqual([PROJECT_TOPIC.id]);
    expect(life.get().state.openPanels).not.toContain(`project:${PROJECT_TOPIC.projectPath}`);
  });

  test('a standalone topic (the preview seed, after the fix) opens as itself, hosted and intact', async () => {
    life = mountDetached(STANDALONE_TOPIC.id, { [STANDALONE_TOPIC.id]: STANDALONE_TOPIC });
    await settle();
    expect(life.get().state.openPanels).toEqual([STANDALONE_TOPIC.id]);
    expect(life.get().state.focusedPanelId).toBe(STANDALONE_TOPIC.id);
  });
});

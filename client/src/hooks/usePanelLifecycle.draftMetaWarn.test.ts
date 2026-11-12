/**
 * `draft-meta` is the SOLE persisted copy of a draft pane's project
 * association (read back only at init). A `setItem` failure used to be
 * swallowed silently; it is now logged, and the draft still has its
 * project in the live state for the rest of the session.
 *
 * @covers draft-meta persistence
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { usePanelLifecycle, type UsePanelLifecycleArgs } from './usePanelLifecycle';
import { usePaneStore } from '../state/pane/store';
import type { WSMessage } from '../types';

const g = globalThis as unknown as Record<string, unknown>;
const found = { window: g.window, fetch: g.fetch, localStorage: g.localStorage };
afterAll(() => {
  if (found.window === undefined) delete g.window; else g.window = found.window;
  g.fetch = found.fetch;
  if (found.localStorage === undefined) delete g.localStorage; else g.localStorage = found.localStorage;
});

function mountLifecycle() {
  const handlers = new Set<(msg: WSMessage) => void>();
  const args = {
    isDetached: false, detachedTopicId: null, isMobile: false,
    topics: {}, topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
    archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
    workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids,
    terminalOps: { markRecentlyCreated: () => {}, addOptimisticSession: () => {} },
    onWSMessage: (h: (msg: WSMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    sendWS: () => {}, windowId: 'draft-meta-window',
    chatStreamHandlers: { isOwnStream: () => false, isSessionStreaming: () => false, loadHistory: () => {} },
    setSidebarCollapsed: () => {},
    removeClosedTab: () => {}, closedTabs: [],
  } as unknown as UsePanelLifecycleArgs;
  const seen: Array<ReturnType<typeof usePanelLifecycle>> = [];
  function Pane(): null {
    seen.push(usePanelLifecycle(args));
    return null;
  }
  const harness: Harness = mount(React.createElement(Pane));
  return { get: () => seen[seen.length - 1]!, unmount: () => harness.unmount() };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('draft-meta persistence failure is visible', () => {
  const store = usePaneStore.getState();
  let life: ReturnType<typeof mountLifecycle> | null = null;

  beforeEach(() => {
    // A localStorage that reads fine but throws on every write (quota, private mode).
    const throwing = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    g.localStorage = throwing;
    g.window = {
      localStorage: throwing,
      location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      close: () => {},
    };
    g.fetch = () => Promise.resolve(new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  afterEach(() => {
    life?.unmount();
    life = null;
    usePaneStore.setState(store, true);
  });

  test('a failed write is logged, and the draft keeps its project in live state', async () => {
    life = mountLifecycle();
    const warn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...a: unknown[]) => { calls.push(a); };
    const draftId = await life.get().handlers.handleQuickCreateTopic();
    await settle();
    console.warn = warn;

    if (typeof draftId !== 'string') throw new Error('expected a new draft, not a project topic');
    expect(calls.length, 'the failed localStorage.setItem is not silent').toBeGreaterThan(0);
    // The write failed, but the in-memory association survives for this session.
    expect(life.get().state.draftMeta[draftId]).toBeDefined();
  });
});

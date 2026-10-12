/**
 * THE PENCIL ON THE PHONE OPENS ONE DRAFT, NOT TWO (MOBILE-CHROME-12).
 *
 * On the phone `openPanel` truncates `openPanels` to `[id]`: one surface,
 * so one composer in the DOM (other panes stay mounted with
 * `display:none`, and the e2e `toBeVisible` on the composer trips strict
 * mode as soon as there is more than one). A synchronous FOCUS_PANE planted
 * AFTER `openPanel` wakes Effect A (subscribed to `lastSeq`) before Effect B
 * has mirrored the truncation into the store: Effect A re-applies
 * `storeOrder` (the whole list) over `[draft]`, and the phone mounts two
 * composers.
 *
 * Mounted on the real harness, not detached: Effects A/B/C must be live.
 *
 * @covers MOBILE-CHROME-12
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
const found = { window: g.window, fetch: g.fetch, localStorage: g.localStorage };
afterAll(() => {
  if (found.window === undefined) delete g.window;
  else g.window = found.window;
  g.fetch = found.fetch;
  if (found.localStorage === undefined) delete g.localStorage;
  else g.localStorage = found.localStorage;
});

const CHAT = { id: 'chat-1', sessionKey: 'topic:chat-1', name: 'Esistente' };

function mountMobile() {
  const handlers = new Set<(msg: WSMessage) => void>();
  const collapsed: boolean[] = [];
  const args = {
    isDetached: false, detachedTopicId: null, isMobile: true,
    topics: { [CHAT.id]: CHAT },
    topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
    archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
    workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids,
    terminalOps: { markRecentlyCreated: () => {}, addOptimisticSession: () => {} },
    onWSMessage: (h: (msg: WSMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    sendWS: () => {}, windowId: 'mobile-draft-window',
    chatStreamHandlers: { isOwnStream: () => false, isSessionStreaming: () => false, loadHistory: () => {} },
    setSidebarCollapsed: ((v: boolean) => { collapsed.push(v); }) as React.Dispatch<React.SetStateAction<boolean>>,
    removeClosedTab: () => {}, closedTabs: [],
  } as unknown as UsePanelLifecycleArgs;
  const seen: Array<ReturnType<typeof usePanelLifecycle>> = [];
  function Pane(): null {
    seen.push(usePanelLifecycle(args));
    return null;
  }
  const harness: Harness = mount(React.createElement(Pane));
  return {
    get: () => seen[seen.length - 1]!,
    collapsed,
    unmount: () => harness.unmount(),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('la matita sul telefono', () => {
  const store = usePaneStore.getState();
  let life: ReturnType<typeof mountMobile> | null = null;
  beforeEach(() => {
    const storage = new MemStorage();
    g.localStorage = storage;
    g.window = {
      localStorage: storage,
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

  test('il tap apre una bozza sola: openPanels resta lungo uno', async () => {
    life = mountMobile();
    await life.get().handlers.openPanel(CHAT.id, 'permanent', true);
    await settle();
    expect(life.get().state.openPanels).toEqual([CHAT.id]);

    const draftId = await life.get().handlers.handleQuickCreateTopic();
    await settle();
    if (typeof draftId !== 'string') throw new Error('attesa una bozza nuova, non un topic di progetto');
    // The phone shows one surface: two ids here are two composers in the
    // DOM, and MOBILE-CHROME-12 fails with a strict mode violation.
    expect(life.get().state.openPanels).toEqual([draftId]);
    expect(life.get().state.visiblePanels).toEqual([draftId]);
    expect(life.get().state.focusedPanelId).toBe(draftId);
    // The focus is also planted in the store synchronously: a concurrent
    // hydrate must not bring the old chat back to the front.
    expect(usePaneStore.getState().focusedPaneId).toBe(draftId);
    // The drawer closed onto the draft.
    expect(life.collapsed).toContain(true);
  });

  test('il secondo tap riusa la bozza vuota senza duplicare', async () => {
    life = mountMobile();
    await life.get().handlers.openPanel(CHAT.id, 'permanent', true);
    await settle();
    const first = await life.get().handlers.handleQuickCreateTopic();
    await settle();
    if (typeof first !== 'string') throw new Error('attesa una bozza nuova, non un topic di progetto');
    const second = await life.get().handlers.handleQuickCreateTopic();
    await settle();
    expect(second).toBe(first);
    expect(life.get().state.openPanels).toEqual([first]);
    expect(life.get().state.focusedPanelId).toBe(first);
  });
});

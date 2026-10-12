/**
 * LA MATITA SUL TELEFONO APRE UNA BOZZA SOLA, NON DUE (MOBILE-CHROME-12).
 *
 * Sul telefono `openPanel` tronca `openPanels` a `[id]`: una superficie sola,
 * quindi un solo composer nel DOM (le altre pane restano montate in
 * `display:none`, e l'assert e2e `toBeVisible` sul composer scatta in strict
 * mode appena ce n'è più di uno). Il FOCUS_PANE sincrono piantato DOPO
 * `openPanel` risveglia Effect A (sottoscritto a `lastSeq`) prima che Effect B
 * abbia specchiato il troncamento nello store: Effect A riapplica
 * `storeOrder` — la lista intera — sopra `[draft]`, e il telefono monta due
 * composer.
 *
 * Montato sull'harness vero, non detached: servono Effect A/B/C accesi.
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
    // Il telefono mostra una superficie sola: due id qui sono due composer
    // nel DOM e MOBILE-CHROME-12 va in strict mode violation.
    expect(life.get().state.openPanels).toEqual([draftId]);
    expect(life.get().state.visiblePanels).toEqual([draftId]);
    expect(life.get().state.focusedPanelId).toBe(draftId);
    // E il fuoco è piantato anche nello store in modo sincrono: un hydrate
    // concorrente non deve riportare davanti la chat vecchia.
    expect(usePaneStore.getState().focusedPaneId).toBe(draftId);
    // Il cassetto si è chiuso sulla bozza.
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

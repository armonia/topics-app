/**
 * TWO OPENINGS THAT MUST LAND WHERE THE ASKER IS, through the lifecycle the app
 * runs (mounted on the hook harness, network and window faked):
 *
 *  - the agent's `browser_focus_tab` is broadcast to every client, and a client
 *    that merely had the task's tabs cached used to open the board and the
 *    drawer: a phone yanked off what it was showing;
 *  - «Open in terminal» from a chat in its project window used to drop the
 *    shell in the workspace's focused group, outside the project.
 *
 * @covers BROWSER-CHAT-05, CHAT-RUN-05
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { usePanelLifecycle, type UsePanelLifecycleArgs } from './usePanelLifecycle';
import { usePaneStore } from '../state/pane/store';
import { __resetTaskTabs, applyRemoteTaskTabs } from '../state/taskBrowserTabs';
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

const HOST = { id: 'host-1', sessionKey: 'topic:host-1', name: 'Host' };
const CHAT = { id: 'chat-1', sessionKey: 'topic:chat-1', name: 'In project', projectPath: '/work/app', standalone: false };
const TASK = 'abcdef12-3456-7890-abcd-ef1234567890';
const CTX = 'task-abcdef12-napp';

let events: Array<{ type: string; detail: unknown }>;

function mountLifecycle() {
  const handlers = new Set<(msg: WSMessage) => void>();
  const args = {
    isDetached: true, detachedTopicId: HOST.id, detachedTopicIds: [HOST.id], isMobile: false,
    topics: { [HOST.id]: HOST, [CHAT.id]: CHAT },
    topicsLoading: false, loadTopics: () => {}, createTopic: async () => null, applyTopicFromWS: () => {},
    archiveProject: async () => true, archiveTopic: async () => true, ensureTopic: async () => null,
    workspaceProjects: [], terminalSessions: [], pruneStaleTerminalPanes: (ids: string[]) => ids,
    terminalOps: { markRecentlyCreated: () => {}, addOptimisticSession: () => {} },
    onWSMessage: (h: (msg: WSMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    sendWS: () => {}, windowId: 'beside-window',
    chatStreamHandlers: { isOwnStream: () => false, isSessionStreaming: () => false, loadHistory: () => {} },
    setSidebarCollapsed: () => {}, removeClosedTab: () => {}, closedTabs: [],
  } as unknown as UsePanelLifecycleArgs;
  // Every render's answer, the last one is the hook now.
  const seen: Array<ReturnType<typeof usePanelLifecycle>> = [];
  function Pane(): null {
    seen.push(usePanelLifecycle(args));
    return null;
  }
  const harness: Harness = mount(React.createElement(Pane));
  return {
    get: () => seen[seen.length - 1]!,
    emit: (frame: Record<string, unknown>) => { for (const h of [...handlers]) h(frame as unknown as WSMessage); },
    unmount: () => harness.unmount(),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('openings that land beside the asker', () => {
  const store = usePaneStore.getState();
  let life: ReturnType<typeof mountLifecycle> | null = null;
  beforeEach(() => {
    events = [];
    g.window = {
      localStorage: new MemStorage(),
      location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (e: { type: string; detail?: unknown }) => { events.push({ type: e.type, detail: e.detail }); return true; },
    };
    g.fetch = (url: string, init?: RequestInit): Promise<Response> => {
      const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (String(url).endsWith('/api/terminal/sessions') && init?.method === 'POST') {
        return json({ id: 'term-1', name: 'Shell', createdAt: '2026-10-02T00:00:00Z', cwd: CHAT.projectPath, command: 'zsh', type: 'shell' });
      }
      return json(null);
    };
  });
  afterEach(() => {
    life?.unmount();
    life = null;
    __resetTaskTabs();
    usePaneStore.setState(store, true);
  });

  test('the agent\'s focus on a task tab opens no board on a client that only has the task cached', async () => {
    applyRemoteTaskTabs(TASK, { tabs: [{ contextId: CTX, url: 'https://x.test/', title: 'X', seq: 0 }], activeContextId: CTX, nextSeq: 1 }, 1);
    life = mountLifecycle();
    life.emit({ type: 'browser:focus-pane', contextId: CTX });
    await settle();
    expect(events.filter((e) => e.type === 'topics:open-task' || e.type === 'topics:open-utility')).toEqual([]);
  });

  test('«Open in terminal» from a chat in its project window opens the shell there, beside that chat', async () => {
    life = mountLifecycle();
    await life.get().handlers.handleQuickCreateTerminal('shell', true, { cwdOf: CHAT.sessionKey, paste: 'ls' });
    expect(life.get().state.pendingProjectPane).toEqual({
      projectPath: CHAT.projectPath, type: 'terminal', terminalSessionId: 'term-1', nearPaneId: `chat:${CHAT.id}`,
    });
    // Not in the workspace: no group of the app-level store took the shell.
    const s = usePaneStore.getState();
    expect(Object.values(s.groups).some((gr) => gr.paneIds.includes('terminal:term-1'))).toBe(false);
  });
});

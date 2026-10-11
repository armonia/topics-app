/**
 * «Take me to this page» on the REAL stores: the task's tabs read on demand,
 * the agent's focus fenced to the client that shows the drawer, and the
 * marker's state following the project tab records. The order of the decision
 * is `focusBrowserContext.test.ts`; this file is about what the live wiring
 * reads before deciding, with only the network and the window faked.
 *
 * @covers CHAT-BROWSER-02, BROWSER-CHAT-05
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { focusBrowserContextLive, watchBrowserPlace } from './focusBrowserContext';
import { __resetTaskTabs, applyRemoteTaskTabs } from '../state/taskBrowserTabs';
import { __resetTaskSessions, applyTaskSessionIndex } from '../state/taskSessions';
import { __resetProjectSyncForTests } from '../state/pane/adapters/projectLayoutSync';
import { markChatSyncComplete, savePersistedTabState } from '../components/Layout/hooks/projectPersistence';

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const TASK = 'abcdef12-3456-7890-abcd-ef1234567890';
const CTX = 'task-abcdef12-napp';
const URL_ = 'http://localhost:5173/';
const TABS = { tabs: [{ contextId: CTX, url: URL_, title: 'App', seq: 0 }], activeContextId: CTX, nextSeq: 1 };

const g = globalThis as unknown as Record<string, unknown>;
const found = { window: g.window, fetch: g.fetch, localStorage: g.localStorage };
afterAll(() => {
  if (found.window === undefined) delete g.window;
  else g.window = found.window;
  g.fetch = found.fetch;
  // Like `window`: a key left behind as `undefined` still answers `in`, and a
  // later file that checks `'localStorage' in globalThis` before removing its
  // own fake keeps it (projectSidebarHeights.test.ts, 08/10/2026).
  if (found.localStorage === undefined) delete g.localStorage;
  else g.localStorage = found.localStorage;
});

let events: Array<{ type: string; detail: unknown }>;
let served: Map<string, unknown>;
let reads: string[];

beforeEach(() => {
  events = [];
  served = new Map();
  reads = [];
  // One storage, reached both ways, as in a page.
  g.localStorage = new MemStorage();
  g.window = {
    localStorage: g.localStorage,
    location: { origin: 'https://app.test', href: 'https://app.test/', pathname: '/', search: '', protocol: 'https:' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: { type: string; detail?: unknown }) => { events.push({ type: e.type, detail: e.detail }); return true; },
  };
  g.fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const key = decodeURIComponent(String(url).replace(/^.*\/api\/ui-state\//, ''));
    if ((init?.method ?? 'GET') === 'GET') reads.push(key);
    const value = served.get(key);
    const body = value === undefined ? 'null' : JSON.stringify({ value, server_seq: 1 });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
});
afterEach(() => {
  __resetTaskTabs();
  __resetTaskSessions();
  __resetProjectSyncForTests();
});

const taskOpens = () => events.filter((e) => e.type === 'topics:open-task');

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

describe('a task tab the drawer never loaded in this client', () => {
  beforeEach(() => {
    served.set(`task-browser-tabs:${TASK}`, TABS);
    applyTaskSessionIndex({ t1: { taskId: TASK, text: 'Task', status: 'review', dispatchState: null } });
  });

  test('the marker\'s click reads that task\'s tabs and opens its drawer on the tab, not a second sheet', async () => {
    const outcome = await focusBrowserContextLive({ contextId: CTX, topicId: 't1', url: URL_, reopen: true });
    expect(outcome).toBe('task');
    expect(reads.filter((k) => k === `task-browser-tabs:${TASK}`)).toHaveLength(1);
    expect(taskOpens().map((e) => e.detail)).toEqual([{ taskId: TASK, focusPaneId: `browser:${CTX}` }]);
  });

  test('the marker\'s state reads them too, and says «in a tab» instead of «closed»', async () => {
    const seen: Array<string | null> = [];
    const stop = watchBrowserPlace(CTX, 't1', (p) => seen.push(p));
    await until(() => seen.length > 0);
    stop();
    expect(seen.at(-1)).toBe('task');
  });
});

describe('the agent\'s browser_focus_tab, fanned out to every client', () => {
  beforeEach(() => { applyRemoteTaskTabs(TASK, TABS, 1); });

  test('a client that only has the task cached opens nothing', async () => {
    const outcome = await focusBrowserContextLive({ contextId: CTX, reopen: false, onlyWhereShown: true }, { layoutHandled: true });
    expect(outcome).toBe('none');
    expect(taskOpens()).toEqual([]);
    expect(events.filter((e) => e.type === 'topics:open-utility')).toEqual([]);
  });

  test('the client whose drawer shows the task brings the tab in front', async () => {
    const location = (g.window as { location: { pathname: string } }).location;
    location.pathname = `/task/${TASK}`;
    const outcome = await focusBrowserContextLive({ contextId: CTX, reopen: false, onlyWhereShown: true }, { layoutHandled: true });
    expect(outcome).toBe('task');
    expect(taskOpens().map((e) => e.detail)).toEqual([{ taskId: TASK, focusPaneId: `browser:${CTX}` }]);
  });
});

describe('the marker\'s state follows a project window', () => {
  // Through the save the project window really makes: it writes the record
  // locally first and only then hands it to the synced save, so the notice
  // has to come from the local write or it never comes.
  async function openedThere(projectPath: string, pageId: string, chatSynced: boolean): Promise<Array<string | null>> {
    const seen: Array<string | null> = [];
    const stop = watchBrowserPlace(pageId, '', (p) => seen.push(p));
    await until(() => seen.length > 0);
    expect(seen.at(-1)).toBeNull();
    if (chatSynced) markChatSyncComplete(projectPath);
    savePersistedTabState(projectPath, { nonChatPanes: [{ id: `browser:${pageId}`, type: 'browser', title: 'App' }], openChatTopicIds: [] } as never);
    stop();
    return seen;
  }

  test('a tab opened in a project\'s layout turns «closed» into «in a tab» with nothing else ticking', async () => {
    expect((await openedThere('/p', 'page-1', true)).at(-1)).toBe('layout');
  });

  test('the same holds before the project\'s chats have synced, when only the local record is written', async () => {
    expect((await openedThere('/q', 'page-2', false)).at(-1)).toBe('layout');
  });
});

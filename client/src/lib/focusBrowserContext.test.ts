/**
 * «Take me to this page»: layout, then task, then the topic's window, and only
 * the chat marker may bring a closed page back.
 *
 * @covers CHAT-BROWSER-02, BROWSER-CHAT-05
 */
import { describe, expect, test } from 'bun:test';
import { focusBrowserContext, locateBrowserContext, type BrowserFocusDeps } from './focusBrowserContext';

interface World {
  layout?: string[];
  tasks?: Record<string, string[]>;
  windows?: Record<string, string[]>;
  /** False = the chat has no window door (narrow, or inside a project window). */
  door?: boolean;
  /** Tasks whose drawer, and topics whose window, THIS client has on screen. */
  shownTasks?: string[];
  shownWindows?: string[];
}

function harness(world: World) {
  const calls: string[] = [];
  const deps: BrowserFocusDeps = {
    inLayout: (ctx) => (world.layout ?? []).includes(ctx),
    taskOwning: (ctx) => Object.keys(world.tasks ?? {}).find((t) => world.tasks![t].includes(ctx)) ?? null,
    windowHolding: (ctx, prefer) => {
      const windows = world.windows ?? {};
      if (prefer && windows[prefer]?.includes(ctx)) return prefer;
      return Object.keys(windows).find((t) => windows[t].includes(ctx)) ?? null;
    },
    taskShown: (taskId) => (world.shownTasks ?? []).includes(taskId),
    windowShown: (topicId) => (world.shownWindows ?? []).includes(topicId),
    focusLayoutTab: (ctx) => calls.push(`layout:${ctx}`),
    openTask: (taskId, ctx) => calls.push(`task:${taskId}:${ctx}`),
    wakeSheet: (topicId, ctx) => calls.push(`wake:${topicId}:${ctx}`),
    reopenInWindow: (topicId, ctx, url) => {
      if (world.door === false) return false;
      calls.push(`reopen:${topicId}:${ctx}:${url}`);
      return true;
    },
    openAsTab: (url) => calls.push(`link:${url}`),
  };
  return { deps, calls };
}

describe('locateBrowserContext', () => {
  test('layout wins over task wins over window', () => {
    const everywhere = harness({ layout: ['c'], tasks: { T: ['c'] }, windows: { t1: ['c'] } });
    expect(locateBrowserContext('c', 't1', everywhere.deps)).toEqual({ kind: 'layout' });
    const taskAndWindow = harness({ tasks: { T: ['c'] }, windows: { t1: ['c'] } });
    expect(locateBrowserContext('c', 't1', taskAndWindow.deps)).toEqual({ kind: 'task', taskId: 'T' });
    expect(locateBrowserContext('c', 't1', harness({ windows: { t1: ['c'] } }).deps)).toEqual({ kind: 'window', topicId: 't1' });
    expect(locateBrowserContext('c', 't1', harness({}).deps)).toBeNull();
  });
});

describe('focusBrowserContext', () => {
  test('a tab of the layout takes the focus and the window is not touched', () => {
    const h = harness({ layout: ['c'], windows: { t1: ['other'] } });
    expect(focusBrowserContext({ contextId: 'c', topicId: 't1', url: 'https://x/', reopen: true }, h.deps)).toBe('layout');
    expect(h.calls).toEqual(['layout:c']);
  });

  test('a task tab opens its task', () => {
    const h = harness({ tasks: { 'task-full-id': ['task-12345678-napp'] } });
    expect(focusBrowserContext({ contextId: 'task-12345678-napp', topicId: 't1', reopen: true }, h.deps)).toBe('task');
    expect(h.calls).toEqual(['task:task-full-id:task-12345678-napp']);
  });

  test('a sheet of the window wakes it on that sheet, even from another topic', () => {
    const h = harness({ windows: { t2: ['c'] } });
    expect(focusBrowserContext({ contextId: 'c', reopen: false }, h.deps)).toBe('window');
    expect(h.calls).toEqual(['wake:t2:c']);
  });

  test('a closed page is reopened in THIS chat\'s window on the same context, at the marker\'s URL', () => {
    const h = harness({});
    expect(focusBrowserContext({ contextId: 'c', topicId: 't1', url: 'https://x/c', reopen: true }, h.deps)).toBe('reopened');
    expect(h.calls).toEqual(['reopen:t1:c:https://x/c']);
  });

  test('no window possible: it opens as a tab, like a link', () => {
    const h = harness({ door: false });
    expect(focusBrowserContext({ contextId: 'c', topicId: 't1', url: 'https://x/c', reopen: true }, h.deps)).toBe('tab');
    expect(h.calls).toEqual(['link:https://x/c']);
  });

  test('an old row without a context uses the topic\'s own', () => {
    const h = harness({ windows: { t1: ['t1'] } });
    expect(focusBrowserContext({ topicId: 't1', url: 'https://x/', reopen: true }, h.deps)).toBe('window');
    expect(h.calls).toEqual(['wake:t1:t1']);
  });

  test('the agent\'s browser_focus_tab never brings a closed page back', () => {
    const h = harness({});
    expect(focusBrowserContext({ contextId: 'c', topicId: 't1', url: 'https://x/', reopen: false }, h.deps)).toBe('none');
    expect(h.calls).toEqual([]);
  });
});

// The agent's focus reaches every connected client. A client that merely has
// the task's tabs cached (a phone that once opened the drawer) used to open the
// board and the drawer too.
describe('the agent\'s focus, fanned out to every client', () => {
  const agent = { contextId: 'task-12345678-napp', reopen: false, onlyWhereShown: true } as const;

  test('a task tab moves only where its drawer is on screen', () => {
    const elsewhere = harness({ tasks: { T: ['task-12345678-napp'] } });
    expect(focusBrowserContext(agent, elsewhere.deps)).toBe('none');
    expect(elsewhere.calls).toEqual([]);
    const here = harness({ tasks: { T: ['task-12345678-napp'] }, shownTasks: ['T'] });
    expect(focusBrowserContext(agent, here.deps)).toBe('task');
    expect(here.calls).toEqual(['task:T:task-12345678-napp']);
  });

  test('a sheet wakes only where its topic\'s window is drawn', () => {
    const elsewhere = harness({ windows: { t2: ['c'] } });
    expect(focusBrowserContext({ contextId: 'c', reopen: false, onlyWhereShown: true }, elsewhere.deps)).toBe('none');
    expect(elsewhere.calls).toEqual([]);
    const here = harness({ windows: { t2: ['c'] }, shownWindows: ['t2'] });
    expect(focusBrowserContext({ contextId: 'c', reopen: false, onlyWhereShown: true }, here.deps)).toBe('window');
    expect(here.calls).toEqual(['wake:t2:c']);
  });

  test('the chat marker is not fenced: a click opens the drawer wherever it is', () => {
    const h = harness({ tasks: { T: ['task-12345678-napp'] } });
    expect(focusBrowserContext({ contextId: 'task-12345678-napp', topicId: 't1', reopen: true }, h.deps)).toBe('task');
  });
});

/**
 * «TAKE ME TO THIS PAGE», WHEREVER IT LIVES (CHAT-BROWSER-02, BROWSER-CHAT-05).
 *
 * A browser context lives in one of three places: a pane of the layout (the
 * workspace or a project window, where a sheet lent by a topic's window also
 * goes), a tab in a task's drawer, or a sheet of a topic's window. Before this
 * module the answer was spread over `tabLink.openBrowserTab` and the
 * `browser:focus-pane` handler, and neither knew about the window: a page
 * living there read as dead, and the agent's `browser_focus_tab` did nothing.
 *
 * One resolver, first answer wins: layout, task, window. Then, only for the
 * chat marker (`reopen`), a page that lives nowhere is brought back in the
 * window of the chat being looked at, on the same context; a chat that cannot
 * hold a window opens it as a tab, like a link. The agent's focus never
 * reopens: focusing a closed page must not make one appear.
 *
 * The decision is pure over injected surfaces and effects, so the order is
 * tested without a DOM; `focusBrowserContextLive` wires the real stores.
 */
import { openTabInApp, browserPaneInLayout } from './tabLink';
import { openTaskInApp } from './openTaskLink';
import { openInTopicWindow } from './topicWindowDoor';
import { openLink } from './openLink';
import { findTaskOwningTab } from '../state/taskBrowserTabs';
import { loadTopicWindowStore, type TopicWindowStore } from '../components/Browser/topicBrowserWindowLazy';

/** Where a context lives, asked of each surface. */
export interface BrowserSurfaces {
  inLayout(contextId: string): boolean;
  /** The task whose drawer holds it as a tab. */
  taskOwning(contextId: string): string | null;
  /** The topic whose window holds it as a sheet, `preferTopicId` asked first. */
  windowHolding(contextId: string, preferTopicId?: string): string | null;
}

export interface BrowserFocusEffects {
  focusLayoutTab(contextId: string): void;
  openTask(taskId: string): void;
  /** Activate the sheet and wake the window (hidden comes back minimised). */
  wakeSheet(topicId: string, contextId: string): void;
  /** False when that chat has no window to open it in. */
  reopenInWindow(topicId: string, contextId: string, url: string): boolean;
  openAsTab(url: string): void;
}

export type BrowserFocusDeps = BrowserSurfaces & BrowserFocusEffects;

export type BrowserPlace =
  | { kind: 'layout' }
  | { kind: 'task'; taskId: string }
  | { kind: 'window'; topicId: string };

export type BrowserFocusOutcome = 'layout' | 'task' | 'window' | 'reopened' | 'tab' | 'none';

export interface BrowserFocusRequest {
  /** Absent on rows older than BROWSER-CHAT-05: the topic's own context then. */
  contextId?: string;
  /** The topic of the chat the request comes from, when there is one. */
  topicId?: string;
  /** Where to reopen a page that lives nowhere. */
  url?: string;
  reopen: boolean;
}

export function locateBrowserContext(contextId: string, topicId: string | undefined, surfaces: BrowserSurfaces): BrowserPlace | null {
  if (!contextId) return null;
  if (surfaces.inLayout(contextId)) return { kind: 'layout' };
  const taskId = surfaces.taskOwning(contextId);
  if (taskId) return { kind: 'task', taskId };
  const owner = surfaces.windowHolding(contextId, topicId);
  return owner ? { kind: 'window', topicId: owner } : null;
}

export function focusBrowserContext(req: BrowserFocusRequest, deps: BrowserFocusDeps): BrowserFocusOutcome {
  const contextId = req.contextId || req.topicId || '';
  const place = locateBrowserContext(contextId, req.topicId, deps);
  if (place?.kind === 'layout') { deps.focusLayoutTab(contextId); return 'layout'; }
  if (place?.kind === 'task') { deps.openTask(place.taskId); return 'task'; }
  if (place?.kind === 'window') { deps.wakeSheet(place.topicId, contextId); return 'window'; }
  if (!req.reopen || !req.url) return 'none';
  if (req.topicId && contextId && deps.reopenInWindow(req.topicId, contextId, req.url)) return 'reopened';
  deps.openAsTab(req.url);
  return 'tab';
}

/** The real surfaces. `store` is the lazy window store, once it has loaded. */
export function liveBrowserSurfaces(store: TopicWindowStore | null): BrowserSurfaces {
  return {
    // A sheet lent to the layout is a tab even before its pane is persisted.
    inLayout: (contextId) => browserPaneInLayout(contextId) || !!store?.findTopicOwningPromoted(contextId),
    taskOwning: findTaskOwningTab,
    windowHolding: (contextId, preferTopicId) => store?.findTopicHoldingSheet(contextId, preferTopicId) ?? null,
  };
}

/**
 * Resolve and act on the real stores. `layoutHandled` is for the
 * `browser:focus-pane` handler, which has already surfaced a layout pane in its
 * own way: from there only the task and the window are left to try.
 */
export async function focusBrowserContextLive(
  req: BrowserFocusRequest,
  opts: { layoutHandled?: boolean } = {},
): Promise<BrowserFocusOutcome> {
  const store = await loadTopicWindowStore();
  if (req.topicId) await store.ensureTopicWindowLoaded(req.topicId);
  const surfaces = liveBrowserSurfaces(store);
  return focusBrowserContext(req, {
    ...surfaces,
    inLayout: opts.layoutHandled ? () => false : surfaces.inLayout,
    focusLayoutTab: (contextId) => openTabInApp({ kind: 'browser', key: contextId }),
    openTask: (taskId) => openTaskInApp({ taskId }),
    wakeSheet: (topicId, contextId) => store.topicBrowserWindow.open(topicId, { contextId }),
    reopenInWindow: (topicId, contextId, url) => openInTopicWindow(topicId, { contextId, url, openedBy: 'user' }),
    openAsTab: (url) => openLink(url),
  });
}

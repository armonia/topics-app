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
 * reopens: focusing a closed page must not make one appear. And it reaches
 * every client, so a task tab or a sheet moves only where its drawer or window
 * is already on screen: another device is never yanked to the board.
 *
 * The decision is pure over injected surfaces and effects, so the order is
 * tested without a DOM; `focusBrowserContextLive` wires the real stores.
 */
import { openTabInApp, browserPaneInLayout } from './tabLink';
import { currentTaskTarget, openTaskInApp } from './openTaskLink';
import { openInTopicWindow, topicWindowOnScreen } from './topicWindowDoor';
import { openLink } from './openLink';
import { ensureTaskTabsLoaded, findTaskOwningTab, isTaskContextId, subscribeTaskTabs } from '../state/taskBrowserTabs';
import { getTopicTask, subscribeTopicTask } from '../state/taskSessions';
import { usePaneStore } from '../state/pane/store';
import { createPaneId } from '../state/pane/adapters/paneConfig';
import { subscribeProjectPanes } from '../state/pane/adapters/projectLayoutSync';
import { loadTopicWindowStore, type TopicWindowStore } from '../components/Browser/topicBrowserWindowLazy';

/** Where a context lives, asked of each surface. */
export interface BrowserSurfaces {
  inLayout(contextId: string): boolean;
  /** The task whose drawer holds it as a tab. */
  taskOwning(contextId: string): string | null;
  /** The topic whose window holds it as a sheet, `preferTopicId` asked first. */
  windowHolding(contextId: string, preferTopicId?: string): string | null;
}

/** Whether THIS client already shows a surface, for a focus fanned out to all. */
export interface BrowserShownHere {
  /** The task's drawer is on screen here. */
  taskShown(taskId: string): boolean;
  /** The topic's window is drawn here. */
  windowShown(topicId: string): boolean;
}

export interface BrowserFocusEffects {
  focusLayoutTab(contextId: string): void;
  /** Open the task's drawer with that tab in front. */
  openTask(taskId: string, contextId: string): void;
  /** Activate the sheet and wake the window (hidden comes back minimised). */
  wakeSheet(topicId: string, contextId: string): void;
  /** False when that chat has no window to open it in. */
  reopenInWindow(topicId: string, contextId: string, url: string): boolean;
  openAsTab(url: string): void;
}

export type BrowserFocusDeps = BrowserSurfaces & BrowserShownHere & BrowserFocusEffects;

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
  /**
   * The agent's `browser_focus_tab`, broadcast to every client: a task tab or a
   * sheet is brought forward only where its drawer or window is already on
   * screen. Elsewhere (another device, a phone) nothing opens.
   */
  onlyWhereShown?: boolean;
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
  if (place?.kind === 'task') {
    if (req.onlyWhereShown && !deps.taskShown(place.taskId)) return 'none';
    deps.openTask(place.taskId, contextId);
    return 'task';
  }
  if (place?.kind === 'window') {
    if (req.onlyWhereShown && !deps.windowShown(place.topicId)) return 'none';
    deps.wakeSheet(place.topicId, contextId);
    return 'window';
  }
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
 * A task's tabs are read lazily, when its drawer opens. A chat marker of a task
 * tab asks before any drawer did: read that task's tabs first (one fetch), or
 * the page reads as closed and the click reopens it in the topic's window.
 * The task is the chat's own; the contextId names the first 8 chars of its id.
 */
export function ensureTaskTabsFor(contextId: string, topicId: string | undefined): Promise<void> {
  if (!topicId || !isTaskContextId(contextId)) return Promise.resolve();
  const taskId = getTopicTask(topicId)?.taskId;
  if (!taskId || !contextId.startsWith(`task-${taskId.slice(0, 8)}-`)) return Promise.resolve();
  return ensureTaskTabsLoaded(taskId);
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
  // A focus that acts only where the drawer is on screen finds its tabs loaded
  // by that drawer: no read on every other client.
  if (!req.onlyWhereShown) await ensureTaskTabsFor(req.contextId || req.topicId || '', req.topicId);
  const surfaces = liveBrowserSurfaces(store);
  return focusBrowserContext(req, {
    ...surfaces,
    inLayout: opts.layoutHandled ? () => false : surfaces.inLayout,
    // The URL mirrors the global board's drawer only while it is on screen.
    taskShown: (taskId) => currentTaskTarget()?.taskId === taskId,
    windowShown: topicWindowOnScreen,
    focusLayoutTab: (contextId) => openTabInApp({ kind: 'browser', key: contextId }),
    openTask: (taskId, contextId) => openTaskInApp({ taskId }, createPaneId('browser', contextId)),
    wakeSheet: (topicId, contextId) => store.topicBrowserWindow.open(topicId, { contextId }),
    reopenInWindow: (topicId, contextId, url) => openInTopicWindow(topicId, { contextId, url, openedBy: 'user' }),
    openAsTab: (url) => openLink(url),
  });
}

/**
 * Where a context lives now, told to `onPlace` at once and on every change of a
 * surface that can hold it: the workspace, the project tab records, the task
 * tabs (read on demand for the chat's own task), the topic windows. Nothing is
 * told before the window store has answered: «closed» for that instant would
 * flash a false state on every load. Returns the unsubscribe.
 */
export function watchBrowserPlace(
  contextId: string,
  topicId: string,
  onPlace: (place: BrowserPlace['kind'] | null) => void,
): () => void {
  let alive = true;
  let store: TopicWindowStore | null = null;
  const read = (): void => {
    if (alive && store) onPlace(locateBrowserContext(contextId, topicId, liveBrowserSurfaces(store))?.kind ?? null);
  };
  // The chat's task can be learnt after the marker mounts (the board feed).
  const loadTask = (): void => { void ensureTaskTabsFor(contextId, topicId); };
  const stops = [usePaneStore.subscribe(read), subscribeProjectPanes(read), subscribeTaskTabs(read)];
  if (topicId) stops.push(subscribeTopicTask(topicId, loadTask));
  void loadTopicWindowStore().then(async (s) => {
    if (topicId) await s.ensureTopicWindowLoaded(topicId);
    await ensureTaskTabsFor(contextId, topicId);
    if (!alive) return;
    store = s;
    stops.push(s.subscribeTopicWindows(read));
    read();
  });
  return () => {
    alive = false;
    for (const stop of stops) stop();
  };
}

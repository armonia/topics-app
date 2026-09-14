/**
 * THE BROWSER PANES OF A PROJECT WINDOW, PUBLISHED FOR THE TOPIC'S WINDOW.
 *
 * A project window does not keep its panes in `usePaneStore`: they are React
 * state inside `useProjectLayout`, persisted per project. So the topic's
 * browser window, which reads the pane store, is blind to them. Two things
 * break because of that blindness, and both are the SAME invariant seen from
 * two sides:
 *
 *  - the "+" menu would list nothing inside a project, although the project
 *    window is exactly where the pages of that project are open;
 *  - a sheet promoted from a project topic becomes a PROJECT pane, and the
 *    return path (`RECLAIM_PANE` on the pane store) would not remove it, so
 *    the same contextId would be drawn twice: two `RemoteBrowserPanel` on one
 *    page, which is the one thing the design forbids.
 *
 * So the project window PUBLISHES what it has open plus the way to take it
 * back, and this module is the only meeting point. It is a registry, not a
 * store: the truth stays in the project layout, this is the window it opens
 * onto it. `registerProjectWindow` next door does the same for mounting.
 */

export interface ProjectBrowserPaneEntry {
  contextId: string;
  url: string;
  title: string;
}

interface Published {
  entries: ProjectBrowserPaneEntry[];
  /** Close that pane in the project layout. The page itself is NOT destroyed:
   *  the caller is about to draw it somewhere else. */
  reclaim: (contextId: string) => void;
}

/**
 * The empty answer, as ONE frozen array.
 *
 * `useSyncExternalStore` compares snapshots by identity: a fresh `[]` per call
 * is a new snapshot every time and re-renders forever.
 */
export const NO_PROJECT_BROWSER_PANES: readonly ProjectBrowserPaneEntry[] = Object.freeze([]);

const published = new Map<string, Published>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Publish the browser panes of `projectPath`, and how to take one back.
 *
 * Returns the un-publish, for the effect that called it. Publishing the same
 * list again is cheap but NOT free: it notifies, so call it from an effect
 * that depends on the panes, not on every render.
 */
export function publishProjectBrowserPanes(
  projectPath: string,
  entries: ProjectBrowserPaneEntry[],
  reclaim: (contextId: string) => void,
): () => void {
  if (!projectPath) return () => {};
  published.set(projectPath, { entries, reclaim });
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only drop the entry if it is still ours: a remount publishes before the
    // previous effect cleans up, and clearing then would blank a live window.
    if (published.get(projectPath)?.reclaim === reclaim) {
      published.delete(projectPath);
      notify();
    }
  };
}

/** What `projectPath` has open right now. Empty for a project with no window. */
export function listProjectBrowserPanes(projectPath: string): readonly ProjectBrowserPaneEntry[] {
  return published.get(projectPath)?.entries ?? NO_PROJECT_BROWSER_PANES;
}

/**
 * Is this page open as a pane of SOME project window?
 *
 * Asked by the topic window before it decides a promoted id is gone: a page
 * that lives in a project layout is not in the pane store, and treating it as
 * closed would draw it a second time inside the window.
 */
export function isProjectBrowserPaneOpen(contextId: string): boolean {
  for (const { entries } of published.values()) {
    if (entries.some((e) => e.contextId === contextId)) return true;
  }
  return false;
}

/**
 * Take a page out of whichever project window holds it.
 *
 * True when somebody held it, which is also the caller's signal that it does
 * not need to touch the pane store for this id.
 */
export function reclaimProjectBrowserPane(contextId: string): boolean {
  for (const { entries, reclaim } of published.values()) {
    if (entries.some((e) => e.contextId === contextId)) {
      reclaim(contextId);
      return true;
    }
  }
  return false;
}

/** Ask to be told when any project window publishes a different list. */
export function subscribeProjectBrowserPanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}


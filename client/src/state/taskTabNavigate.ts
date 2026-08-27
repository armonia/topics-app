/**
 * taskTabNavigate — the pending "go to this URL" for a task browser tab that is
 * ALREADY on screen.
 *
 * The server announces an agent's `open_browser_pane` with
 * `browser:open-task-tab`, and the client upserts the record into
 * `taskBrowserTabs`. That record feeds the panel as `initialUrl`, which the
 * panel reads ONCE, at mount: a tab opened a minute ago and still mounted stayed
 * on its old page while the record (and the board) claimed the new URL. The two
 * other surfaces (project window, standalone chat) never had the problem because
 * they push the URL through `RemoteBrowserPanel.navigateUrl`; the task branch was
 * the one that did not.
 *
 * So this is that same channel for task tabs: a transient contextId -> url map,
 * NOT persisted (a navigation request is an event, not tab state; ui-state holds
 * the tab's URL already). It is filled only for a tab that already exists — a
 * brand-new tab mounts on `initialUrl` and needs nothing — and emptied as soon
 * as the panel reports it consumed the request.
 */
import { useSyncExternalStore } from 'react';

export type TaskTabNavigateMap = Readonly<Record<string, string>>;

const EMPTY: TaskTabNavigateMap = Object.freeze({});

let pending: TaskTabNavigateMap = EMPTY;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Ask the (mounted) pane bound to `contextId` to navigate. Last request wins:
 *  open-pane announces a second time when the navigation redirected, and the
 *  landing URL is the one the tab must end up on. A request for the URL already
 *  queued is a no-op (the panel has not consumed it yet, it will). */
export function requestTaskTabNavigate(contextId: string, url: string): void {
  if (!contextId || !url) return;
  if (pending[contextId] === url) return;
  pending = Object.freeze({ ...pending, [contextId]: url });
  notify();
}

/** The panel consumed the request (or the tab went away). */
export function clearTaskTabNavigate(contextId: string): void {
  if (!(contextId in pending)) return;
  const { [contextId]: _drop, ...rest } = pending;
  pending = Object.freeze(rest);
  notify();
}

/** Test seam: drop every pending request. */
export function __resetTaskTabNavigate(): void {
  pending = EMPTY;
  notify();
}

export function getTaskTabNavigates(): TaskTabNavigateMap {
  return pending;
}

export function subscribeTaskTabNavigate(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React view of the pending navigations, for the task browser group layout. */
export function useTaskTabNavigate(): TaskTabNavigateMap {
  return useSyncExternalStore(subscribeTaskTabNavigate, getTaskTabNavigates, () => EMPTY);
}

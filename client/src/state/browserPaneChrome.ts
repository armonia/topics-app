/**
 * THE BROWSER CHROME, PUBLISHED BY THE PANE AND CONSUMED BY ITS TAB.
 *
 * A browser pane owns everything a browser chrome shows: the live URL, the
 * favicon Chromium/WebKit emitted, whether it is loading, whether back and
 * forward are possible, how many console errors piled up, and the handful of
 * commands (reload, back, devtools, zoom, forget-site, ...). All of it lives
 * inside `RemoteBrowserPanel`, which is mounted somewhere below the pane grid.
 *
 * The TAB is drawn by `PaneTabBar`, in a different subtree entirely. Passing
 * that state up through the layout would mean threading a dozen props through
 * every group component, and re-rendering the whole tab bar on every favicon
 * that lands. So the pane PUBLISHES here, keyed by pane id, and only the one
 * small component that draws that tab subscribes.
 *
 * Two properties this registry has to have, and they are the reason it is a
 * hand-written store instead of a context:
 *
 *  1. PER-PANE SUBSCRIPTION. Ten open tabs must not re-render because the
 *     eleventh finished loading. Listeners are kept in a per-pane set.
 *  2. SURVIVES THE TAB. A pane can be mounted while its tab bar is not (a
 *     detached window, a task drawer), and the reverse: a tab can render for
 *     a pane whose panel has not mounted yet. Both directions are a plain
 *     "no entry yet", never a crash: the tab falls back to the persisted URL.
 */
import { useSyncExternalStore } from 'react';
import type { DeviceMode } from '../components/Browser/browserDevTypes';

/** What a browser pane can be asked to do from its tab. Every command is
 *  optional: the shared (server-streamed) pane has no DevTools, the web build
 *  has no share toggle, and a pane sitting on `about:blank` has no site to
 *  forget. An absent command means "do not offer it", not "no-op". */
export interface BrowserPaneCommands {
  reload?: () => void;
  back?: () => void;
  forward?: () => void;
  /** Bring the address bar back and put the caret in it (Cmd+L by another name). */
  editAddress?: () => void;
  openExternal?: () => void;
  /** Focus the chat this browser was opened from (when there is one). */
  backToSpawner?: () => void;
  toggleDevTools?: () => void;
  /** Reveal the chrome row with the console panel already open. */
  openConsole?: () => void;
  clearConsole?: () => void;
  /** Reveal the chrome row with the downloads list already open. */
  openDownloads?: () => void;
  setZoom?: (delta: number | 'reset') => void;
  setDevice?: (mode: DeviceMode) => void;
  toggleShare?: () => void;
  forgetSite?: () => void;
}

/** The snapshot a tab reads. Plain data plus the command table. */
export interface BrowserPaneChrome {
  url: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Console tallies for this pane. Zero when the pane has no console at all. */
  consoleErrors: number;
  consoleWarnings: number;
  downloads: number;
  zoom: number;
  deviceMode: DeviceMode;
  /** True while the pane renders the shared (server) session instead of native. */
  shared: boolean;
  commands: BrowserPaneCommands;
}

const registry = new Map<string, BrowserPaneChrome>();
const listeners = new Map<string, Set<() => void>>();

function emit(paneId: string): void {
  const set = listeners.get(paneId);
  if (!set) return;
  for (const fn of set) fn();
}

/**
 * Publish (or replace) a pane's chrome snapshot.
 *
 * The caller passes a NEW object whenever anything changed: the identity of the
 * snapshot IS the change signal, because `useSyncExternalStore` compares
 * snapshots by reference. Publishing an equal-but-fresh object every render
 * would loop, which is why the panel builds it in a `useMemo` over the values
 * it actually depends on.
 */
export function publishBrowserPaneChrome(paneId: string, chrome: BrowserPaneChrome): void {
  if (registry.get(paneId) === chrome) return;
  registry.set(paneId, chrome);
  emit(paneId);
}

/** Drop a pane's entry (its panel unmounted). Idempotent. */
export function retireBrowserPaneChrome(paneId: string): void {
  if (!registry.delete(paneId)) return;
  emit(paneId);
}

/** Read a pane's chrome without subscribing (menus, keyboard shortcuts). */
export function getBrowserPaneChrome(paneId: string): BrowserPaneChrome | undefined {
  return registry.get(paneId);
}

function subscribe(paneId: string, fn: () => void): () => void {
  let set = listeners.get(paneId);
  if (!set) { set = new Set(); listeners.set(paneId, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(paneId);
  };
}

/**
 * Subscribe one tab to one pane. Returns undefined while the panel has not
 * published yet, which is a normal state and not an error: a tab restored from
 * disk exists before its panel mounts.
 */
export function useBrowserPaneChrome(paneId: string | undefined): BrowserPaneChrome | undefined {
  return useSyncExternalStore(
    (fn) => (paneId ? subscribe(paneId, fn) : () => {}),
    () => (paneId ? registry.get(paneId) : undefined),
    () => undefined,
  );
}

/** Test hook: forget every pane. */
export function __resetBrowserPaneChrome(): void {
  registry.clear();
  listeners.clear();
}

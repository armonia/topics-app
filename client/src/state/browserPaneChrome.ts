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
import type { BrowserConsoleEntry, DeviceMode } from '../components/Browser/browserDevTypes';
import type { DownloadsMenuProps } from '../components/Browser/DownloadsMenu';
import type { ShareMode } from '../lib/sharedAuto';

/** What a browser pane can be asked to do from its tab. Every command is
 *  optional: the shared (server-streamed) pane has no DevTools, the web build
 *  has no share toggle, and a pane sitting on `about:blank` has no site to
 *  forget. An absent command means "do not offer it", not "no-op". */
export interface BrowserPaneCommands {
  reload?: () => void;
  back?: () => void;
  forward?: () => void;
  /** Ask the TAB to open its sheet, address field focused (Cmd+L by another name). */
  editAddress?: () => void;
  /** Go to an address typed in the tab's sheet. */
  navigate?: (url: string) => void;
  openExternal?: () => void;
  /** Focus the chat this browser was opened from (when there is one). */
  backToSpawner?: () => void;
  toggleDevTools?: () => void;
  clearConsole?: () => void;
  /** Ask the TAB to open its sheet with the Downloads section already down.
   *  The downloads cue in the tab's quiet rail is the only caller: a download
   *  announces itself there and opens nothing until you click it. */
  openDownloads?: () => void;
  setZoom?: (delta: number | 'reset') => void;
  /** `custom` carries its own box: it is the one mode that is not a preset, and
   *  without those two numbers it would mean nothing. */
  setDevice?: (mode: DeviceMode, custom?: { width: number; height: number }) => void;
  toggleShare?: () => void;
  /** Move this pane between the server's bundled Playwright engine and the
   *  real Chromium installed on the machine (with its extensions). Present only
   *  when the server advertises the capability, i.e. the switch exists. */
  setEngine?: (engine: 'native' | 'chromium') => void;
  /** DOM reconstruction (rrweb, this device's own engine) ↔ the pixel stream.
   *  Streaming pane only: the native and iframe panes ARE the page. */
  setRenderMode?: (mode: 'dom' | 'video') => void;
  forgetSite?: () => void;
  /**
   * Park the page behind a pixel still while the sheet covers it, and bring it
   * back when the sheet closes.
   *
   * The occlusion watcher already does this by measurement, and that path is
   * untouched: these two exist because the sheet KNOWS it is covering the page
   * from the instant it mounts, while the watcher only knows once the panel has
   * been laid out and measured. Absent on the panes whose page is already a
   * picture (streaming, iframe), where there is nothing to freeze.
   */
  freeze?: () => void;
  thaw?: () => void;
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
  /** The user's session CHOICE, which is not the same thing as `shared` (the
   *  effective render): 'auto' is native alone and shared the moment another
   *  device looks at the same context. Absent on the web, where there is only
   *  the shared session and nothing to choose. */
  shareMode?: ShareMode;
  /**
   * WHAT THIS PANE *IS*, for the one icon the tab draws between favicon and
   * title (`BrowserTabTypeIcon`) and for the switches in the sheet's Session
   * section. Until 2026-09-14 these three lived as pills PARKED OVER THE PAGE —
   * a connection dot top-right, an engine pill top-left, a render pill
   * bottom-left — which is what `TOPIC-BROWSER-03` forbids: no permanent DOM
   * above a browser pane's page.
   *
   * All three are OPTIONAL, and absence is a real answer rather than a default:
   *
   *  - `connection` is absent on every path that has no streaming socket at all
   *    (native Tauri pane, hosted iframe). The tab reads absent as connected,
   *    because a pane with no socket cannot have lost one.
   *  - `engine` and `engineExtensions` exist only when the server advertises the
   *    capability (`browser.engineToggleAvailable`): without a real Chromium on
   *    the machine there is no choice to offer, and an engine label nobody can
   *    change is decoration.
   *  - `renderMode` is absent wherever there is nothing to switch.
   */
  connection?: 'connected' | 'connecting' | 'fallback-http' | 'disconnected';
  engine?: 'native' | 'chromium';
  engineExtensions?: number;
  renderMode?: 'dom' | 'video';
  /**
   * What the sheet shows and the tab does not: the pane's own address list,
   * the console rows behind the tally, and the downloads with their actions.
   *
   * They live here for the same reason the tally does: the pane owns them, and
   * the sheet is drawn in another subtree entirely. They are optional because
   * the three render paths hold different things - the shared pane has no
   * console of its own, the iframe pane has no downloads queue of its own.
   */
  history: string[];
  consoleEntries?: BrowserConsoleEntry[];
  downloadsMenu?: DownloadsMenuProps;
  /** Monotonic count of downloads that have STARTED on this pane. It drives the
   *  appearing and the one-shot pulse of the tab's downloads cue, and nothing
   *  else: a file that arrives never opens a surface by itself. */
  downloadsStarted: number;
  /** Grows every time the sheet is asked for WITH THE CARET: Cmd+L, a click on
   *  the tab you are already in, the three dots, a blank pane that wants an
   *  address. The tab compares it with the last value it acted on. */
  addressEditRequest: number;
  /** Grows every time something asks for the sheet OPENED ON ITS DOWNLOADS
   *  (today: the tab's downloads cue). Separate from `addressEditRequest`
   *  because that one selects the address, and a file you clicked to look at
   *  must not put the caret somewhere you then have to undo. */
  downloadsOpenRequest: number;
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

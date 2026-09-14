/**
 * THE PANE SIDE OF "THE TAB IS THE CHROME".
 *
 * The pane publishes its live chrome (address, favicon, loading, history reach,
 * console tally and rows, downloads, zoom, device, session) plus the commands
 * that go with it, into `state/browserPaneChrome`. The tab reads it from there
 * and draws it in its SHEET (`BrowserTabSheet`). See that module for why it is
 * a registry and not a prop.
 *
 * WHAT THIS HOOK DECIDES IS ONLY *WHEN THE SHEET OPENS*, and both reasons are a
 * request someone made:
 *
 *   - the caret is asked for (Cmd+L, a click on the tab you are already in, a
 *     blank pane that has nowhere to go): `addressEditRequest`;
 *   - the downloads cue in the tab is CLICKED: `downloadsOpenRequest`.
 *
 * NOTHING OPENS IT BY ITSELF, a started download least of all: the sheet covers
 * the page and freezes it, so an arrival would interrupt a reading nobody asked
 * to interrupt. `downloadsStarted` travels to the tab's quiet rail and lights a
 * cue there; the opening waits for the click.
 *
 * There is no third surface left to reveal. Until 2026-09-13 there was: a 40px
 * `BrowserToolbar` above the page, shown on demand and brought back by a
 * download. It is gone, and with it the whole `revealed`/`showChrome` axis.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { publishBrowserPaneChrome, retireBrowserPaneChrome, type BrowserPaneCommands } from '../../state/browserPaneChrome';
import { isRealUrl } from '../../state/pane/browserPaneUrl';
import { releaseNativeFocus } from '../../lib/shell/tauri';
import type { BrowserConsoleEntry, DeviceMode } from './browserDevTypes';
import type { DownloadsMenuProps } from './DownloadsMenu';
import type { ShareMode } from '../../lib/sharedAuto';

export interface BrowserChromeBridgeInput {
  url: string;
  /**
   * The URL the pane is KNOWN to be on, from the store — which is not the same
   * thing as the URL the live browser is currently showing.
   *
   * They diverge on a RESTORED pane, and that divergence is the whole reason
   * this field exists. The store is rehydrated the moment the pane mounts; the
   * browser has not navigated yet and still reports `about:blank`. Judging
   * "is this a blank pane?" on the live URL alone therefore answered YES for a
   * pane that is merely catching up, and the address row stayed on screen — on
   * the very panes where the card that moved the address onto the tab said it
   * should be gone.
   */
  knownUrl?: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  consoleSummary?: { errors: number; warnings: number };
  /** How many downloads the pane is holding (drives the sheet's tally). */
  downloads: number;
  /** Monotonic count of downloads that STARTED. It lights the tab's downloads
   *  cue and pulses it once; it opens nothing. */
  downloadsStarted: number;
  zoom?: number;
  deviceMode?: DeviceMode;
  shared: boolean;
  shareMode?: ShareMode;
  /** WHAT THIS PANE IS: the streaming connection, the server engine, the render
   *  mode. They feed the tab's single type icon and the sheet's Session
   *  switches; see `BrowserPaneChrome` for why each one is optional and what
   *  absence means. The paths without a streaming socket (native, iframe) pass
   *  none of them. */
  connection?: 'connected' | 'connecting' | 'fallback-http' | 'disconnected';
  engine?: 'native' | 'chromium';
  engineExtensions?: number;
  renderMode?: 'dom' | 'video';
  /** An agent is driving this pane, and what it is doing. The tab draws it as
   *  its type icon; nothing is drawn over the page for it. */
  agentActive?: boolean;
  agentAction?: string | null;
  /** What the SHEET shows and the tab cannot: this pane's address list, the
   *  console rows behind the tally, the downloads with their actions. They
   *  travel through the registry for the same reason the tally does - the sheet
   *  is drawn in another subtree - and each is absent on the paths that do not
   *  have it. */
  history?: string[];
  consoleEntries?: BrowserConsoleEntry[];
  downloadsMenu?: DownloadsMenuProps;
  commands: BrowserPaneCommands;
}

export interface BrowserChromeBridge {
  /** Open the tab's sheet with the address selected. The pane's own ⌘L. */
  focusAddress: () => void;
}

/** One frozen empty list, so a pane with no history does not publish a new
 *  array (and therefore a new snapshot) on every render. */
const EMPTY_HISTORY: string[] = [];

export function useBrowserChromeBridge(
  contextId: string,
  input: BrowserChromeBridgeInput,
): BrowserChromeBridge {
  // EDITING HAPPENS IN THE TAB. Until 2026-09-03 this revealed an address row
  // and put the caret there, so a click on the active tab (the gesture that
  // also FOCUSES the pane) brought a row back under a tab that was already
  // naming the page. It asks the tab for its sheet instead.
  //
  // TAKING THE KEYBOARD BACK IS PART OF ASKING FOR THE CARET.
  //
  // A native pane is a sibling webview that holds the OS keyboard while it is
  // there. Putting the caret in an input of THIS webview does not move it: the
  // editor opens, it looks focused, and the letters go to the page instead.
  // Measured on Windows 2.2.291 — Ctrl+L, a full address typed, and the HTTP
  // witness records nothing, while the same address typed the instant the pane
  // opens (before the native child exists) loads normally.
  //
  // The tab strip already did this on pointer-down, so the mouse worked and the
  // keyboard did not. It belongs here instead, at the one door both go through:
  // every way of asking for the address bar is a request for the keyboard too.
  // Off the desktop shell it is a no-op.
  const [addressEditRequest, setAddressEditRequest] = useState(0);
  const focusAddress = useCallback(() => {
    releaseNativeFocus();
    setAddressEditRequest((n) => n + 1);
  }, []);

  const url = input.url;

  // A DOWNLOAD SPEAKS FIRST, AND SPEAKS QUIETLY.
  //
  // Between 2026-09-03 and this card nothing spoke at all: `downloadsStarted`
  // arrived here and was dropped. A file landed on the disk and the app said
  // nothing - no bubble, no badge, no toast. Then it brought the 40px row back
  // over the page, which said it loudly and took the page away to do it.
  //
  // The sheet must NOT be that second mistake with a smaller footprint: it
  // covers the page and freezes it, so a file arriving while you read would
  // stop the reading to report something you did not ask for at that instant.
  // The announcement is the cue in the tab's quiet rail
  // (`BrowserTabDownloadsCue`) and the opening is the user's click on it.
  //
  // So `downloadsStarted` only travels; `openDownloads` is what opens, and it
  // is a SEPARATE counter from `addressEditRequest` because that one selects
  // the address, and a file you clicked to look at must not leave you with a
  // caret to undo.
  const [downloadsOpenRequest, setDownloadsOpenRequest] = useState(0);
  const openDownloads = useCallback(() => {
    releaseNativeFocus();
    setDownloadsOpenRequest((n) => n + 1);
  }, []);


  const {
    faviconUrl, loading, canGoBack, canGoForward, consoleSummary, downloads,
    zoom, deviceMode, shared, shareMode, connection, engine, engineExtensions,
    renderMode, history, consoleEntries, downloadsMenu, commands,
    agentActive, agentAction,
  } = input;

  /**
   * THE ADDRESS THE TAB SHOWS IS THE ONE THE TAB KNOWS, not the one the browser
   * has finished loading.
   *
   * On a restored pane `url` is `about:blank` for a few instants, so
   * `prettyUrl` produced nothing and the address the tab surface was supposed
   * to carry simply was not drawn: it opened maimed exactly where the card had
   * moved the address to.
   *
   * Showing `knownUrl` is not a lie: the tab's LABEL, a centimetre further up,
   * already reads the store and already shows that address. Before, the two
   * surfaces said different things about the same pane; now they say the same.
   * And it stays a fallback, not a replacement — as soon as the browser
   * navigates, `url` is real and wins.
   */
  const urlToShow = isRealUrl(url) ? url : (input.knownUrl ?? url);

  const chrome = useMemo(() => ({
    url: urlToShow,
    faviconUrl,
    loading,
    canGoBack,
    canGoForward,
    consoleErrors: consoleSummary?.errors ?? 0,
    consoleWarnings: consoleSummary?.warnings ?? 0,
    downloads,
    zoom: zoom ?? 100,
    deviceMode: deviceMode ?? ('desktop' as DeviceMode),
    shared,
    shareMode,
    connection,
    engine,
    engineExtensions,
    renderMode,
    agentActive,
    agentAction: agentAction ?? undefined,
    history: history ?? EMPTY_HISTORY,
    consoleEntries,
    downloadsMenu,
    downloadsStarted: input.downloadsStarted,
    addressEditRequest,
    downloadsOpenRequest,
    commands: {
      ...commands,
      editAddress: focusAddress,
      // Only offered when there is a list to open: the cue hides on an empty
      // pane anyway, and a command that opens an empty section is a dead door.
      openDownloads: downloadsMenu ? openDownloads : undefined,
    },
  }), [
    urlToShow, faviconUrl, loading, canGoBack, canGoForward,
    consoleSummary?.errors, consoleSummary?.warnings, downloads, zoom, deviceMode, shared,
    shareMode, connection, engine, engineExtensions, renderMode,
    agentActive, agentAction,
    history, consoleEntries, downloadsMenu, input.downloadsStarted,
    addressEditRequest, downloadsOpenRequest, commands, focusAddress, openDownloads,
  ]);

  const paneId = `browser:${contextId}`;
  useEffect(() => {
    publishBrowserPaneChrome(paneId, chrome);
  }, [paneId, chrome]);

  // The entry dies with the panel, not with the tab: a tab whose panel is gone
  // must fall back to its persisted URL rather than keep a stale favicon.
  useEffect(() => () => { retireBrowserPaneChrome(paneId); }, [paneId]);

  return { focusAddress };
}

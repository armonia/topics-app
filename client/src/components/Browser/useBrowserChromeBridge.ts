/**
 * THE PANE SIDE OF "THE TAB IS THE CHROME".
 *
 * Two things live here, and they are the same decision seen from both ends:
 *
 *  1. WHAT THE TAB GETS. The pane publishes its live chrome (address, favicon,
 *     loading, history reach, console tally, zoom, device, session) plus the
 *     commands that go with it, into `state/browserPaneChrome`. The tab reads
 *     it from there. See that module for why it is a registry and not a prop.
 *
 *  2. WHEN THE ADDRESS BAR EXISTS AT ALL. On a loaded page it does not: the tab
 *     says where you are, so a second row saying the same thing is 40px of
 *     furniture. It comes back exactly when you need to TYPE an address:
 *       - a pane with no real page yet (a new tab: you are here to type),
 *       - Cmd+L, or "Edit address" in the tab menu,
 *       - the tab menu asking for the console or the downloads list, because
 *         those two panels are anchored to buttons that live in that row.
 *     And it goes away again on the next navigation, which is the gesture that
 *     says you are done typing.
 *
 * The pane still owns everything. This hook only decides who can SEE it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { publishBrowserPaneChrome, retireBrowserPaneChrome, type BrowserPaneCommands } from '../../state/browserPaneChrome';
import { isRealUrl } from '../../state/pane/browserPaneUrl';
import type { DeviceMode } from './browserDevTypes';

export interface BrowserChromeBridgeInput {
  url: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  consoleSummary?: { errors: number; warnings: number };
  /** How many downloads the pane is holding (drives the tab menu entry). */
  downloads: number;
  /** Monotonic count of downloads that STARTED. A download announcing itself is
   *  one of the few things allowed to bring the chrome row back on its own. */
  downloadsStarted: number;
  zoom?: number;
  deviceMode?: DeviceMode;
  shared: boolean;
  commands: BrowserPaneCommands;
}

export interface BrowserChromeBridge {
  /** Render the address row? */
  showChrome: boolean;
  /** Reveal it and put the caret in it. */
  revealAddress: () => void;
  /** Give the row back (Escape). */
  hideChrome: () => void;
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
  /** Counter for `DownloadsMenu.requestOpen`. */
  downloadsRequestOpen: number;
  /** Wire this into `BrowserToolbar.onRegisterFocus`. */
  registerFocus: (fn: () => void) => void;
  /** Focus the address input, revealing the row first if it is hidden. */
  focusAddress: () => void;
}

export function useBrowserChromeBridge(
  contextId: string,
  input: BrowserChromeBridgeInput,
): BrowserChromeBridge {
  const [revealed, setRevealed] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [downloadsRequestOpen, setDownloadsRequestOpen] = useState(0);
  const focusFnRef = useRef<(() => void) | null>(null);

  const registerFocus = useCallback((fn: () => void) => { focusFnRef.current = fn; }, []);

  // The 50ms defer is the same one the auto-focus effect uses: on a hidden row
  // the input does not exist yet when the reveal is decided, so the focus call
  // has to land after the paint that mounts it.
  const focusAddress = useCallback(() => {
    setRevealed(true);
    setTimeout(() => focusFnRef.current?.(), 50);
  }, []);

  const revealAddress = focusAddress;
  const hideChrome = useCallback(() => { setRevealed(false); }, []);

  const openConsole = useCallback(() => {
    setRevealed(true);
    setConsoleOpen(true);
  }, []);

  const openDownloads = useCallback(() => {
    setRevealed(true);
    setDownloadsRequestOpen((n) => n + 1);
  }, []);

  // A NAVIGATION ENDS THE REASON THE ROW WAS SHOWING. You revealed it to type an
  // address; you typed it; the row has no further job.
  //
  // Adjusted DURING the render (the way React asks a state to react to a prop
  // that changed) and not in an effect: an effect here would be a second render
  // pass with the bar still painted, and the lint rule that forbids it is
  // right. Guarded on a REAL url, so landing on about:blank (a pane being
  // recreated) never hides the one bar that lets you leave it.
  const url = input.url;
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    if (isRealUrl(url) && revealed) setRevealed(false);
  }

  // A DOWNLOAD THAT STARTS BRINGS THE ROW BACK. Its list is anchored to a
  // button that lives there, and a download that announces itself into a hidden
  // row announces itself to nobody. Same during-render adjustment as above.
  const [seenStarted, setSeenStarted] = useState(input.downloadsStarted);
  if (input.downloadsStarted !== seenStarted) {
    setSeenStarted(input.downloadsStarted);
    if (input.downloadsStarted > seenStarted && !revealed) setRevealed(true);
  }

  const showChrome = revealed || !isRealUrl(url);

  const {
    faviconUrl, loading, canGoBack, canGoForward, consoleSummary, downloads,
    zoom, deviceMode, shared, commands,
  } = input;

  const chrome = useMemo(() => ({
    url,
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
    commands: {
      ...commands,
      editAddress: revealAddress,
      openConsole: commands.clearConsole ? openConsole : undefined,
      openDownloads: downloads > 0 ? openDownloads : undefined,
    },
  }), [
    url, faviconUrl, loading, canGoBack, canGoForward,
    consoleSummary?.errors, consoleSummary?.warnings, downloads, zoom, deviceMode, shared,
    commands, revealAddress, openConsole, openDownloads,
  ]);

  const paneId = `browser:${contextId}`;
  useEffect(() => {
    publishBrowserPaneChrome(paneId, chrome);
  }, [paneId, chrome]);

  // The entry dies with the panel, not with the tab: a tab whose panel is gone
  // must fall back to its persisted URL rather than keep a stale favicon.
  useEffect(() => () => { retireBrowserPaneChrome(paneId); }, [paneId]);

  return {
    showChrome,
    revealAddress,
    hideChrome,
    consoleOpen,
    setConsoleOpen,
    downloadsRequestOpen,
    registerFocus,
    focusAddress,
  };
}

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
  // EDITING HAPPENS IN THE TAB. Until 2026-09-03 this revealed the address
  // row and put the caret there, so a click on the active tab (the gesture
  // that also FOCUSES the pane) brought the row back under a tab that was
  // already naming the page. Now it asks the tab to open its inline editor;
  // the row stays where it belongs, behind the console and the downloads.
  const [addressEditRequest, setAddressEditRequest] = useState(0);
  const focusAddress = useCallback(() => {
    setAddressEditRequest((n) => n + 1);
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

  // A download that starts used to bring the row back (its list is anchored
  // there). Since 2026-09-03 the tab menu carries the downloads entry and its
  // count: nothing brings the row back on its own any more.

  /**
   * THE ROW SHOWS WHEN YOU ASKED FOR IT, OR WHEN THERE IS NOWHERE TO GO.
   *
   * The second half used to read the LIVE url alone, and that made a restored
   * pane indistinguishable from a blank one: the store already knows the pane
   * is on `…/rapporto` while `browser.url` is still `about:blank`, so the bar
   * stayed up on exactly the panes where the address had already moved onto
   * the tab. `knownUrl` is that store value, and consulting it is the fix.
   *
   * WHY HIDING IT HERE IS NOT A TRAP, which is the objection the original
   * guard was written against. On a genuinely blank pane the row is the only
   * way out, and that case still shows it — neither url is real. On a restored
   * pane there are two other ways back to the address, both independent of the
   * row: `⌘L` (`RemoteBrowserPanel`) and the tab menu's own "edit address"
   * item (`browser-tab-edit-address`). And a navigation that FAILS lands on
   * `chrome-error:`, which `isRealUrl` rejects, so the bar comes back by
   * itself exactly when it is needed.
   *
   * AND THE THIRD STATE: «I DO NOT KNOW YET» IS NOT «IT IS NOT REAL».
   *
   * `knownUrl` reads the pane store SYNCHRONOUSLY (`getBrowserPaneUrl`), so
   * before the server hydration lands that store knows nothing and returns
   * `undefined` — which `isRealUrl` rejects, exactly like a blank pane. The
   * guard then answered "neither is real → show the row", and on a restored
   * pane the row came back and stayed.
   *
   * It is not a race that only theory has: measured 2026-08-25 on a four-shard
   * run, `browser-url-input` resolved to 1 element for 34 consecutive polls
   * across a 30s timeout — it did not arrive late, it did not arrive. Under
   * load the hydration lands after the mount, and that inverted order is the
   * whole defect. Reproduced deterministically by delaying `/api/ui-state`
   * (`browser-tab-chrome.spec.ts`, "con l'idratazione IN RITARDO").
   *
   * So the row waits for the store to speak. A genuinely blank pane still gets
   * it — the flag flips within a boot, and from then on `!isRealUrl` on both
   * sides means what it says. What it can no longer do is answer a question the
   * store has not been asked yet.
   */
  // `useServerHydrated` and NOT `hasReceivedServerHydrate()`: the second is a
  // plain read, and read during a render it gives the value of that instant. The
  // flag flips AFTER the mount — that is the normal order, and the whole reason
  // this third state exists — so nothing told React to render again and the row
  // stayed on screen for the rest of the session.
  //
  // The cure below was right and is untouched; what was missing is that a third
  // state has to be OBSERVED, not sampled. Measured on 2026-08-26: three failures
  // out of four in `browser-tab-chrome.spec.ts` under `--workers=4`, and the same
  // red in CI on a four-shard run.
  // THE ROW APPEARS ONLY WHEN ASKED (console, downloads). A blank pane has
  // its start page and an editable tab; a page that failed has its own retry;
  // the address is on the tab. Reported 2026-09-03, in the words of the
  // report (allow-italian: the report, verbatim): "la riga sotto compare
  // quando faccio focus, ma non dovrebbe proprio esserci" (allow-italian: same).
  const showChrome = revealed;

  const {
    faviconUrl, loading, canGoBack, canGoForward, consoleSummary, downloads,
    zoom, deviceMode, shared, commands,
  } = input;

  /**
   * THE ADDRESS THE TAB SHOWS IS THE ONE THE TAB KNOWS, not the one the browser
   * has finished loading.
   *
   * Same divergence as `showChrome`, and the same cure. On a restored pane
   * `url` is `about:blank` for a few instants, so `prettyUrl` produced nothing
   * and the address line inside the three-dots menu simply was not drawn: the
   * menu opened maimed exactly where the card had moved the address to.
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
    addressEditRequest,
    commands: {
      ...commands,
      editAddress: revealAddress,
      openConsole: commands.clearConsole ? openConsole : undefined,
      openDownloads: downloads > 0 ? openDownloads : undefined,
    },
  }), [
    urlToShow, faviconUrl, loading, canGoBack, canGoForward,
    consoleSummary?.errors, consoleSummary?.warnings, downloads, zoom, deviceMode, shared,
    addressEditRequest, commands, revealAddress, openConsole, openDownloads,
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

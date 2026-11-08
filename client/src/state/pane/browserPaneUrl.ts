/**
 * Browser-pane URL persistence — makes a browser tab restore to its page after
 * a window restart, exactly like a chat tab restores its conversation.
 *
 * The URL is stored on the pane object (`pane.url`) and round-trips through the
 * normal pane-store sync (server pane-store-v2 + warm-boot localStorage). Read
 * it on mount to seed `initialUrl`; persist it (debounced, change-gated) as the
 * pane navigates.
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePaneStore } from './store';
// `tryHostname` was re-exported from here for the tab bar, which used it to
// collapse a title-less browser pane down to its hostname before the label rule
// ever saw it. The rule owns that fallback now (`lib/browserTabLabel`), and it
// prefers the whole address, so the only consumer left is the sidebar - which
// imports the canonical pure one from `lib/path-utils` directly.

/** A URL worth persisting/restoring: not blank, not the empty page, not a
 *  failed-navigation error page (`chrome-error:`). Exported so every persist
 *  callsite (standalone + project layouts) shares ONE guard instead of
 *  re-implementing it inline and drifting (e.g. forgetting `chrome-error:`). */
export function isRealUrl(url: string | undefined | null): url is string {
  return !!url && url !== 'about:blank' && !url.startsWith('chrome-error:');
}

// Initial-URL seed for force-opened browser panes. A session-initiated open
// (`browser:force-open`) arrives BEFORE the pane exists in the store, and the
// native browser hook captures `initialUrl` exactly ONCE at mount (useTauri-
// Browser / useNativeBrowser ref-capture it) — so the URL must be readable the
// instant the pane first renders. persistBrowserPaneUrl can't bridge this: it
// no-ops until the pane is store-resident, and on Tauri the server never drives
// the navigation over CDP (no Electron CDP). Seed the URL here, at the earliest
// point (the force-open handler, before any render), so getBrowserPaneUrl —
// which the pane list reads to populate initialUrl — returns it at mount. Once
// the page actually navigates, onUrlChange writes the real store url, which then
// supersedes (and clears) the seed.
const initialUrlSeeds = new Map<string, string>();

/**
 * The same URL, but as something REACT CAN SEE CHANGE.
 *
 * `getBrowserPaneUrl` is a plain `getState()` read: called during a render it
 * gives the value of that instant and never speaks again. On a RESTORED pane the
 * order is exactly the inconvenient one — the pane mounts with `url` still
 * `about:blank`, and the store snapshot with the real address lands a few
 * instants later. Nothing subscribed, so nothing re-rendered: the address bar
 * that should have disappeared stayed on screen for the rest of the session.
 *
 * Measured on 2026-08-26 under `--workers=4`: `browser-url-input` resolved to 1
 * element for 34 consecutive polls across a 30s timeout, in the restored-pane
 * case of `browser-tab-chrome.spec.ts`. Same class of defect as
 * `useServerHydrated`, one level up: a value that arrives late has to be
 * OBSERVED, not sampled.
 *
 * The seed fallback stays a plain read on purpose: seeds are written by the
 * force-open handler BEFORE the pane mounts, so there is no later arrival to
 * miss. And unlike `getBrowserPaneUrl` this hook does not delete the seed —
 * mutating a module Map during render is exactly the kind of side effect that
 * makes a double-invoked render mean two different things.
 */
export function useBrowserPaneUrl(paneId: string): string | undefined {
  const stored = usePaneStore((s) => s.panes[paneId]?.url);
  if (isRealUrl(stored)) return stored;
  return initialUrlSeeds.get(paneId);
}

/** What a browser tab is labelled from: the page's address, its title, and who
 *  DECIDED that title. The third field is not decoration: `browserTabLabel`
 *  needs it to tell a page title (which the next navigation replaces) from a
 *  name a person or an agent chose (which it must not). */
export interface BrowserPaneFacts {
  url?: string;
  title: string;
  titleSource?: 'auto' | 'agent' | 'user';
}

/**
 * Url and title of MANY browser panes, subscribed — for a list that is built
 * inside a memo.
 *
 * `getBrowserPaneUrl` is a plain `getState()` read. A
 * pane list built from them inside a `useMemo` is only as fresh as the render
 * that happened to rebuild it: the store moved to the next page, the memo's
 * dependencies did not, and the tab kept writing the previous address until
 * some unrelated re-render. Measured 2026-09-03 (BROWSER-CHROME-INLINE-01):
 * store and server both already on the second page, the tab still naming
 * the first sixty seconds later. Same defect as `useBrowserPaneUrl`, for a list.
 *
 * The values are read through `useShallow` as one flat array of strings, so
 * the returned map keeps its identity until an url or a title actually
 * changes — which is exactly when the caller's memo has to rebuild. Pass a
 * MEMOIZED id list: a fresh array on every render rebuilds the map every
 * render and the memo above it with it.
 */
export function useBrowserPaneFacts(paneIds: readonly string[]): ReadonlyMap<string, BrowserPaneFacts> {
  const flat = usePaneStore(useShallow((s) =>
    paneIds.flatMap((id) => [s.panes[id]?.url ?? '', s.panes[id]?.title ?? '', s.panes[id]?.titleSource ?? ''])));
  return useMemo(() => {
    const facts = new Map<string, BrowserPaneFacts>();
    paneIds.forEach((id, i) => {
      const stored = flat[i * 3];
      const source = flat[i * 3 + 2];
      // Same fallback as `useBrowserPaneUrl`: a force-opened pane knows its
      // address from the seed before the store does.
      facts.set(id, {
        url: isRealUrl(stored) ? stored : initialUrlSeeds.get(id),
        title: flat[i * 3 + 1]!,
        titleSource: source ? (source as 'auto' | 'agent' | 'user') : undefined,
      });
    });
    return facts;
  }, [flat, paneIds]);
}

/** Seed the URL a not-yet-mounted browser pane must open at (force-open). */
export function seedBrowserPaneInitialUrl(paneId: string, url: string): void {
  if (isRealUrl(url)) initialUrlSeeds.set(paneId, url);
}

/** Read a browser pane's URL: the persisted store url, else a force-open seed. */
export function getBrowserPaneUrl(paneId: string): string | undefined {
  try {
    const pane = usePaneStore.getState().panes[paneId];
    if (isRealUrl(pane?.url)) {
      initialUrlSeeds.delete(paneId); // real navigation supersedes the seed
      return pane!.url;
    }
  } catch {
    /* fall through to the seed */
  }
  return initialUrlSeeds.get(paneId);
}

/**
 * Persist a browser pane's current URL onto its pane (change-gated). No-op when
 * the pane isn't in the global store (e.g. a project-layout pane) or the URL is
 * blank/unchanged. The dispatch bumps lastSeq → the debounced server sync PUTs.
 */
export function persistBrowserPaneUrl(paneId: string, url: string): void {
  if (!isRealUrl(url)) return;
  try {
    const state = usePaneStore.getState();
    const pane = state.panes[paneId];
    if (!pane) return; // not a store-resident pane — caller persists elsewhere
    if (pane.url === url) return; // no change
    state.dispatch({ type: 'UPDATE_PANE', payload: { id: paneId, updates: { url } } });
  } catch {
    /* ignore — persistence is best-effort */
  }
}

// ── Browser tab title ────────────────────────────────────────────────────────
// A browser tab shows the live page `<title>` (polled off the WKWebView in
// useTauriBrowser), falling back to the URL's hostname, then the constant
// "Browser". The page title round-trips on `pane.title` exactly like `pane.url`
// so the tab keeps its label across a restart (and a background/hidden pane,
// whose poll is paused, keeps its last-known title instead of resetting).
//
// `pane.titleSource` mirrors a terminal's `name_source`: 'auto' (or absent) = the
// title tracks the page; 'user' = the user renamed the tab, which pins it so the
// poll's 'auto' writes no longer clobber it (see shouldPersistBrowserTitle).

/** Pure gate: should an incoming auto (page-poll) title be written? Skip blank
 *  titles, no-op writes, and any pane whose label someone DECIDED — la rinomina
 *  a mano ('user') o il nome che l'agente ha dato alla tab di un task ('agent').
 *  Shared by the store-backed path (standalone) and the project-layout path so
 *  the rule is defined once. */
export function shouldPersistBrowserTitle(
  currentTitle: string | undefined,
  currentSource: 'auto' | 'agent' | 'user' | undefined,
  incoming: string,
): boolean {
  const next = incoming.trim();
  if (!next) return false; // a page with no <title> pushes '' — don't erase
  if (currentSource === 'user' || currentSource === 'agent') return false; // etichetta decisa: appiccicosa
  if (currentTitle === next) return false; // unchanged
  return true;
}

/**
 * Persist a browser pane's live page title (change-gated, source-gated). No-op
 * when the pane isn't in the global store (project-layout panes persist via
 * updatePane), the title is blank/unchanged, or the tab was manually renamed.
 * Stamps titleSource='auto'.
 */
export function persistBrowserPaneTitle(paneId: string, title: string): void {
  try {
    const state = usePaneStore.getState();
    const pane = state.panes[paneId];
    if (!pane) return; // not a store-resident pane — caller persists elsewhere
    if (!shouldPersistBrowserTitle(pane.title, pane.titleSource, title)) return;
    state.dispatch({ type: 'UPDATE_PANE', payload: { id: paneId, updates: { title: title.trim(), titleSource: 'auto' } } });
  } catch {
    /* ignore — persistence is best-effort */
  }
}

/**
 * Pin a browser pane's title to a user-chosen name (manual rename from the tab
 * context menu). Stamps titleSource='user' so the page-title poll leaves it
 * alone thereafter. Blank input is ignored.
 */
export function setBrowserPaneUserTitle(paneId: string, title: string): void {
  const name = title.replace(/\s+/g, ' ').trim();
  if (!name) return;
  try {
    const state = usePaneStore.getState();
    if (!state.panes[paneId]) return;
    state.dispatch({ type: 'UPDATE_PANE', payload: { id: paneId, updates: { title: name, titleSource: 'user' } } });
  } catch {
    /* ignore — best-effort */
  }
}

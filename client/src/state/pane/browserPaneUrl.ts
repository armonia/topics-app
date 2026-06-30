/**
 * Browser-pane URL persistence — makes a browser tab restore to its page after
 * a window restart, exactly like a chat tab restores its conversation.
 *
 * The URL is stored on the pane object (`pane.url`) and round-trips through the
 * normal pane-store sync (server pane-store-v2 + warm-boot localStorage). Read
 * it on mount to seed `initialUrl`; persist it (debounced, change-gated) as the
 * pane navigates.
 */
import { usePaneStore } from './store';

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

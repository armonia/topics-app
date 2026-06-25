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

/** Read a browser pane's persisted URL from the store (undefined if none). */
export function getBrowserPaneUrl(paneId: string): string | undefined {
  try {
    const pane = usePaneStore.getState().panes[paneId];
    return isRealUrl(pane?.url) ? pane!.url : undefined;
  } catch {
    return undefined;
  }
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

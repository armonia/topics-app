/**
 * Write-through localStorage persistence for the pane store.
 *
 * Two keys, each with a single owner:
 *   - `pane-store-v2`        : full snapshot (panes/groups/closedStack).
 *                              Written debounced (100 ms) on `lastSeq` change,
 *                              cross-tab broadcast via the `storage` event.
 *                              `focusedPaneId` is intentionally NOT here —
 *                              sanitizeSnapshot strips it on inbound (it's
 *                              per-device, not per-account).
 *   - `pane-store-focused-id`: just the focused pane id. Written synchronously
 *                              on every change so a reload inside the 100 ms
 *                              debounce window still finds the latest value.
 *
 * Bootstrap calls `hydrateFromLocalSnapshot()` to warm-hydrate both before
 * React renders — eliminates the ~500 ms gap between mount and the server
 * hydrate landing, during which `openPanels` would otherwise be empty.
 * The subsequent server hydrate still wins LWW via syncWS's
 * `lastAppliedServerSeq` guard.
 */
import { usePaneStore, type PaneStore } from '../store';
import { selectLocalSnapshot } from '../selectors';
import { getTabId } from './syncCrossTab';

const LOCAL_KEY = 'pane-store-v2';
const LOCAL_FOCUS_KEY = 'pane-store-focused-id';
const DEBOUNCE_MS = 100;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function writeSnapshotNow(): void {
  try {
    const snap = {
      ...selectLocalSnapshot(usePaneStore.getState()),
      savedAt: Date.now(),
      // `senderId` is the per-tab UUID from syncCrossTab; receivers drop
      // payloads whose senderId matches their own, preventing self-apply loops.
      senderId: getTabId(),
    };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snap));
  } catch {
    /* quota / private mode — server sync is the source of truth */
  }
}

function writeFocusNow(focused: string | null): void {
  try {
    if (focused) localStorage.setItem(LOCAL_FOCUS_KEY, focused);
    else localStorage.removeItem(LOCAL_FOCUS_KEY);
  } catch { /* silent */ }
}

/**
 * Warm-hydrate panes + focus from localStorage. Synchronous, called at
 * bootstrap before React renders. Server hydrate wins LWW afterwards.
 */
export function hydrateFromLocalSnapshot(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const snap = JSON.parse(raw) as Record<string, unknown> & { server_seq?: number };
      const seq = typeof snap.server_seq === 'number' ? snap.server_seq : 0;
      usePaneStore.getState().dispatch({
        type: 'HYDRATE_FROM_SNAPSHOT',
        payload: {
          snapshot: {
            ...snap,
            lastSeq: Math.max(usePaneStore.getState().lastSeq, seq),
            server_seq: seq,
            seq,
          },
        },
      });
    }
    // Focus lives in its own key (sanitizeSnapshot strips it from the main
    // snapshot). Apply it after the panes hydrate so FOCUS_PANE's existence
    // check finds the pane.
    const focused = localStorage.getItem(LOCAL_FOCUS_KEY);
    if (focused) {
      usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: focused } });
    }
  } catch {
    /* corrupt snapshot — fall through to server hydrate */
  }
}

function flushNow(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  writeSnapshotNow();
}

export function initLocalPersistence(): void {
  if (started) return;
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  started = true;

  // Full snapshot: debounced.
  usePaneStore.subscribe(
    (s: PaneStore) => s.lastSeq,
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(writeSnapshotNow, DEBOUNCE_MS);
    },
  );

  // Focus: synchronous. Single short string, cheap to write on every change,
  // and a reload mid-debounce must not resurrect a stale focused id.
  usePaneStore.subscribe(
    (s: PaneStore) => s.focusedPaneId,
    (focused) => writeFocusNow(focused),
  );

  // Tab close / hide: flush the pending snapshot debounce so other tabs
  // observing `storage` see the final state.
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

export const PANE_STORE_LOCAL_KEY = LOCAL_KEY;

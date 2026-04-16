/**
 * Write-through localStorage persistence for the pane store.
 *
 * Subscribes to `lastSeq` changes and debounces a full snapshot write under
 * the key `pane-store-v2`. Exists outside React — the store is the only
 * thing that triggers the writer; components never touch localStorage directly.
 *
 * Device-local fields (focusedPaneId, scrollOffset) are excluded via
 * `selectSyncableSnapshot` so the same shape that reaches the server also
 * reaches localStorage. Cross-tab LWW (syncCrossTab.ts) relies on this.
 */
import { usePaneStore, type PaneStore } from '../store';
import { selectSyncableSnapshot } from '../selectors';
import { getTabId } from './syncCrossTab';

const LOCAL_KEY = 'pane-store-v2';
const DEBOUNCE_MS = 100;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function writeSnapshotNow(): void {
  try {
    const snap = {
      ...selectSyncableSnapshot(usePaneStore.getState()),
      savedAt: Date.now(),
      // Bug #4: self-suppression for cross-tab receivers. `senderId` is the
      // per-tab UUID from syncCrossTab; the receiver drops payloads whose
      // senderId matches its own tabId, preventing self-apply loops.
      senderId: getTabId(),
    };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(snap));
  } catch {
    // Quota exceeded or private mode — silent; the server sync is the source of truth.
  }
}

/**
 * Sync flush used by the `pagehide` / `visibilitychange(hidden)` path.
 * Ensures the last ~100 ms of mutations reach localStorage before the tab
 * closes — otherwise the cross-tab listener in other tabs sees stale state
 * (review I5: asymmetric with syncServer, which already has flushNow()).
 */
function flushNow(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeSnapshotNow();
}

export function initLocalPersistence(): void {
  if (started) return;
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  started = true;

  usePaneStore.subscribe(
    (s: PaneStore) => s.lastSeq,
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(writeSnapshotNow, DEBOUNCE_MS);
    },
  );

  // Tab close / hide: synchronously flush the pending debounce so another
  // tab that listens on `storage` sees the final state after this tab exits.
  // sendBeacon doesn't apply here — localStorage.setItem is already sync.
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

export const PANE_STORE_LOCAL_KEY = LOCAL_KEY;

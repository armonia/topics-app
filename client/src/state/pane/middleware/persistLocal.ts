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
 *   - `pane-store-active-space`: the window's active Spazio — the twin of the
 *                              focused-id key (DEVICE-LOCAL: excluded from the
 *                              outbound snapshot, stripped inbound). Written
 *                              synchronously on change, boot-read only — no
 *                              live cross-tab application, so each window
 *                              keeps its own active space.
 *
 * RIMOSSA (2026-08-06) la chiave `pane-store-scroll-offsets`, che riportava la
 * posizione di scroll delle chat attraverso un ricaricamento. Un documento si
 * riapre dove l'avevi lasciato; una chat no: il suo stato di riposo è il fondo,
 * e una posizione salvata invecchia nell'istante in cui arriva un messaggio —
 * riapplicarla ti deposita in mezzo al nulla, che è il «ricarico e si perde»
 * segnalato più volte. Nessuna app di messaggi ripristina lo scroll a un
 * riavvio: ripristinano semmai il segno del non letto.
 *
 * `pane.scrollOffset` resta VIVO in memoria: serve all'undo di una pane chiusa,
 * che se lo porta dietro dentro `ClosedPaneRecord` e riapre la scheda
 * esattamente com'era. È solo la traversata del ricaricamento che sparisce.
 *
 * Bootstrap calls `hydrateFromLocalSnapshot()` to warm-hydrate both before
 * React renders — eliminates the ~500 ms gap between mount and the server
 * hydrate landing, during which `openPanels` would otherwise be empty.
 * The subsequent server hydrate still wins LWW via syncWS's
 * `lastAppliedServerSeq` guard.
 */
import { usePaneStore, type PaneStore } from '../store';
import { selectLocalSnapshot } from '../selectors';
import { DEFAULT_SPACE_ID } from '../types';
import { getTabId } from './syncCrossTab';
import { spaceWindowId } from '../../../lib/windowRole';

const LOCAL_KEY = 'pane-store-v2';
const LOCAL_FOCUS_KEY = 'pane-store-focused-id';
const LOCAL_ACTIVE_SPACE_KEY = 'pane-store-active-space';
const DEBOUNCE_MS = 100;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function writeSnapshotNow(): void {
  try {
    const state = usePaneStore.getState();
    const snap = {
      ...selectLocalSnapshot(state),
      // LWW key for the warm-boot hydrate and the cross-tab gate: the highest
      // server-stamped seq this tab has applied. Without it the boot-time
      // hydrate dispatched seq 0 and the reducer's gate dropped it on every
      // boot (audit HIGH: warm-hydrate was dead code).
      server_seq: state.lastServerSeq,
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

function writeActiveSpaceNow(activeSpaceId: string): void {
  // Una finestra-gruppo non scrive MAI questa chiave: è per-origine, quindi
  // scriverla vorrebbe dire spostare il gruppo attivo della finestra
  // principale ogni volta che ne stacchi una.
  if (spaceWindowId()) return;
  try {
    // Absent key ⟺ default space — the same canonical encoding the pane's
    // `spaceId` field uses (and the focus key's remove-on-null precedent).
    if (activeSpaceId && activeSpaceId !== DEFAULT_SPACE_ID) {
      localStorage.setItem(LOCAL_ACTIVE_SPACE_KEY, activeSpaceId);
    } else {
      localStorage.removeItem(LOCAL_ACTIVE_SPACE_KEY);
    }
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
      const snap = JSON.parse(raw) as Record<string, unknown> & {
        server_seq?: number;
        lastSeq?: number;
      };
      const seq = typeof snap.server_seq === 'number' ? snap.server_seq : 0;
      // The reducer's LWW gate compares `server_seq` against lastServerSeq
      // (0 at boot, with a warm-boot escape for never-synced snapshots), so
      // this dispatch applies. Restore the persisted lastSeq too so the local
      // dispatch counter resumes from where the previous session left off.
      usePaneStore.getState().dispatch({
        type: 'HYDRATE_FROM_SNAPSHOT',
        payload: {
          snapshot: {
            ...snap,
            lastSeq: Math.max(
              usePaneStore.getState().lastSeq,
              typeof snap.lastSeq === 'number' ? snap.lastSeq : 0,
              seq,
            ),
            server_seq: seq,
            seq,
          },
        },
      });
    }
    // Active Spazio lives in its own device-local key (twin of the focus key
    // below). Applied AFTER the snapshot hydrate so the spaces registry is
    // already in the store — SET_ACTIVE_SPACE resolves a dead/unknown id to
    // the default space against that registry. Applied BEFORE the focus
    // restore so the reducer's focus handoff can't override the saved focus.
    //
    // In una FINESTRA-GRUPPO (`?space=<id>`) comanda la query, non la chiave:
    // quella chiave è dell'ORIGINE, quindi è condivisa fra tutte le finestre, e
    // leggerla qui farebbe partire la finestra staccata sul gruppo dell'altra.
    const pinnedSpace = spaceWindowId();
    const activeSpace = pinnedSpace ?? localStorage.getItem(LOCAL_ACTIVE_SPACE_KEY);
    if (activeSpace) {
      usePaneStore.getState().dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: activeSpace } });
    }
    // Focus lives in its own key (sanitizeSnapshot strips it from the main
    // snapshot). Apply it after the panes hydrate — FOCUS_PANE has no
    // existence check, so ordering only matters for consumers reading
    // focusedPaneId + panes together right after boot.
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

/**
 * Synchronously write the current pane-store snapshot to localStorage,
 * cancelling any pending debounce. Exposed so an unload handler can flush the
 * store AFTER committing pending closes (which dispatch CLOSE_PANE) — the
 * separate `pagehide` listener registered here would otherwise fire first
 * (registered at bootstrap, before the PendingActionProvider mounts) and
 * persist the stale pre-close snapshot, resurrecting the tab on reload.
 */
export function flushLocalPaneStoreNow(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  flushNow();
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

  // Active Spazio: synchronous, same rationale as focus (a reload inside the
  // 100 ms snapshot debounce must reopen on the space the user was viewing).
  usePaneStore.subscribe(
    (s: PaneStore) => s.activeSpaceId,
    (activeSpaceId) => writeActiveSpaceNow(activeSpaceId),
  );

  // Tab close / hide: flush the pending snapshot debounce so other tabs
  // observing `storage` see the final state.
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

export const PANE_STORE_LOCAL_KEY = LOCAL_KEY;

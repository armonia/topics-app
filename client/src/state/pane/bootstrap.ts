/**
 * Pane-store bootstrap — wires legacy-storage hydration, the four persistence
 * transports (local/server/WS/cross-tab), and the 500 ms WS-latency GET fallback
 * against /api/ui-state into a single entry point called from main.tsx.
 *
 * Phase 30 PANE-01: every /api/ui-state access lives inside client/src/state/pane/.
 * The grep gate in tests/e2e/infra-validation.spec.ts asserts that outside this
 * directory no file references /api/ui-state, topics-open-panels, etc.
 *
 * main.tsx calls bootstrapPaneStore() once, synchronously, before React renders.
 *
 * Review I4: we no longer open a second WebSocket here. `useWebSocket` (owned
 * by App.tsx once React mounts) fans frames out via `wsFrameBus`; this module
 * just subscribes to that bus.
 */
import { hydrateFromLegacyStorage } from './migration/importLegacy';
import { scheduleBrowserDataStoreReap } from '../../lib/browserDataStoreReaper';
import { scheduleBrowserClaimHeartbeat } from '../../lib/browserClaimHeartbeat';
import {
  initLocalPersistence,
  initServerSync,
  initWSSync,
  initCrossTabSync,
  hydrateFromLocalSnapshot,
  type WSFrame,
} from './middleware';
import { isSelfEcho } from './middleware/selfEcho';
import {
  hasReceivedServerHydrate,
  markServerHydrated,
} from './middleware/serverHydrated';
import { usePaneStore } from './store';
import { preloadPaneChunks } from './panePreload';
import { subscribeFrames } from '../../lib/wsFrameBus';
import { initTombstoneSync } from './adapters/tombstoneSync';

/**
 * Thin adapter: conform `subscribeFrames` (untyped frame) to the
 * `initWSSync(onFrame)` contract (`WSFrame` = `{type: string}` + extras).
 * Passes a `types` whitelist so high-frequency chat/stream/ping frames never
 * reach the pane-store middleware — the bus filters in-place per review I1.
 * Only frames matching one of these types can reach the handler.
 */
// Review-round-12 B5: `ui-state:patch` MUST be on this whitelist — the server
// broadcasts it from bulk PUT (server/routes/ui-state.ts finding #11) and
// syncWS narrows on it at runtime. Without it in the whitelist, the frame bus
// filters patches out before they ever reach the middleware, so bulk PUTs from
// other tabs never hydrate this tab until the next full reconnect.
const PANE_STORE_WS_FRAME_TYPES = ['ui-state:init', 'ui-state:updated', 'ui-state:patch'] as const;

function subscribePaneStoreFrames(handler: (frame: WSFrame) => void): () => void {
  return subscribeFrames(
    (raw) => {
      // Bus whitelist (above) already guaranteed raw.type is one of the listed
      // strings, so this cast is safe. Keep the defensive null-check for
      // extreme edge cases (e.g. a test dispatching an odd payload).
      if (!raw || typeof raw !== 'object') return;
      handler(raw as WSFrame);
    },
    { types: PANE_STORE_WS_FRAME_TYPES },
  );
}

/**
 * Fallback to GET /api/ui-state after 500 ms if the WS `ui-state:init` frame
 * has not arrived. Per CONTEXT.md §Sync strategy initial-load priority step 3:
 * the syncWS middleware's lastAppliedServerSeq guard ensures any later WS init
 * frame is only applied if it carries a higher server_seq, so this fallback
 * races safely.
 *
 * PR-review #14: the suppression gate is `hasReceivedServerHydrate()` — a
 * module-level flag set ONLY by (a) syncWS on a valid ui-state:init /
 * ui-state:updated, (b) this fallback itself on success. Previously we
 * gated on `state.lastSeq > 0`, which bumps for any local dispatch (e.g.
 * an early `OPEN_PANE`), so if the WS was down we'd suppress the fallback
 * and render an empty UI. Local dispatches must not be treated as server
 * hydrate.
 */
function scheduleInitialLoadFallback(): void {
  setTimeout(async () => {
    if (hasReceivedServerHydrate()) return;
    try {
      const res = await fetch('/api/ui-state');
      if (!res.ok) return;
      const envelope = (await res.json()) as {
        data?: Record<string, unknown>;
        meta?: Record<string, { payload_version: number; server_seq: number }>;
      };
      const snap = envelope.data?.['pane-store-v2'];
      const seq = envelope.meta?.['pane-store-v2']?.server_seq ?? 0;
      // A successful GET — even one we decide not to apply (self-echo of our
      // own PUT) — proves the server is reachable and authoritative for this
      // tab, so mark hydrated to suppress any subsequent race with the 500 ms
      // schedule (this fallback is one-shot, but the flag also matters for
      // other code paths that may check it later).
      markServerHydrated();
      // B2: if the server snapshot is the echo of a PUT this client just wrote
      // (race with an already-acked in-flight write), skip — local state is
      // already at or ahead of this seq.
      if (snap && !isSelfEcho(seq)) {
        usePaneStore.getState().dispatch({
          type: 'HYDRATE_FROM_SNAPSHOT',
          payload: {
            snapshot: {
              ...(snap as object),
              lastSeq: Math.max(usePaneStore.getState().lastSeq, seq),
              server_seq: seq,
              seq,
            },
          },
        });
      }
    } catch {
      /* fallback is best-effort */
    }
  }, 500);
}

/**
 * Bootstrap the pane store. Call exactly once at app module load, before React
 * renders. Idempotent via each init*()'s internal `started` flag.
 */
export function bootstrapPaneStore(): void {
  // Detached pop-out windows (`?topics=a,b` / legacy `?topic=`) host exactly
  // the topics in their URL and must be READ-ONLY toward the shared pane
  // store: they still hydrate (local snapshot + WS/HTTP) so panes render, but
  // never write back — no server PUT, no cross-tab broadcast, no local
  // snapshot overwrite, no tombstone mirroring, no legacy-key clearing. A
  // detached window that persisted its dispatches leaked its panes into every
  // other client's layout (live incident 2026-07-20: automation windows in
  // detached mode stranded nine floating browser panes in group:default).
  const params = new URLSearchParams(window.location.search);
  const isDetached = Boolean(params.get('topics') ?? params.get('topic'));

  // Seed the reducer from legacy localStorage (one-shot; also clears legacy keys).
  if (!isDetached) hydrateFromLegacyStorage();

  // Warm-hydrate from the same-device `pane-store-v2` snapshot BEFORE React
  // renders. Closes the ~500 ms gap between mount and the WS/HTTP server
  // hydrate landing, during which `openPanels` would otherwise start empty
  // and the focus-keeper effects would snap focus to `storeOrder[0]`.
  // Server hydrate still wins LWW via syncWS's lastAppliedServerSeq guard.
  hydrateFromLocalSnapshot();

  // The snapshot just told us WHICH KINDS of pane are on screen, and every pane
  // body is a lazy chunk. Ask for those chunks now, in parallel with the rest
  // of the boot, instead of after React has mounted and hit the suspense
  // boundary: that wait was 222-347 ms of spinner on a reload, and it was the
  // same figure for the board, the editor and the terminal, because it was
  // never their data - it was their code. See `panePreload.ts`.
  preloadPaneChunks(Object.values(usePaneStore.getState().panes).map((p) => p.type));

  // Wire the persistence subscribers (write paths gated on detached above).
  if (!isDetached) {
    initLocalPersistence();
    initServerSync();
    initCrossTabSync();
  }
  // Subscribe to the app's single WS via the module-level frame bus. When
  // React later mounts and useWebSocket opens the socket, frames flow into
  // `dispatchFrame` and fan out to every subscriber registered here.
  initWSSync(subscribePaneStoreFrames);

  // Cross-device mirroring of browser/terminal close-tombstones over the same
  // ui_state channel (union-only, clobber-safe). Wired after the frame bus so
  // its subscribeFrames registration is in place before the socket opens.
  if (!isDetached) initTombstoneSync();

  // 500 ms WS-latency fallback to GET /api/ui-state.
  scheduleInitialLoadFallback();

  // Lo spazzino degli store browser orfani (Tauri, differito di 90 s). Non
  // dalle finestre staccate: sono READ-ONLY verso lo stato condiviso, e questo
  // è il gesto meno reversibile che ci sia — due finestre che grattano lo
  // stesso disco insieme, poi, non aggiungono niente.
  if (!isDetached) scheduleBrowserDataStoreReap();

  // Il battito che rivendica le pane browser di questa finestra. Senza il
  // guard `isDetached`, e non per svista: una finestra staccata OSPITA pane
  // browser, e il suo reclamo è esattamente ciò che le tiene aperte. Zittirla
  // qui vorrebbe dire far chiudere al Rust le webview che sta mostrando.
  // Non è una scrittura sullo stato condiviso, quindi il read-only del
  // pop-out resta intatto: dice solo cosa vive dentro questa pagina.
  scheduleBrowserClaimHeartbeat();
}

/**
 * Test-only — invoke the fallback schedule without wiring the full bootstrap.
 * The 500 ms timer runs as in production; tests fake the timer.
 */
export function __scheduleInitialLoadFallbackForTests(): void {
  scheduleInitialLoadFallback();
}

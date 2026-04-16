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
import {
  initLocalPersistence,
  initServerSync,
  initWSSync,
  initCrossTabSync,
  type WSFrame,
} from './middleware';
import { isSelfEcho } from './middleware/selfEcho';
import {
  hasReceivedServerHydrate,
  markServerHydrated,
} from './middleware/serverHydrated';
import { usePaneStore } from './store';
import { subscribeFrames } from '../../lib/wsFrameBus';

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
  // Seed the reducer from legacy localStorage (one-shot; also clears legacy keys).
  hydrateFromLegacyStorage();

  // Wire the four persistence subscribers.
  initLocalPersistence();
  initServerSync();
  initCrossTabSync();
  // Subscribe to the app's single WS via the module-level frame bus. When
  // React later mounts and useWebSocket opens the socket, frames flow into
  // `dispatchFrame` and fan out to every subscriber registered here.
  initWSSync(subscribePaneStoreFrames);

  // 500 ms WS-latency fallback to GET /api/ui-state.
  scheduleInitialLoadFallback();
}

/**
 * Test-only — invoke the fallback schedule without wiring the full bootstrap.
 * The 500 ms timer runs as in production; tests fake the timer.
 */
export function __scheduleInitialLoadFallbackForTests(): void {
  scheduleInitialLoadFallback();
}

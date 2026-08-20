import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { paneReducer } from './reducers';
import type { PaneState, PaneAction } from './types';
import { DEFAULT_SPACE_ID } from './types';
// `import type` è erasable: il modulo NON entra nel grafo di produzione (Vite lo
// tree-shaka come prima). In cambio il tipo non passa più da
// `typeof import('./middleware/mutationLog')`, che per il cancello sul codice
// morto è un riferimento opaco all'intero modulo.
import type { MutationLogEntry } from './middleware/mutationLog';

// Monotonic per-dispatch sequence. Kept as a *lower bound*: after HYDRATE_FROM_SNAPSHOT
// applies a higher server_seq to state.lastSeq, the next dispatch clamps `_seq`
// to at least that value before incrementing — so outbound syncServer PUTs
// always carry a seq greater than anything the store has seen (I1 in the PR
// review: without this, post-hydrate dispatches would emit seq=1 against a
// server at seq=N>>1, and the server would reject them as stale).
let _seq = 0;

/**
 * Actions whose payload carries an authoritative `lastSeq` the reducer writes
 * directly onto state (no dispatcher bump needed). Incrementing `lastSeq` after
 * these would push it one past the server-allocated seq, and the subsequent
 * WS broadcast carrying that same server_seq would be dropped by the LWW gate
 * (`clean.lastSeq <= state.lastSeq`) — silently losing cross-tab HYDRATE
 * sync. See the HYDRATE_FROM_SNAPSHOT case in reducers/panes.ts.
 */
function isServerAuthoritativeAction(action: PaneAction): boolean {
  return action.type === 'HYDRATE_FROM_SNAPSHOT';
}

// Dev-only: dedupe the "no pane entity for id" warning by paneId. A throttled
// scroll handler firing at 250 ms during a racy mount would otherwise spam the
// console on every tick until OPEN_PANE dispatches. The whole block is tree-
// shaken from production by `import.meta.env.DEV`.
const warnedMissingPaneIds = new Set<string>();

// Dev-only: resolve the mutation-log module ONCE and reuse the cached promise.
// Calling import('./middleware/mutationLog') per dispatch re-walks the module
// resolution machinery on every tick; the dynamic import already memoises the
// module, but caching the promise here avoids the per-dispatch call overhead
// entirely. The whole thing is gated behind `import.meta.env.DEV` so Vite
// still tree-shakes it (and the module) out of production.
let _mutationLogPromise: Promise<{ recordAction: (entry: MutationLogEntry) => void }> | null = null;

const initialState: PaneState = {
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId: DEFAULT_SPACE_ID,
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
};

export interface PaneStore extends PaneState {
  dispatch: (action: PaneAction) => void;
  /**
   * Device-local scroll-offset setter. Bypasses the action/reducer pipeline
   * on purpose: `pane.scrollOffset` is per-device (never syncs; stripped from
   * the outbound snapshot by `selectSyncableSnapshot`) so we DON'T want it to
   * bump `lastSeq` and trigger persistLocal / syncServer writes on every
   * scroll tick. PANE-03 scroll-restore uses this for its hot-path tracker.
   */
  setPaneScrollOffset: (paneId: string, offset: number) => void;
}

export const usePaneStore = create<PaneStore>()(
  subscribeWithSelector(
    immer((set) => ({
      ...initialState,
      dispatch: (action: PaneAction) => {
        set((draft) => {
          paneReducer(draft as PaneState, action);
          // Clamp `_seq` to the current draft.lastSeq before bumping — the
          // reducer may have just applied HYDRATE_FROM_SNAPSHOT with a server-
          // originated seq that is higher than our local counter.
          //
          // Naming: `lastSeq` (client-side) and `server_seq` (DB column / HTTP
          // response) are SEPARATE counters that converge post-hydrate.
          // `lastSeq` is the monotonically-increasing local dispatch counter;
          // `server_seq` is the server-allocated LWW key. HYDRATE clamps the
          // local counter to max(lastSeq, server_seq) so post-hydrate PUTs
          // always carry a seq the server considers fresh. The naming is
          // intentionally different to signal the domain boundary.
          if (draft.lastSeq > _seq) _seq = draft.lastSeq;
          // Server-originated actions carry an authoritative `lastSeq` in
          // their payload (reducer writes it onto draft.lastSeq). Bumping
          // here would push lastSeq to clean.lastSeq + 1, so the very next
          // WS broadcast carrying that same server_seq would be dropped by
          // the LWW gate (`clean.lastSeq <= state.lastSeq` fails at equal).
          // We keep `_seq` clamped (above) so outbound PUTs still carry a
          // seq the server considers fresh; we just don't increment when
          // the reducer already installed a server-authoritative value.
          if (isServerAuthoritativeAction(action)) return;
          // Qui siamo su una modifica di QUESTO dispositivo: e' l'unico punto
          // in cui `localSeq` sale, ed e' quello che il middleware di sync
          // osserva. Un `HYDRATE_FROM_SNAPSHOT` esce alla riga sopra e non lo
          // tocca, che e' precisamente cio' che spezza il ciclo fra pari
          // (vedi il commento di `localSeq` in types.ts).
          draft.localSeq += 1;
          draft.lastSeq = ++_seq;
        });
        // DEV-only mutation log. Vite tree-shakes this block when import.meta.env.DEV is false.
        if (import.meta.env.DEV) {
          // Dynamic import keeps the module out of the production graph; the
          // promise is cached (module-level) so we resolve it once, not per
          // dispatch. Capture seq/ts at dispatch time — `_seq` mutates before
          // the microtask runs.
          const seq = _seq;
          const ts = performance.now();
          // La destrutturazione sta dentro l'`await`: un `import()` il cui
          // risultato non finisce in un `const { … } =` è opaco per knip e
          // rende immortale ogni export di quel modulo
          // (`bun run check:deadcode-blindspots`).
          _mutationLogPromise ??= (async () => {
            const { recordAction } = await import('./middleware/mutationLog');
            return { recordAction };
          })();
          _mutationLogPromise.then(({ recordAction }) => {
            recordAction({ seq, ts, action });
          });
        }
      },
      setPaneScrollOffset: (paneId: string, offset: number) => {
        if (!Number.isFinite(offset) || offset < 0) return;
        set((draft) => {
          const pane = draft.panes[paneId];
          if (pane) {
            pane.scrollOffset = offset;
          } else if (import.meta.env.DEV) {
            // Review #2: surface the silent no-op. If a chat renders for a
            // topic whose pane entity isn't in the reducer (legacy flow or
            // a racy mount), scroll tracking falls on the floor — log it
            // in dev so we catch drift early. Production tree-shakes this.
            // Dedupe by paneId so a 250 ms-throttled scroll handler doesn't
            // spam the console on every tick until OPEN_PANE dispatches.
            if (!warnedMissingPaneIds.has(paneId)) {
              warnedMissingPaneIds.add(paneId);
              console.warn(
                `[paneStore] setPaneScrollOffset: no pane entity for id="${paneId}" — scroll tracking is a no-op until OPEN_PANE dispatches. (This warning fires once per unique id.)`,
              );
            }
          }
          // NOTE: no `draft.lastSeq = ++_seq` — see setPaneScrollOffset
          // docstring. Persistence and sync intentionally do NOT fire here.
        });
      },
    })),
  ),
);

/**
 * Find which group currently hosts a given pane id. Returns null if no
 * group references the id. Useful for callers that need to dispatch a
 * group-scoped action (CLOSE_PANE, REORDER_PANES) without re-implementing
 * the lookup loop on each call site.
 */
export function findPaneLocation(
  state: PaneState,
  paneId: string,
): { groupId: string; groupIndex: number } | null {
  for (const gid of Object.keys(state.groups)) {
    const ids = state.groups[gid]?.paneIds ?? [];
    const idx = ids.indexOf(paneId);
    if (idx !== -1) return { groupId: gid, groupIndex: idx };
  }
  return null;
}

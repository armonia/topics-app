/**
 * paneZoom — which surface is zoomed, on which tab, and how wide.
 *
 * EPHEMERAL, never persisted, per window. That is a decision, not an omission.
 * Panel state is shared by KEY and broadcast to every device (`ui_state` has a
 * primary key and no device column), so a synced zoom would be a modal opening
 * by itself on the phone because someone double-clicked on the Mac; and every
 * write that is not a focus change arms a PUT of the WHOLE snapshot, so eight
 * toggles would be eight ~68 KB uploads with the same hash. The resting state is
 * "not zoomed", so a reload has nothing to restore and no frame is ever drawn
 * over a grid that has not hydrated yet.
 *
 * LEAVING THE ZOOM WHEN THE SPACE CHANGES IS WANTED, and it is written here so
 * that nobody "fixes" it: `App.tsx` keys the subtree on the active space, the
 * surface remounts, and its unmount effect calls `exit(surfaceId)`. Lifting this
 * state any higher to keep the zoom alive across a space switch would make a
 * zoom travel between groups, which is not what the gesture promises.
 *
 * ONE RECORD PER SURFACE, not one global slot: a zoom inside a nested project
 * must not cancel the one on the outer grid.
 *
 * `scope` is the scope FIXED AT ENTRY (`derived` = the conversation and the tabs
 * it opened, `cell` = the anchor's cell alone) — never a mode switch. A `toggle`
 * on the same anchor EXITS whatever scope it carries, and two toggles with
 * different scopes on one surface leave ONE record, never two. Which cells that
 * scope reveals is decided downstream by `resolveZoomCells`, on every render.
 *
 * It is `scope` and not a `cellOnly` boolean because the two do not name the
 * same thing: `cellOnly` names the KEY that was held, `scope` names the OUTCOME.
 * In the degraded case no modifier was pressed and the scope is the single cell
 * anyway, so a boolean named after the modifier would either lie about the
 * record or force the degradation to be recomputed on every render — which is
 * exactly what the design forbids, and what would make a browser opened later
 * silently walk into a zoom that was asked to hold one cell.
 *
 * Modelled on `state/projectFocus.ts` / `state/windowPresence.ts`: a small
 * standalone zustand store, off the hot App ⇄ usePanelLifecycle path.
 */
import { create } from 'zustand';
import type { ZoomScope } from '../components/Layout/zoomScope';

export interface PaneZoomRecord {
  /** The tab the zoom hangs from. It disappearing is what closes the zoom. */
  anchorPaneId: string;
  /** The scope chosen at entry — see the header: an outcome, not a key. */
  scope: ZoomScope;
  /** Monotonic open order, so `exitTop` can close the most recent one. */
  openedSeq: number;
}

interface PaneZoomState {
  bySurface: Record<string, PaneZoomRecord>;
  /** Zoom `paneId` on `surfaceId` with `scope`, or leave the zoom when that
   *  same anchor is already the zoomed one — whatever scope either carries. */
  toggle: (surfaceId: string, paneId: string, scope: ZoomScope) => void;
  exit: (surfaceId: string) => void;
  /** Close the most recently opened zoom; false when there was none. It is what
   *  the Escape branch calls: `useKeyboardShortcuts` sits at App level and has
   *  to read a surface below it without being handed props. */
  exitTop: () => boolean;
}

let openedSeq = 0;

function withoutSurface(
  bySurface: Record<string, PaneZoomRecord>,
  surfaceId: string,
): Record<string, PaneZoomRecord> {
  const next = { ...bySurface };
  delete next[surfaceId];
  return next;
}

export const usePaneZoomStore = create<PaneZoomState>((set, get) => ({
  bySurface: {},

  toggle: (surfaceId, paneId, scope) =>
    set((s) => {
      const current = s.bySurface[surfaceId];
      if (current?.anchorPaneId === paneId) return { bySurface: withoutSurface(s.bySurface, surfaceId) };
      return {
        bySurface: { ...s.bySurface, [surfaceId]: { anchorPaneId: paneId, scope, openedSeq: ++openedSeq } },
      };
    }),

  exit: (surfaceId) =>
    set((s) => (s.bySurface[surfaceId] ? { bySurface: withoutSurface(s.bySurface, surfaceId) } : s)),

  exitTop: () => {
    let topId: string | null = null;
    let topSeq = -Infinity;
    for (const [surfaceId, record] of Object.entries(get().bySurface)) {
      if (record.openedSeq > topSeq) { topSeq = record.openedSeq; topId = surfaceId; }
    }
    if (!topId) return false;
    const target = topId;
    set((s) => ({ bySurface: withoutSurface(s.bySurface, target) }));
    return true;
  },
}));

/** Stable callers for effects and key handlers (no hook subscription). */
export const paneZoomActions = {
  toggle: (surfaceId: string, paneId: string, scope: ZoomScope) =>
    usePaneZoomStore.getState().toggle(surfaceId, paneId, scope),
  exit: (surfaceId: string) => usePaneZoomStore.getState().exit(surfaceId),
  exitTop: (): boolean => usePaneZoomStore.getState().exitTop(),
};

import type { PaneState, PaneAction } from '../types';

// Clamp split ratios away from the [0,1] endpoints so a misclick on the
// resize handle (or a buggy client) can't collapse a pane to zero width and
// strand it off-screen. Also rejects NaN/Infinity — `typeof NaN === 'number'`
// so the reducer can't rely on the type system here.
const RATIO_MIN = 0.05;
const RATIO_MAX = 0.95;
function clampRatio(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  if (raw < RATIO_MIN) return RATIO_MIN;
  if (raw > RATIO_MAX) return RATIO_MAX;
  return raw;
}

export function groupsReducer(state: PaneState, action: PaneAction): void {
  switch (action.type) {
    case 'SPLIT': {
      const g = state.groups[action.payload.groupId];
      if (!g) break;
      g.splitAxis = action.payload.axis;
      g.splitRatio = clampRatio(action.payload.ratio, g.splitRatio);
      break;
    }
    case 'RESIZE': {
      const g = state.groups[action.payload.groupId];
      if (g) g.splitRatio = clampRatio(action.payload.ratio, g.splitRatio);
      break;
    }
    case 'REORDER_PANES': {
      const g = state.groups[action.payload.groupId];
      if (!g) break;
      // REORDER is a *permutation* primitive — the new list must be a reorder
      // of the existing paneIds. Filtering to {existing pane entities} ∩
      // {current group members} prevents two failure modes:
      //   1. orphan IDs (no pane entity) — would render ghost tabs
      //   2. cross-group injection — payload references a pane that lives in
      //      another group; accepting it would silently move the pane without
      //      removing it from the source group, leaving it in two places.
      const currentSet = new Set(g.paneIds);
      const next = action.payload.paneIds.filter(
        (id) => state.panes[id] && currentSet.has(id),
      );
      // If the payload dropped any current panes, append them at the end so
      // we never silently lose a tab from the bar.
      for (const id of g.paneIds) {
        if (!next.includes(id)) next.push(id);
      }
      g.paneIds = next;
      break;
    }
  }
}

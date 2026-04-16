import type { PaneState, PaneAction, ClosedPaneRecord, PaneType } from '../types';
import { CLOSED_STACK_MAX } from '../types';
import { groupsReducer } from './groups';
import { projectsReducer } from './projects';
import { undoReducer } from './undo';
import { sanitizeSnapshot, KNOWN_PANE_TYPES } from './sanitizeSnapshot';

export function paneReducer(state: PaneState, action: PaneAction): void {
  switch (action.type) {
    case 'OPEN_PANE': {
      const { groupId, insertIndex, ...pane } = action.payload;
      state.panes[pane.id] = pane;
      if (!state.groups[groupId]) {
        state.groups[groupId] = {
          id: groupId,
          paneIds: [],
          splitRatio: 0.5,
          splitAxis: 'horizontal',
        };
        if (!state.groupOrder.includes(groupId)) state.groupOrder.push(groupId);
      }
      // Review-round-12: guard against a stale `groupId` on the payload causing
      // a pane to live in two groups simultaneously. If the pane already
      // appears in a *different* group, remove it from the old one before
      // inserting into the new. Same-group re-open is idempotent (early-exit
      // below). OPEN_PANE is NOT a move primitive — this branch exists purely
      // to heal inconsistent state; real moves should use REORDER_PANES within
      // a group and an explicit close/open across groups.
      for (const [otherGroupId, otherGroup] of Object.entries(state.groups)) {
        if (otherGroupId === groupId) continue;
        const idx = otherGroup.paneIds.indexOf(pane.id);
        if (idx < 0) continue;
        otherGroup.paneIds.splice(idx, 1);
        // If the heal just emptied a non-default group, remove it from
        // groupOrder so the UI doesn't render a ghost tab-bar. We keep
        // `group:default` around even if empty — every app-level dispatch
        // lands there, so removing it would force a re-creation next tick.
        if (otherGroup.paneIds.length === 0 && otherGroupId !== 'group:default') {
          delete state.groups[otherGroupId];
          const orderIdx = state.groupOrder.indexOf(otherGroupId);
          if (orderIdx >= 0) state.groupOrder.splice(orderIdx, 1);
        }
      }
      const g = state.groups[groupId];
      const existingIdx = g.paneIds.indexOf(pane.id);
      if (existingIdx >= 0) break; // already in target group; re-open is a no-op
      if (
        typeof insertIndex === 'number' &&
        insertIndex >= 0 &&
        insertIndex <= g.paneIds.length
      ) {
        g.paneIds.splice(insertIndex, 0, pane.id);
      } else {
        g.paneIds.push(pane.id);
      }
      break;
    }
    case 'CLOSE_PANE': {
      const { id, groupId, groupIndex } = action.payload;
      const pane = state.panes[id];
      const group = state.groups[groupId];
      if (!pane || !group) break;
      // `pane.scrollOffset` is device-local and MUST NOT be copied onto the
      // ClosedPaneRecord — otherwise it leaks cross-device: CLOSE_PANE fires
      // on device A, the record is synced (outbound path via
      // selectSyncableSnapshot), device B hydrates, and UNDO_CLOSE on B would
      // restore A's scroll position. We also drop the nested pane.scrollOffset
      // to keep the record shape uniform (strip once, at the source, instead
      // of relying on every downstream consumer to strip it again).
      const { scrollOffset: _srcScroll, ...paneWithoutScroll } = pane;
      const record: ClosedPaneRecord = {
        id,
        closedAt: Date.now(),
        pane: { ...paneWithoutScroll },
        groupId,
        groupIndex,
        level: pane.projectPath ? 'project' : 'app',
        projectPath: pane.projectPath,
        topicId: pane.topicId,
        filePath: pane.filePath,
        splitRatio: group.splitRatio,
        splitAxis: group.splitAxis,
        focusedAtClose: state.focusedPaneId === id,
        tabOrderSnapshot: [...group.paneIds],
        // Peek at the next seq the dispatcher will assign to this action —
        // `state.lastSeq + 1` matches what store.ts will write after the
        // reducer returns. Mutating state.lastSeq here would cause the
        // dispatcher to increment a second time, burning one seq per close.
        seq: state.lastSeq + 1,
      };
      state.closedStack.push(record);
      while (state.closedStack.length > CLOSED_STACK_MAX) state.closedStack.shift(); // FIFO
      // Remove pane from group
      const idx = group.paneIds.indexOf(id);
      if (idx >= 0) group.paneIds.splice(idx, 1);
      delete state.panes[id];
      if (state.focusedPaneId === id) state.focusedPaneId = null;
      break;
    }
    case 'UNDO_CLOSE': {
      undoReducer(state, action);
      break;
    }
    case 'FOCUS_PANE': {
      state.focusedPaneId = action.payload.id;
      break;
    }
    case 'SPLIT':
    case 'RESIZE':
    case 'REORDER_PANES': {
      groupsReducer(state, action);
      break;
    }
    case 'PROJECT_LAYOUT_RESTORE':
    case 'PROJECT_LAYOUT_SNAPSHOT': {
      projectsReducer(state, action);
      break;
    }
    case 'HYDRATE_FROM_LEGACY': {
      // Minimal hydration: import open panels into a single default group.
      // Full migration lives in migration/importLegacy.ts — this reducer path is the atomic commit.
      const { openPanels, focusedPaneId, panelOrder } = action.payload;
      const groupId = 'group:default';
      if (!state.groups[groupId]) {
        state.groups[groupId] = {
          id: groupId,
          paneIds: [],
          splitRatio: 0.5,
          splitAxis: 'horizontal',
        };
        state.groupOrder.push(groupId);
      }
      for (const paneId of openPanels ?? []) {
        if (!state.panes[paneId]) {
          state.panes[paneId] = {
            id: paneId,
            type: inferTypeFromId(paneId),
            title: paneId,
          };
          state.groups[groupId].paneIds.push(paneId);
        }
      }
      // panelOrder tells us explicit ordering; if present, use it
      if (panelOrder?.order?.length) {
        state.groups[groupId].paneIds = panelOrder.order.filter((id) => state.panes[id]);
      }
      state.focusedPaneId = focusedPaneId ?? null;
      break;
    }
    case 'HYDRATE_FROM_SNAPSHOT': {
      // Validate + strip device-local fields (B3). Payload may arrive from
      // server WS, cross-tab storage, or the 500ms GET fallback — all
      // untrusted. `sanitizeSnapshot` returns null if the root shape is
      // unusable, or a safe subset with scrollOffset/focusedPaneId scrubbed.
      const clean = sanitizeSnapshot(action.payload.snapshot);
      if (!clean) break;
      // LWW gate — without a numeric lastSeq we can't decide if the snapshot
      // is newer than local state, so we drop it entirely. Treating `undefined`
      // as "apply anyway" would let a malformed server/cross-tab payload
      // overwrite fresh local state with an older shape.
      if (typeof clean.lastSeq !== 'number') break;
      if (clean.lastSeq <= state.lastSeq) break;
      if (clean.panes) state.panes = clean.panes;
      if (clean.groups) state.groups = clean.groups;
      if (clean.projects) state.projects = clean.projects;
      if (clean.groupOrder) state.groupOrder = clean.groupOrder;
      if (clean.closedStack) state.closedStack = clean.closedStack;
      // Defense-in-depth — sanitizer also clamps, but a test fixture or legacy
      // payload that bypasses the sanitizer must not blow up the stack. Keep
      // the tail (most recent closes) so undo still works; see sanitizeSnapshot
      // B3 for the matching rationale.
      if (state.closedStack.length > CLOSED_STACK_MAX) {
        state.closedStack = state.closedStack.slice(-CLOSED_STACK_MAX);
      }
      // focusedPaneId is DEVICE-LOCAL — sanitizeSnapshot already dropped it.
      state.lastSeq = clean.lastSeq;
      break;
    }
    case 'CLEAR_CLOSED_RECORD': {
      // Selective removal from the closedStack. Timer cancellation lives in
      // the adapter (see useClosedTabs.removeClosedTab) so the reducer stays
      // pure — cleanupTimers is module-level state, not Immer state.
      const { id } = action.payload;
      const idx = state.closedStack.findIndex((r) => r.id === id);
      if (idx >= 0) state.closedStack.splice(idx, 1);
      break;
    }
    case 'CLEAR_CLOSED_STACK': {
      // Empty the stack. Timers for terminal records are cancelled by the
      // adapter pre-dispatch; the reducer only owns the data.
      state.closedStack = [];
      break;
    }
    case 'PANE_ID_REMAP': {
      const { from, to } = action.payload;
      if (!state.panes[from]) break;
      state.panes[to] = { ...state.panes[from], id: to };
      delete state.panes[from];
      for (const g of Object.values(state.groups)) {
        const idx = g.paneIds.indexOf(from);
        if (idx >= 0) g.paneIds[idx] = to;
      }
      if (state.focusedPaneId === from) state.focusedPaneId = to;
      for (const rec of state.closedStack) {
        if (rec.id === from) rec.id = to;
        rec.tabOrderSnapshot = rec.tabOrderSnapshot.map((x) => (x === from ? to : x));
      }
      break;
    }
  }
}

function inferTypeFromId(id: string): PaneType {
  // Legacy pane id convention: "<type>:<...>" — see client/src/lib/paneConfig.ts.
  // Single source of truth is KNOWN_PANE_TYPES in sanitizeSnapshot (imported
  // above) — previously this list was duplicated inline and drifted out of
  // sync with sanitizeSnapshot's whitelist.
  const prefix = id.split(':')[0];
  return ((KNOWN_PANE_TYPES as readonly string[]).includes(prefix) ? prefix : 'chat') as PaneType;
}

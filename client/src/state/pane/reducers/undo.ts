import type { PaneState, PaneAction } from '../types';
import { isLiveSpaceId } from './spaces';

export function undoReducer(state: PaneState, action: PaneAction): void {
  if (action.type !== 'UNDO_CLOSE') return;
  const record = state.closedStack.pop();
  if (!record) return;

  // Stale-record guard (mirrors OPEN_PANE's idempotent early-exit): if the
  // pane was already re-opened via OPEN_PANE after the close, re-inserting
  // here would put the same id in paneIds twice — duplicate tabs sharing one
  // entity and React key collisions. Popping the record IS the right outcome;
  // there is nothing left to undo.
  if (state.panes[record.id]) return;

  // Re-insert the pane entity. Strip `scrollOffset` defensively — it is a
  // device-local field that CLOSE_PANE no longer copies onto the record
  // (reducers/panes.ts) and sanitizeSnapshot drops on inbound, but a legacy
  // record lingering from a pre-fix build could still carry one. Re-inserting
  // it here would re-introduce the cross-device leak.
  const { scrollOffset: _staleScroll, ...paneWithoutScroll } = record.pane;
  // Spazio membership: an undo into a DELETED (or unknown) space resolves to
  // the default space — otherwise the restored tab would be invisible in
  // every switcher chip while still occupying the store.
  if (paneWithoutScroll.spaceId && !isLiveSpaceId(paneWithoutScroll.spaceId, state.spaces)) {
    delete paneWithoutScroll.spaceId;
  }
  state.panes[record.id] = { ...paneWithoutScroll };

  // Ensure the target group still exists; if not, recreate it
  if (!state.groups[record.groupId]) {
    state.groups[record.groupId] = {
      id: record.groupId,
      paneIds: [],
      splitRatio: record.splitRatio ?? 0.5,
      splitAxis: record.splitAxis ?? 'horizontal',
    };
    if (!state.groupOrder.includes(record.groupId)) state.groupOrder.push(record.groupId);
  }
  const group = state.groups[record.groupId];

  // Restore split settings if saved
  if (record.splitRatio !== undefined) group.splitRatio = record.splitRatio;
  if (record.splitAxis) group.splitAxis = record.splitAxis;

  // Re-insert at original groupIndex (clamped to current length)
  const clamped = Math.min(Math.max(0, record.groupIndex), group.paneIds.length);
  group.paneIds.splice(clamped, 0, record.id);

  // Restore focus iff pane was focused at close
  if (record.focusedAtClose) state.focusedPaneId = record.id;

  // DO NOT restore `scrollOffset` from the record. `pane.scrollOffset` is a
  // device-local field (CONTEXT.md §Sync strategy); CLOSE_PANE no longer
  // writes it onto the record (reducers/panes.ts) and sanitizeSnapshot strips
  // it on inbound. Restoring it here would re-introduce the cross-device leak
  // for any legacy record still carrying a non-undefined value (e.g. from a
  // pre-fix localStorage payload). Same-device scroll restore is handled
  // post-mount by the DOM scroll tracker via `setPaneScrollOffset` and the
  // ChatPane initialScrollOffset subscription (see ChatPane.tsx).
}

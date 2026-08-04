import type { PaneState, PaneAction } from '../types';
import { isLiveSpaceId } from './spaces';

export function undoReducer(state: PaneState, action: PaneAction): void {
  if (action.type !== 'UNDO_CLOSE') return;
  const record = state.closedStack.pop();
  if (!record) return;

  // Stale-record guard (mirrors OPEN_PANE's idempotent early-exit): bail ONLY
  // when the pane is already SLOTTED in a group — i.e. genuinely re-opened via
  // OPEN_PANE, which inserts into BOTH state.panes AND a group. Re-inserting
  // then would duplicate the id in paneIds (React key collisions).
  //
  // A bare presence in state.panes is NOT enough to bail: the undo callback
  // (usePanelLifecycle) fires an async `archiveTopic(id, false)` unarchive
  // BEFORE this dispatch, and a hydrate racing on its response can resurrect
  // the entity into state.panes WITHOUT a group slot — a ghost pane. The
  // OLD `if (state.panes[record.id]) return` swallowed exactly that case:
  // the record was popped, nobody re-slotted the pane, and the tab surfaced
  // appended at the end (PANE-03). When the entity is a ghost, this record is
  // precisely what re-slots it, so we must fall through and repair the group.
  //
  // Misurato nell'E2E pane-undo, chiudendo la tab di mezzo di tre:
  //   store  group:default = [t1, t3]   ·   UI  [t1, t3, t2]
  //
  // BUT "already slotted" is not always "leave it alone". The same racing
  // hydrate that resurrects the entity can re-slot it into the RECORDED group
  // at the WRONG index — a stale peer/server still had the pane in the group
  // (the close hadn't propagated), so the union hydrate appends it at the tail.
  // The store then reads `[t1, t3, t2]` while the record says t2 belongs at
  // index 1. If we bailed here the tab would settle appended in the store, and
  // any surface that trusts store order (reload, a fresh client) would show it
  // at the end again. So: when the pane sits in its recorded group at the wrong
  // slot, MOVE it to `groupIndex`; only a genuine reopen already at the right
  // slot (or reopened into a different group) is a true no-op.
  const slottedGroupId = Object.keys(state.groups).find(gid =>
    state.groups[gid].paneIds.includes(record.id),
  );
  if (slottedGroupId) {
    if (slottedGroupId === record.groupId) {
      const g = state.groups[slottedGroupId];
      const cur = g.paneIds.indexOf(record.id);
      const target = Math.min(Math.max(0, record.groupIndex), g.paneIds.length - 1);
      if (cur !== target) {
        g.paneIds.splice(cur, 1);
        g.paneIds.splice(target, 0, record.id);
      }
    }
    if (record.focusedAtClose) state.focusedPaneId = record.id;
    if (state.tombstones) delete state.tombstones[record.id];
    return;
  }

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
  // Undo is a closed→open transition — stamp the causal open timestamp so a
  // stale peer's surviving marker for this id (union-merged tombstone maps
  // never propagate deletions) loses the hydrate comparison to the restore.
  // Se l'entità è stata resuscitata da un'altra strada, la si tiene: quella
  // viva può avere campi più freschi del record (che è una fotografia del
  // momento della chiusura). Quello che serviva è il POSTO nel gruppo, qui
  // sotto. `openedAt` si ristampa comunque: l'undo è una transizione
  // chiuso→aperto, e senza quel timbro un marcatore superstite di un peer
  // stantio vince il confronto all'hydrate e richiude la tab.
  const existing = state.panes[record.id];
  state.panes[record.id] = existing
    ? { ...existing, openedAt: Date.now() }
    : { ...paneWithoutScroll, openedAt: Date.now() };

  // Undo re-opens the pane — retract its durable tombstone so the restored tab
  // isn't stripped on the next union hydrate (mirrors OPEN_PANE's clear).
  if (state.tombstones) delete state.tombstones[record.id];

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

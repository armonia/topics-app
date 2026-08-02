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
  //
  // La domanda però è «ha già un POSTO in un gruppo?», non «esiste l'entità?».
  // Con il test sulla sola entità questa guardia produceva una GHOST PANE:
  // l'undo di App fa partire un unarchive PRIMA del dispatch
  // (usePanelLifecycle), e una ri-idratazione può rimettere l'entità in `panes`
  // mentre nessun gruppo la contiene ancora. Il reducer usciva qui, il record
  // era già stato consumato dalla `pop`, e la pane restava senza posto:
  // invisibile allo store, visibile alla UI attraverso `openPanels`, e appesa
  // in fondo invece che al suo indice. Misurato nell'E2E pane-undo:
  //   store  group:default = [t1, t3]   ·   UI  [t1, t3, t2]
  // A duplicare la tab è l'id ripetuto nei `paneIds`, ed è quello che si
  // controlla.
  const alreadySlotted = Object.values(state.groups).some((g) => g.paneIds.includes(record.id));
  if (alreadySlotted) return;

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
  state.panes[record.id] = state.panes[record.id]
    ? { ...state.panes[record.id], openedAt: Date.now() }
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

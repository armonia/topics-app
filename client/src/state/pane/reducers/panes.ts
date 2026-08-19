import type { PaneState, PaneAction, ClosedPaneRecord, PaneType, TombstoneMark } from '../types';
import { CLOSED_STACK_MAX, TOMBSTONES_MAX, DEFAULT_SPACE_ID, toTombstoneMark } from '../types';
import { groupsReducer } from './groups';
import { undoReducer } from './undo';
import { spacesReducer, mergeSpaces } from './spaces';
import { sanitizeSnapshot, KNOWN_PANE_TYPES } from './sanitizeSnapshot';

/**
 * Record a durable close marker for `id`. Kept SEPARATE from the FIFO-bounded
 * closedStack so it survives >50 subsequent closes — see PaneState.tombstones.
 * Older-write guard: only advance closedAt (a stale re-close must not shadow a
 * newer reopen that already cleared it in the same merge window).
 */
function recordTombstone(state: PaneState, id: string, closedAt: number, closedSeq: number): void {
  if (!state.tombstones) state.tombstones = {};
  const prev = state.tombstones[id];
  // Guardia sulla scrittura vecchia: avanza solo. Si confronta su `seq` quando
  // entrambi ce l'hanno — è la grandezza che ordina fra dispositivi — e si
  // ricade sull'orologio solo quando uno dei due è un marcatore legacy.
  if (prev === undefined) {
    state.tombstones[id] = { at: closedAt, seq: closedSeq };
  } else if ((prev.seq > 0 && closedSeq > 0) ? (closedSeq > prev.seq) : (closedAt > prev.at)) {
    state.tombstones[id] = { at: closedAt, seq: Math.max(closedSeq, prev.seq) };
  }
  capTombstones(state);
}

/** Bound the tombstone map, keeping the most-recently-closed ids. */
function capTombstones(state: PaneState): void {
  const ids = Object.keys(state.tombstones);
  if (ids.length <= TOMBSTONES_MAX) return;
  const kept = ids
    .sort((a, b) => (state.tombstones[b]?.at ?? 0) - (state.tombstones[a]?.at ?? 0))
    .slice(0, TOMBSTONES_MAX);
  const next: Record<string, TombstoneMark> = {};
  for (const id of kept) next[id] = state.tombstones[id];
  state.tombstones = next;
}

/** Retract a close marker (reopen / undo / explicit clear / remap). */
function clearTombstone(state: PaneState, id: string): void {
  if (state.tombstones && id in state.tombstones) delete state.tombstones[id];
}

/**
 * Retract a close marker proven STALE by a live pane's newer `openedAt`
 * (the hydrate-time causal comparison — see HYDRATE_FROM_SNAPSHOT). Mirrors
 * OPEN_PANE's retraction: drop the durable tombstone AND every closedStack
 * record for the id — a record left behind would re-close the pane on every
 * peer (their union filter consults incoming closedStack ids) and ⇧⌘T would
 * list a tab that is actually open.
 */
function retractStaleMarker(state: PaneState, id: string): void {
  clearTombstone(state, id);
  for (let i = state.closedStack.length - 1; i >= 0; i--) {
    if (state.closedStack[i].id === id) state.closedStack.splice(i, 1);
  }
}

export function paneReducer(state: PaneState, action: PaneAction): void {
  switch (action.type) {
    case 'OPEN_PANE': {
      const { groupId, insertIndex, ...pane } = action.payload;
      // Opening a pane CLEARS any closedStack tombstone for its id. A tombstone
      // means "this id is closed"; re-opening the same id (e.g. a browser pane
      // re-navigated to the same `browser:<ctx>` id via persistBrowserPane,
      // which OPEN_PANEs rather than going through the reopen-closed-tab path)
      // must retract that claim — otherwise the HYDRATE_FROM_SNAPSHOT strip
      // below would drop the freshly re-opened pane on the next union, and
      // ⇧⌘T would still list it as "recently closed". Reopen-via-history
      // already clears the record (removeClosedTab / UNDO_CLOSE); this covers
      // the OPEN_PANE re-entry those paths don't touch.
      {
        const idx = state.closedStack.findIndex((r) => r.id === pane.id);
        if (idx >= 0) state.closedStack.splice(idx, 1);
        // Also retract the durable tombstone (the FIFO-independent marker the
        // HYDRATE strip consults) — otherwise a re-opened durable pane would be
        // stripped on the next union even though its closedStack record is gone.
        clearTombstone(state, pane.id);
      }
      // Seed stableKey on first insert so PANE_ID_REMAP has something to
      // preserve. For panes that come back through hydration (sanitizeSnapshot
      // already stripped/preserved the field), we leave the existing value.
      //
      // Spazio stamping — the ONE central place that assigns membership, so
      // every call site (usePanelLifecycle.openPanel, force-open, cross-window
      // drag arrival, terminal/browser opens) lands in the window's active
      // space by construction. Precedence: an explicit payload spaceId wins;
      // else a RE-open of an already-known pane keeps its membership (e.g.
      // persistBrowserPane re-OPEN_PANEs the same id — that must not teleport
      // the tab into whatever space happens to be active); else stamp the
      // active space. The default space is stored as ABSENT (undefined), the
      // canonical "absent ⟺ default" encoding — which is why the re-open
      // branch gates on the PANE's existence, not on its spaceId: a known
      // pane with an absent spaceId lives in the DEFAULT space and must stay
      // there, not fall through to the active space.
      const knownPane = state.panes[pane.id];
      const inheritedSpaceId =
        pane.spaceId ??
        (knownPane ? knownPane.spaceId ?? DEFAULT_SPACE_ID : state.activeSpaceId);
      const spaceId =
        inheritedSpaceId === DEFAULT_SPACE_ID || inheritedSpaceId === undefined
          ? undefined
          : inheritedSpaceId;
      // Causal open timestamp: a FRESH insert (no live entity) is a
      // closed→open transition — stamp now. A re-OPEN of an already-open pane
      // keeps the existing value (persistBrowserPane re-OPENs the same id on
      // navigation; restamping would let a passive refresh outrank a peer's
      // genuine concurrent close in the hydrate comparison). An explicit
      // payload value wins (restore paths carrying the historical timestamp).
      // Legacy already-open panes stay unstamped — the marker keeps winning
      // for them exactly as before the field existed.
      const openedAt = pane.openedAt ?? (knownPane ? knownPane.openedAt : Date.now());
      // Il gemello CAUSALE di `openedAt`, e quello su cui si decide davvero.
      // Stesse regole: un inserimento FRESCO timbra, un ri-OPEN di una pane gia'
      // viva conserva (altrimenti una navigazione del browser pane, che
      // ri-OPEN_PANEa lo stesso id, farebbe scavalcare la chiusura genuina di un
      // peer), un valore esplicito nel payload vince. `state.lastSeq + 1` e' lo
      // stesso "sbircia il prossimo seq" gia' usato dal record di closedStack:
      // scriverlo su `state.lastSeq` qui farebbe incrementare due volte il
      // dispatcher, bruciando un seq per ogni apertura.
      const openedSeq = pane.openedSeq ?? (knownPane ? knownPane.openedSeq : state.lastSeq + 1);
      state.panes[pane.id] = { ...pane, stableKey: pane.stableKey ?? pane.id, spaceId, openedAt, openedSeq };
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
    case 'UPDATE_PANE': {
      // Merge a partial update into an existing pane. No-op if unknown (the pane
      // may live in a project layout / local state, not the global store). Never
      // lets the merge change `id` or `type`.
      const { id, updates } = action.payload;
      const pane = state.panes[id];
      if (!pane) break;
      const { id: _ignoreId, type: _ignoreType, ...safe } = updates;
      void _ignoreId; void _ignoreType;
      // UN AGGIORNAMENTO CHE NON AGGIORNA NIENTE NON È UN AGGIORNAMENTO.
      //
      // Il merge `{...pane, ...safe}` produceva un oggetto NUOVO anche quando
      // ogni valore era identico a quello che c'era già, e la freschezza di
      // quell'oggetto arriva fino in fondo alla catena: il dispatcher alza
      // `lastSeq`, il middleware di sync vede il contatore muoversi e manda al
      // server uno snapshot da 75 KB. Misurato il 2026-08-19 su una finestra
      // FERMA, senza un gesto dell'utente: **16 PUT in 25 secondi**, uno ogni
      // 1,15 s, con l'unica differenza fra un corpo e il successivo che era
      // `lastSeq` (+2). Per sempre, finché la finestra resta aperta.
      //
      // E non è solo banda: il server è Bun con `bun:sqlite` SINCRONO, quindi
      // ogni PUT è event loop fermo, e su HTTP/1.1 occupa una delle SEI
      // connessioni per host — cioè ritarda le letture che disegnano la board.
      //
      // Il confronto è SUPERFICIALE, e basta: i campi di `Pane` sono scalari
      // (id, url, title, projectPath, timestamp…). Un confronto profondo
      // costerebbe più di quello che evita, e per un campo oggetto la
      // disuguaglianza di riferimento sbaglia solo in DIREZIONE SICURA — un
      // aggiornamento in più, mai uno perso.
      let cambiato = false;
      for (const k of Object.keys(safe) as (keyof typeof safe)[]) {
        if (!Object.is(pane[k as keyof typeof pane], safe[k])) { cambiato = true; break; }
      }
      if (!cambiato) break;
      state.panes[id] = { ...pane, ...safe };
      break;
    }
    case 'CLOSE_PANE': {
      const { id, groupId, groupIndex } = action.payload;
      const pane = state.panes[id];
      const group = state.groups[groupId];
      if (!pane) {
        // Entity-less group ref (corruption — observed live: `__board__`
        // listed in group:default with no pane record, and the X did NOTHING
        // because this case used to bail). The user's intent is unambiguous:
        // strip the ref from every group (PURGE semantics — no closedStack
        // record, there is no pane shape to restore) and write the durable
        // tombstone so a stale peer's union-hydrate can't resurrect the ref.
        const referenced = Object.values(state.groups).some((g) => g.paneIds.includes(id));
        if (!referenced) break;
        for (const [gid, g] of Object.entries(state.groups)) {
          const idx = g.paneIds.indexOf(id);
          if (idx >= 0) g.paneIds.splice(idx, 1);
          if (g.paneIds.length === 0 && gid !== 'group:default') {
            delete state.groups[gid];
            const orderIdx = state.groupOrder.indexOf(gid);
            if (orderIdx >= 0) state.groupOrder.splice(orderIdx, 1);
          }
        }
        if (state.focusedPaneId === id) state.focusedPaneId = null;
        recordTombstone(state, id, Date.now(), state.lastSeq + 1);
        break;
      }
      if (!group) break;
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
        // The project-wrapper pane itself (type === 'project') is an
        // App-level top panel even though it carries a projectPath. Only
        // panes that LIVE INSIDE a project (chats, files, terminals with
        // a projectPath) count as 'project'-level for reopen routing.
        level: pane.type !== 'project' && pane.projectPath ? 'project' : 'app',
        projectPath: pane.projectPath,
        topicId: pane.topicId,
        filePath: pane.filePath,
        // Terminal metadata so reopenClosedTab can recreate the server
        // session — its recreation branch gates on `record.terminal`, so a
        // record without this field reopens bound to the OLD (deleted)
        // session id: a dead terminal. sessionId itself is re-derived from
        // pane.id at reopen; the POST body consumes cwd/sessionType/name.
        terminal:
          pane.type === 'terminal'
            ? {
                sessionId: pane.terminalSessionId,
                cwd: pane.projectPath,
                sessionType: pane.terminalType,
                name: pane.title,
              }
            : undefined,
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
      // Durable tombstone (survives the FIFO eviction above).
      recordTombstone(state, id, record.closedAt, record.seq);
      // Remove pane from group
      const idx = group.paneIds.indexOf(id);
      if (idx >= 0) group.paneIds.splice(idx, 1);
      delete state.panes[id];
      if (state.focusedPaneId === id) state.focusedPaneId = null;
      // Mirror the OPEN_PANE healing branch above: a non-default group that
      // just emptied is a ghost — keeping it leaks entries into groupOrder
      // and renders an empty tab-bar slot. `group:default` is preserved
      // even when empty because it is the app-level dispatch target.
      if (group.paneIds.length === 0 && groupId !== 'group:default') {
        delete state.groups[groupId];
        const orderIdx = state.groupOrder.indexOf(groupId);
        if (orderIdx >= 0) state.groupOrder.splice(orderIdx, 1);
      }
      break;
    }
    case 'PUSH_CLOSED_RECORD': {
      // Caller-captured record (project-inner closes — see the PaneAction
      // docstring). Strip scrollOffset like CLOSE_PANE does (device-local,
      // must not leak cross-device) and let the reducer own seq + bound.
      const { record } = action.payload;
      const { scrollOffset: _srcScroll, ...paneWithoutScroll } = record.pane;
      state.closedStack.push({
        ...record,
        pane: paneWithoutScroll,
        scrollOffset: undefined,
        seq: state.lastSeq + 1,
      });
      while (state.closedStack.length > CLOSED_STACK_MAX) state.closedStack.shift(); // FIFO
      // Durable tombstone for the project-inner close (same as CLOSE_PANE).
      recordTombstone(state, record.id, record.closedAt ?? Date.now(), record.seq ?? state.lastSeq + 1);
      break;
    }
    case 'UNDO_CLOSE': {
      undoReducer(state, action);
      break;
    }
    case 'FOCUS_PANE': {
      // FOCALIZZARE CIO' CHE E' GIA' FOCALIZZATO NON E' UN CAMBIAMENTO.
      //
      // Stessa forma della guardia in `UPDATE_PANE`, e come quella costa un
      // confronto per evitare un dispatch a vuoto: `lastSeq` sale a OGNI
      // dispatch, e chi guarda quel contatore (il middleware di sync) manda un
      // PUT da 75 KB anche quando non c'e' un byte di differenza — `focusedPaneId`
      // e' device-local e `selectSyncableSnapshot` lo toglie dallo snapshot,
      // quindi una rifocalizzazione a vuoto e' rumore puro sul filo.
      //
      // ONESTA' SU COSA QUESTA RIGA NON RISOLVE. L'ho scritta credendo fosse la
      // causa di un ciclo di PUT ricomparso dopo il rimedio a `UPDATE_PANE` (17
      // scritture in 25 s a schermo fermo, `scripts/check-idle-writes.mjs`).
      // NON lo era: strumentando il dispatcher ho contato **zero azioni** in
      // quella finestra, con quindici PUT partiti lo stesso. Quel ciclo non
      // nasce da qui e resta aperto — vedi la nota in `middleware/syncWS.ts`.
      //
      // `Object.is` e non `===`: `null` e `undefined` significano entrambi
      // «nessuna pane focalizzata» ma non sono lo stesso valore, e trattarli
      // come diversi rimetterebbe un dispatch a vuoto ogni volta che il boot
      // passa dall'uno all'altro.
      if (Object.is(state.focusedPaneId, action.payload.id)) break;
      state.focusedPaneId = action.payload.id;
      break;
    }
    case 'SPLIT':
    case 'RESIZE':
    case 'REORDER_PANES': {
      groupsReducer(state, action);
      break;
    }
    case 'SPACE_UPSERT':
    case 'SPACE_DELETE':
    case 'SET_ACTIVE_SPACE': {
      spacesReducer(state, action);
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
            stableKey: paneId,
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
      // Legacy/pre-tombstones fixtures and old persisted snapshots may lack the
      // field; the merge + strip below read it unconditionally.
      if (!state.tombstones) state.tombstones = {};
      // Validate + strip device-local fields (B3). Payload may arrive from
      // server WS, cross-tab storage, or the 500ms GET fallback — all
      // untrusted. `sanitizeSnapshot` returns null if the root shape is
      // unusable, or a safe subset with scrollOffset/focusedPaneId scrubbed.
      const clean = sanitizeSnapshot(action.payload.snapshot);
      if (!clean) break;
      // LWW gate — compare SERVER seq against SERVER seq. Without a numeric
      // server_seq we can't decide if the snapshot is newer than local state,
      // so we drop it entirely (a malformed payload must not overwrite fresh
      // local state). Audit HIGH: this gate previously compared the payload's
      // lastSeq against state.lastSeq — the LOCAL per-dispatch counter, which
      // bumps for every action including device-local FOCUS_PANE. Any burst
      // of local dispatches pushed lastSeq past the server counter and the
      // next N remote broadcasts were silently dropped (then this tab's own
      // debounced PUT reverted the other device's change for everyone).
      if (typeof clean.server_seq !== 'number') break;
      // Warm-boot escape: the boot-time localStorage hydrate may carry
      // server_seq 0 (snapshot written before the device ever synced). With
      // lastServerSeq also 0 the `<=` gate would drop it — but an empty,
      // never-server-hydrated store has nothing to protect, so let it apply.
      const isWarmBoot =
        state.lastServerSeq === 0 && Object.keys(state.panes).length === 0;
      if (clean.server_seq <= state.lastServerSeq && !isWarmBoot) break;
      // Capture local drafts BEFORE the merge. Drafts are device-local
      // pre-promotion scratch panes (mirror of the outbound stripping in
      // selectSyncableSnapshot) — a remote snapshot that doesn't know about
      // them must not erase them. Without this, a concurrent Electron client
      // PUT triggers a broadcast back to this tab whose `state.panes = clean.panes`
      // assignment wipes the locally-created draft within ~300ms of creation.
      const localDraftPanes: PaneState['panes'] = {};
      const localDraftsByGroup: Record<string, string[]> = {};
      for (const [id, pane] of Object.entries(state.panes)) {
        if (id.startsWith('draft:')) localDraftPanes[id] = pane;
      }
      if (Object.keys(localDraftPanes).length > 0) {
        for (const [gid, group] of Object.entries(state.groups)) {
          const drafts = group.paneIds.filter((id) => id.startsWith('draft:'));
          if (drafts.length > 0) localDraftsByGroup[gid] = drafts;
        }
      }
      // Cross-client UNION (was: first-server-hydrate only — steady state did a
      // wholesale replace). A remote snapshot that doesn't list a pane we hold
      // locally must NOT silently drop it — that wholesale replace IS the
      // multi-client clobber: open a project on device A and device B's stale
      // PUT closes it for everyone (desktop ⇄ PWA ⇄ a second window). We keep
      // local-only panes (the union) and let the closedStack TOMBSTONE channel
      // carry removals: a pane genuinely CLOSED on another client rides in
      // clean.closedStack and IS dropped here, so a real close still propagates
      // and a closed tab never resurrects. This tab's next debounced PUT pushes
      // the merged union back to the server.
      //
      // Drafts (device-local scratch) are preserved separately just below; this
      // block subsumes the old boot-window special case (the first hydrate is
      // simply the first union).
      // A remote close arrives as a closedStack record AND/OR a durable
      // tombstone. Consult BOTH so a durable pane whose remote closedStack
      // record already aged out of the FIFO-50 (but is still in the remote
      // tombstone map) is dropped from the union, not kept as local-only.
      // Keep the NEWEST closedAt per id — the comparison below is causal, not
      // mere membership: a marker only beats a pane whose `openedAt` predates
      // it. Tombstone retraction is a local DELETE that never crosses the
      // wire (the maps merge by union), so a peer that slept through a
      // close-then-reopen cycle still holds the dead marker; membership alone
      // let that stale marker kill the re-opened tab on every client (the
      // stale-webapp-closes-topic-tabs bug).
      // `seq` e non `closedAt`: e' la stessa correzione della meta' 2 qui sotto,
      // e va fatta su ENTRAMBE o il guasto rientra da questo lato. Si tiene il
      // seq PIU' ALTO per id — cioe' la chiusura piu' avanti nella storia
      // condivisa. `0` significa «marcatore senza seq» (legacy) e vince sempre.
      const remoteClosedSeq = new Map<string, number>();
      const bumpClosed = (id: string, seq: number): void => {
        const prev = remoteClosedSeq.get(id);
        if (prev === undefined) { remoteClosedSeq.set(id, seq); return; }
        // `0` = chiusura senza seq (marcatore legacy). E' il valore PIU' FORTE:
        // «non so quando», quindi il marcatore vince e nessun seq noto lo
        // scavalca. Fra due seq noti si tiene il piu' avanti nella storia.
        if (prev === 0 || seq === 0) { remoteClosedSeq.set(id, 0); return; }
        if (seq > prev) remoteClosedSeq.set(id, seq);
      };
      for (const r of clean.closedStack ?? []) bumpClosed(r.id, r.seq ?? 0);
      for (const [id, raw] of Object.entries(clean.tombstones ?? {})) {
        const mark = toTombstoneMark(raw);
        if (mark) bumpClosed(id, mark.seq);
      }
      const localKeptPanes: PaneState['panes'] = {};
      const localKeptByGroup: Record<string, string[]> = {};
      // Ids whose incoming marker was beaten by a local pane's newer openedAt
      // — retracted after the marker merges below, so the dead marker neither
      // survives locally nor rides our next PUT back to the peers.
      const staleMarkerIds: string[] = [];
      {
        const incomingIds = new Set(Object.keys(clean.panes ?? {}));
        for (const [id, pane] of Object.entries(state.panes)) {
          if (id.startsWith('draft:')) continue;     // re-injected separately below
          if (incomingIds.has(id)) continue;          // remote already has it
          const closedSeq = remoteClosedSeq.get(id);
          if (closedSeq !== undefined) {
            // Chiusa su un altro client → si lascia cadere, A MENO CHE questa
            // pane viva sia stata (ri)aperta DOPO quella chiusura nella storia
            // CONDIVISA — non secondo l'orologio di chi l'ha aperta. Manca uno
            // dei due seq? Vince il marcatore. Vedi `Pane.openedSeq`.
            const openedSeq = pane.openedSeq;
            if (!(typeof openedSeq === 'number' && closedSeq > 0 && openedSeq > closedSeq)) continue;
            staleMarkerIds.push(id);
          }
          localKeptPanes[id] = pane;
        }
        if (Object.keys(localKeptPanes).length > 0) {
          for (const [gid, group] of Object.entries(state.groups)) {
            const kept = group.paneIds.filter((id) => localKeptPanes[id]);
            if (kept.length > 0) localKeptByGroup[gid] = kept;
          }
        }
      }
      // Snapshot each local group's split config BEFORE the overwrite below, so
      // a group we have to recreate during re-injection (draft or local-kept,
      // when the remote snapshot omitted it) restores the user's real divider
      // position instead of resetting to the 0.5/horizontal default.
      const localGroupSplit: Record<string, { splitRatio: number; splitAxis: 'horizontal' | 'vertical' }> = {};
      // Full local paneIds order per group, captured BEFORE the wholesale
      // `state.groups = clean.groups` below. Local-kept re-injection consults it
      // so a pane we hold locally is spliced back at the ABSOLUTE position it
      // occupied here, not appended at the tail — otherwise an undo that just
      // re-slotted a tab at index 1 gets clobbered to the end by the very
      // hydrate the async unarchive kicks off (PANE-03 store-order drift).
      const localGroupOrder: Record<string, string[]> = {};
      for (const [gid, group] of Object.entries(state.groups)) {
        localGroupSplit[gid] = { splitRatio: group.splitRatio, splitAxis: group.splitAxis };
        localGroupOrder[gid] = [...group.paneIds];
      }
      // Preserve the causal open timestamp across the wholesale pane apply:
      // a peer on an older build (sanitizer without the openedAt whitelist)
      // strips the field from every pane it re-PUTs — taking its copy
      // verbatim would erase local knowledge and let a stale close marker
      // win the strip again on the next merge. Keep the NEWEST of the two
      // sides; either may have seen the more recent closed→open transition.
      const localOpenedAt = new Map<string, number>();
      // Idem per il gemello CAUSALE, e qui la posta e' piu' alta: `openedSeq` e'
      // il campo su cui la ritrattazione decide davvero, quindi perderlo in un
      // giro su un peer vecchio non degrada la precisione — spegne la regola, e
      // la pane legittimamente riaperta muore al primo marcatore stantio.
      const localOpenedSeq = new Map<string, number>();
      // `scrollOffset` is DEVICE-LOCAL: sanitizeSnapshot strips it from every
      // inbound snapshot, so the wholesale `state.panes = clean.panes` below
      // would zero the live scroll position of every open chat on every WS
      // broadcast / server hydrate. Preserve local values across the apply —
      // same pattern as `openedAt` just above.
      const localScrollOffset = new Map<string, number>();
      for (const [id, p] of Object.entries(state.panes)) {
        if (typeof p.openedAt === 'number') localOpenedAt.set(id, p.openedAt);
        if (typeof p.openedSeq === 'number') localOpenedSeq.set(id, p.openedSeq);
        if (typeof p.scrollOffset === 'number') localScrollOffset.set(id, p.scrollOffset);
      }
      if (clean.panes) {
        state.panes = clean.panes;
        for (const [id, ts] of localOpenedAt) {
          const p = state.panes[id];
          if (p && (typeof p.openedAt !== 'number' || p.openedAt < ts)) p.openedAt = ts;
        }
        for (const [id, sq] of localOpenedSeq) {
          const p = state.panes[id];
          if (p && (typeof p.openedSeq !== 'number' || p.openedSeq < sq)) p.openedSeq = sq;
        }
        for (const [id, off] of localScrollOffset) {
          const p = state.panes[id];
          if (p && typeof p.scrollOffset !== 'number') p.scrollOffset = off;
        }
      }
      if (clean.groups) state.groups = clean.groups;
      // `clean.projects` is intentionally ignored — see selectors.ts for the
      // full reasoning. The field is no longer in outbound snapshots; any
      // legacy server snapshot still carrying it is dead data.
      if (clean.groupOrder) state.groupOrder = clean.groupOrder;
      // Spazi registry: per-id LWW merge (updatedAt; deleted-tombstone wins
      // when newer) — NEVER `state.spaces = clean.spaces`, which would be the
      // exact wholesale-replace clobber the pane union above exists to
      // prevent (a space created locally inside the debounce window must
      // survive a concurrent remote PUT that doesn't know it yet).
      // `state.activeSpaceId` is untouched: device-local, and sanitizeSnapshot
      // strips any inbound value anyway.
      if (clean.spaces) state.spaces = mergeSpaces(state.spaces, clean.spaces);
      // closedStack is a TOMBSTONE log — MERGE (union by id+closedAt), never
      // replace: a close that happened on THIS client but hasn't been PUT yet
      // must not be dropped by an older incoming snapshot (which would let the
      // union above resurrect the just-closed pane). The clamp further down
      // keeps it bounded to the most-recent CLOSED_STACK_MAX.
      if (clean.closedStack) {
        const seen = new Set(state.closedStack.map((r) => `${r.id}@${r.closedAt}`));
        const merged = [...state.closedStack];
        for (const r of clean.closedStack) {
          const k = `${r.id}@${r.closedAt}`;
          if (!seen.has(k)) { seen.add(k); merged.push(r); }
        }
        merged.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
        state.closedStack = merged;
      }
      // Durable tombstone map — per-id union keeping the newest closedAt. Same
      // "MERGE, never replace" reasoning as closedStack above, but WITHOUT the
      // FIFO-50 bound: this is the marker the strip below actually consults, so
      // a durable pane closed 50+ tabs ago stays closed across a stale union.
      // A local reopen (OPEN_PANE) already deleted the id here, so the merge
      // only re-adds ids the local client hasn't retracted.
      if (clean.tombstones) {
        for (const [id, raw] of Object.entries(clean.tombstones)) {
          // `toTombstoneMark` normalizza anche la forma LEGACY (numero nudo):
          // un marcatore che arriva da un client vecchio o da uno snapshot su
          // disco scritto prima di questa change non ha `seq`, e diventa
          // `seq: 0` — cioe' «decide il marcatore».
          const mark = toTombstoneMark(raw);
          if (!mark) continue;
          recordTombstone(state, id, mark.at, mark.seq);
        }
      }
      // Bidirectional tombstone strip. The `remoteClosedIds` filter above only
      // drops a LOCAL pane the REMOTE closed; it does nothing about the reverse
      // — a stale snapshot (older cross-tab write, a warm-boot localStorage
      // read, or a second client that never learned about the close) whose
      // `clean.panes` STILL lists a pane this client already tombstoned.
      // `state.panes = clean.panes` applied it verbatim, resurrecting the
      // just-closed tab (the browser/terminal-tab reappears-after-reload bug:
      // durable pane + one-directional union). We evict every applied pane whose
      // id is tombstoned — using the DURABLE `tombstones` map, not closedStack:
      // closedStack is FIFO-bounded at 50, so after 50 further closes a durable
      // pane's record fell out and a stale peer resurrected it. `tombstones` is
      // the FIFO-independent marker and is a superset of closedStack's ids.
      //
      // A live tombstone means "closed, do not resurrect": OPEN_PANE (and every
      // reopen-history path — CLEAR_CLOSED_RECORD / UNDO_CLOSE / PANE_ID_REMAP)
      // clears it, so re-opening the SAME id on this client retracts the strip.
      // The one residual case — another client re-opens the exact same id within
      // the tombstone's lifetime while this client still holds the marker —
      // self-heals: this client's next local OPEN of that id clears it, and
      // until then a stale resurrection is the worse failure. Local drafts /
      // local-kept panes are re-injected below and are never tombstoned, so
      // they're untouched.
      {
        // Stale-marker retraction, half 1: markers beaten by a LOCAL-kept
        // pane's newer openedAt (union filter above). Runs AFTER the
        // closedStack/tombstone merges so the dead marker is purged from the
        // merged state, not resurrected by it.
        for (const id of staleMarkerIds) retractStaleMarker(state, id);
        const tombstonedIds = new Set(Object.keys(state.tombstones));
        if (tombstonedIds.size > 0) {
          for (const id of tombstonedIds) {
            const pane = state.panes[id];
            if (!pane) continue;
            // Half 2: the INCOMING (LWW-newer) snapshot lists this pane as
            // open. If its openedAt postdates the merged marker, the marker
            // is stale — a close-then-reopen cycle on another client whose
            // tombstone retraction never reached us. Retract and keep the
            // pane instead of stripping the authoritative re-open (this was
            // the strip half of the stale-webapp-closes-topic-tabs bug).
            // Il confronto e' CAUSALE, non su orologio: `openedSeq` e' quanto
            // lontano questo client aveva visto lo stato condiviso quando ha
            // aperto la pane, e `mark.seq` e' il punto in cui e' avvenuta la
            // chiusura. Un dispositivo fermo da due settimane porta un
            // `openedSeq` basso e PERDE — che e' l'esito giusto, e l'opposto di
            // cio' che faceva il confronto fra `openedAt` e `closedAt`, timbrati
            // su due macchine diverse e valutati su una terza (guasto misurato
            // il 2026-08-06: una pane chiusa il 23/07 ancora aperta su un
            // telefono, e la ritrattazione che si propagava all'indietro).
            //
            // Manca uno dei due? Il marcatore vince. Vale per le pane precedenti
            // a `openedSeq` e per i marcatori legacy senza `seq`: al massimo si
            // richiude una pane davvero riaperta — l'utente la riapre — e mai il
            // contrario, che sarebbe una resurrezione silenziosa.
            const mark = state.tombstones[id];
            const openedSeq = pane.openedSeq;
            if (typeof openedSeq === 'number' && mark.seq > 0 && openedSeq > mark.seq) {
              retractStaleMarker(state, id);
              tombstonedIds.delete(id);
              continue;
            }
            delete state.panes[id];
          }
          for (const [gid, group] of Object.entries(state.groups)) {
            const kept = group.paneIds.filter((id) => !tombstonedIds.has(id));
            if (kept.length !== group.paneIds.length) {
              group.paneIds = kept;
              // Mirror the OPEN_PANE / CLOSE_PANE ghost-group pruning: a
              // non-default group emptied purely by the strip must not leave a
              // dangling tab-bar slot + groupOrder entry.
              if (kept.length === 0 && gid !== 'group:default') {
                delete state.groups[gid];
                const orderIdx = state.groupOrder.indexOf(gid);
                if (orderIdx >= 0) state.groupOrder.splice(orderIdx, 1);
              }
            }
          }
        }
      }
      // Re-inject local drafts on top of the freshly applied snapshot. We
      // append rather than insert at a fixed index because the draft's prior
      // position is meaningful only locally and the user expects a freshly-
      // created tab to remain on the right side of the bar.
      for (const [id, pane] of Object.entries(localDraftPanes)) {
        state.panes[id] = pane;
      }
      for (const [gid, drafts] of Object.entries(localDraftsByGroup)) {
        let group = state.groups[gid];
        if (!group) {
          // The draft's group was local-only and the remote snapshot dropped it.
          // Recreate it (mirroring the local-kept path below) instead of
          // `continue`-ing — otherwise the draft pane lands in state.panes with
          // no group.paneIds entry and silently vanishes from every tab bar
          // while the user is mid-edit, exactly the erase the capture above guards against.
          const split = localGroupSplit[gid];
          group = { id: gid, paneIds: [], splitRatio: split?.splitRatio ?? 0.5, splitAxis: split?.splitAxis ?? 'horizontal' };
          state.groups[gid] = group;
          if (!state.groupOrder.includes(gid)) state.groupOrder.push(gid);
        }
        for (const draftId of drafts) {
          if (!group.paneIds.includes(draftId)) group.paneIds.push(draftId);
        }
      }
      // Re-inject local-only panes (the UNION half — see the note above).
      // Unlike drafts we recreate a missing group: these are real panes this
      // client holds that the remote snapshot didn't list — e.g. a project /
      // chat tab the user just opened here while another client's older state
      // was in flight. Spliced back at the ABSOLUTE position they held locally
      // (after the nearest surviving predecessor) rather than blindly appended:
      // appending clobbers a locally-repositioned pane — an undo that re-slotted
      // a tab at index 1 would settle at the tail once this hydrate applies, and
      // resurface appended on the next reload (PANE-03). When the group is
      // recreated wholesale (remote omitted it) there is no incoming order to
      // splice against, so the captured local order IS the order.
      for (const [gid, ids] of Object.entries(localKeptByGroup)) {
        let group = state.groups[gid];
        if (!group) {
          const split = localGroupSplit[gid];
          group = { id: gid, paneIds: [], splitRatio: split?.splitRatio ?? 0.5, splitAxis: split?.splitAxis ?? 'horizontal' };
          state.groups[gid] = group;
          if (!state.groupOrder.includes(gid)) state.groupOrder.push(gid);
        }
        const localOrder = localGroupOrder[gid] ?? [];
        for (const id of ids) {
          state.panes[id] = localKeptPanes[id];
          if (group.paneIds.includes(id)) continue;
          // Nearest preceding local neighbor that survived into the merged
          // group anchors the insert; none found → front of the group.
          const localIdx = localOrder.indexOf(id);
          let insertAt = group.paneIds.length;
          if (localIdx >= 0) {
            let anchor = -1;
            for (let i = localIdx - 1; i >= 0; i--) {
              const pos = group.paneIds.indexOf(localOrder[i]);
              if (pos >= 0) { anchor = pos; break; }
            }
            insertAt = anchor + 1;
          }
          group.paneIds.splice(insertAt, 0, id);
        }
      }
      // Defense-in-depth — sanitizer also clamps, but a test fixture or legacy
      // payload that bypasses the sanitizer must not blow up the stack. Keep
      // the tail (most recent closes) so undo still works; see sanitizeSnapshot
      // B3 for the matching rationale.
      if (state.closedStack.length > CLOSED_STACK_MAX) {
        state.closedStack = state.closedStack.slice(-CLOSED_STACK_MAX);
      }
      // focusedPaneId is DEVICE-LOCAL — sanitizeSnapshot already dropped it.
      // Advance BOTH counters monotonically: lastServerSeq is the LWW key for
      // future hydrates; lastSeq keeps the local dispatch counter ahead of
      // everything the store has seen so outbound PUTs stay fresh (store.ts
      // clamps `_seq` to this after the reducer returns).
      state.lastServerSeq = Math.max(state.lastServerSeq, clean.server_seq);
      if (typeof clean.lastSeq === 'number') {
        state.lastSeq = Math.max(state.lastSeq, clean.lastSeq);
      }
      break;
    }
    case 'CLEAR_CLOSED_RECORD': {
      // Selective removal from the closedStack. Timer cancellation lives in
      // the adapter (see useClosedTabs.removeClosedTab) so the reducer stays
      // pure — cleanupTimers is module-level state, not Immer state.
      const { id } = action.payload;
      const idx = state.closedStack.findIndex((r) => r.id === id);
      if (idx >= 0) state.closedStack.splice(idx, 1);
      // removeClosedTab fires on REOPEN (the record is consumed as the tab
      // comes back), so retract the durable tombstone too — else the reopened
      // pane would be stripped on the next union.
      clearTombstone(state, id);
      break;
    }
    case 'CLEAR_CLOSED_STACK': {
      // Empty the "recently closed" (⇧⌘T) list. Timers for terminal records are
      // cancelled by the adapter pre-dispatch; the reducer only owns the data.
      // Durable `tombstones` are DELIBERATELY kept: clearing the undo history
      // must not un-close those panes (a stale peer would resurrect them).
      state.closedStack = [];
      break;
    }
    case 'PURGE_ORPHAN_PANE': {
      // Remove an orphan pane id from `panes` AND every `groups[*].paneIds`,
      // without touching the closedStack. See PaneAction docstring on
      // PURGE_ORPHAN_PANE for the rationale (closedStack would re-introduce
      // the orphan via UNDO_CLOSE → Effect 7 → ping-pong loop).
      const { id } = action.payload;
      const wasInState =
        Boolean(state.panes[id]) ||
        Object.values(state.groups).some((g) => g.paneIds.includes(id));
      if (!wasInState) break;
      delete state.panes[id];
      for (const [gid, group] of Object.entries(state.groups)) {
        const idx = group.paneIds.indexOf(id);
        if (idx >= 0) group.paneIds.splice(idx, 1);
        // Mirror the OPEN_PANE / CLOSE_PANE healing branch: a non-default
        // group that just emptied is a ghost — drop it from groups +
        // groupOrder so the UI doesn't keep an empty tab-bar slot.
        if (group.paneIds.length === 0 && gid !== 'group:default') {
          delete state.groups[gid];
          const orderIdx = state.groupOrder.indexOf(gid);
          if (orderIdx >= 0) state.groupOrder.splice(orderIdx, 1);
        }
      }
      if (state.focusedPaneId === id) state.focusedPaneId = null;
      break;
    }
    case 'PANE_ID_REMAP': {
      const { from, to, updates } = action.payload;
      if (!state.panes[from]) break;
      // No-op: same id in/out. Defensive — call sites usually filter, but a
      // stale dispatcher tick could request from === to and corrupt
      // closedStack via the rec.id rewrite below.
      if (from === to) break;
      // Collision guard: if `to` is already a real pane (race: same topic
      // promoted twice, or remap into a pre-existing id), the previous code
      // overwrote `state.panes[to]` with a copy of `prev` — silently turning
      // the existing pane into a clone of the draft. Bail out instead so the
      // dispatcher can decide (delete + remap, or close the duplicate).
      if (state.panes[to]) break;
      // stableKey survives the remap: it's the value React uses as the tab's
      // list key, so the DOM element persists across draft → real promotion
      // (no unmount/mount = no flash). Default to the original `from` id for
      // panes that predate the field.
      const prev = state.panes[from];
      const stableKey = prev.stableKey ?? from;
      state.panes[to] = { ...prev, ...(updates ?? {}), id: to, stableKey };
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
      // `to` is now a LIVE pane — it must not be tombstoned (a terminal reopen
      // remaps the dead id to a fresh live one). Drop `from`'s marker and make
      // sure `to` carries none.
      clearTombstone(state, from);
      clearTombstone(state, to);
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

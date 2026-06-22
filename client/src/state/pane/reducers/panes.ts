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
      // Seed stableKey on first insert so PANE_ID_REMAP has something to
      // preserve. For panes that come back through hydration (sanitizeSnapshot
      // already stripped/preserved the field), we leave the existing value.
      state.panes[pane.id] = { ...pane, stableKey: pane.stableKey ?? pane.id };
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
      state.panes[id] = { ...pane, ...safe };
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
      const remoteClosedIds = new Set((clean.closedStack ?? []).map((r) => r.id));
      const localKeptPanes: PaneState['panes'] = {};
      const localKeptByGroup: Record<string, string[]> = {};
      {
        const incomingIds = new Set(Object.keys(clean.panes ?? {}));
        for (const [id, pane] of Object.entries(state.panes)) {
          if (id.startsWith('draft:')) continue;     // re-injected separately below
          if (incomingIds.has(id)) continue;          // remote already has it
          if (remoteClosedIds.has(id)) continue;      // closed on another client → drop
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
      for (const [gid, group] of Object.entries(state.groups)) {
        localGroupSplit[gid] = { splitRatio: group.splitRatio, splitAxis: group.splitAxis };
      }
      if (clean.panes) state.panes = clean.panes;
      if (clean.groups) state.groups = clean.groups;
      // `clean.projects` is intentionally ignored — see selectors.ts for the
      // full reasoning. The field is no longer in outbound snapshots; any
      // legacy server snapshot still carrying it is dead data.
      if (clean.groupOrder) state.groupOrder = clean.groupOrder;
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
      // was in flight. Appended so a freshly-opened local tab stays on the
      // right of the bar.
      for (const [gid, ids] of Object.entries(localKeptByGroup)) {
        let group = state.groups[gid];
        if (!group) {
          const split = localGroupSplit[gid];
          group = { id: gid, paneIds: [], splitRatio: split?.splitRatio ?? 0.5, splitAxis: split?.splitAxis ?? 'horizontal' };
          state.groups[gid] = group;
          if (!state.groupOrder.includes(gid)) state.groupOrder.push(gid);
        }
        for (const id of ids) {
          state.panes[id] = localKeptPanes[id];
          if (!group.paneIds.includes(id)) group.paneIds.push(id);
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
      break;
    }
    case 'CLEAR_CLOSED_STACK': {
      // Empty the stack. Timers for terminal records are cancelled by the
      // adapter pre-dispatch; the reducer only owns the data.
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
      // Also strip the orphan from any project layout that referenced it
      // (project-layout-* persist `panes` + `groupOrder` + `tabOrder` +
      // `focusedPaneId`, all of which can carry the orphan id).
      for (const layout of Object.values(state.projects)) {
        if (layout.panes[id]) delete layout.panes[id];
        for (const g of layout.groups) {
          const i = g.paneIds.indexOf(id);
          if (i >= 0) g.paneIds.splice(i, 1);
        }
        const tabIdx = layout.tabOrder.indexOf(id);
        if (tabIdx >= 0) layout.tabOrder.splice(tabIdx, 1);
        if (layout.focusedPaneId === id) layout.focusedPaneId = null;
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

import type { AppContext } from "../types";
import type { ReopenTopicDeps } from "../services/archive-topic";
import { purgeTopicBrowserState } from "../services/topic-browser-teardown";
import { clearRetirement } from "../services/retirement";

/**
 * Remove a topic id from every ui_state record's `openChatTopicIds` array,
 * across all clients. Called when a topic is archived or deleted to prevent
 * phantom ids from lingering in per-project persisted tab state.
 *
 * The read-modify-write is wrapped in a transaction so concurrent writes from
 * clients (debounced ui_state PUTs) can't interleave and lose the purge.
 * Broadcasts are collected and emitted AFTER the transaction commits so
 * clients never see a mutation that was subsequently rolled back.
 */
/**
 * Remove every reference to `topicId` from a single ui_state record value,
 * mutating `parsed` in place. Returns true iff something changed.
 *
 * Handles BOTH persisted shapes that can hold an open chat:
 *  - Project / legacy tab-identity records: `{ openChatTopicIds: string[],
 *    activeChatTopicId? }` (written by the project-window layout sync).
 *  - The single global `pane-store-v2` snapshot: `{ panes, groups, closedStack }`,
 *    where a top-level chat pane is keyed by the RAW topic id
 *    (`createPaneId('chat', id) === id`).
 *
 * Why both: before this, the purge only filtered `openChatTopicIds`, which the
 * current `pane-store-v2` snapshot does NOT contain. So archiving/deleting a
 * chat removed it from project records but NEVER from `pane-store-v2` — the
 * pane lingered in the single shared snapshot and resurfaced as a phantom tab
 * on any client that didn't independently filter it (the "ghost tab on mobile"
 * bug). Now the shared snapshot is purged too, with a fresh server_seq so LWW
 * treats the removal as newer than any pre-purge client write.
 */
/** Mirror of the client's `TOMBSTONES_MAX` (client/src/state/pane/types.ts). */
const TOMBSTONES_MAX = 500;

export function removeTopicFromUiStateValue(parsed: any, topicId: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  let changed = false;

  // Shape A — project / legacy tab-identity records.
  if (Array.isArray(parsed.openChatTopicIds) && parsed.openChatTopicIds.includes(topicId)) {
    parsed.openChatTopicIds = parsed.openChatTopicIds.filter((id: string) => id !== topicId);
    changed = true;
  }
  if (parsed.activeChatTopicId === topicId) {
    delete parsed.activeChatTopicId;
    changed = true;
  }

  // Shape B — pane-store-v2 snapshot (panes / groups / closedStack).
  const removedPaneIds = new Set<string>();
  if (parsed.panes && typeof parsed.panes === "object" && !Array.isArray(parsed.panes)) {
    for (const [pid, p] of Object.entries(parsed.panes as Record<string, any>)) {
      if (pid === topicId || (p && typeof p === "object" && (p as any).topicId === topicId)) {
        removedPaneIds.add(pid);
      }
    }
    for (const pid of removedPaneIds) {
      delete (parsed.panes as Record<string, any>)[pid];
      changed = true;
    }
  }
  if (parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)) {
    for (const g of Object.values(parsed.groups as Record<string, any>)) {
      if (g && Array.isArray(g.paneIds)) {
        const filtered = g.paneIds.filter((id: string) => id !== topicId && !removedPaneIds.has(id));
        if (filtered.length !== g.paneIds.length) {
          g.paneIds = filtered;
          changed = true;
        }
      }
      // Defensive only: the current synced pane-store-v2 Group shape carries no
      // `activePaneId` (active pane is derived at render time, never persisted),
      // so this never fires for real data — it's a no-op guard for legacy/demo
      // group shapes that did carry it. Kept for parity with the orphan-cleanup
      // backstop; safe because `Set.has(undefined)` is false.
      if (g && typeof g === "object" && removedPaneIds.has((g as any).activePaneId)) {
        delete (g as any).activePaneId;
        changed = true;
      }
    }
  }
  // THE UNDO RECORD STAYS, AND ITS ID IS STAMPED AS CLOSED.
  //
  // Until 2026-08-19 this line DELETED the record, and that is the chain that
  // emptied `closedStack` after a real close:
  //
  //   someone closes a chat tab
  //     → the reducer puts the undo record in `closedStack` and PUTs
  //     → the retirement cascade archives that topic (`retirement.ts`, «tab-close»)
  //     → `archiveTopicFully` calls this purge
  //     → the record just created vanishes, and the tombstone below does not
  //       replace it, because it looks at `removedPaneIds` — i.e. the panes
  //       taken out of `panes`, and a pane already closed is no longer there.
  //
  // Measured result: after a close, the close leaves NO trace — neither the
  // record nor the marker. `pane-undo.spec.ts` saw it («closedStack must have at
  // least one entry after CLOSE_PANE») and stayed green anyway, because the
  // idle write loop resent the state a moment later and put the record back. So
  // one defect was propped up by another: the fix for the loop (branch
  // `wip/ciclo-scritture-localseq`) made this one surface, and that is why it
  // stayed out of main.
  //
  // WHY DELETING IT WAS NOT NEEDED. The defect this purge guards against is the
  // GHOST TAB — an archived chat reappearing open on another device — and that
  // one lives in `panes`, which is still cleaned above. `closedStack` reopens
  // nothing: on the client it feeds `bumpClosed` (`reducers/panes.ts`), exactly
  // the same CLOSE signal the tombstones carry. Removing it from there did not
  // prevent a resurrection, it deleted an undo.
  //
  // And the marker is printed all the same: `id` goes into `removedPaneIds`, so
  // the block below stamps it as if the pane had been removed now. That way a
  // peer that still had that tab open drops it — the protection is intact — and
  // the undo survives.
  if (Array.isArray(parsed.closedStack)) {
    for (const rec of parsed.closedStack as any[]) {
      if (!rec || !rec.pane) continue;
      if (rec.pane.id === topicId || rec.pane.topicId === topicId) {
        removedPaneIds.add(rec.pane.id);
      }
    }
  }

  // Durable close MARKER for every pane we just deleted. Deleting the entry is
  // NOT enough: the client's HYDRATE_FROM_SNAPSHOT does a cross-client UNION
  // (reducers/panes.ts — "we let the closedStack TOMBSTONE channel carry
  // removals"), so a pane that a live client still holds locally and that the
  // incoming snapshot merely OMITS is kept, not dropped — a bare deletion is
  // structurally indistinguishable from "this peer never knew about it". So the
  // purge was silently undone: the archived chat rode the client's next
  // debounced PUT straight back into the shared snapshot (measured: server
  // purge at seq N, resurrection at seq N+1 ~1s later), and the re-add was then
  // mistaken for a preview-navigation, which closed a BYSTANDER tab.
  // `tombstones` is the map that union actually consults; its causal guard
  // (`openedAt > closedAt`) keeps a genuine later reopen alive, so stamping now
  // can't kill a tab the user re-opens afterwards.
  if (removedPaneIds.size > 0) {
    if (!parsed.tombstones || typeof parsed.tombstones !== "object" || Array.isArray(parsed.tombstones)) {
      parsed.tombstones = {};
    }
    const closedAt = Date.now();
    for (const pid of removedPaneIds) parsed.tombstones[pid] = closedAt;
    // Mirror the client's TOMBSTONES_MAX cap (state/pane/types.ts) so a
    // long-lived DB can't grow the map without bound: keep the newest ids.
    const ids = Object.keys(parsed.tombstones);
    if (ids.length > TOMBSTONES_MAX) {
      const keep = new Set(
        ids.sort((a, b) => (parsed.tombstones[b] ?? 0) - (parsed.tombstones[a] ?? 0)).slice(0, TOMBSTONES_MAX),
      );
      for (const id of ids) if (!keep.has(id)) delete parsed.tombstones[id];
    }
    changed = true;
  }

  return changed;
}

/**
 * Retract the durable close markers this topic's panes may carry — the exact
 * inverse of the tombstone stamping in `removeTopicFromUiStateValue`.
 *
 * Required for symmetry: the client's hydrate runs a BIDIRECTIONAL tombstone
 * strip (reducers/panes.ts), so a pane listed in the incoming snapshot is
 * DELETED whenever a live tombstone claims its id. Stamping on archive without
 * retracting on unarchive therefore makes the reopen invisible — the chat comes
 * back in the topic list but its tab is stripped on every hydrate, forever.
 * Matches both pane-id encodings for a chat: the raw topic id
 * (`createPaneId('chat', id) === id`) and any `<prefix>:<topicId>` form.
 */
export function retractTopicTombstoneFromUiStateValue(parsed: any, topicId: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const tomb = parsed.tombstones;
  if (!tomb || typeof tomb !== "object" || Array.isArray(tomb)) return false;
  let changed = false;
  for (const key of Object.keys(tomb)) {
    if (key === topicId || key.endsWith(`:${topicId}`)) {
      delete tomb[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Apply `mutate` to every ui_state record, persisting + broadcasting only the
 * ones it actually changed. Shared by the archive purge and the unarchive
 * retraction so both inherit the same seq allocation and locking discipline.
 */
function mutateAllUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  label: string,
  topicId: string,
  mutate: (parsed: any, topicId: string) => boolean,
): { ok: true } | { ok: false; error: string } {
  // Phase 30 PANE-02 invariant: every ui_state write must allocate a fresh
  // server_seq so cross-device LWW treats this purge as newer than any
  // pre-purge snapshot. Without this bump, a later client PUT carrying an
  // older seq could silently win and re-introduce the purged topic.
  //
  // Race-fix (round-6 audit): mirrors the BEGIN IMMEDIATE pattern used in
  // server/routes/ui-state.ts (single-key PUT L74-90, bulk PUT L107-126). The
  // previous implementation used db.transaction() (DEFERRED) plus three
  // redundant `SELECT MAX(server_seq)` subqueries per row (INSERT VALUES,
  // ON CONFLICT SET, and a separate readback), so a concurrent PUT could
  // snapshot the same MAX and collide on seq. Now: acquire RESERVED lock at
  // BEGIN via .immediate(), read MAX once, allocate N distinct seqs with a
  // counter, and bind nextSeq as a parameter (no more subqueries). The allocated
  // seq is returned from the txn, eliminating the separate readback SELECT.
  let broadcasts: { key: string; value: any; server_seq: number }[] = [];
  try {
    broadcasts = db.transaction(() => {
      const out: { key: string; value: any; server_seq: number }[] = [];
      const rows = db.query("SELECT key, value FROM ui_state").all() as { key: string; value: string }[];
      const { maxSeq } = db.query(
        "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
      ).get() as { maxSeq: number };
      let i = 0;
      for (const row of rows) {
        let parsed: any;
        try { parsed = JSON.parse(row.value); } catch { continue; }
        if (!mutate(parsed, topicId)) continue;
        const next = JSON.stringify(parsed);
        const nextSeq = maxSeq + (++i);
        db.run(
          `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
           VALUES (?, ?, 2, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             payload_version = 2,
             server_seq = excluded.server_seq,
             updated_at = datetime('now')`,
          [row.key, next, nextSeq],
        );
        out.push({ key: row.key, value: parsed, server_seq: nextSeq });
      }
      return out;
    }).immediate();
  } catch (err) {
    // Bug #12 (round-7 hardening): do NOT swallow. A silent failure here leaves
    // the ui_state record stale so the archived topic id "resurrects" on the
    // next reload — the ghost-topic bug. Log structured + propagate so the
    // caller can surface it to the client (500) instead of returning 200 OK
    // while the server state is incoherent.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[topics] ${label} failed for topicId=${topicId}:`, { error: message, stack: err instanceof Error ? err.stack : undefined });
    return { ok: false, error: message };
  }
  for (const b of broadcasts) {
    broadcastToAll({
      type: "ui-state:updated",
      key: b.key,
      value: b.value,
      payload_version: 2,
      server_seq: b.server_seq,
    });
  }
  return { ok: true };
}

/** Archive/delete: strip the topic from every ui_state record + tombstone it.
 *  Esportata perché `archiveTopicFully` (services/archive-topic.ts) la riceve
 *  iniettata: il servizio non può importare da `routes/` senza invertire gli
 *  strati, ma questo è il passo 3 dell'archiviazione e deve restare uno solo.
 *
 *  Two different gestures, one door. The shared records are REWRITTEN without
 *  the topic; the row the topic OWNS — `topic-browser:<topicId>`, its browser
 *  window — is deleted, because there is nothing in it to rewrite and a
 *  per-topic row that survives its topic grows forever
 *  (`services/topic-browser-teardown.ts`). The delete runs first: if the
 *  rewrite throws, the caller turns it into a 500 and retries the whole purge,
 *  and dropping the row is idempotent. */
export function purgeTopicFromUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  topicId: string,
  destroyContext?: (contextId: string) => Promise<void> | void,
): { ok: true } | { ok: false; error: string } {
  purgeTopicBrowserState({ db, broadcastToAll, destroyContext }, [topicId]);
  return mutateAllUiState(db, broadcastToAll, "purgeTopicFromUiState", topicId, removeTopicFromUiStateValue);
}

/**
 * Unarchive: retract the close markers left by the purge. Best-effort by
 * design — unlike the purge, a failure here can't leave the topic in a
 * half-archived state, so it must never turn a successful unarchive into a
 * 500. The retraction is idempotent, so the next unarchive retries it.
 */
export function restoreTopicInUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  topicId: string,
): void {
  mutateAllUiState(db, broadcastToAll, "restoreTopicInUiState", topicId, retractTopicTombstoneFromUiStateValue);
}

/** What `reopenTopicFully` needs, bound once: the unarchive route and a sub-agent's resume share it. */
export function reopenDepsFor(ctx: Pick<AppContext, "db" | "getTopicById" | "saveSingleTopic">, broadcastToAll: ReopenTopicDeps["broadcastToAll"]): ReopenTopicDeps {
  return {
    getTopicById: ctx.getTopicById,
    saveSingleTopic: ctx.saveSingleTopic,
    broadcastToAll,
    restoreInUiState: (topicId) => restoreTopicInUiState(ctx.db, broadcastToAll, topicId),
    clearRetirement: (topicId) => { clearRetirement(ctx.db, "topic", topicId); },
  };
}

import type { Database } from "bun:sqlite";

/**
 * Relocate a Claude Code TERMINAL tab into a project window, server-side and
 * de-duplicated. Shared core of POST /api/sessions/:sessionKey/move-to-project
 * AND the terminal-tab fallback of the open-project / create-project handlers
 * (a terminal tab has no chat topic, so bindTopicToProject can't move it — the
 * pane lives in the app-level `pane-store-v2`, not in a topic).
 *
 * `projectDir` MUST already be a resolved, existing directory (callers resolve
 * it with resolveProjectRef before calling). Steps:
 *   1. splice the pane out of the app-level standalone store (`pane-store-v2`:
 *      its `panes` entry + every `groups.*.paneIds` ref), capturing its full
 *      pane object so the project membership carries the same shape — AND
 *      write a durable TOMBSTONE for it. The client hydrate is a
 *      union-with-tombstones (reducers/panes.ts HYDRATE_FROM_SNAPSHOT): any
 *      local-only pane the incoming snapshot doesn't mark in
 *      closedStack/tombstones is KEPT and re-persisted, so a bare removal is
 *      unwinnable against live clients — the moved tab came straight back and
 *      sat duplicated standalone+project (closing either killed the shared
 *      session, so both vanished together). The tombstone makes the union drop
 *      it everywhere; a legitimate later re-open clears it (OPEN_PANE deletes
 *      the entry).
 *   2. add it to the project's server-synced membership
 *      (`topics-project-panes-<projectHash(dir)>` → `nonChatPanes`), idempotent;
 *   3. persist both ui_state writes with a fresh monotonic server_seq (BEGIN
 *      IMMEDIATE so two writers can't collide on seq) and broadcast each so
 *      live clients converge to exactly ONE instance.
 *
 * Does NOT broadcast `open-project` — the caller owns focus semantics. Device-
 * local split geometry (`project-layout-<hash>`) is untouched.
 */
export function moveTerminalPaneToProject(
  db: Database,
  broadcastToAll: (msg: object) => void,
  term: { id: string; name?: string },
  projectDir: string,
): { paneId: string; membershipKey: string } {
  const paneId = `terminal:${term.id}`;

  // djb2 — MUST match client projectHash() in
  // client/src/state/pane/adapters/projectLayoutSync.ts so the membership key
  // lines up with what the renderer reads.
  const projectHash = (p: string): string => {
    let h = 0;
    for (let i = 0; i < p.length; i++) { h = p.charCodeAt(i) + ((h << 5) - h); h = h & h; }
    return Math.abs(h).toString(36);
  };
  const membershipKey = `topics-project-panes-${projectHash(projectDir)}`;
  const APP_KEY = "pane-store-v2";

  const readUi = (key: string): Record<string, unknown> | null => {
    const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try { return JSON.parse(row.value) as Record<string, unknown>; } catch { return null; }
  };
  // Read-modify-write MUST be atomic: the reads below (APP_KEY, membershipKey)
  // and the writes run inside ONE `BEGIN IMMEDIATE` txn so a concurrent
  // ui-state PUT can't land between the read and the commit and get silently
  // reverted (this write always wins on server_seq regardless of when it
  // read). IMMEDIATE takes a RESERVED lock at txn start, so a second writer
  // blocks until we commit and then reads our updated rows. Mirrors the
  // single-transaction pattern in purgeTopicFromUiState.
  const stamped = db.transaction(() => {
    const writes: Array<{ key: string; value: unknown }> = [];

    // 1. Splice the pane out of the app-level standalone store, capturing its
    //    full pane object so the project membership carries the same shape.
    let paneObj: Record<string, unknown> | null = null;
    const app = readUi(APP_KEY);
    if (app) {
      const panes = app.panes as Record<string, Record<string, unknown>> | undefined;
      if (panes && panes[paneId]) {
        const { scrollOffset: _drop, ...rest } = panes[paneId];
        paneObj = rest;
        delete panes[paneId];
      }
      const groups = app.groups as Record<string, { paneIds?: string[] }> | undefined;
      if (groups) {
        for (const g of Object.values(groups)) {
          if (g && Array.isArray(g.paneIds)) g.paneIds = g.paneIds.filter((x) => x !== paneId);
        }
      }
      // Durable removal marker — see the header. Shape mirrors the client's
      // `tombstones: Record<paneId, closedAt-ms>`; newest wins on merge.
      const tombs = (app.tombstones && typeof app.tombstones === "object"
        ? app.tombstones
        : {}) as Record<string, number>;
      tombs[paneId] = Date.now();
      app.tombstones = tombs;
      writes.push({ key: APP_KEY, value: app });
    }

    // 2. Add the pane to the project's server-synced membership (idempotent).
    const mem = (readUi(membershipKey) as { nonChatPanes?: unknown[]; openChatTopicIds?: unknown[] } | null)
      || { nonChatPanes: [], openChatTopicIds: [] };
    if (!Array.isArray(mem.nonChatPanes)) mem.nonChatPanes = [];
    if (!Array.isArray(mem.openChatTopicIds)) mem.openChatTopicIds = [];
    if (!mem.nonChatPanes.some((p) => (p as { id?: string })?.id === paneId)) {
      mem.nonChatPanes.push(paneObj || { id: paneId, type: "terminal", title: term.name || "Claude Code", preview: false, terminalType: "claude-code" });
    }
    writes.push({ key: membershipKey, value: mem });

    // 3. Persist with fresh monotonic server_seq each, then return them for
    //    broadcast after the txn commits.
    const out: Array<{ key: string; value: unknown; seq: number }> = [];
    for (const w of writes) {
      const { maxSeq } = db.query("SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state").get() as { maxSeq: number };
      const seq = maxSeq + 1;
      db.run(
        `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
         VALUES (?, ?, 2, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, payload_version = 2,
           server_seq = excluded.server_seq, updated_at = datetime('now')`,
        [w.key, JSON.stringify(w.value), seq],
      );
      out.push({ key: w.key, value: w.value, seq });
    }
    return out;
  }).immediate() as Array<{ key: string; value: unknown; seq: number }>;

  for (const s of stamped) {
    broadcastToAll({ type: "ui-state:updated", key: s.key, value: s.value, payload_version: 2, server_seq: s.seq });
  }
  return { paneId, membershipKey };
}

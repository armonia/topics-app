/**
 * `ui_state` orphan-reference cleanup — boot-time defence.
 *
 * Symptom this prevents (post-mortem from the May 3 incident): the
 * `pane-store-v2` (and `project-layout-*`) keys can persist topic UUIDs
 * that point at topics whose `project_path` is set. The renderer's
 * `usePanelLifecycle.ts` Effect 7 then refuses to keep those topics in
 * `openPanels` (because topic-with-projectPath must render as a project
 * pane, not as a standalone topic-pane), but the WS hydrate keeps
 * re-applying them from the server. Result: an Effect 7 ↔ HYDRATE
 * ping-pong that toggles the topic's `class` ~750×/s and visually
 * "flashes" the sidebar tree.
 *
 * The proper fix is in the renderer (Effect 7 must also dispatch
 * `PURGE_ORPHAN_PANE` so the removal lands in the store). This module
 * is the boot-time backstop: if a previous version of the renderer
 * left the database in a corrupt state, a single restart cleans it
 * automatically without losing any data.
 *
 * What counts as "orphan":
 *   · A topic UUID that appears in any field of any `ui_state.value`
 *     (recursively: array element, object key, scalar value), AND
 *   · The corresponding `topics` row exists AND has `project_path` set
 *     AND is not archived.
 *
 * Cleanup walks every key, builds a cleaned copy of the value, and if
 * it changed writes it back with a fresh `server_seq` (LWW invariant
 * preserved — the same `BEGIN IMMEDIATE` + `MAX(server_seq) + 1`
 * pattern as `purgeTopicFromUiState`).
 */
import type { Database } from "bun:sqlite";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCALAR_REF_FIELDS = [
  "activeChatTopicId",
  "activePaneId",
  "focusedPaneId",
  "focusedTopicId",
  "activeTopicId",
] as const;

interface CleanupReport {
  /** Number of `ui_state` rows that were rewritten. */
  rowsAffected: number;
  /** Total orphan references stripped (across all rows + all locations). */
  refsRemoved: number;
  /** Per-key breakdown for logs / tests. */
  perKey: Array<{ key: string; removed: number }>;
}

/**
 * Strip every orphan UUID from a parsed `ui_state.value`.
 *
 * - Drops orphan IDs from arrays.
 * - Drops object entries whose key OR `.id` field is an orphan UUID
 *   (covers the `panes: { <UUID>: { id: <UUID>, … } }` shape inside
 *   `pane-store-v2`).
 * - Nulls scalar fields named in {@link SCALAR_REF_FIELDS}.
 *
 * Returns a `{ value, removed }` tuple. `removed === 0` ⇒ caller
 * skips the write (no `server_seq` burn for no-op).
 */
function stripOrphans(input: unknown, orphans: ReadonlySet<string>): { value: unknown; removed: number } {
  let removed = 0;

  const recurse = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const next: unknown[] = [];
      for (const item of v) {
        if (typeof item === "string" && orphans.has(item)) {
          removed++;
          continue;
        }
        // Drop array elements whose `.id` is an orphan (covers
        // `closedStack: [{ id: <orphan>, … }]` inside pane-store-v2).
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const id = (item as { id?: unknown }).id;
          if (typeof id === "string" && orphans.has(id)) {
            removed++;
            continue;
          }
        }
        next.push(recurse(item));
      }
      return next;
    }
    if (v && typeof v === "object") {
      const next: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // Drop entries keyed by an orphan UUID (e.g. `panes: { <orphan>: ... }`)
        if (UUID_RE.test(k) && orphans.has(k)) {
          removed++;
          continue;
        }
        // Drop entries whose `.id` is an orphan (e.g. ClosedPaneRecord)
        if (val && typeof val === "object") {
          const id = (val as { id?: unknown }).id;
          if (typeof id === "string" && orphans.has(id)) {
            removed++;
            continue;
          }
        }
        // Null scalar pointer fields
        if (
          (SCALAR_REF_FIELDS as readonly string[]).includes(k) &&
          typeof val === "string" &&
          orphans.has(val)
        ) {
          next[k] = null;
          removed++;
          continue;
        }
        next[k] = recurse(val);
      }
      return next;
    }
    return v;
  };

  return { value: recurse(input), removed };
}

/**
 * Boot-time cleanup. Idempotent: if the database is already clean it
 * runs in O(rows × topics) but writes nothing. Safe to call on every
 * server boot.
 *
 * @param db The open `bun:sqlite` Database instance.
 * @returns A report you can log + assert on in tests.
 */
export function purgeOrphanTopicRefs(db: Database): CleanupReport {
  // Find the orphan candidate set: active topics with a non-empty project_path.
  const orphans = new Set(
    (db
      .query(
        `SELECT id FROM topics WHERE project_path IS NOT NULL AND project_path != '' AND archived = 0`,
      )
      .all() as { id: string }[]).map((r) => r.id),
  );
  if (orphans.size === 0) {
    return { rowsAffected: 0, refsRemoved: 0, perKey: [] };
  }

  const rows = db.query(`SELECT key, value FROM ui_state`).all() as {
    key: string;
    value: string;
  }[];

  // Plan all rewrites first; commit in a single BEGIN IMMEDIATE txn so
  // the cross-row server_seq sequence is monotonic and atomic with any
  // concurrent client PUT (mirrors purgeTopicFromUiState in
  // routes/topics.ts:23-94).
  const plans: Array<{ key: string; nextValue: string; removed: number }> = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const { value: cleaned, removed } = stripOrphans(parsed, orphans);
    if (removed > 0) {
      plans.push({ key: row.key, nextValue: JSON.stringify(cleaned), removed });
    }
  }

  if (plans.length === 0) {
    return { rowsAffected: 0, refsRemoved: 0, perKey: [] };
  }

  const txn = db.transaction(() => {
    const baseSeq =
      (db.query(`SELECT COALESCE(MAX(server_seq), 0) AS m FROM ui_state`).get() as {
        m: number;
      }).m;
    for (let i = 0; i < plans.length; i++) {
      const { key, nextValue } = plans[i];
      const nextSeq = baseSeq + 1 + i;
      db.run(
        `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
         VALUES (?, ?, 2, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           payload_version = 2,
           server_seq = excluded.server_seq,
           updated_at = datetime('now')`,
        [key, nextValue, nextSeq],
      );
    }
  });
  txn.immediate();

  return {
    rowsAffected: plans.length,
    refsRemoved: plans.reduce((s, p) => s + p.removed, 0),
    perKey: plans.map((p) => ({ key: p.key, removed: p.removed })),
  };
}

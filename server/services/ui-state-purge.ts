/**
 * `ui_state` purge helpers — keep the LWW invariant intact when a
 * referenced entity is deleted.
 *
 * Phase 30 PANE-02 invariant (preserved verbatim from
 * `server/routes/topics.ts:purgeTopicFromUiState`): every ui_state write
 * MUST allocate a fresh `server_seq` so cross-device LWW treats this
 * purge as newer than any pre-purge snapshot. Without the bump, a later
 * client PUT carrying an older seq could silently win and re-introduce
 * the purged reference.
 *
 * Race-fix: BEGIN IMMEDIATE acquires the RESERVED lock at txn start so
 * concurrent PUTs cannot interleave. We read `MAX(server_seq)` once,
 * allocate distinct seqs with a counter, and write `payload_version: 2`
 * on every row touched.
 *
 * `purgeWorktreeFromUiState` is the worktree-scoped sibling of
 * `purgeTopicFromUiState` (Phase A · WORKTREE-03 in
 * `openspec/changes/add-project-worktree-domain/specs/worktrees/spec.md`).
 *
 * The set of ui_state keys that may carry worktree references is open
 * for future extension. Today (Phase A · §13 IA) the only known callers
 * are the New Topic dialog and the Topic Settings modal — neither of
 * which persists worktree IDs in ui_state. The function is wired up
 * pre-emptively so that as soon as a future phase introduces (e.g.)
 * `openWorktreeIds` or `activeWorktreeId` to a pane-store snapshot, the
 * cleanup is already in place. The function is conservative: only
 * known-shape arrays/scalars are mutated; everything else is left
 * untouched.
 */
import type { Database } from "bun:sqlite";
import type { OutboundMessage } from "../../shared/ws-outbound";

type Broadcaster = (msg: OutboundMessage) => void;

interface PurgeResult {
  ok: true;
  /** Number of `ui_state` rows that were rewritten. */
  rowsAffected: number;
}
type PurgeError = { ok: false; error: string };

/**
 * Strip `worktreeId` from any ui_state row that holds it.
 *
 * Recognised shapes (open for extension):
 *   - `parsed.openWorktreeIds: string[]`     → filter the array
 *   - `parsed.activeWorktreeId === id`       → delete the property
 *   - `parsed.worktreeIdsByPane: Record<string, string>` → drop entries pointing at id
 *
 * Unknown keys are left alone. We only rewrite a row if its content
 * actually changes — no-op rows do not consume a `server_seq`.
 *
 * @param db          The bun:sqlite database singleton.
 * @param broadcastToAll Called outside the transaction with one
 *                    `ui-state:updated` envelope per rewritten row.
 * @param worktreeId  The id being deleted.
 */
export function purgeWorktreeFromUiState(
  db: Database,
  broadcastToAll: Broadcaster,
  worktreeId: string,
): PurgeResult | PurgeError {
  let broadcasts: { key: string; value: any; server_seq: number }[] = [];
  try {
    broadcasts = db.transaction(() => {
      const out: { key: string; value: any; server_seq: number }[] = [];
      const rows = db
        .query("SELECT key, value FROM ui_state")
        .all() as { key: string; value: string }[];
      const { maxSeq } = db.query(
        "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
      ).get() as { maxSeq: number };
      let i = 0;
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        let mutated = false;

        if (Array.isArray(parsed.openWorktreeIds)) {
          const next = parsed.openWorktreeIds.filter(
            (id: unknown) => id !== worktreeId,
          );
          if (next.length !== parsed.openWorktreeIds.length) {
            parsed.openWorktreeIds = next;
            mutated = true;
          }
        }

        if (parsed.activeWorktreeId === worktreeId) {
          delete parsed.activeWorktreeId;
          mutated = true;
        }

        if (parsed.worktreeIdsByPane && typeof parsed.worktreeIdsByPane === "object") {
          for (const k of Object.keys(parsed.worktreeIdsByPane)) {
            if (parsed.worktreeIdsByPane[k] === worktreeId) {
              delete parsed.worktreeIdsByPane[k];
              mutated = true;
            }
          }
        }

        if (!mutated) continue;

        const nextValue = JSON.stringify(parsed);
        const nextSeq = maxSeq + (++i);
        db.run(
          `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
           VALUES (?, ?, 2, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             payload_version = 2,
             server_seq = excluded.server_seq,
             updated_at = datetime('now')`,
          [row.key, nextValue, nextSeq],
        );
        out.push({ key: row.key, value: parsed, server_seq: nextSeq });
      }
      return out;
    }).immediate();
  } catch (err) {
    // Mirror the topic purge: do NOT swallow. The caller (DELETE worktree
    // route) should surface a 500 instead of returning 200 with an
    // incoherent server state.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ui-state-purge] purgeWorktreeFromUiState failed for worktreeId=${worktreeId}:`,
      { error: message, stack: err instanceof Error ? err.stack : undefined },
    );
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
  return { ok: true, rowsAffected: broadcasts.length };
}

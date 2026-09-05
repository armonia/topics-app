/**
 * Boot-time repair of the pane store already on disk: raw project paths become
 * canonical, and the per-project rows follow.
 *
 * WHY AT BOOT, IN JS, AND NOT AS A SQL MIGRATION. The per-project key
 * `topics-project-panes-<hash>` is a hash of the path: the server cannot
 * invert it. It can only be renamed while the raw path is still readable in
 * the `pane-store-v2` snapshot, and resolving that path needs `realpathSync`,
 * which SQL does not have. Same seam as `ui-state-orphan-cleanup.ts`: the
 * runtime canonicalisation on read (`routes/ui-state.ts`) is the primary
 * defence, this is the one-off that fixes what an older build already wrote.
 *
 * WHY THE ROW GETS A FRESH `server_seq`. The client's hydrate gate drops any
 * snapshot whose seq it has already seen. A repaired row served at the OLD seq
 * would be ignored by every device that had synced before the restart, and
 * the first debounced PUT from one of them would write the raw pane back,
 * undoing the repair. A rewrite is a write: it takes the next seq like any
 * other.
 *
 * ONE transaction, idempotent: a second run finds no raw path and does nothing.
 */
import type { Database } from "bun:sqlite";
import { canonicalProjectPath } from "../lib/canonical-project-path";
import { canonicalPaneSnapshot, projectPanesKeyRenames, type ProjectPathPair, type UiStateKeyRename } from "../lib/canonical-pane-state";
import { PANE_STORE_KEY } from "../routes/ui-state";

export interface CanonicalRepairReport {
  pairs: ProjectPathPair[];
  /** Per-project rows moved under the canonical key. */
  renamed: UiStateKeyRename[];
  /** Raw per-project rows discarded because the canonical row already existed. */
  dropped: string[];
}

export function repairCanonicalPaneState(
  db: Database,
  canon: (p: string) => string = canonicalProjectPath,
  now: number = Date.now(),
): CanonicalRepairReport {
  const empty: CanonicalRepairReport = { pairs: [], renamed: [], dropped: [] };
  const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(PANE_STORE_KEY) as { value: string } | null;
  if (!row) return empty;
  let parsed: unknown;
  try { parsed = JSON.parse(row.value); } catch { return empty; }

  const { value, pairs } = canonicalPaneSnapshot(parsed, canon, now);
  if (pairs.length === 0) return empty;

  const report: CanonicalRepairReport = { pairs, renamed: [], dropped: [] };
  db.transaction(() => {
    const { maxSeq } = db.query("SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state").get() as { maxSeq: number };
    db.run(
      "UPDATE ui_state SET value = ?, payload_version = 2, server_seq = ?, updated_at = datetime('now') WHERE key = ?",
      [JSON.stringify(value), maxSeq + 1, PANE_STORE_KEY],
    );
    const exists = (key: string): boolean =>
      db.query("SELECT 1 FROM ui_state WHERE key = ?").get(key) !== null;
    for (const rename of projectPanesKeyRenames(pairs)) {
      if (!exists(rename.from)) continue;
      if (exists(rename.to)) {
        db.run("DELETE FROM ui_state WHERE key = ?", [rename.from]);
        report.dropped.push(rename.from);
      } else {
        db.run("UPDATE ui_state SET key = ? WHERE key = ?", [rename.to, rename.from]);
        report.renamed.push(rename);
      }
    }
  }).immediate();
  return report;
}

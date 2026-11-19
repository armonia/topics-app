#!/usr/bin/env bun
/**
 * HOW THE AUTOMATIC LAND DOES, IN DORA TERMS — `bun scripts/autoland-stats.ts [--db <file>] [--days N] [--project <id>] [--json]`
 *
 * The land that needs no one (`server/services/auto-land.ts`) is only worth
 * keeping if what it lands holds. DORA 2025 measures two sides of the same
 * change: throughput (how much reaches main) and instability (change failure
 * and rework). This probe counts both, for the cards closed in the last N days,
 * read-only from the board's database:
 *
 *   - landed alone: the card carries the auto-land's own note («Atterrata da
 *     sola», written inside the land queue a moment before the merge);
 *   - landed by a person: every other card that reached `done` with its code on
 *     main («Mergiato su main»);
 *   - failure after an automatic land: the CI on main went red after it (the
 *     status line «la CI su main è rossa dopo il land» sends the card back), or // allow-italian: the status text the probe matches
 *     a revert names its commit;
 *   - rework after an automatic land: the card was reopened after it landed.
 *
 * The rate that matters is failures over automatic lands. With zero automatic
 * lands it says so instead of printing a rate: a rate over nothing is not a zero.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

export const AUTO_NOTE = "Atterrata da sola";
const MERGED_NOTE = "Mergiato su main (commit ";
const RED_AFTER_LAND = "la CI su main è rossa dopo il land";

export interface AutoLandStats {
  days: number;
  closed: number;
  landedAlone: number;
  landedByPerson: number;
  failedAfterAuto: number;
  reworkedAfterAuto: number;
  /** Commits of automatic lands that a later commit on main reverts (`revertsOf` answers). */
  revertedAuto: string[];
}

interface Row { id: string; reopened_at: string | null; auto_at: string | null; merged: string | null; red_after: number }

/**
 * `revertsOf(commits)` = which of those commits a revert on main names; absent,
 * reverts are not counted (a database copy without its repository).
 */
export function autoLandStats(
  db: Database,
  opts: { days: number; projectId?: string; now?: string; revertsOf?: (commits: string[]) => string[] },
): AutoLandStats {
  const now = opts.now ?? new Date().toISOString();
  const since = new Date(Date.parse(now) - opts.days * 86_400_000).toISOString();
  const rows = db.query(
    `SELECT t.id, t.reopened_at,
       (SELECT MIN(c.created_at) FROM task_comments c WHERE c.task_id = t.id AND c.content LIKE ?1) AS auto_at,
       (SELECT c.content FROM task_comments c WHERE c.task_id = t.id AND c.content LIKE ?2 ORDER BY c.created_at DESC LIMIT 1) AS merged,
       (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id AND c.kind = 'status' AND c.content LIKE ?3) AS red_after
     FROM tasks t
     WHERE t.status = 'done' AND t.completed_at >= ?4 AND (?5 IS NULL OR t.project_id = ?5)`,
  ).all(`${AUTO_NOTE}%`, `${MERGED_NOTE}%`, `%${RED_AFTER_LAND}%`, since, opts.projectId ?? null) as Row[];
  const auto = rows.filter((r) => r.auto_at);
  const commitOf = (r: Row) => r.merged?.slice(MERGED_NOTE.length).replace(/\).*$/, "") ?? "";
  const autoCommits = auto.map(commitOf).filter(Boolean);
  const revertedAuto = autoCommits.length && opts.revertsOf ? opts.revertsOf(autoCommits) : [];
  return {
    days: opts.days,
    closed: rows.length,
    landedAlone: auto.length,
    landedByPerson: rows.filter((r) => !r.auto_at && r.merged).length,
    failedAfterAuto: auto.filter((r) => r.red_after > 0 || revertedAuto.includes(commitOf(r))).length,
    reworkedAfterAuto: auto.filter((r) => r.reopened_at && r.reopened_at > r.auto_at!).length,
    revertedAuto,
  };
}

/** The commits among `commits` that a `git revert` message on `main` of `repo` names. */
export function gitRevertsOf(repo: string): (commits: string[]) => string[] {
  return (commits) => {
    const res = Bun.spawnSync(["git", "-C", repo, "log", "main", "--grep=This reverts commit", "--format=%B"]);
    if (res.exitCode !== 0) return [];
    const text = res.stdout.toString();
    return commits.filter((c) => c.length >= 7 && text.includes(c.slice(0, 7)));
  };
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

export function render(s: AutoLandStats): string {
  const landed = s.landedAlone + s.landedByPerson;
  return [
    `Ultimi ${s.days} giorni: ${s.closed} card chiuse, ${landed} con codice su main.`,
    `  atterrate da sole: ${s.landedAlone} (${pct(s.landedAlone, landed)}) · a mano: ${s.landedByPerson}`,
    s.landedAlone === 0
      ? "  nessun land automatico ancora: niente tasso di fallimento da calcolare."
      : `  dopo un land automatico: ${s.failedAfterAuto} rossi o revert (change failure ${pct(s.failedAfterAuto, s.landedAlone)}), ${s.reworkedAfterAuto} riaperte (rework ${pct(s.reworkedAfterAuto, s.landedAlone)})`,
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const dbPath = opt("db") ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "topics.db") : join(import.meta.dir, "..", "data", "topics.db"));
  const days = Number(opt("days") ?? 7);
  if (!Number.isFinite(days) || days <= 0) { console.error("--days wants a positive number"); process.exit(2); }
  let db: Database;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (err) { console.error(`cannot open ${dbPath}: ${String(err)}`); process.exit(2); }
  const stats = autoLandStats(db, { days, projectId: opt("project"), revertsOf: gitRevertsOf(join(import.meta.dir, "..")) });
  console.log(argv.includes("--json") ? JSON.stringify(stats) : render(stats));
}

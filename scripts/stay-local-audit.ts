/**
 * THE AUDIT VIEW of the `stay_local` pins without an expiry: one line per
 * card saying what the sweep thinks of it, and who set the pin.
 *
 * The decision itself does NOT live here: it lives in
 * `server/services/stay-local-sweep.ts`, which the server runs at boot, and
 * which this script imports. There is one classifier, and this file is its
 * reader, not a second opinion. Read that module's doc for what KEEP means
 * and why the feature check is broader than `namesMacOnlyPaths`.
 *
 * READ-ONLY BY DEFAULT: the database is opened `readonly` and nothing is
 * written. With `--apply` it is opened read-write and the SAME sweep the
 * server runs at boot is applied to the database given by `--db`, which is
 * what you want when the board lives on another machine's file.
 *
 * Run:
 *   bun scripts/stay-local-audit.ts [--db <path/to/topics.db>] [--apply]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  classifyOrigin,
  classifyStayLocal,
  PERMANENT_PINS_SQL,
  runStayLocalSweep,
} from "../server/services/stay-local-sweep";
import { resolveDataDir, stateDirTarget } from "../server/lib/data-dir";

export { classifyOrigin, classifyStayLocal };
export type { StayLocalOrigin, StayLocalVerdict } from "../server/services/stay-local-sweep";

/**
 * `resolveStateDir` would `mkdirSync` the folder it resolves to: fine for a
 * server about to write there, wrong for a read-only audit that may be
 * pointed at a path that does not exist yet (a typo, a stale mount) and has
 * no business creating it. `stateDirTarget` is the same resolution with no
 * mkdir and no write probe.
 */
function defaultDbPath(): string {
  return join(resolveDataDir(stateDirTarget(process.cwd())), "topics.db");
}

function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function main(): void {
  // `resolveStateDir` creates the directory it resolves to as a side effect
  // (`mkdirSync`), which a read-only audit has no business doing. Only ever
  // called when nobody passed `--db`, and then only to find the default path.
  const dbPath = opt("db") ?? defaultDbPath();
  const apply = process.argv.includes("--apply");
  if (apply) {
    // Read-write only on this branch: the default run must not be able to
    // write even by accident.
    const writable = new Database(dbPath, { readonly: false });
    try {
      const r = runStayLocalSweep(writable);
      console.log(
        `[stay-local] sweep applied: scanned ${r.scanned}, cleared ${r.cleared}, kept ${r.kept}, already decided ${r.skipped}`,
      );
    } finally {
      writable.close();
    }
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(PERMANENT_PINS_SQL)
      .all() as { id: string; text: string | null; description: string | null }[];
    const commentsOf = db.prepare(
      "SELECT kind, content FROM task_comments WHERE task_id = ? ORDER BY created_at ASC",
    );
    let kept = 0;
    for (const row of rows) {
      const verdict = classifyStayLocal(row);
      const comments = commentsOf.all(row.id) as { kind: string | null; content: string }[];
      const origin = classifyOrigin(comments);
      const why = verdict === "KEEP" ? "mac-only path or feature named in text/description" : "no mac-only path or feature found";
      console.log(`${row.id} ${verdict} origin=${origin} (${why})`);
      if (verdict === "KEEP") kept += 1;
    }
    console.log(`\n${rows.length} rows pinned without an expiry: ${kept} KEEP, ${rows.length - kept} DROP.`);
  } finally {
    db.close();
  }
}

if (import.meta.main) main();

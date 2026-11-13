/**
 * AUDIT, NOT A FIX: which `stay_local` pins without an expiry still have a
 * reason.
 *
 * TWO DIFFERENT QUESTIONS, not one:
 *  - WHO pinned it: the dispatcher (`task-dispatcher-remote-node-empty.ts`'s
 *    mac-only branch, or any permanent pin written through `tasks.ts`'s
 *    `update`/`create`, which now leaves a `kind: "service"` comment
 *    starting with the quote mark below) or a PERSON (the PATCH route, the
 *    composer checkbox, the TaskDetail toggle) — read from the comment
 *    thread, not guessed.
 *  - WHETHER THE WORK STILL NEEDS THIS MAC: `namesMacOnlyPaths` alone only
 *    catches a literal path (`~/`, `/Users/`, `launchd`...), and misses a
 *    card that touches the Mac through a NAME rather than a path — the tray
 *    icon, the local hub on :3360, a launchd agent described in prose. A
 *    card like that (b3e19133, the Mac tray) came back DROP from the old
 *    path-only check, which was wrong: the work is still Mac-only, the text
 *    just never spells out a path. `MAC_ONLY_WORK` below is deliberately
 *    broader than `namesMacOnlyPaths` for that reason — it is an audit hint
 *    for a human, not the dispatcher's own eligibility gate, which stays
 *    narrow on purpose (a false KEEP there strands a card that would have
 *    run fine elsewhere; a false KEEP here just asks a person to look twice).
 *
 * READ-ONLY. It opens the database `readonly` and writes nothing: deciding
 * what to do with a DROP is a human's call, not this script's.
 *
 * Run:
 *   bun scripts/stay-local-audit.ts [--db <path/to/topics.db>]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { namesMacOnlyPaths } from "../server/services/dispatch-overflow";
import { resolveDataDir, stateDirTarget } from "../server/lib/data-dir";

export type StayLocalVerdict = "KEEP" | "DROP";
export type StayLocalOrigin = "dispatcher" | "person" | "unknown";

/**
 * Names this Mac's own FEATURES, not just its paths: the tray icon, the
 * local hub port, a launchd agent described in words rather than a path.
 * Broader than `namesMacOnlyPaths` on purpose (see the module doc above).
 */
const MAC_ONLY_WORK = /\btray\b|\bmenu ?bar\b|\bsystray\b|\bhub\b|:3360\b|\blaunchd\b|\blaunchagents\b|\blaunchctl\b|\bdock\b|\bkeychain\b|\bfinder\b/i;

/** The classifier alone, with no DB/IO: does EITHER check say the permanent
 *  pin still answers to a reason that touches this Mac itself? */
export function classifyStayLocal(task: { text?: string | null; description?: string | null }): StayLocalVerdict {
  if (namesMacOnlyPaths(task)) return "KEEP";
  const haystack = `${task.text ?? ""}\n${task.description ?? ""}`;
  return MAC_ONLY_WORK.test(haystack) ? "KEEP" : "DROP";
}

/**
 * The dispatcher's own permanent pin (`task-dispatcher-remote-node-empty.ts`)
 * writes its own `kind: "service"` comment naming a mac-only path (the
 * marker text it uses is the dispatcher-marker check below). Every OTHER
 * permanent pin, set by a person through the PATCH route, the composer
 * checkbox or the TaskDetail toggle, reaches `tasks.ts`'s `update`/`create`,
 * which writes a differently worded `kind: "service"` comment (the
 * person-marker prefix below). A row with NEITHER predates both write paths:
 * `"unknown"`, not a guess either way.
 */
export function classifyOrigin(comments: { kind?: string | null; content: string }[]): StayLocalOrigin {
  const service = comments.filter((c) => c.kind === "service");
  if (service.some((c) => c.content.includes("usa file che stanno solo su questo Mac"))) return "dispatcher";
  if (service.some((c) => c.content.startsWith("«Solo Mac», senza scadenza:"))) return "person";
  return "unknown";
}

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
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT id, text, description FROM tasks WHERE stay_local = 1 AND stay_local_until IS NULL",
    ).all() as { id: string; text: string | null; description: string | null }[];
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

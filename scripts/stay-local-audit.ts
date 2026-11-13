/**
 * AUDIT, NOT A FIX: which `stay_local` pins without an expiry still have a
 * reason.
 *
 * `task-dispatcher-remote-node-empty.ts` pins a card to this machine forever
 * (`stay_local = 1`, no `stay_local_until`) in exactly one place: a card that
 * names a mac-only path (`~/`, `/Users/`, `LaunchAgents`, `launchd`,
 * `launchctl`). That reason does not expire, so the pin does not either - but
 * nothing records the reason on the row itself, only on the card's thread in
 * Italian. This script re-applies the same check the dispatcher used
 * (`namesMacOnlyPaths`) to every row that carries a permanent pin today, so a
 * person can tell a pin that still matches its own reason from one that no
 * longer does (the text changed, the pin predates this rule, ...).
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
import { resolveDataDir, resolveStateDir } from "../server/lib/data-dir";

export type StayLocalVerdict = "KEEP" | "DROP";

/** The classifier alone, with no DB/IO: `namesMacOnlyPaths` says whether the
 *  permanent pin still answers to the reason that put it there. */
export function classifyStayLocal(task: { text?: string | null; description?: string | null }): StayLocalVerdict {
  return namesMacOnlyPaths(task) ? "KEEP" : "DROP";
}

function defaultDbPath(): string {
  return join(resolveDataDir(resolveStateDir(process.cwd())), "topics.db");
}

function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function main(): void {
  const dbPath = opt("db") ?? defaultDbPath();
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(
      "SELECT id, text, description FROM tasks WHERE stay_local = 1 AND stay_local_until IS NULL",
    ).all() as { id: string; text: string | null; description: string | null }[];
    for (const row of rows) {
      const verdict = classifyStayLocal(row);
      const why = verdict === "KEEP" ? "macOnlyPaths match" : "no mac-only path found in text/description";
      console.log(`${row.id} ${verdict} (${why})`);
    }
    const kept = rows.filter((r) => classifyStayLocal(r) === "KEEP").length;
    console.log(`\n${rows.length} rows pinned without an expiry: ${kept} KEEP, ${rows.length - kept} DROP.`);
  } finally {
    db.close();
  }
}

if (import.meta.main) main();

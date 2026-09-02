/**
 * A project's identity is the DIRECTORY, not the string you reached it through.
 *
 * `projectIdForPath` (shared/board.ts) is `basename + hash of the STRING`, and
 * the `ui_state` keys use a twin hash. So two paths pointing at the same
 * directory — one direct, one through a symlink — produce two distinct
 * projects: two sidebar entries, two boards, two panes. Measured 2026-09-02:
 * `~/.openclaw/workspace/neuture-proposal` is a link to
 * `~/Projects/neuture-proposal`, and neuture showed up twice.
 *
 * The link is resolved ONCE here, when the path COMES IN. Nothing already
 * written is touched: changing an existing project's path changes its id and
 * would orphan its `tasks` rows — the "empty board" already paid for once. This
 * function stops the SECOND identity from being born; the ones already born are
 * merged by a separate migration that rewrites them in a transaction.
 *
 * A path that does not exist yet is kept as-is: there is nothing to resolve, and
 * refusing it would turn "directory not created yet" into an error.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function canonicalProjectPath(p: string | null | undefined): string {
  // Expand FIRST, normalise AFTER: `~/` with a trailing slash no longer starts
  // with `~/` once trimmed, and the literal string "~" survived.
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  const espanso = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  const abs = espanso.replace(/(.)\/+$/, "$1");
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

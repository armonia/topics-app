/**
 * The Windows rules of the worktree code, kept pure and with the platform as a
 * parameter so they are tested on any machine (cross-node addendum, B5). A suite
 * that assumes POSIX gives false reds on the Windows node; a rule that is only
 * exercised there is never exercised at all.
 */

/**
 * `git worktree add` (and anything that writes a checkout) on Windows gets
 * `core.longpaths=true` for that one command: a worktree under a short root still
 * holds `node_modules` paths past MAX_PATH. Elsewhere the arguments are unchanged.
 */
export function worktreeGitArgs(args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["-c", "core.longpaths=true", ...args] : [...args];
}

const BUSY_CODES = new Set(["EBUSY", "EPERM"]);
const BUSY_TEXT = /device or resource busy|permission denied|being used by another process|access is denied/i;

/**
 * On Windows a removal that fails with EBUSY or EPERM means a process still holds
 * a file in the folder: the checkout is ALIVE. The row stays and the next pass
 * retries; nothing escalates to a second `--force` or to a bare `rm`. On POSIX a
 * busy folder can still be unlinked, so the rule does not apply there.
 */
export function removalMeansAlive(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32" || err === null || err === undefined) return false;
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  if (typeof e.code === "string" && BUSY_CODES.has(e.code)) return true;
  const text = `${typeof e.stderr === "string" ? e.stderr : ""} ${typeof e.message === "string" ? e.message : typeof err === "string" ? err : ""}`;
  return BUSY_TEXT.test(text);
}

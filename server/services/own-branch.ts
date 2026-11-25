/**
 * The branch a worktree has checked out, when it carries commits of its own.
 *
 * Read by the wait path (`deferForWait`) before it frees the card's slot: the
 * worktree may be gone by the time the card runs again, and without the branch
 * recorded the next run starts from main without the work already committed.
 */
import { spawnSync } from "node:child_process";

function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch { return null; }
}

/** `null` = detached, on the main line itself, nothing ahead of it, or git could not tell. */
export function branchAheadOfMain(root: string): string | null {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return null;
  const base = git(root, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]) ? "origin/main" : "main";
  const ahead = git(root, ["rev-list", "--count", `${base}..${branch}`]);
  return ahead && Number(ahead) > 0 ? branch : null;
}

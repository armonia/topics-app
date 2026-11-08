/**
 * IS THIS FOLDER STILL A CHECKOUT? A pure filesystem read, shared by the dirt
 * probe (`task-automerge.ts`) and the residue commit (`worktree-residue.ts`).
 *
 * It lives in its own module because `worktree-residue` already sits under
 * `own-commits`, which `task-automerge` imports: a value import from
 * `task-automerge` into the residue would close a cycle.
 *
 * A worktree's `.git` is a FILE reading `gitdir: <repo>/.git/worktrees/<name>`.
 * When that target directory no longer exists, git has lost (pruned, or never
 * had) the registration: every git command in the folder exits 128 "not a git
 * repository", forever. That is the shape `sage-well` had in production, and
 * the shape every failed `git worktree remove` leaves behind.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function worktreeRegistrationLost(path: string): boolean {
  const dotGit = join(path, ".git");
  let text: string;
  try {
    if (!statSync(dotGit).isFile()) return false;
    text = readFileSync(dotGit, "utf8");
  } catch {
    return false;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return false;
  return !existsSync(resolve(path, m[1]));
}

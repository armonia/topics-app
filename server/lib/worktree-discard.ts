/**
 * THROWING A WORKTREE AWAY WITHOUT LEAVING HALF OF IT REGISTERED.
 *
 * `git worktree remove --force` deletes the tree IN PLACE and drops the
 * registration only at the end. Killed in between, it leaves a worktree that
 * git still lists with its branch checked out, but with part of its tracked
 * files gone. That is what a shutdown did: `stopReviewChecks` ends the round,
 * the node meter's `finally` starts the remove, and `process.exit` reaps the git
 * group a moment later (`reapBoundedGroups` in `bounded-spawn.ts`). The land
 * then found the branch "live" in that tree and refused it for 196 uncommitted
 * files (card 8e9c2873, twelve check trees out of twenty-four).
 *
 * Here the order is reversed: the tree is moved aside (one rename, atomic on
 * the same volume), the registration is pruned, and only then is the moved copy
 * deleted. A kill at any point leaves either the whole tree registered, a
 * registration pointing to nothing (which `worktree prune` drops and the land
 * skips), or an unregistered leftover that the next discard of the same path
 * removes.
 */
import { readdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type DiscardGit = (cwd: string, args: string[]) => Promise<{ code: number }>;

export interface DiscardDeps {
  /** How the moved-aside copy is deleted (injectable to simulate a kill mid-way). */
  deleteTree?: (path: string) => Promise<void>;
}

/** What a discard appends to the name of the copy it moves aside. */
export const ASIDE_MARK = ".discarded-";

const deleteTreeDefault = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 3 });

/**
 * Remove the worktree at `path` of `repoPath` so that no interruption leaves it registered and incomplete.
 * `repoPath` null: a leftover no repository is known for (its `.git` file is gone), only the folder goes.
 * The rename is the first thing the call does, synchronously: a caller that checks a lease right before
 * calling cannot be overtaken by an open of the same path.
 */
export async function discardWorktree(git: DiscardGit, repoPath: string | null, path: string, deps: DiscardDeps = {}): Promise<void> {
  const deleteTree = deps.deleteTree ?? deleteTreeDefault;
  const aside = `${path}${ASIDE_MARK}${process.pid}-${Date.now().toString(36)}`;
  let moved = false;
  try {
    renameSync(path, aside);
    moved = true;
  } catch {
    // Missing already, or held open (Windows refuses to rename a directory
    // some process sits in): git's own remove is the fallback.
  }
  if (repoPath !== null) {
    if (!moved) await git(repoPath, ["worktree", "remove", "--force", path]).catch(() => undefined);
    // A `git worktree add` killed by SIGKILL (the deadline, or the reap at
    // process.exit, see TERM_GRACE_MS in bounded-spawn.ts) leaves its
    // registration "locked initializing", which prune skips for ever and which
    // keeps the branch checked out. The path is the caller's own, so its lock goes.
    await git(repoPath, ["worktree", "unlock", path]).catch(() => undefined);
    await git(repoPath, ["worktree", "prune"]).catch(() => undefined);
  }
  for (const leftover of asideCopiesOf(path)) await deleteTree(leftover).catch(() => undefined);
}

/** The copies of `path` a previous discard moved aside and did not finish deleting. */
function asideCopiesOf(path: string): string[] {
  const parent = dirname(path);
  const prefix = basename(path) + ASIDE_MARK;
  try {
    return readdirSync(parent).filter((name) => name.startsWith(prefix)).map((name) => join(parent, name));
  } catch {
    return [];
  }
}

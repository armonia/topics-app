/**
 * WHO A WORKTREE BELONGS TO, written where git keeps it (change worktree-standard, T3).
 *
 * Two facts about a checkout Topics made, kept in git's own admin folder of the
 * worktree (`<common-dir>/worktrees/<name>/`) and never in `git config`:
 *
 *  - a MARKER file `topics-owner` (JSON), so a folder found later with no row in
 *    the database can still say which project and which row it was made for;
 *  - a LOCK (`git worktree lock --reason topics:<name>`), so `git worktree
 *    prune`, a stray `git worktree remove` and other tools that sweep git's list
 *    leave it alone while it is in use.
 *
 * Why not `git config`: in a linked worktree `git config` writes the SHARED
 * repository config, so a per-worktree value would leak into every sibling.
 *
 * The lock is Topics' own: its reason starts with `topics:`. A lock with any
 * other reason belongs to somebody else and is never lifted here.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { GitRunner } from "./own-commits";

/**
 * A path in the form git prints it: symbolic links resolved (`/var` is
 * `/private/var` on macOS). For a path that does not exist (a row whose folder is
 * gone) the nearest existing parent is resolved and the rest is kept. Every
 * comparison between a row, a scanned folder and a line of `git worktree list`
 * goes through this, or the same folder reads as two.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

/** File name of the marker inside the worktree's admin folder. */
export const OWNER_MARKER_FILE = "topics-owner";
/** Every lock Topics takes has a reason that starts with this. */
export const OWNER_LOCK_PREFIX = "topics:";

export interface OwnerMarker {
  worktreeId: string;
  projectId: string;
  createdAt: string;
}

/**
 * The admin folder of a LINKED worktree, read off its `.git` file
 * (`gitdir: <repo>/.git/worktrees/<name>`). Null for the main checkout (`.git`
 * is a directory), for a folder with no `.git`, and when the file is unreadable.
 * Pure filesystem: no git process.
 */
export function worktreeAdminDir(absPath: string): string | null {
  const dotGit = join(absPath, ".git");
  try {
    if (!statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    return m ? resolve(absPath, m[1]!) : null;
  } catch {
    return null;
  }
}

/** Writes the marker. Best effort: false when the admin folder is missing or unwritable. */
export function writeOwnerMarker(absPath: string, marker: OwnerMarker): boolean {
  const admin = worktreeAdminDir(absPath);
  if (!admin || !existsSync(admin)) return false;
  try {
    writeFileSync(join(admin, OWNER_MARKER_FILE), JSON.stringify(marker) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** The marker of a worktree folder, or null when there is none or it does not parse. */
export function readOwnerMarker(absPath: string): OwnerMarker | null {
  const admin = worktreeAdminDir(absPath);
  if (!admin) return null;
  try {
    const v = JSON.parse(readFileSync(join(admin, OWNER_MARKER_FILE), "utf8")) as Partial<OwnerMarker>;
    if (typeof v.worktreeId !== "string" || typeof v.projectId !== "string") return null;
    return { worktreeId: v.worktreeId, projectId: v.projectId, createdAt: typeof v.createdAt === "string" ? v.createdAt : "" };
  } catch {
    return null;
  }
}

/** One entry of `git worktree list --porcelain -z`. */
export interface ListedWorktree {
  path: string;
  head: string | null;
  /** Branch name without `refs/heads/`, null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
}

/**
 * Parses the NUL-separated porcelain list. Fields end with NUL and a record ends
 * with one more NUL, so records split on a double NUL; a lock reason may hold any
 * character but NUL.
 */
export function parseWorktreeList(stdout: string): ListedWorktree[] {
  const out: ListedWorktree[] = [];
  for (const record of stdout.split("\0\0")) {
    const fields = record.split("\0").filter((f) => f !== "");
    if (!fields.length) continue;
    const wt: ListedWorktree = { path: "", head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false };
    for (const f of fields) {
      if (f.startsWith("worktree ")) wt.path = f.slice("worktree ".length);
      else if (f.startsWith("HEAD ")) wt.head = f.slice("HEAD ".length);
      else if (f.startsWith("branch ")) wt.branch = f.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (f === "detached") wt.detached = true;
      else if (f === "bare") wt.bare = true;
      else if (f === "locked" || f.startsWith("locked ")) { wt.locked = true; wt.lockReason = f.length > 7 ? f.slice(7) : null; }
      else if (f === "prunable" || f.startsWith("prunable ")) wt.prunable = true;
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

/** `git worktree list` of a repository, or null when git could not answer. */
export async function listRepoWorktrees(git: GitRunner, repoPath: string): Promise<ListedWorktree[] | null> {
  const r = await git(repoPath, ["worktree", "list", "--porcelain", "-z"]);
  return r.code === 0 ? parseWorktreeList(r.stdout) : null;
}

/** The lock is the one Topics took (its reason says so). */
export function lockedByTopics(w: Pick<ListedWorktree, "locked" | "lockReason">): boolean {
  return w.locked && (w.lockReason ?? "").startsWith(OWNER_LOCK_PREFIX);
}

/** Takes Topics' lock on a worktree. Already locked counts as done. */
export async function lockOwned(git: GitRunner, repoPath: string, absPath: string, label: string): Promise<boolean> {
  const r = await git(repoPath, ["worktree", "lock", "--reason", `${OWNER_LOCK_PREFIX}${label}`, absPath]);
  return r.code === 0 || /already locked/i.test(r.stderr ?? "");
}

/**
 * Lifts Topics' own lock, and only that one: a lock with a foreign reason stays,
 * and the answer is false so the caller knows the checkout is still protected.
 * Nothing locked, or nothing to find, is true (there is nothing in the way).
 */
export async function unlockOwned(git: GitRunner, repoPath: string, absPath: string): Promise<boolean> {
  const listed = await listRepoWorktrees(git, repoPath);
  const target = canonicalPath(absPath);
  const entry = listed?.find((w) => canonicalPath(w.path) === target);
  if (!entry || !entry.locked) return true;
  if (!lockedByTopics(entry)) return false;
  const r = await git(repoPath, ["worktree", "unlock", absPath]);
  return r.code === 0;
}

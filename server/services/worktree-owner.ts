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
 * The lock reason names who took it: `<creator>:<label>`. `topics:` is Topics'
 * own and is lifted whenever Topics removes the checkout. `claude-code:` is the
 * one the Claude Code hook takes (cross-node addendum, B4): it is lifted only by
 * `claudeCodeLockVerdict`, when every fact says the session is over and nothing
 * would be lost. A lock with any other prefix belongs to somebody nobody
 * registered and is never lifted here.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { GitRunner } from "./own-commits";
import type { WorktreeSource } from "../../shared/types";

export interface CanonicalPathOptions {
  /** Path rules to apply; defaults to the platform the server runs on. */
  platform?: NodeJS.Platform;
  /** Resolves links; injectable so the Windows behaviour is testable anywhere. */
  realpath?: (p: string) => string;
}

/**
 * A path in the form git prints it: symbolic links resolved (`/var` is
 * `/private/var` on macOS). For a path that does not exist (a row whose folder is
 * gone) the nearest existing parent is resolved and the rest is kept. Every
 * comparison between a row, a scanned folder and a line of `git worktree list`
 * goes through this, or the same folder reads as two.
 *
 * On Windows the NATIVE realpath is used: it returns the spelling the volume
 * stores, so `c:\users\x` and `C:\Users\x` come back as one string, which the
 * JS realpath does not do on a case-insensitive filesystem.
 */
export function canonicalPath(p: string, opts: CanonicalPathOptions = {}): string {
  const win = (opts.platform ?? process.platform) === "win32";
  const P = win ? win32 : posix;
  const real = opts.realpath ?? (win ? realpathSync.native : realpathSync);
  const abs = P.resolve(p);
  try { return real(abs); } catch {
    const parent = P.dirname(abs);
    return parent === abs ? abs : P.join(canonicalPath(parent, opts), P.basename(abs));
  }
}

/**
 * The key two paths are compared by: the canonical path, lower-cased on Windows
 * where the filesystem ignores case. Never shown or stored, only compared.
 */
export function pathKey(p: string, opts: CanonicalPathOptions = {}): string {
  const c = canonicalPath(p, opts);
  return (opts.platform ?? process.platform) === "win32" ? c.toLowerCase() : c;
}

/** File name of the marker inside the worktree's admin folder. */
export const OWNER_MARKER_FILE = "topics-owner";
/** Every lock Topics takes has a reason that starts with this. */
export const OWNER_LOCK_PREFIX = "topics:";
/** The lock the Claude Code worktree hook takes: `claude-code:<session id>`. */
export const CLAUDE_CODE_LOCK_PREFIX = "claude-code:";

/** Who made a worktree. Unknown values read as `adopted`; a missing one as `topics`. */
export const WORKTREE_CREATORS: readonly WorktreeSource[] = ["topics", "claude-code", "claude-desktop", "codex", "jcode", "muse", "workflow", "adopted"];
export type WorktreeCreator = WorktreeSource;

export function isWorktreeCreator(v: unknown): v is WorktreeCreator {
  return typeof v === "string" && (WORKTREE_CREATORS as readonly string[]).includes(v);
}

/**
 * The marker. v1 had the first three fields; v2 adds who made the checkout, for
 * which session and on which machine. Every v2 field is optional and unknown
 * fields are ignored, so a v1 marker still reads (as `creator: "topics"`).
 */
export interface OwnerMarker {
  worktreeId: string;
  projectId: string;
  createdAt: string;
  creator?: WorktreeCreator;
  session?: { id: string; transcript?: string };
  /** The machine id when known, else the host name. */
  machine?: string;
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
    return adminDirFromDotGit(absPath, readFileSync(dotGit, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pure: the admin folder named by the text of a `.git` file. Git for Windows
 * writes `gitdir: C:/repo/.git/worktrees/x` with forward slashes; the Windows
 * path rules read it as the same folder.
 */
export function adminDirFromDotGit(absPath: string, content: string, platform: NodeJS.Platform = process.platform): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  return m ? (platform === "win32" ? win32 : posix).resolve(absPath, m[1]!) : null;
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
    const v = JSON.parse(readFileSync(join(admin, OWNER_MARKER_FILE), "utf8")) as Record<string, unknown>;
    return parseOwnerMarker(v);
  } catch {
    return null;
  }
}

/** Pure: the marker out of its parsed JSON, v1 or v2. Null when the two ids are missing. */
export function parseOwnerMarker(v: Record<string, unknown>): OwnerMarker | null {
  if (typeof v.worktreeId !== "string" || typeof v.projectId !== "string") return null;
  const out: OwnerMarker = { worktreeId: v.worktreeId, projectId: v.projectId, createdAt: typeof v.createdAt === "string" ? v.createdAt : "" };
  if (v.creator !== undefined) out.creator = isWorktreeCreator(v.creator) ? v.creator : "adopted";
  const session = v.session as { id?: unknown; transcript?: unknown } | undefined;
  if (session && typeof session.id === "string" && session.id) {
    out.session = { id: session.id, ...(typeof session.transcript === "string" && session.transcript ? { transcript: session.transcript } : {}) };
  }
  if (typeof v.machine === "string" && v.machine) out.machine = v.machine;
  return out;
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

/** Everything the `claude-code:` lock rule looks at, read off the disk by `readClaudeCodeLockFacts`. */
export interface ClaudeCodeLockFacts {
  lockReason: string;
  marker: OwnerMarker | null;
  /** How long the session transcript the marker names has not changed; null when it cannot be read. */
  transcriptIdleMs: number | null;
  dirty: boolean;
  /** Every commit of HEAD is on a remote ref (pushed, or merged upstream). */
  mergedOrPushed: boolean;
  /** Age of the checkout per its marker; null when the marker has no date. */
  ageMs: number | null;
  abandonMs: number;
}

const CLAUDE_CODE_MIN_AGE_MS = 24 * 3600_000;

/**
 * Pure: may the GC lift a `claude-code:<session>` lock? Only when ALL hold: the
 * marker says Claude Code made it for that very session, the transcript has been
 * silent for the abandon period, the tree is clean, every commit is on a remote,
 * and the checkout is older than a day. Anything unknown is a no.
 */
export function claudeCodeLockVerdict(f: ClaudeCodeLockFacts): { lift: boolean; reason: string } {
  if (!f.lockReason.startsWith(CLAUDE_CODE_LOCK_PREFIX)) return { lift: false, reason: "not a claude-code lock" };
  const session = f.lockReason.slice(CLAUDE_CODE_LOCK_PREFIX.length);
  if (f.marker?.creator !== "claude-code" || !session || f.marker.session?.id !== session) return { lift: false, reason: "the marker does not name this session" };
  if (f.transcriptIdleMs === null || f.transcriptIdleMs < f.abandonMs) return { lift: false, reason: "the session transcript is not silent long enough" };
  if (f.dirty) return { lift: false, reason: "the tree has changes" };
  if (!f.mergedOrPushed) return { lift: false, reason: "commits that are on no remote" };
  if (f.ageMs === null || f.ageMs < CLAUDE_CODE_MIN_AGE_MS) return { lift: false, reason: "younger than 24 h" };
  return { lift: true, reason: "the claude-code session is over and nothing would be lost" };
}

/**
 * Reads the facts of the `claude-code:` rule for one checkout.
 *
 * The files first (marker, transcript, age), git last, and git only when those
 * already allow a lift: the rule runs on every pass and every preview over every
 * locked worktree, and most of them are live sessions. When git is not asked,
 * `dirty` and `mergedOrPushed` hold the refusing values (unknown is a no).
 * `git status` runs with `--no-optional-locks`: it never takes the `index.lock`
 * a live session's `git add` or `git commit` needs.
 */
export async function readClaudeCodeLockFacts(
  git: GitRunner,
  absPath: string,
  lockReason: string,
  abandonDays: number,
  now: number = Date.now(),
): Promise<ClaudeCodeLockFacts> {
  const marker = readOwnerMarker(absPath);
  let transcriptIdleMs: number | null = null;
  try { if (marker?.session?.transcript) transcriptIdleMs = Math.max(0, now - statSync(marker.session.transcript).mtimeMs); } catch { /* unreadable: unknown */ }
  const born = Date.parse(marker?.createdAt ?? "");
  const facts: ClaudeCodeLockFacts = {
    lockReason, marker, transcriptIdleMs, dirty: true, mergedOrPushed: false,
    ageMs: Number.isFinite(born) ? Math.max(0, now - born) : null,
    abandonMs: abandonDays * 24 * 3600_000,
  };
  // Even a clean, pushed tree would not lift it: git has nothing to add.
  if (!claudeCodeLockVerdict({ ...facts, dirty: false, mergedOrPushed: true }).lift) return facts;
  const status = await git(absPath, ["--no-optional-locks", "status", "--porcelain"]).catch(() => null);
  facts.dirty = !status || status.code !== 0 || status.stdout.trim() !== "";
  const ahead = await git(absPath, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).catch(() => null);
  facts.mergedOrPushed = !!ahead && ahead.code === 0 && ahead.stdout.trim() === "0";
  return facts;
}

/**
 * The lock-lifting rule as one predicate over a listed worktree: Topics' own lock
 * always, a `claude-code:` lock when its rule says so, anything else never.
 */
export function lockLiftRule(git: GitRunner, abandonDays: () => number): (w: ListedWorktree) => Promise<boolean> {
  return async (w) => {
    if (!w.locked) return true;
    if (lockedByTopics(w)) return true;
    // A foreign prefix, or a marker that does not name the session, is refused
    // off the files alone: `readClaudeCodeLockFacts` never asks git for those.
    return claudeCodeLockVerdict(await readClaudeCodeLockFacts(git, w.path, w.lockReason ?? "", abandonDays())).lift;
  };
}

/** The lock is the one the Claude Code worktree hook took (`claude-code:<session>`). */
export function isClaudeCodeLock(w: Pick<ListedWorktree, "locked" | "lockReason">): boolean {
  return w.locked && (w.lockReason ?? "").startsWith(CLAUDE_CODE_LOCK_PREFIX);
}

/** Takes Topics' lock on a worktree. Already locked counts as done. */
export async function lockOwned(git: GitRunner, repoPath: string, absPath: string, label: string): Promise<boolean> {
  const r = await git(repoPath, ["worktree", "lock", "--reason", `${OWNER_LOCK_PREFIX}${label}`, absPath]);
  return r.code === 0 || /already locked/i.test(r.stderr ?? "");
}

/**
 * Lifts Topics' own lock (or, with `mayLift`, one its rule allows), and only that
 * one: any other lock stays, and the answer is false so the caller knows the
 * checkout is still protected. Nothing locked, or nothing to find, is true.
 */
export async function unlockOwned(
  git: GitRunner,
  repoPath: string,
  absPath: string,
  mayLift: (w: ListedWorktree) => boolean | Promise<boolean> = lockedByTopics,
): Promise<boolean> {
  const listed = await listRepoWorktrees(git, repoPath);
  const target = canonicalPath(absPath);
  const entry = listed?.find((w) => canonicalPath(w.path) === target);
  if (!entry || !entry.locked) return true;
  if (!(await mayLift(entry))) return false;
  const r = await git(repoPath, ["worktree", "unlock", absPath]);
  return r.code === 0;
}

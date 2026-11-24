/**
 * THE GC LOOKS AT THE DISK, not only at its own table (change worktree-standard, T3).
 *
 * `worktree-gc.ts` judges the rows of the `worktrees` table. A folder with no row
 * was invisible to it, and so was a row whose folder had gone: on 24/11/2026 the
 * root held 37 folders and 16.8 GB that no row knew. This module reads
 * `{root}/{slug}/{name}` and joins it with the rows and with what git says
 * (`git worktree list`), and sorts every entry into one class:
 *
 *   tracked        row + folder inside the root: the normal sweep judges it
 *   orphan         no row, but git knows it (a `.git`, or a listed worktree): REGISTER it,
 *                  the next sweep judges it like any other
 *   ghost          no row, no `.git`, git does not list it, nobody inside it, 24 h old, and
 *                  Topics' own marker says Topics made it: QUARANTINE (a rename under the root,
 *                  deleted N days later). Without the marker it is only listed.
 *   row-no-folder  a row whose folder is gone (`error` rows included): the sweep closes it
 *   foreign        outside the root: an inventory, never removed unless `gc_foreign=merged`
 *
 * `classifyRootEntry` and `planRoot` are pure, so the classes are testable
 * without a disk; the scan and the actions sit below and take every effect as a
 * dependency. A folder git still lists is never removed with a bare `rm`.
 *
 * WHAT IS NEVER A WORKTREE, whatever git says (24/11/2026, 30 real folders lost):
 * a `{root}/{slug}` that is itself a checkout (it has a `.git`) or is a known
 * project's own path. Its subfolders are its `src/`, `docs/`, `tests/`: the scan
 * does not descend into it and lists it as inventory.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, sep, basename, dirname } from "node:path";
import type { GitRunner } from "./own-commits";
import {
  canonicalPath, listRepoWorktrees, lockedByTopics, readOwnerMarker, unlockOwned, worktreeAdminDir,
  type ListedWorktree,
} from "./worktree-owner";
import { folderOwned, quarantineFolder, surelyAbsent, type QuarantinedFolder } from "./worktree-root-ledger";
import { isInsideDir } from "../lib/path-containment";

export { canonicalPath };

/** Nothing younger than this is ever removed. */
export const MIN_REMOVAL_AGE_MS = 24 * 3600_000;
/** `--check` fails when reading the root takes longer: the trigger to move the scan to a native sidecar. */
export const ROOT_SCAN_BUDGET_MS = 2000;
/** Folders of the root that are not projects: `_` can never be a slug. */
const RESERVED_PREFIX = "_";

export interface RootEntry {
  absPath: string;
  slug: string;
  name: string;
  hasDotGit: boolean;
  /** `.git` is a DIRECTORY: a repository of its own (a clone, a main checkout), never a linked worktree. */
  standaloneRepo?: boolean;
  isSymlink: boolean;
  /** Age of the folder: its birth time when the filesystem has one, else its mtime. */
  ageMs: number;
  /** Topics' marker for this folder is in the root's ledger (`worktree-root-ledger.ts`). */
  owned?: boolean;
  /** `.git` is a file pointing at an admin folder that is gone: git lost this worktree. */
  registrationLost?: boolean;
}

export interface RootScan {
  entries: RootEntry[];
  /** `{root}/{slug}` folders that are checkouts or project paths: never descended into. */
  checkouts: string[];
  ms: number;
}

/** What a `.git` inside a folder says, with doubt counted as presence. */
function dotGitOf(absPath: string): { hasDotGit: boolean; standaloneRepo: boolean; registrationLost: boolean } {
  const dotGit = join(absPath, ".git");
  let st;
  try { st = lstatSync(dotGit); } catch (err) {
    // Only ENOENT means "no .git": an unreadable one is kept as if it were there.
    const absent = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { hasDotGit: !absent, standaloneRepo: false, registrationLost: false };
  }
  if (st.isDirectory()) return { hasDotGit: true, standaloneRepo: true, registrationLost: false };
  const admin = st.isFile() ? worktreeAdminDir(absPath) : null;
  return { hasDotGit: true, standaloneRepo: false, registrationLost: admin !== null && surelyAbsent(admin) };
}

/**
 * Reads `{root}/{slug}/{name}`. Skips `_scratch`, `_cache` and any dot-folder at
 * the first level, and anything that is not a folder. A `{slug}` folder that has
 * a `.git` (or any doubt about one), or that IS a known project's path, is a
 * checkout and not a folder of worktrees: it goes to `checkouts` and is never
 * descended into. A missing root is an empty scan, not an error.
 */
export function scanWorktreeRoot(
  root: string,
  now: number = Date.now(),
  opts: { projectPaths?: ReadonlySet<string> } = {},
): RootScan {
  const t0 = performance.now();
  const entries: RootEntry[] = [];
  const checkouts: string[] = [];
  let slugs: string[] = [];
  try { slugs = readdirSync(root); } catch { return { entries, checkouts, ms: performance.now() - t0 }; }
  for (const slug of slugs) {
    if (slug.startsWith(RESERVED_PREFIX) || slug.startsWith(".")) continue;
    const slugDir = join(root, slug);
    let names: string[];
    try {
      if (!lstatSync(slugDir).isDirectory()) continue;
      if (!surelyAbsent(join(slugDir, ".git")) || opts.projectPaths?.has(canonicalPath(slugDir))) {
        checkouts.push(slugDir);
        continue;
      }
      names = readdirSync(slugDir);
    } catch { continue; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const absPath = join(slugDir, name);
      try {
        const st = lstatSync(absPath);
        const isSymlink = st.isSymbolicLink();
        if (!isSymlink && !st.isDirectory()) continue;
        const git = isSymlink ? { hasDotGit: false, standaloneRepo: false, registrationLost: false } : dotGitOf(absPath);
        const born = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
        entries.push({ absPath, slug, name, ...git, isSymlink, ageMs: Math.max(0, now - born), owned: folderOwned(root, absPath) });
      } catch { /* vanished while reading */ }
    }
  }
  return { entries, checkouts, ms: performance.now() - t0 };
}

export type RootEntryClass = "tracked" | "orphan" | "ghost" | "row-no-folder" | "foreign" | "quarantined";
/**
 * `wait` = it will qualify, not yet (too young, or somebody is inside).
 * `quarantine` = moved under `{root}/.quarantine`, `purge` = deleted from there.
 */
export type RootEntryAction = "judge" | "register" | "quarantine" | "purge" | "close-row" | "inventory" | "wait";

export interface RootFacts {
  hasRow: boolean;
  folderPresent: boolean;
  inRoot: boolean;
  hasDotGit: boolean;
  /** A repository of its own (`.git` directory) or a known project's main checkout: never Topics' to register or remove. */
  standaloneRepo?: boolean;
  inGitList: boolean;
  isSymlink: boolean;
  liveInside: boolean;
  /** Age of the folder, or of the row when there is no folder. */
  ageMs: number;
  /** A known project could be named for it (needed to register an orphan). */
  projectKnown: boolean;
  /** Topics wrote the marker for this folder: the only proof that lets a ghost be moved. */
  owned?: boolean;
  /** git lost the registration of this worktree (its admin folder is gone). */
  registrationLost?: boolean;
}

export interface RootVerdict {
  cls: RootEntryClass;
  action: RootEntryAction;
  reason: string;
}

/** Pure: which class an entry belongs to and what is done about it. */
export function classifyRootEntry(f: RootFacts): RootVerdict {
  if (f.hasRow) {
    if (!f.folderPresent) {
      return f.ageMs < MIN_REMOVAL_AGE_MS
        ? { cls: "row-no-folder", action: "wait", reason: "row without a folder, younger than 24 h" }
        : { cls: "row-no-folder", action: "close-row", reason: "the folder is gone: the row is closed" };
    }
    if (!f.inRoot) return { cls: "foreign", action: "inventory", reason: "outside the worktree root: not Topics' to remove" };
    return { cls: "tracked", action: "judge", reason: "judged by the sweep" };
  }
  if (!f.inRoot || f.isSymlink) {
    return { cls: "foreign", action: "inventory", reason: f.isSymlink ? "a symbolic link: never followed or removed" : "outside the worktree root" };
  }
  if (f.standaloneRepo) return { cls: "foreign", action: "inventory", reason: "a repository of its own, not a worktree: never registered or removed" };
  if (f.hasDotGit || f.inGitList) {
    // git cannot answer for it any more: whatever is inside stays until a person looks.
    if (f.registrationLost && !f.inGitList) return { cls: "orphan", action: "inventory", reason: "git lost the registration of this worktree: listed only" };
    if (!f.projectKnown) return { cls: "orphan", action: "inventory", reason: "a checkout of a repository that is not a known project" };
    // A fresh folder with no row may be a create in flight: it is not claimed before a day has passed.
    return f.ageMs < MIN_REMOVAL_AGE_MS
      ? { cls: "orphan", action: "wait", reason: "git knows this checkout but no row does, younger than 24 h" }
      : { cls: "orphan", action: "register", reason: "git knows this checkout but no row does: it is registered, then judged" };
  }
  // No proof that Topics made it: somebody's folder, listed and never touched.
  if (!f.owned) return { cls: "ghost", action: "inventory", reason: "no .git and no Topics marker: not known to be Topics', listed only" };
  if (f.liveInside) return { cls: "ghost", action: "wait", reason: "a live session is inside" };
  if (f.ageMs < MIN_REMOVAL_AGE_MS) return { cls: "ghost", action: "wait", reason: "no .git and not listed by git, younger than 24 h" };
  return { cls: "ghost", action: "quarantine", reason: "made by Topics, no .git, not listed by git, nobody inside: moved to quarantine" };
}

export interface RootRow {
  id: string;
  projectId: string;
  absPath: string;
  status: "pending" | "ready" | "error";
  /** Row creation time, ms. */
  createdAtMs: number;
}

/** One line of the plan: what the GC sees and would do for a folder or a row. */
export interface RootPlanEntry extends RootVerdict {
  absPath: string;
  projectId: string | null;
  rowId: string | null;
  /** On-disk weight in bytes, when it was measured. */
  bytes: number | null;
  /** A quarantined folder: where it came from (moving it back restores it). */
  from?: string | null;
}

export interface RootPlanInput {
  root: string;
  /** Other roots whose checkouts are still Topics' own (the default one, after the setting moved the root). */
  extraRoots?: readonly string[];
  rows: readonly RootRow[];
  scanned: readonly RootEntry[];
  /** `git worktree list` of the known repos, by resolved path. */
  listed: ReadonlyMap<string, { projectId: string; entry: ListedWorktree }>;
  /** Paths of the main checkouts, which `git worktree list` also names. */
  repoPaths: ReadonlySet<string>;
  folderPresent: (absPath: string) => boolean;
  liveInside: (absPath: string) => boolean;
  projectOf: (entry: RootEntry) => string | null;
  now: number;
  /** `{root}/{slug}` folders that are checkouts: listed, never descended into. */
  checkouts?: readonly string[];
  /** What sits in the quarantine of the roots, and after how many days it goes. */
  quarantined?: readonly QuarantinedFolder[];
  quarantineDays?: number;
}

/** Pure: every row and every folder of the root, classified. */
export function planRoot(input: RootPlanInput): RootPlanEntry[] {
  const out: RootPlanEntry[] = [];
  const roots = [input.root, ...(input.extraRoots ?? [])].map(canonicalPath);
  const ours = (abs: string) => roots.some((r) => isInsideDir(abs, r));
  const byPath = new Map(input.rows.map((r) => [canonicalPath(r.absPath), r]));
  const scannedByPath = new Map(input.scanned.map((e) => [canonicalPath(e.absPath), e]));
  // Rows first: tracked, foreign or without a folder.
  for (const row of input.rows) {
    const abs = canonicalPath(row.absPath);
    const present = input.folderPresent(abs);
    const scan = scannedByPath.get(abs);
    const v = classifyRootEntry({
      hasRow: true, folderPresent: present, inRoot: ours(abs),
      hasDotGit: scan?.hasDotGit ?? false, inGitList: input.listed.has(abs), isSymlink: false, liveInside: false,
      ageMs: Math.max(0, input.now - row.createdAtMs), projectKnown: true,
    });
    out.push({ ...v, absPath: abs, projectId: row.projectId, rowId: row.id, bytes: null });
  }
  // Then folders with no row.
  for (const e of input.scanned) {
    const abs = canonicalPath(e.absPath);
    if (byPath.has(abs)) continue;
    const projectId = input.projectOf(e);
    const v = classifyRootEntry({
      hasRow: false, folderPresent: true, inRoot: true, hasDotGit: e.hasDotGit,
      standaloneRepo: e.standaloneRepo === true || input.repoPaths.has(abs), inGitList: input.listed.has(abs),
      isSymlink: e.isSymlink, liveInside: input.liveInside(e.absPath) || input.liveInside(abs), ageMs: e.ageMs, projectKnown: projectId !== null,
      owned: e.owned === true, registrationLost: e.registrationLost === true,
    });
    out.push({ ...v, absPath: abs, projectId, rowId: null, bytes: null });
  }
  // Worktrees git lists outside the root that no row knows: inventory only.
  for (const [abs, { projectId }] of input.listed) {
    if (byPath.has(abs) || scannedByPath.has(abs) || input.repoPaths.has(abs)) continue;
    if (ours(abs)) continue;
    out.push({ cls: "foreign", action: "inventory", reason: "listed by git, made by another tool", absPath: abs, projectId, rowId: null, bytes: null });
  }
  for (const c of input.checkouts ?? []) {
    out.push({ cls: "foreign", action: "inventory", reason: "a checkout or a project at the level of a project folder: never descended into", absPath: canonicalPath(c), projectId: null, rowId: null, bytes: null });
  }
  const days = input.quarantineDays ?? 0;
  for (const q of input.quarantined ?? []) {
    const due = input.now - q.sinceMs >= days * 24 * 3600_000;
    out.push({
      cls: "quarantined", action: due ? "purge" : "wait",
      reason: due ? `in quarantine for ${days} days: deleted on this pass` : `in quarantine, deleted after ${days} days; move it back to ${q.from} to restore it`,
      absPath: q.path, projectId: null, rowId: null, bytes: null, from: q.from,
    });
  }
  return out;
}

/** The counts the check and the summary print. */
export interface RootCounts {
  ghosts: number;
  orphans: number;
  rowsWithoutFolder: number;
  foreign: number;
  quarantined: number;
}

export function countRoot(plan: readonly RootPlanEntry[]): RootCounts {
  const c: RootCounts = { ghosts: 0, orphans: 0, rowsWithoutFolder: 0, foreign: 0, quarantined: 0 };
  for (const p of plan) {
    if (p.cls === "ghost") c.ghosts++;
    else if (p.cls === "orphan") c.orphans++;
    else if (p.cls === "row-no-folder") c.rowsWithoutFolder++;
    else if (p.cls === "foreign") c.foreign++;
    else if (p.cls === "quarantined") c.quarantined++;
  }
  return c;
}

// ─── Effects ──────────────────────────────────────────────────────────────

export interface KnownProject { id: string; slug: string; path: string }

/**
 * `git worktree list` of every known repository, indexed by the path of each
 * worktree. A repository git cannot answer for is left out (no answer is not an
 * empty list).
 */
export async function indexListedWorktrees(
  git: GitRunner,
  projects: readonly KnownProject[],
): Promise<{ listed: Map<string, { projectId: string; entry: ListedWorktree }>; repoPaths: Set<string>; byRepo: Map<string, ListedWorktree[]> }> {
  const listed = new Map<string, { projectId: string; entry: ListedWorktree }>();
  const repoPaths = new Set<string>();
  const byRepo = new Map<string, ListedWorktree[]>();
  for (const p of projects) {
    const repo = canonicalPath(p.path);
    repoPaths.add(repo);
    if (byRepo.has(repo)) continue;
    const list = await listRepoWorktrees(git, repo).catch(() => null);
    if (!list) continue;
    byRepo.set(repo, list);
    for (const entry of list) {
      const abs = canonicalPath(entry.path);
      if (abs === repo) continue;
      if (!listed.has(abs)) listed.set(abs, { projectId: p.id, entry });
    }
  }
  return { listed, repoPaths, byRepo };
}

/**
 * The project of a folder with no row: the marker Topics wrote in its admin
 * folder, then the repository whose `git worktree list` names it, then the
 * `{slug}` folder it sits in (only when that slug names exactly one project).
 */
export function projectOfFolder(
  entry: RootEntry,
  projects: readonly KnownProject[],
  listed: ReadonlyMap<string, { projectId: string }>,
): string | null {
  const marked = readOwnerMarker(entry.absPath)?.projectId;
  if (marked && projects.some((p) => p.id === marked)) return marked;
  const fromGit = listed.get(canonicalPath(entry.absPath))?.projectId;
  if (fromGit) return fromGit;
  const bySlug = projects.filter((p) => p.slug === entry.slug);
  return bySlug.length === 1 ? bySlug[0]!.id : null;
}

/**
 * Unlock-and-prune: git forgets the worktrees whose folder is gone. A lock Topics
 * took stops `git worktree prune` from forgetting one, so when no row claims the
 * entry its own lock is lifted first; a foreign lock is left alone.
 */
export async function pruneKnownRepos(
  git: GitRunner,
  byRepo: ReadonlyMap<string, ListedWorktree[]>,
  rowPaths: ReadonlySet<string>,
): Promise<number> {
  let pruned = 0;
  for (const [repo, list] of byRepo) {
    for (const w of list) {
      // git never flags a LOCKED worktree as prunable, so a vanished folder is read off the disk.
      if (!lockedByTopics(w) || !(w.prunable || !existsSync(w.path)) || rowPaths.has(canonicalPath(w.path))) continue;
      if (await unlockOwned(git, repo, w.path).catch(() => false)) pruned++;
    }
    await git(repo, ["worktree", "prune"]).catch(() => undefined);
  }
  return pruned;
}

/**
 * Moves a ghost folder into the root's quarantine, and returns where it went.
 * Re-checks everything the classification assumed, because the folder may have
 * changed since: it must sit EXACTLY two levels under the root, be a real
 * directory (never a link), resolve inside the real root, still hold no `.git`,
 * its parent must hold no `.git` either (then it is a subfolder of a checkout),
 * and Topics' marker must still be there. Any doubt (an `lstat` that fails for a
 * reason other than "not there") keeps the folder. Null when anything is off.
 */
export function quarantineGhostFolder(root: string, absPath: string, now: Date = new Date()): string | null {
  const realRoot = canonicalPath(root);
  const rel = relative(realRoot, canonicalPath(absPath));
  if (!rel || isAbsolute(rel) || rel.split(sep).length !== 2 || rel.startsWith("_") || rel.startsWith(".")) return null;
  try {
    // lstat on the path as given: a link is not a directory here.
    if (!lstatSync(absPath).isDirectory()) return null;
    if (!surelyAbsent(join(absPath, ".git"))) return null;
    if (!surelyAbsent(join(dirname(absPath), ".git"))) return null;
    if (realpathSync(absPath) !== join(realRoot, rel)) return null;
  } catch {
    return null;
  }
  if (!folderOwned(realRoot, join(realRoot, rel))) return null;
  return quarantineFolder(realRoot, join(realRoot, rel), now);
}

/** A label for a row made from a folder found on disk: lowercase, dashes, unique among the project's. */
export function nameForAdopted(folderName: string, taken: ReadonlySet<string>): string {
  const stem = folderName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 56) || "adopted";
  let name = stem;
  for (let i = 2; taken.has(name); i++) name = `${stem}-${i}`;
  return name;
}

export interface RegisterStore {
  create(input: { projectId: string; name: string; branchName: string | null; baseRef: string | null; mode: "branch" | "reuse" | "detached"; absPath: string }): { id: string };
  update(id: string, patch: { status: "ready" }): unknown;
  listNamesForProject(projectId: string): Set<string>;
}

/** Makes a row for an orphan checkout, as `ready`, and returns its id. Mode comes from what git says about its HEAD. */
export function registerOrphan(
  store: RegisterStore,
  entry: RootEntry,
  projectId: string,
  listedEntry: ListedWorktree | null,
  headBranch: string | null,
): { id: string } {
  const branch = listedEntry ? listedEntry.branch : headBranch;
  const detached = listedEntry ? listedEntry.detached || !listedEntry.branch : !branch;
  const mode: "branch" | "reuse" | "detached" = detached ? "detached" : branch!.startsWith("topics/") ? "branch" : "reuse";
  const name = nameForAdopted(basename(entry.absPath), store.listNamesForProject(projectId));
  const row = store.create({ projectId, name, branchName: detached ? null : branch, baseRef: detached ? null : branch, mode, absPath: entry.absPath });
  store.update(row.id, { status: "ready" });
  return row;
}

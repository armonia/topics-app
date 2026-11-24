/**
 * THE ROOT PASS OF THE WORKTREE GC (change worktree-standard, T3): the part of a
 * pass that reads the DISK and git instead of the table.
 *
 *   1. scan `{root}/{slug}/{name}` and index `git worktree list` of the known repos;
 *   2. classify every folder and row (`worktree-root-gc.ts`, pure);
 *   3. register the orphans (a row appears; the sweep then judges them like any other);
 *   4. remove the ghosts (24 h old, no `.git`, not listed by git, nobody inside);
 *   5. unlock and prune what git lists whose folder is gone.
 *
 * A row without a folder is not closed here: the sweep owns that, because
 * closing it also has to look at the task bound to it. This pass only counts it.
 */
import { existsSync } from "node:fs";
import type { GitRunner } from "./own-commits";
import {
  canonicalPath, countRoot, hasCreatorMarker, indexListedWorktrees, planRoot, projectOfFolder, pruneKnownRepos,
  registerOrphan, removeGhostFolder, scanWorktreeRoot, MIN_REMOVAL_AGE_MS,
  type KnownProject, type RegisterStore, type RootCounts, type RootEntry, type RootPlanEntry, type RootRow, type RootScan,
} from "./worktree-root-gc";
import { isInsideDir } from "../lib/path-containment";
import { lockedByTopics, lockLiftRule } from "./worktree-owner";

/** What the root pass reads of a stored worktree row: the real rows satisfy it, and so do the thin rows of a test bench. */
export interface StoredWorktree {
  id: string;
  projectId: string;
  absPath: string;
  branchName: string | null;
  status?: string;
  createdAt?: string;
}

export interface RootPassDeps {
  /** The current worktree root, or null when the host cannot name one (then there is no pass). */
  roots: () => { root: string; extraRoots: string[] } | null;
  store: { list(): StoredWorktree[]; create?: RegisterStore["create"]; update?: RegisterStore["update"]; listNamesForProject?: RegisterStore["listNamesForProject"] };
  projects: () => KnownProject[];
  git: GitRunner;
  liveInside: (absPath: string) => boolean;
  log: (msg: string) => void;
  now?: () => number;
  /** Told, on every read of git's lists, which worktrees carry a lock no rule lets Topics lift. */
  onLocks?: (lockedByOthers: Set<string>) => void;
  /** Days of silence after which a `claude-code:` session counts as over (the `worktree_abandon_days` setting). */
  abandonDays?: () => number;
}

export interface RootPassResult {
  scanMs: number;
  registered: number;
  ghostsRemoved: number;
  pruned: number;
  /** Counts of what the scan found BEFORE acting. */
  found: RootCounts;
  plan: RootPlanEntry[];
}

function rowsOf(store: RootPassDeps["store"]): RootRow[] {
  return store.list().map((w) => {
    const created = Date.parse(w.createdAt ?? "");
    return {
      id: w.id, projectId: w.projectId, absPath: w.absPath, status: w.status as RootRow["status"],
      createdAtMs: Number.isFinite(created) ? created : Date.now(),
    };
  });
}

/** Everything a pass needs to know about the disk, read once. */
async function gather(deps: RootPassDeps) {
  const r = deps.roots();
  if (!r) return null;
  const now = (deps.now ?? Date.now)();
  const projects = deps.projects();
  const rows = rowsOf(deps.store);
  const scans: RootScan[] = [r.root, ...r.extraRoots].map((root) => scanWorktreeRoot(root, now));
  const scanned: RootEntry[] = scans.flatMap((s) => s.entries);
  const scanMs = scans.reduce((n, s) => n + s.ms, 0);
  const { listed, repoPaths, byRepo } = await indexListedWorktrees(deps.git, projects);
  // Locked by others = every lock the rule does not lift: foreign prefixes always,
  // a `claude-code:` lock until its session is over and nothing would be lost.
  const mayLift = lockLiftRule(deps.git, deps.abandonDays ?? (() => 7));
  const others = new Set<string>();
  for (const w of [...byRepo.values()].flat()) {
    if (w.locked && !lockedByTopics(w) && !(await mayLift(w).catch(() => false))) others.add(canonicalPath(w.path));
  }
  deps.onLocks?.(others);
  const plan = planRoot({
    root: r.root, extraRoots: r.extraRoots, rows, scanned, listed, repoPaths,
    folderPresent: (p) => existsSync(p),
    liveInside: deps.liveInside,
    projectOf: (e) => projectOfFolder(e, projects, listed),
    creatorMarked: (e) => hasCreatorMarker(e, projects),
    now,
  });
  return { r, rows, scanned, scanMs, listed, byRepo, plan, projects };
}

/** The classification only, nothing acted on: what the preview and `--check` show. */
export async function previewRoot(deps: RootPassDeps): Promise<{ plan: RootPlanEntry[]; scanMs: number; counts: RootCounts } | null> {
  const g = await gather(deps);
  return g ? { plan: g.plan, scanMs: g.scanMs, counts: countRoot(g.plan) } : null;
}

export async function runRootPass(deps: RootPassDeps): Promise<RootPassResult | null> {
  const g = await gather(deps);
  if (!g) return null;
  const found = countRoot(g.plan);
  let registered = 0;
  let ghostsRemoved = 0;
  const scannedByPath = new Map(g.scanned.map((e) => [canonicalPath(e.absPath), e]));
  for (const p of g.plan) {
    try {
      if (p.action === "register" && p.projectId && deps.store.create && deps.store.update && deps.store.listNamesForProject) {
        const entry = scannedByPath.get(p.absPath);
        if (!entry) continue;
        const listedEntry = g.listed.get(p.absPath)?.entry ?? null;
        const head = listedEntry ? null : await headBranchOf(deps.git, entry.absPath);
        const row = registerOrphan({ create: deps.store.create, update: deps.store.update, listNamesForProject: deps.store.listNamesForProject }, entry, p.projectId, listedEntry, head);
        registered++;
        deps.log(`[worktree-gc] cartella orfana registrata: ${p.absPath} (riga ${row.id})`);
      } else if (p.action === "remove-folder") {
        // Re-asked at the last moment: somebody may have walked in since the scan.
        if (deps.liveInside(p.absPath)) continue;
        const root = [g.r.root, ...g.r.extraRoots].find((x) => isInsideDir(p.absPath, canonicalPath(x)));
        if (root && await removeGhostFolder(root, p.absPath)) {
          ghostsRemoved++;
          deps.log(`[worktree-gc] cartella fantasma rimossa: ${p.absPath}`);
        }
      }
    } catch (err) {
      deps.log(`[worktree-gc] passata sulla radice, ${p.absPath}: ${(err as Error)?.message ?? err}`);
    }
  }
  const pruned = await pruneKnownRepos(deps.git, g.byRepo, new Set(g.rows.map((r) => canonicalPath(r.absPath)))).catch(() => 0);
  return { scanMs: g.scanMs, registered, ghostsRemoved, pruned, found, plan: g.plan };
}

/** `git rev-parse --abbrev-ref HEAD` of a folder: the branch, or null when HEAD is detached or git cannot say. */
async function headBranchOf(git: GitRunner, absPath: string): Promise<string | null> {
  const r = await git(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = r.stdout.trim();
  return r.code === 0 && name && name !== "HEAD" ? name : null;
}

export interface ForeignDeps {
  /** The row's folder is outside Topics' roots. */
  isForeign: (absPath: string) => boolean;
  /** The row's branch is merged into main and the tree is clean. */
  mergedAndClean: (row: { id: string; projectId: string; absPath: string; branchName: string | null }) => Promise<boolean>;
  /** A live session, a running turn, or a task still active holds the row. */
  held: (row: { id: string; absPath: string }) => boolean;
  remove: (id: string) => Promise<boolean>;
  log: (msg: string) => void;
}

/**
 * `gc_foreign = merged`: the adopted worktrees (made by another tool) whose branch
 * is merged into main and whose tree is clean, nobody inside, older than 24 h. The
 * default is `off` and then this never runs. The branch is never touched, and git
 * itself refuses a dirty or locked folder.
 */
export async function removeMergedForeign(rows: readonly StoredWorktree[], d: ForeignDeps, now: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const w of rows) {
    if (w.status !== "ready" || !d.isForeign(w.absPath)) continue;
    const age = now - Date.parse(w.createdAt ?? "");
    if (!Number.isFinite(age) || age < MIN_REMOVAL_AGE_MS) continue;
    try {
      if (d.held(w)) continue;
      if (!(await d.mergedAndClean(w))) continue;
      if (await d.remove(w.id)) { removed++; d.log(`[worktree-gc] worktree esterno già su main, rimosso: ${w.absPath}`); }
    } catch (err) {
      d.log(`[worktree-gc] worktree esterno ${w.absPath}: ${(err as Error)?.message ?? err}`);
    }
  }
  return removed;
}

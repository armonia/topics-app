/**
 * The bar behind `scripts/worktree-orphans.ts --check` (change worktree-standard, T3):
 * it fails when the worktree root has leaked. It reads the rows of the database
 * (read-only) and the folders of the root, classifies them with the same code the
 * GC uses (`worktree-root-gc.ts`), and exits 1 when any of these remain:
 *
 *   - ghosts: folders with no row, no `.git`, nothing listing them;
 *   - unregistered orphans: checkouts git knows that no row claims;
 *   - rows whose folder is gone;
 *   - or when reading the root takes longer than 2 s (the trigger to move the scan
 *     to a native sidecar).
 *
 * An entry the GC is still waiting on (under a day old) does not count: it is in
 * flight, not leaked. Foreign worktrees are inventory, not a failure, and so is a
 * folder with no Topics marker: the GC never touches it, so it is printed for a
 * person to look at (`unknown`), and it does not fail the check. What sits in
 * quarantine is printed too, with where it came from.
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  ROOT_SCAN_BUDGET_MS, canonicalPath, countRoot, planRoot, scanWorktreeRoot,
  type RootCounts, type RootPlanEntry, type RootRow,
} from "./worktree-root-gc";
import { normalizeWorktreeRoot } from "../lib/worktree-root-setting";
import { listQuarantine, pastRootsFromRows } from "./worktree-root-ledger";
import { defaultWorktreeRootDir, worktreeRootDir } from "./worktree-root";
import { resolve } from "node:path";

export interface RootCheckResult {
  /** 0 clean, 1 leaked or too slow. */
  exit: 0 | 1;
  counts: RootCounts;
  scanMs: number;
  /** The entries that make the check fail, one line each. */
  problems: string[];
  /** Entries a person should look at that do not fail the check: unknown folders, quarantine. */
  notes: string[];
}

/** Pure over its inputs apart from the folder reads: what is leaking in `root`. */
export function checkRoot(input: {
  rows: readonly RootRow[];
  root: string;
  extraRoots?: readonly string[];
  now?: number;
  /** Paths of the known projects: a `{root}/{slug}` that is one is never descended into. */
  projectPaths?: readonly string[];
}): RootCheckResult {
  const now = input.now ?? Date.now();
  const roots = [input.root, ...(input.extraRoots ?? [])];
  const projectPaths = new Set((input.projectPaths ?? []).map((p) => canonicalPath(p)));
  const scans = roots.map((r) => scanWorktreeRoot(r, now, { projectPaths }));
  const scanMs = scans.reduce((n, s) => n + s.ms, 0);
  const plan = planRoot({
    root: input.root, extraRoots: input.extraRoots, rows: input.rows, scanned: scans.flatMap((s) => s.entries),
    listed: new Map(), repoPaths: new Set(), folderPresent: (p) => existsSync(p), liveInside: () => false,
    // The check does not ask git which repository an orphan belongs to: any checkout no row claims is a leak.
    projectOf: () => "unknown", now,
    checkouts: scans.flatMap((s) => s.checkouts),
    quarantined: roots.flatMap((r) => listQuarantine(r)),
  });
  const leaking = (e: RootPlanEntry) =>
    e.action !== "wait" && e.action !== "inventory" && (e.cls === "ghost" || e.cls === "orphan" || e.cls === "row-no-folder");
  const failing = plan.filter(leaking);
  const problems = failing.map((e) => `${e.cls.padEnd(14)} ${e.absPath}  (${e.reason})`);
  const notes = plan
    .filter((e) => (e.cls === "ghost" && e.action === "inventory") || e.cls === "quarantined")
    .map((e) => `${(e.cls === "ghost" ? "unknown" : e.cls).padEnd(14)} ${e.absPath}${e.from ? `  from ${e.from}` : ""}  (${e.reason})`);
  const slow = scanMs > ROOT_SCAN_BUDGET_MS;
  if (slow) problems.push(`scan           reading the root took ${Math.round(scanMs)} ms, over the ${ROOT_SCAN_BUDGET_MS} ms budget`);
  return { exit: failing.length > 0 || slow ? 1 : 0, counts: countRoot(failing), scanMs, problems, notes };
}

/**
 * The rows of a database opened read-only, the root set in its settings when
 * there is one, and the known projects (for past roots and the slug-level check).
 */
export function readRootInputs(dbPath: string): { rows: RootRow[]; rootSetting: string | null; projects: Array<{ slug: string; path: string }> } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = (db.prepare("SELECT id, project_id AS projectId, abs_path AS absPath, status, created_at AS createdAt FROM worktrees").all() as Array<{
      id: string; projectId: string; absPath: string; status: RootRow["status"]; createdAt: string;
    }>).map((r) => ({
      id: r.id, projectId: r.projectId, absPath: r.absPath, status: r.status,
      createdAtMs: Number.isFinite(Date.parse(r.createdAt)) ? Date.parse(r.createdAt) : Date.now(),
    }));
    let rootSetting: string | null = null;
    try {
      const v = (db.prepare("SELECT worktree_root AS v FROM app_settings LIMIT 1").get() as { v?: string | null } | null)?.v;
      rootSetting = v && v.trim() ? normalizeWorktreeRoot(v) : null;
    } catch { /* an older database has no such column: the default root applies */ }
    let projects: Array<{ slug: string; path: string }> = [];
    try { projects = db.prepare("SELECT slug, path FROM projects").all() as Array<{ slug: string; path: string }>; } catch { /* no projects table */ }
    return { rows, rootSetting, projects };
  } finally {
    db.close();
  }
}

/**
 * The roots of the installation a database belongs to: the one its settings name
 * (the env override still wins), the default one, and the past ones its rows
 * prove. What the scripts read instead of guessing the home of whoever runs them.
 */
export function rootsOfDatabase(dbPath: string, env: NodeJS.ProcessEnv = process.env) {
  const inputs = readRootInputs(dbPath);
  const root = resolve(worktreeRootDir(env, inputs.rootSetting));
  const past = pastRootsFromRows(inputs.rows, new Set(inputs.projects.map((p) => p.slug))).map((r) => resolve(r));
  const extraRoots = [...new Set([resolve(defaultWorktreeRootDir(env)), ...past])].filter((r) => r !== root);
  return { ...inputs, root, extraRoots };
}

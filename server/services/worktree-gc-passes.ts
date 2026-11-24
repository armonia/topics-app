/**
 * THE EXTRA PASSES OF THE WORKTREE GC (change worktree-standard, T3 and T4):
 * the cap per project, the removal of merged foreign worktrees, and the preview.
 *
 * They are written against `PassesCtx`, a small set of closures the runner
 * builds from its own state, so this file owns the logic and the runner keeps
 * the wiring (and stays under the size gate).
 */
import type { GcForeignMode } from "../../shared/worktree-settings";
import type { GcWorktree, TaskStatus, WorktreeGcSummary } from "./worktree-gc";
import { planOverCap } from "./worktree-cap";
import { planSweep, weighFolders, type PlannedOutcome } from "./worktree-gc-dryrun";
import { previewRoot, removeMergedForeign, type RootPassDeps } from "./worktree-gc-root-pass";
import { canonicalPath, type RootPlanEntry } from "./worktree-root-gc";

/** The worktree settings a pass reads (Settings > Worktrees). */
export interface GcSettings {
  abandonDays: number;
  gcForeign: GcForeignMode;
  maxPerProject: number;
  /** Days a quarantined ghost folder is kept; absent = the default. */
  quarantineDays?: number;
}

/** A row as the passes see it. */
export interface GcRow {
  id: string;
  projectId: string;
  absPath: string;
  branchName: string | null;
  mode: "branch" | "reuse" | "detached";
  status?: string;
  createdAt?: string;
}

/** The preview of a pass: nothing is written, every folder and row gets a class, an action and a weight. */
export interface GcPlan {
  entries: Array<RootPlanEntry & { planned: PlannedOutcome | null }>;
  scanMs: number;
  /** Projects over their cap. */
  overCap: Array<{ projectId: string; count: number; max: number }>;
  settings: GcSettings;
}

export interface PassesCtx {
  readSettings: () => GcSettings;
  rows: () => GcRow[];
  isOurs: (absPath: string) => boolean;
  folderPresent: (absPath: string) => boolean;
  taskOf: (worktreeId: string) => { taskId: string; status: TaskStatus; archived: boolean } | { taskId: null };
  isInFlight: (taskId: string) => boolean;
  liveInside: (absPath: string) => boolean;
  /** A preview or a script of Topics is running in this worktree. */
  busyInside: (wt: GcRow) => boolean;
  slim: (absPath: string) => Promise<unknown>;
  /** One worktree through the full safety contract, with the real effects. */
  sweepOne: (wt: GcWorktree, settings: GcSettings) => Promise<WorktreeGcSummary>;
  /** The dry-run dependencies of the whole sweep, for the preview. */
  previewDeps: (population: GcRow[], settings: GcSettings) => Parameters<typeof planSweep>[0];
  population: (opts: { repair: boolean }) => Promise<GcRow[]>;
  rootDeps: () => RootPassDeps;
  canScanRoot: () => boolean;
  removeForeign: Parameters<typeof removeMergedForeign>[1];
}

const asGc = (w: GcRow): GcWorktree => ({ id: w.id, projectId: w.projectId, absPath: w.absPath, branchName: w.branchName, mode: w.mode });

/**
 * Over the cap: slim the checkouts nobody is in, then try the oldest ones against
 * the full safety contract until the project is back at the cap. The cap never
 * loosens the contract: a worktree the sweep would keep stays. Returns how many
 * checkouts went.
 */
export async function capPass(ctx: PassesCtx, projectId?: string): Promise<number> {
  const settings = ctx.readSettings();
  const rows = ctx.rows();
  // The cheap question first: a create asks for one project, and most are under the cap.
  if (projectId && rows.filter((w) => w.projectId === projectId && w.status !== "error" && ctx.isOurs(w.absPath) && ctx.folderPresent(w.absPath)).length <= settings.maxPerProject) return 0;
  const plans = planOverCap(rows.map((w) => {
    const t = ctx.taskOf(w.id);
    const working = t.taskId !== null && (t.status === "in_progress" || ctx.isInFlight(t.taskId));
    return {
      id: w.id, projectId: w.projectId, status: (w.status ?? "ready") as "pending" | "ready" | "error",
      createdAtMs: Date.parse(w.createdAt ?? "") || 0,
      inRoot: ctx.isOurs(w.absPath) && ctx.folderPresent(w.absPath),
      exempt: working || ctx.liveInside(w.absPath),
    };
  }), settings.maxPerProject).filter((p) => !projectId || p.projectId === projectId);

  let freed = 0;
  const byId = new Map(rows.map((w) => [w.id, w]));
  for (const plan of plans) {
    const candidates = plan.reap.map((id) => byId.get(id)).filter((w): w is GcRow => !!w);
    for (const w of candidates) {
      if (!ctx.busyInside(w)) { try { await ctx.slim(w.absPath); } catch { /* best effort: slimming is a courtesy */ } }
    }
    let goneHere = 0;
    for (const w of candidates) {
      if (goneHere >= plan.excess) break;
      const s = await ctx.sweepOne(asGc(w), settings);
      goneHere += s.reaped + s.freed + s.abandoned + s.unbound;
    }
    freed += goneHere;
  }
  return freed;
}

/** `gc_foreign = merged`: adopted worktrees already on main, clean and idle, are removed (the folder, never the branch). */
export function foreignPass(ctx: PassesCtx): Promise<number> {
  return removeMergedForeign(ctx.rows(), ctx.removeForeign);
}

/** The preview: the real decision code over every folder and row, effects stubbed, nothing written. */
export async function previewPass(ctx: PassesCtx, opts: { weigh?: boolean } = {}): Promise<GcPlan> {
  const settings = ctx.readSettings();
  const scanned = ctx.canScanRoot() ? await previewRoot(ctx.rootDeps()) : null;
  const population = await ctx.population({ repair: false });
  const outcomes = await planSweep(ctx.previewDeps(population, settings), population.map(asGc));
  const idByPath = new Map(population.map((w) => [canonicalPath(w.absPath), w.id]));
  const base: RootPlanEntry[] = scanned?.plan ?? population.map((w) => ({
    cls: "tracked", action: "judge", reason: "judged by the sweep",
    absPath: canonicalPath(w.absPath), projectId: w.projectId, rowId: w.id, bytes: null,
  }));
  const entries = base.map((e) => {
    const id = idByPath.get(e.absPath);
    return { ...e, planned: (id ? outcomes.get(id) : undefined) ?? null };
  });
  if (opts.weigh) {
    const sizes = await weighFolders(entries.filter((e) => ctx.folderPresent(e.absPath)).map((e) => e.absPath));
    for (const e of entries) e.bytes = sizes.get(e.absPath) ?? null;
  }
  const counts = new Map<string, number>();
  for (const w of ctx.rows()) {
    if (w.status !== "error" && ctx.isOurs(w.absPath)) counts.set(w.projectId, (counts.get(w.projectId) ?? 0) + 1);
  }
  const overCap = [...counts]
    .filter(([, n]) => n > settings.maxPerProject)
    .map(([projectId, count]) => ({ projectId, count, max: settings.maxPerProject }));
  return { entries, scanMs: scanned?.scanMs ?? 0, overCap, settings };
}

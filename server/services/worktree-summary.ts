/**
 * The one-line summary of this machine's worktrees (change worktree-standard,
 * track T12), as a node reports it to its primary and as the primary shows its
 * own line.
 *
 * Built from the cleanup preview with weights, which walks every folder with
 * `du`: seconds on a root with a hundred worktrees. The heartbeat asks every
 * 30 s through a client with a 5 s deadline, so the answer is always the last
 * one measured, and a stale one starts a new measure in the background
 * (stale-while-revalidate, one measure at a time). The first ask after a start
 * answers `null` and the next one has the number.
 */
import type { WorktreePlanEntryPayload, WorktreePlanPayload } from "../../shared/worktree-plan";
import type { WorktreeSummary } from "../../shared/worktree-summary";

/** How long a measure stays current. A worktree root does not change by the minute. */
export const WORKTREE_SUMMARY_TTL_MS = 10 * 60_000;

/** The summary of one preview. Pure. */
export function summarizePlan(plan: WorktreePlanPayload, root: string, rootFreeGb: number | null, at: Date): WorktreeSummary {
  const folders = plan.entries.filter((e) => e.cls === "tracked" || e.cls === "orphan");
  const weighed = plan.entries.filter((e) => e.bytes !== null && e.cls !== "foreign");
  return {
    root,
    count: folders.length,
    bytes: weighed.length > 0 ? weighed.reduce((sum, e) => sum + (e.bytes ?? 0), 0) : null,
    rootFreeGb: rootFreeGb === null ? null : Math.round(rootFreeGb * 10) / 10,
    foreign: plan.foreignCount,
    ghosts: plan.entries.filter((e) => e.cls === "ghost").length,
    orphans: plan.entries.filter((e) => e.cls === "orphan").length,
    scanMs: plan.scanMs,
    at: at.toISOString(),
  };
}

export interface WorktreeSummaryDeps {
  /** The cleanup preview of this machine, read only; `weigh` adds sizes. `null` = it could not be built. */
  plan: (opts: { weigh: boolean }) => Promise<WorktreePlanPayload | null>;
  /** The worktree root this machine resolves now. */
  root: () => string;
  /** Free GB on the volume of a path; `null` when it cannot be read. */
  freeGb: (path: string) => number | null;
  now?: () => number;
  ttlMs?: number;
  log?: (message: string, err?: unknown) => void;
}

export interface WorktreeSummarySource {
  /** The last measure, never waiting; a missing or stale one starts a new measure. */
  current(): WorktreeSummary | null;
  /** The folders of the last measure; `null` when none was taken yet (one is started). */
  entries(): WorktreePlanEntryPayload[] | null;
  /** Measure now (shared with a measure already running). */
  refresh(): Promise<WorktreeSummary | null>;
  /** Forget the last measure: the next `current()` starts a new one (after a cleanup pass). */
  invalidate(): void;
}

export function createWorktreeSummarySource(deps: WorktreeSummaryDeps): WorktreeSummarySource {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? WORKTREE_SUMMARY_TTL_MS;
  let last: { summary: WorktreeSummary; entries: WorktreePlanEntryPayload[]; atMs: number } | null = null;
  let running: Promise<WorktreeSummary | null> | null = null;
  // Bumped by `invalidate()`: a measure started before it read the folders as
  // they were before the cleanup or the policy change, and must not land over
  // the fresh state for a whole TTL.
  let generation = 0;

  function refresh(): Promise<WorktreeSummary | null> {
    if (running) return running;
    const startedAt = generation;
    const run = (async () => {
      const plan = await deps.plan({ weigh: true });
      if (!plan || startedAt !== generation) return last?.summary ?? null;
      const root = deps.root();
      const atMs = now();
      const summary = summarizePlan(plan, root, deps.freeGb(root), new Date(atMs));
      last = { summary, entries: plan.entries, atMs };
      return summary;
    })().catch((err) => {
      deps.log?.("worktree summary: the measure failed", err);
      return last?.summary ?? null;
    });
    running = run;
    void run.finally(() => { if (running === run) running = null; });
    return run;
  }

  const stale = () => !last || now() - last.atMs >= ttl;

  return {
    current() {
      if (stale()) void refresh();
      return last?.summary ?? null;
    },
    entries() {
      if (stale()) void refresh();
      return last?.entries ?? null;
    },
    refresh,
    invalidate() { generation++; last = null; },
  };
}

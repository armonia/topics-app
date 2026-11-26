/**
 * THE PREVIEW OF A GC PASS (change worktree-standard, T3).
 *
 * The preview runs the REAL decision code, `sweepWorktrees`, with every effect
 * swapped for a stub that says yes and does nothing, one worktree at a time, so
 * each folder gets its own answer: what the contract would do, and why. Reads
 * (git status, branch state, who is inside) are the real ones; nothing is
 * written, removed, archived, commented or broadcast.
 */
import { runBounded } from "../lib/bounded-spawn";
import { sweepWorktrees, type GcWorktree, type WorktreeGcDeps, type WorktreeGcSummary } from "./worktree-gc";

export type PlannedAction =
  | "reap" | "archive-then-free" | "free-checkout" | "commit-residue-then-free"
  | "abandon" | "unbind" | "keep" | "error";

export interface PlannedOutcome {
  action: PlannedAction;
  /** Why it is kept, when it is; otherwise empty. */
  reason: string;
  /** The checkout would also lose its regenerable artifacts (kept, but slimmed). */
  slim: boolean;
}

/** The same dependencies with every effect replaced by a stub that succeeds and changes nothing. */
export function dryRunDeps(real: WorktreeGcDeps): WorktreeGcDeps {
  const yes = async () => true;
  return {
    ...real,
    reap: yes,
    freeCheckout: real.freeCheckout ? yes : undefined,
    abandon: real.abandon ? yes : undefined,
    unbind: real.unbind ? yes : undefined,
    archiveBranch: real.archiveBranch ? yes : undefined,
    commitResidue: real.commitResidue ? yes : undefined,
    slim: real.slim ? async () => 1 : undefined,
    noteOnTask: undefined,
    stampDeliveryBranch: undefined,
    log: () => undefined,
  };
}

/** What one worktree's own pass did, read off its summary. */
export function describeSweepOutcome(s: WorktreeGcSummary): PlannedOutcome {
  const slim = s.slimmed > 0;
  if (s.errors > 0) return { action: "error", reason: "the decision could not be taken", slim };
  if (s.abandoned > 0) return { action: "abandon", reason: "", slim };
  if (s.unbound > 0) return { action: "unbind", reason: "", slim };
  if (s.archived > 0) return { action: "archive-then-free", reason: "", slim };
  if (s.freed > 0) return { action: s.residueCommitted > 0 ? "commit-residue-then-free" : "free-checkout", reason: "", slim };
  if (s.reaped > 0) return { action: "reap", reason: "", slim };
  const [reason] = Object.keys(s.keptReasons);
  return { action: "keep", reason: reason ?? "", slim };
}

/** Plans each worktree on its own, in order, against the dry-run dependencies. */
export async function planSweep(
  real: WorktreeGcDeps,
  population: readonly GcWorktree[],
): Promise<Map<string, PlannedOutcome>> {
  const out = new Map<string, PlannedOutcome>();
  const stubbed = dryRunDeps(real);
  for (const wt of population) {
    const summary = await sweepWorktrees({ ...stubbed, listWorktrees: () => [wt] });
    out.set(wt.id, describeSweepOutcome(summary));
  }
  return out;
}

/**
 * On-disk weight of folders, in bytes, measured with `du -sk` a few at a time and
 * within an overall budget: what is not measured in time stays `null`.
 */
export async function weighFolders(paths: readonly string[], budgetMs = 60_000, parallel = 6): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(paths.map((p) => [p, null]));
  const deadline = Date.now() + budgetMs;
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= paths.length || Date.now() >= deadline) return;
      const path = paths[i]!;
      const r = await runBounded(["du", "-sk", path], { stderr: "pipe", timeoutMs: Math.max(1000, Math.min(15_000, deadline - Date.now())) });
      const kb = r.exitCode === 0 || r.stdout ? Number.parseInt(r.stdout.split(/\s/)[0] ?? "", 10) : NaN;
      out.set(path, Number.isFinite(kb) ? kb * 1024 : null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, paths.length) }, lane));
  return out;
}

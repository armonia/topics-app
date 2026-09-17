/**
 * WHAT ONE CARD REALLY COSTS IN MEMORY, measured where the cost is.
 *
 * The admission gate prices one more agent at the median of the recent ones
 * (`estimatedAgentMemCost` in `shared/machine-budget.ts`). The samples used to
 * be the footprint of each live SESSION in the fleet probe, and that list
 * cannot see a card: on the native runtime the agent is an array of messages
 * inside the server, and its bash tool and its pre-review checks are children
 * of the server root, never of a session. Read live on 14/09/2026: three PTY
 * terminals of the person, median 1.28 GB, clamped to the floor, while two
 * `test:unit:shards` runs of 11 GB each hung off the server pid.
 *
 * So the price list is fed from the one place a card's memory is attributable
 * by construction: the process tree of its own pre-review checks, whose root
 * pid the check runner already holds. Each round keeps its PEAK (the checks run
 * one after the other, so the peak of the round is the peak of its heaviest
 * gate), and one number is kept per card: a card that delivers twice replaces
 * its own sample instead of voting twice.
 *
 * In memory and not in the DB, deliberately: a reload empties it, and an empty
 * list prices at the floor, which is the conservative answer. A table would
 * need a migration applied to the live DB for a number that is stale within a
 * day anyway.
 */
import { getDescendantPids } from "./process-tree";
import { procFootprintKB } from "./fleet-usage";

/** How many cards the median runs over: enough that one pathological delivery
 *  is outvoted, few enough that a change in the kind of work shows up in a day. */
export const CARD_PEAKS_KEPT = 9;

const peaks: { taskId: string; gb: number }[] = [];

/** Record the peak of one check round of `taskId`, replacing that card's older one. */
export function recordCardMemPeak(taskId: string, gb: number): void {
  if (!taskId || !Number.isFinite(gb) || gb <= 0) return;
  const i = peaks.findIndex((p) => p.taskId === taskId);
  if (i >= 0) peaks.splice(i, 1);
  peaks.push({ taskId, gb });
  if (peaks.length > CARD_PEAKS_KEPT) peaks.splice(0, peaks.length - CARD_PEAKS_KEPT);
}

/** The recent per-card peaks, in GB, oldest first: the gate's memory price list. */
export function recentCardMemPeaksGB(): number[] {
  return peaks.map((p) => p.gb);
}

/** Test seam: every case starts from an empty ledger. */
export function _resetCardMemPeaks(): void {
  peaks.length = 0;
}

/**
 * The footprint of `pid` and all its descendants right now, in KB, or `null`
 * when the platform cannot say (no `proc_pid_rusage`, or every pid already
 * gone). The process table is the shared two-second snapshot, not a fresh
 * `ps`: a grandchild born inside that window is missed by one sample, which a
 * sampler that runs every few seconds over minutes of work can afford.
 */
export async function treeFootprintKB(pid: number): Promise<number | null> {
  const pids = await getDescendantPids(pid);
  let total = 0;
  let measured = false;
  for (const p of pids) {
    const kb = procFootprintKB(p);
    if (kb != null) { total += kb; measured = true; }
  }
  return measured ? total : null;
}

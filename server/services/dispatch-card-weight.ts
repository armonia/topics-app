/**
 * WHAT A CARD WEIGHS, MEASURED ON THE CARDS THAT RAN, PER BOARD.
 *
 * `dispatch-card-price.ts` prices a card by its board's KIND: the agent alone
 * (1 GB native) for a board in place without local checks, the price list of
 * the check peaks (4 GB whenever no check runs here, which is now always) for
 * every other board. Both are constants. The cards that actually ran say
 * something else: the whole server tree with one turn in flight was measured at
 * p50 0.83 GB on 26/10/2026, and the idle server is part of that figure, so the
 * card itself sits around 0.4-0.6 GB. Four gigabytes per card is a line nobody
 * reaches (6 + 4 = 10 GB of `held2m`: 0.3% of the samples of 24-26/10), and
 * the queue stays serial on a machine with room for two.
 *
 * HOW A CARD IS WEIGHED. On the `[memsig]` minute the host reads the footprint
 * of the server's whole process tree (`treeFootprintKB(process.pid)`): native
 * agents live inside it, CLI agents and every command and check of a card are
 * its children. With no local turn in flight the reading is the BASELINE; with
 * N local turns in flight, `(tree - baseline) / N` is what each one adds, and
 * every card keeps the highest it reached in its life. A card that ran its
 * pre-review checks also has their peak (`card-memory-peaks.ts`, sampled much
 * more often than once a minute): its weight is the higher of the two, read
 * when the price is asked, since the checks can end after the turn.
 *
 * THE PRICE is the median of the board's last cards (the same estimator as the
 * price list, `estimatedAgentMemCost`), over 72 hours, only once three cards are
 * in: below that the board keeps the price it had. Floor 0.4 GB, the measured
 * peak of one CLI agent, so a measurement that reads near zero (a baseline
 * taken while a terminal was heavier) never hands out unlimited seats; ceiling
 * the price list's own. A card flagged heavy never reads this: it pays the list.
 *
 * In memory and not in the DB, like the check peaks: a restart empties it, and
 * an empty ledger prices as before, which is the conservative answer.
 */
import { AGENT_COST_CEILING_MEM_GB } from "../../shared/board";
import { CLI_AGENT_PEAK_GB } from "./dispatch-capacity";

/** How far back a card still votes on its board's price. */
export const MEASURED_WEIGHT_WINDOW_MS = 72 * 60 * 60_000;
/** Cards a board needs before its measured weight replaces its price. */
export const MEASURED_WEIGHT_MIN_CARDS = 3;
/** Cards kept per board: one pathological card is outvoted, a change of work shows within a day. */
export const MEASURED_WEIGHT_KEPT = 9;
/** Never under one CLI agent's measured peak, whatever the subtraction says. */
export const MEASURED_WEIGHT_FLOOR_GB = CLI_AGENT_PEAK_GB;
/** Idle readings the baseline is the median of. */
const BASELINE_KEPT = 5;
/** An idle reading older than this no longer describes the server under a turn. */
const BASELINE_MAX_AGE_MS = 6 * 60 * 60_000;

/** A local turn in flight at the instant of the reading. */
export interface WeighedTurn {
  taskId: string;
  projectId: string;
}

interface CardWeight { taskId: string; gb: number; at: number }

function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function createCardWeightMeter(deps: {
  now?: () => number;
  /** The peak of the card's pre-review checks in GB, or null when none ran (`cardMemPeakGB`). */
  checkPeakGB?: (taskId: string) => number | null;
} = {}) {
  const now = deps.now ?? Date.now;
  const idle: { gb: number; at: number }[] = [];
  const running = new Map<string, { projectId: string; gb: number }>();
  const boards = new Map<string, CardWeight[]>();

  function baselineGB(at: number): number | null {
    while (idle.length > 0 && at - idle[0]!.at > BASELINE_MAX_AGE_MS) idle.shift();
    return idle.length > 0 ? median(idle.map((r) => r.gb)) : null;
  }

  return {
    /** One reading of the server tree, with the local turns in flight at that instant. */
    sample(treeGB: number | null, turns: readonly WeighedTurn[]): void {
      if (treeGB == null || !Number.isFinite(treeGB) || treeGB <= 0) return;
      const at = now();
      if (turns.length === 0) {
        idle.push({ gb: treeGB, at });
        if (idle.length > BASELINE_KEPT) idle.shift();
        return;
      }
      const base = baselineGB(at);
      if (base == null) return;
      const each = Math.max(0, treeGB - base) / turns.length;
      for (const { taskId, projectId } of turns) {
        const seen = running.get(taskId);
        running.set(taskId, { projectId, gb: Math.max(seen?.gb ?? 0, each) });
      }
    },

    /** The turn ended: its highest reading becomes one vote on its board. A turn never read is no vote. */
    finish(taskId: string): void {
      const card = running.get(taskId);
      if (!card) return;
      running.delete(taskId);
      const list = (boards.get(card.projectId) ?? []).filter((c) => c.taskId !== taskId);
      list.push({ taskId, gb: card.gb, at: now() });
      if (list.length > MEASURED_WEIGHT_KEPT) list.splice(0, list.length - MEASURED_WEIGHT_KEPT);
      boards.set(card.projectId, list);
    },

    /** The board's measured weight in GB, or null while it has too few recent cards. */
    measuredGB(projectId: string | null | undefined): number | null {
      if (!projectId) return null;
      const since = now() - MEASURED_WEIGHT_WINDOW_MS;
      const recent = (boards.get(projectId) ?? []).filter((c) => c.at >= since);
      if (recent.length < MEASURED_WEIGHT_MIN_CARDS) return null;
      const weights = recent.map((c) => {
        let checks: number | null = null;
        try { checks = deps.checkPeakGB?.(c.taskId) ?? null; } catch { /* no check peak: the tree alone */ }
        return Math.max(c.gb, checks != null && Number.isFinite(checks) ? checks : 0);
      });
      return Math.min(AGENT_COST_CEILING_MEM_GB, Math.max(MEASURED_WEIGHT_FLOOR_GB, median(weights)));
    },
  };
}

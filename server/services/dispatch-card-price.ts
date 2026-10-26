/**
 * WHAT ONE MORE CARD WEIGHS IN MEMORY DEPENDS ON WHAT ITS BOARD MAKES IT RUN.
 *
 * The admission gate priced every card at the same figure: the median of the
 * recent check-round peaks, held between 4 and 6 GB. That list is fed only by
 * the pre-review checks the server itself launches, so on a machine where no
 * board launches any it is empty for good and the figure is its floor, 4.0 GB:
 * a constant dressed as a measurement. The floor line then sits at 6 + 4 = 10 GB.
 *
 * MEASURED 26/10/2026, the day the queue stood still for hours:
 *
 *  - the line is out of reach, whatever a card costs. The lowest reading of the
 *    last two minutes (`held2m`) was at or above 10 GB in 0.3% of the 3 799
 *    samples of 24-26/10, at or above 7 GB in 3.1%, at or above 6 GB (the floor
 *    alone) in 6.9%. The other applications hold the RAM: Helium 3.7, OpenClaw
 *    3.2, Claude 3.0, Beeper 2.0.
 *  - the floor itself is right. Share of samples with sustained swap, by the
 *    held reading: 3-4 GB 46%, 4-5 GB 21%, 5-6 GB 9%, 6-7 GB 7%, 7+ GB 4%. The
 *    knee is at 5 GB.
 *  - the 4.0 is right for a card that runs the repo gates: 22 check rounds of
 *    24-26/10 peaked at p50 1.5, p90 4.0, p95 4.3, max 4.8 GB (sampled every
 *    70 s, so a lower bound). Knee 5 + p95 4.3 = 9.3, under the 10 GB line.
 *  - but 27 of the 46 cards started since 24/10 belong to the `attilio` board,
 *    which works IN PLACE on a folder that is not a repository and declares no
 *    local check. Such a card has no gate to burst: the live process tree of
 *    the whole server with six sessions open stayed at 0.65-0.93 GB, children
 *    of the server never above 41 MB (gh, osascript).
 *
 * So the price is the board's, not the machine's: a board that works in place
 * and runs no local check prices its cards at the agent and its light commands
 * (`reservationForRuntime`, the figure the no-check exemption already reserves),
 * everything else keeps the price list. A card flagged heavy keeps the price
 * list wherever it lives: it is the one that takes the machine by itself. The
 * floor and its two-minute window are untouched: they are the part that keeps
 * the Mac out of swap.
 */
import { estimatedAgentMemCost, reservedCost, type ReviewCheck } from "../../shared/board";
import { boardHasNoLocalChecks, reservationForRuntime } from "./dispatch-no-check-exemption";

export type CardWeight = "light" | "standard";

/** The part of a card that decides its weight on top of its board's. */
export interface CardPriceTask {
  projectId?: string | null;
  dispatchWeight?: string | null;
}

/** The part of a board's settings that decides how much its cards weigh. */
export interface CardPriceBoard {
  dispatchUseWorktree: boolean;
  reviewChecks: readonly ReviewCheck[];
}

/**
 * In place and no local check: nothing the card runs can burst past the agent.
 * A worktree board delivers a branch through the repo gates (typecheck, lint,
 * dead code), and a board with a local check runs it on this machine.
 */
export function cardWeightOf(board: CardPriceBoard | null | undefined, dispatchWeight?: string | null): CardWeight {
  if (!board || dispatchWeight === "heavy") return "standard";
  return !board.dispatchUseWorktree && boardHasNoLocalChecks(board.reviewChecks) ? "light" : "standard";
}

export function createCardPrices(deps: {
  /** The recent per-card check peaks, in GB (`recentCardMemPeaksGB`). */
  peaks(): readonly number[];
  isCliRuntime(): boolean;
  board(projectId: string): CardPriceBoard | null | undefined;
  taskOf(taskId: string): CardPriceTask | null | undefined;
}) {
  const safeBoard = (projectId: string | null | undefined): CardPriceBoard | null => {
    if (!projectId) return null;
    try { return deps.board(projectId) ?? null; } catch { return null; }
  };
  const safePeaks = (): readonly number[] => { try { return deps.peaks(); } catch { return []; } };

  /** Light or standard, for a card of that board; unknown reads standard. */
  function weightFor(projectId?: string | null, dispatchWeight?: string | null): CardWeight {
    return cardWeightOf(safeBoard(projectId), dispatchWeight);
  }

  /** One more card of that board, in GB. No board in hand means the dearer price. */
  function priceFor(projectId?: string | null, dispatchWeight?: string | null): number {
    if (weightFor(projectId, dispatchWeight) === "light") return reservationForRuntime(deps.isCliRuntime());
    return estimatedAgentMemCost(safePeaks());
  }

  /**
   * What the local turns in flight have reserved, each at the price of its own
   * board and for the whole life of the turn (`reservedCost` says why).
   */
  function reservedMemGB(launches: readonly (readonly [taskId: string, at: number])[], now: number): number {
    const byPrice = new Map<number, number[]>();
    for (const [taskId, at] of launches) {
      let task: CardPriceTask | null | undefined = null;
      try { task = deps.taskOf(taskId); } catch { /* an unknown card reads standard */ }
      const price = priceFor(task?.projectId, task?.dispatchWeight);
      byPrice.set(price, [...(byPrice.get(price) ?? []), at]);
    }
    let total = 0;
    for (const [price, instants] of byPrice) total += reservedCost(instants, { coreUnits: 0, memGB: price }, now).memGB;
    return total;
  }

  return { weightFor, priceFor, reservedMemGB };
}

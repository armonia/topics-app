/**
 * THE CAP "BY RESOURCES" (KANBAN-75, rewritten by card 363bbbc8), the contract
 * in one place.
 *
 * Its own module and not another two hundred lines of `board.ts`: this is a
 * closed question (a mode, one knob, two pure functions) with three readers
 * that do not talk to each other otherwise, the dispatcher gate, the settings
 * panel and the SQLite row. `board.ts` re-exports everything, so no caller has
 * to know where it lives.
 */
/**
 * THE OTHER WAY TO SAY "ENOUGH", and it answers a different question from the
 * count cap in `board.ts`.
 *
 * `count` asks HOW MANY agents may run together, and it is the default because
 * it is the only answer that is stable: a number does not move while you look
 * at it. `resources` asks something the number cannot express, which is HOW
 * MUCH OF THIS MACHINE Topics may take, and the answer is a percentage.
 *
 * WHAT CHANGED, and why the old shape is gone. This mode used to read the
 * WHOLE machine's load average against two thresholds. That made it a brake
 * measuring somebody else's browser, and it admitted the entire queue the
 * instant the average dipped (eight cards in one tick at load 12 on 12 cores,
 * measured 2026-09-07). Now it reads OUR OWN tree against OUR OWN budget, and
 * the rest of the machine enters only as "what the others leave free": see
 * `shared/machine-budget.ts`, which holds the whole controller.
 */
export type DispatchCapMode = "count" | "resources";

/** What the cap carries BEYOND the number: the mode and the one knob.
 *  Split from `GlobalDispatchCap` because whoever draws a slider holds only
 *  these two fields, and should not have to invent a `max` to read them. */
export interface GlobalDispatchCapExtras {
  /**
   * Which question the brake asks. Optional, and absent means `count`: every
   * install that predates this field, and every test that builds a cap by hand,
   * keeps the behaviour it had.
   */
  mode?: DispatchCapMode;
  /**
   * How much of this computer Topics may use, 0..1. One knob for both axes: the
   * CPU budget is `share x cores` and the memory budget is `share x total`.
   * Absent means the default (see `BUDGET_SHARE_DEFAULT`).
   */
  budgetShare?: number;
}

/** Which mode is in force. `count` unless the machine explicitly asked for the
 *  other one: an unreadable value is the default, never the stricter brake. */
export function capMode(cap: GlobalDispatchCapExtras): DispatchCapMode {
  return cap.mode === "resources" ? "resources" : "count";
}

/**
 * THE THREE COLOURS on the live reading: how close we are to the budget right
 * now. Green while there is room, amber on approach, red once the budget is
 * reached, which is when the next agent waits and the running gates start
 * getting frozen. One function for both axes: the budget is already in the unit
 * of its own measure.
 */
export type ThresholdBand = "green" | "amber" | "red";

export function livePressureBand(value: number, threshold: number): ThresholdBand {
  if (!Number.isFinite(value) || threshold <= 0) return "green";
  if (value >= threshold) return "red";
  return value >= threshold * 0.75 ? "amber" : "green";
}

/**
 * WHAT A WRITER MAY CHANGE about the machine-wide cap: every field of the '*'
 * row, each optional, so a slider that moves the budget does not have to
 * re-send the count.
 *
 * It lives here because BOTH sides need it and both wrote it once already: the
 * client store that calls `setGlobalCap` and the task service that applies it.
 * Two identical copies is exactly the mirror `tests/unit/no-type-mirrors.test.ts`
 * exists to catch, and the day one of the two grows a field the other silently
 * drops it.
 */
export interface GlobalCapPatch {
  auto?: boolean;
  max?: number;
  mode?: DispatchCapMode;
  budgetShare?: number;
}

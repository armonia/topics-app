/**
 * THE LINE THAT SAYS "THIS RUN WILL TAKE LONGER, AND BY HOW MUCH".
 *
 * The twin of `shared/slot-acquired.ts`, for the other half of the same
 * problem. That line says WHEN the command really started; this one says how
 * much longer the command has decided to take, on purpose.
 *
 * WHY IT EXISTS. Under a fleet `scripts/test-unit-shards.ts` deliberately runs
 * with FEWER workers (4 shards -> 2 above a load pressure of 1.25), because
 * adding processes to a machine at load 46 on 12 cores makes every one of them
 * slower. Halving the parallelism roughly doubles the wall clock: that is the
 * point of the decision, not a defect of it. The board, meanwhile, kills any
 * pre-review command at a FIXED cap. Measured on card 40dc7674: the same suite
 * green in 7m59s at 4 shards ran past 20 minutes at 2 shards with the fleet
 * active, and a correct delivery was refused three times for a reason that had
 * nothing to do with its code.
 *
 * A cap that ignores a slowdown the runner ANNOUNCED is not measuring the
 * delivery, it is measuring the traffic. So the runner declares its factor and
 * the board grants it, once, bounded: past the bound the command is not slow,
 * it is hung, and killing it is the right answer.
 *
 * Lives in shared/ because both sides read it: the script that prints it and
 * the server that parses it.
 */

export const GATE_SLOWDOWN_PREFIX = "[slot] slower";

/**
 * The most a declared slowdown may buy, as a multiple of the base cap.
 *
 * Three, so the board's 20 minutes become at most 60 - which is exactly the
 * wall-clock at which `scripts/slot.ts` kills its own child (its
 * `TOPICS_GATE_MAX_RUN_MS`). Beyond that the two clocks would only race to say
 * the same thing, and the one with the process group is the one that can
 * actually stop it.
 */
export const MAX_SLOWDOWN_FACTOR = 3;

/** A declaration is only worth reading up to one decimal: `x2.5`, not `x2.4713`. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clamped to [1, MAX_SLOWDOWN_FACTOR]: a declaration cannot shorten a cap, nor lift it forever. */
export function clampSlowdown(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return round1(Math.min(MAX_SLOWDOWN_FACTOR, Math.max(1, factor)));
}

export function gateSlowdownLine(factor: number, reason: string): string {
  return `${GATE_SLOWDOWN_PREFIX} x${clampSlowdown(factor).toFixed(1)}: ${reason}`;
}

const SLOWDOWN_RE = /\[slot\] slower x(\d+(?:\.\d+)?)/;

/** The factor the line carries, clamped, or null when `text` has no such line. */
export function parseGateSlowdown(text: string): number | null {
  const m = SLOWDOWN_RE.exec(text);
  return m ? clampSlowdown(Number(m[1])) : null;
}

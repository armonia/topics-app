/**
 * THE MEMORY FLOOR IN FRONT OF A CHECK COMMAND, as a setting instead of a constant.
 *
 * WHY A MODULE OF ITS OWN, pure, in `shared/`. Three readers that do not talk to
 * each other otherwise: the brake that holds the command back
 * (`review-checks-brakes.ts`), the route that writes the setting, and the field
 * in the settings panel. Same reason `machine-budget.ts` has one - and the same
 * rule: the number on screen can never be one the brake does not use.
 *
 * IT LIVES ON THE MACHINE ROW (`board_settings['*']`), NOT PER BOARD, and that
 * is not laziness. The brake is mounted once for the whole server (`server.ts`):
 * a per-board floor would be a setting the brake has no way to honour, which is
 * worse than not offering it.
 *
 * WHY THE DEFAULT IS 3 AND NOT THE 6 IT REPLACES. The old number was
 * `DISPATCH_MEM_FLOOR_NATIVE_GB`, the floor for ADMITTING AN AGENT, borrowed by
 * this brake; it was never measured against a check command. Measured 17/09/2026
 * by sampling the process tree every 250 ms, one command at a time: `bun run
 * lint` cold 1.91 GB - the most expensive command on this machine - `typecheck`
 * cold 1.31, `static-rails` 0.31, `check:deadcode` 0.33. Cold is the number that
 * counts: `.cache/checks` is not tracked, so an agent's worktree always starts
 * without it. The server's own sampler, which reads every 3 s, has never seen
 * over 1.1 GB in 1828 beats. Three gigabytes cover the most expensive measured
 * command with a gigabyte to spare; six held the round back in 86.2% of those
 * 1828 readings, and the lowest reading in the whole log is 2.7 GB.
 */

/** The bounds of the field and the value a fresh install is born with.
 *
 *  Zero is a real setting and not a degenerate one: it turns the brake off, and
 *  somebody who wants their checks to start the instant they are asked should be
 *  able to say so without editing a constant. Sixteen is the top because this
 *  brake guards ONE command at a time, and a floor above half the RAM of the
 *  machines this runs on would hold every round for ever - a floor that always
 *  holds is a timer in disguise, which is exactly what the 6 GB had become. */
export const CHECKS_MEM_FLOOR_MIN_GB = 0;
export const CHECKS_MEM_FLOOR_MAX_GB = 16;
export const CHECKS_MEM_FLOOR_DEFAULT_GB = 3;

/**
 * The knob as written in the '*' settings row. Optional, and absent means the
 * default: every install that predates this field, and every test that builds
 * settings by hand, gets 3 GB.
 */
export interface ChecksMemoryFloorSetting {
  /** Gigabytes of free memory a NEW check command needs before it is spawned.
   *  `0` = no floor, the command never waits for room. */
  checksMemFloorGB?: number;
}

/** The floor as it will actually be applied: written value clamped and rounded
 *  to whole gigabytes, missing or unusable value defaulted. The rounding is here
 *  and not in the field so that a number arriving from anywhere else - an old
 *  row, a hand-written PATCH - lands on the same value the panel would show. */
export function checksMemFloorGB(s: ChecksMemoryFloorSetting): number {
  const n = s.checksMemFloorGB;
  if (typeof n !== "number" || !Number.isFinite(n)) return CHECKS_MEM_FLOOR_DEFAULT_GB;
  return Math.round(Math.max(CHECKS_MEM_FLOOR_MIN_GB, Math.min(CHECKS_MEM_FLOOR_MAX_GB, n)));
}

/** Off is a state the interface has to name, not a zero to print: a numeric
 *  field that changes meaning at one end has to say so, or the only way to know
 *  what `0` does is to open the code. */
export const checksMemFloorIsOff = (gb: number): boolean => gb <= 0;

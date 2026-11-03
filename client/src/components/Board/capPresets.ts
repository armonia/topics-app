/**
 * THE THREE CHOICES for "how many cards at once", and what each one writes.
 *
 * The values are not taste. They come from what the dispatcher already knows:
 *  - `cautious` = 2: the floor of the automatic recommendation (`clamp(.., 1, 8)`
 *    never advises fewer than the structural base of 2 on a 6+ core machine), so a
 *    laptop that is also used for work keeps its memory history flat.
 *  - `balanced` = automatic: the live recommendation, which follows the memory
 *    and CPU history the server keeps; it is the default of a fresh install.
 *  - `pushed` = 8: `MAX_AUTO_CAP` of the server, the most the automatic mode will
 *    ever recommend. Above it nothing in the measured history sustains the load.
 * The memory floors keep holding whatever the choice: a preset moves the ceiling,
 * never the floors.
 */
import type { GlobalDispatchCap } from '../../lib/board';
import { GLOBAL_CAP_OFF } from '../../lib/board';

export const CAP_PRESETS = ['cautious', 'balanced', 'pushed'] as const;
export type CapPreset = (typeof CAP_PRESETS)[number];

export const CAUTIOUS_CAP = 2;
export const PUSHED_CAP = 8;

/** The write that a choice means. `balanced` goes back to automatic. */
export function presetPatch(p: CapPreset): { auto: true } | { auto: false; max: number } {
  if (p === 'balanced') return { auto: true };
  return { auto: false, max: p === 'cautious' ? CAUTIOUS_CAP : PUSHED_CAP };
}

/** Which choice the stored cap is, or null when it was set by hand to another number. */
export function presetOf(cap: GlobalDispatchCap | null): CapPreset | null {
  if (!cap) return null;
  if (cap.auto) return 'balanced';
  if (cap.max === GLOBAL_CAP_OFF) return null;
  if (cap.max === CAUTIOUS_CAP) return 'cautious';
  if (cap.max === PUSHED_CAP) return 'pushed';
  return null;
}

/**
 * GB left to the person's own apps if the choice runs full: the machine minus
 * the cards at their measured peak (`agentCostMemGB`, from the last cards).
 */
export function gbLeftFor(totalMemGB: number, agentCostMemGB: number, limit: number): number {
  return Math.max(0, Math.round(totalMemGB - limit * agentCostMemGB));
}

/**
 * What the chosen limit would have done over the recorded memory history: at
 * each sample, how many cards fit once the GB left to the person's apps are
 * kept back (never above the limit), against the cards that really ran.
 * Null while the history has no sample that says how many ran.
 */
export function replayCap(
  history: ReadonlyArray<{ freeGB: number; running?: number }>,
  agentCostMemGB: number,
  floorGB: number,
  limit: number,
): { would: number; actual: number } | null {
  if (!(agentCostMemGB > 0) || !Number.isFinite(limit)) return null;
  const samples = history.filter((h) => typeof h.running === 'number');
  if (samples.length === 0) return null;
  let would = 0;
  let actual = 0;
  for (const h of samples) {
    const running = h.running ?? 0;
    const fit = Math.floor((h.freeGB + running * agentCostMemGB - floorGB) / agentCostMemGB);
    would += Math.max(0, Math.min(limit, fit));
    actual += running;
  }
  return { would: would / samples.length, actual: actual / samples.length };
}

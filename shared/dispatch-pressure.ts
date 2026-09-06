/**
 * THE CAP "BY RESOURCES" (KANBAN-75), the contract in one place.
 *
 * Its own module and not another two hundred lines of `board.ts`: this is a
 * closed question (a mode, two thresholds, three pure functions) with three
 * readers that do not talk to each other otherwise, the dispatcher gate, the
 * settings panel and the SQLite row. `board.ts` re-exports everything, so no
 * caller has to know where it lives.
 */
/**
 * THE OTHER WAY TO SAY "ENOUGH", and it answers a different question from the
 * count cap in `board.ts`.
 *
 * `count` asks HOW MANY agents may run together, and it is the default because
 * it is the only answer that is stable: a number does not move while you look
 * at it. `resources` asks something the number cannot express, which is HOW
 * MUCH OF THIS MACHINE they may take: below the threshold the queue moves, above
 * it the next agent waits, and no count is involved.
 *
 * WHY THIS IS NOT THE `auto` CAP UNDER ANOTHER NAME. `auto` deliberately looks
 * at OUR OWN load only (see the header of `server/services/dispatch-capacity.ts`:
 * a fleet that brakes on the whole machine's load average brakes on itself and
 * settles on one agent forever). This mode is the opposite policy ON PURPOSE:
 * it looks at the WHOLE machine, other people's browser and video call included,
 * because it exists for the person sitting at that machine and wanting it to
 * stay usable. That is also exactly why it is opt-in and not the default.
 */
export type DispatchCapMode = "count" | "resources";

/** What the cap carries BEYOND the number: the mode and the two thresholds.
 *  Split from `GlobalDispatchCap` because whoever draws a slider holds only
 *  these three fields, and should not have to invent a `max` to read them. */
export interface GlobalDispatchCapExtras {
  /**
   * Which question the brake asks. Optional, and absent means `count`: every
   * install that predates this field, and every test that builds a cap by hand,
   * keeps the behaviour it had.
   */
  mode?: DispatchCapMode;
  /** Ceiling on CPU pressure, `load1 / cores`. 1 means "a fully busy machine". */
  maxLoadRatio?: number;
  /** Ceiling on memory pressure, `used / total`. */
  maxMemRatio?: number;
}

/**
 * The bounds, and the defaults inside them.
 *
 * The load default is 0.9 and not 1: at a load equal to the core count the
 * machine is already queueing work, and the point of this mode is to stop
 * BEFORE the person at the keyboard feels it. The memory default is 0.85 for
 * the same reason on the other axis, one step before the swap.
 */
export const LOAD_RATIO_MIN = 0.2;
export const LOAD_RATIO_MAX = 3;
export const LOAD_RATIO_DEFAULT = 0.9;
export const MEM_RATIO_MIN = 0.5;
export const MEM_RATIO_MAX = 0.98;
export const MEM_RATIO_DEFAULT = 0.85;

const clampRatio = (n: number | undefined, lo: number, hi: number, fallback: number): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

/** The two thresholds as they will actually be applied: written value clamped,
 *  missing value defaulted. One reader for the dispatcher and one for the UI,
 *  so the slider can never show a number the gate does not use. */
export function capThresholds(cap: GlobalDispatchCapExtras): { maxLoadRatio: number; maxMemRatio: number } {
  return {
    maxLoadRatio: clampRatio(cap.maxLoadRatio, LOAD_RATIO_MIN, LOAD_RATIO_MAX, LOAD_RATIO_DEFAULT),
    maxMemRatio: clampRatio(cap.maxMemRatio, MEM_RATIO_MIN, MEM_RATIO_MAX, MEM_RATIO_DEFAULT),
  };
}

/** Which mode is in force. `count` unless the machine explicitly asked for the
 *  other one: an unreadable value is the default, never the stricter brake. */
export function capMode(cap: GlobalDispatchCapExtras): DispatchCapMode {
  return cap.mode === "resources" ? "resources" : "count";
}

/** What the machine measures, at the moment of the decision. `availableMemGB`
 *  at `null` means NOT MEASURED (Windows, Linux with no probe): it is not zero,
 *  and it must never be able to block anything. */
export interface MachinePressure {
  load1: number;
  cores: number;
  availableMemGB: number | null;
  totalMemGB: number;
  /** Agents already in flight. Zero is the case that keeps the door open (below). */
  running: number;
}

export interface PressureVerdict {
  /** May one more agent start right now. */
  admit: boolean;
  /** Which of the two axes said no, `null` when nobody did. */
  blockedBy: "load" | "memory" | null;
  /** `load1 / cores`, so it is readable against the threshold on the same scale. */
  loadRatio: number;
  /** `used / total`. `null` when the memory probe had nothing to say. */
  memRatio: number | null;
  /**
   * True when the verdict is a pass ONLY because nothing is running yet. The UI
   * and the log say so instead of claiming the machine is free: it is not.
   */
  firstAgentExempt: boolean;
}

/**
 * LOAD -> START/WAIT, pure, with exactly one declared exception.
 *
 * THE EXCEPTION IS THE POINT. With zero agents alive it ALWAYS admits, however
 * loaded the machine is. Without that line the brake would be a board that
 * never starts: whoever works on their own machine keeps it over the threshold
 * by themselves (browser, a build, a video call), the queue would sit for
 * hours, and the way that gets discovered is somebody looking at the cards and
 * concluding the dispatcher is broken. The first agent starts, the second
 * waits: that is how a threshold brakes without closing.
 */
export function machinePressureVerdict(
  p: MachinePressure,
  thresholds: { maxLoadRatio: number; maxMemRatio: number },
): PressureVerdict {
  const cores = p.cores > 0 ? p.cores : 1;
  const loadRatio = Math.max(0, p.load1) / cores;
  const memRatio =
    p.availableMemGB == null || !Number.isFinite(p.availableMemGB) || !(p.totalMemGB > 0)
      ? null
      : Math.max(0, Math.min(1, 1 - p.availableMemGB / p.totalMemGB));
  const overLoad = loadRatio >= thresholds.maxLoadRatio;
  const overMem = memRatio != null && memRatio >= thresholds.maxMemRatio;
  const blockedBy: "load" | "memory" | null = overLoad ? "load" : overMem ? "memory" : null;
  const firstAgentExempt = blockedBy != null && p.running <= 0;
  return { admit: blockedBy == null || firstAgentExempt, blockedBy, loadRatio, memRatio, firstAgentExempt };
}

/**
 * THE THREE COLOURS, and what they actually judge.
 *
 * Not the temperature of the machine: a judgement on the THRESHOLD being
 * chosen, and there are two ways to get it wrong, not one. Too low and the
 * queue never moves (red on the left); too high and the machine is unusable
 * before the brake bites (red on the right). Green is the band in between, the
 * recommended one, and saying that at a glance is this function's whole job.
 */
export type ThresholdBand = "green" | "amber" | "red";

export function loadThresholdBand(ratio: number): ThresholdBand {
  if (!Number.isFinite(ratio) || ratio < 0.35 || ratio > 1.6) return "red";
  if (ratio < 0.6 || ratio > 1.2) return "amber";
  return "green";
}

export function memThresholdBand(ratio: number): ThresholdBand {
  if (!Number.isFinite(ratio) || ratio < 0.6 || ratio > 0.95) return "red";
  if (ratio < 0.7 || ratio > 0.92) return "amber";
  return "green";
}

/**
 * THE OTHER question, the one about the LIVE machine: how close we are to the
 * chosen threshold right now. Green while there is room, amber on approach,
 * red once the threshold is reached, which is when the next agent waits. One
 * function for both axes: the threshold is already in the unit of its measure.
 */
export function livePressureBand(value: number, threshold: number): ThresholdBand {
  if (!Number.isFinite(value) || threshold <= 0) return "green";
  if (value >= threshold) return "red";
  return value >= threshold * 0.75 ? "amber" : "green";
}

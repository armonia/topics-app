/**
 * ONE KNOB: "Topics may use up to N% of this computer".
 *
 * WHAT IT REPLACES, and why the old shape had to go. The cap "by resources"
 * asked two questions with two sliders, `load1 / cores` and `used mem / total`,
 * and both of them read the WHOLE machine. Two defects came out of that on
 * 2026-09-07, measured on a 12-core box:
 *
 *  1. `load1` is a queue length averaged over a minute, not a budget. It admits
 *     EVERYTHING that is queued the instant the ratio dips under the threshold:
 *     at 19:27, with load 12.0 on 12 cores and the threshold at 100%, eight
 *     cards started inside one tick. Ten minutes later that machine was at load
 *     155 with 13.4 GB of swap.
 *  2. It is a brake that measures somebody else. The load average of a machine
 *     a person is using is mostly their browser and their video call, so the
 *     same threshold means "wide open" on one machine and "never start" on
 *     another.
 *
 * The question a person actually asks is neither of those. It is "how much of
 * MY computer may this thing take", and the answer is a percentage: the budget
 * is `share x cores` in core-units and `share x total` in gigabytes, and what
 * is measured against it is OUR OWN tree (server, sidecars, the pty bridge,
 * every agent and every child of theirs: tsc, eslint, bun test, vite, the
 * Chromium of an e2e run).
 *
 * THE BUDGET IS A CEILING, NOT A RIGHT. What is usable right now is
 * `min(budget, what the others leave free)`. On an idle machine the two are the
 * same number; on a machine whose owner is compiling something else, ours
 * shrinks. The opposite policy (take the budget whatever else is running) is
 * how a background fleet makes a laptop unusable while staying inside its
 * declared share.
 *
 * WHY A MODULE OF ITS OWN, pure, in `shared/`. Three readers that do not talk
 * to each other otherwise: the dispatcher gate, the settings slider, and the
 * governor that freezes what is already running. Same reason
 * `dispatch-pressure.ts` (which this supersedes) had one.
 */

/** The bounds of the knob and the value a fresh install is born with.
 *
 *  60% by default, not 80: the default protects the person who never opens the
 *  setting, and the machine has to stay usable for them. Whoever knows what
 *  they are doing moves it up. Not lower than 10% because a budget under one
 *  core on a small machine is a queue that never moves, and not higher than
 *  95% because the last slice belongs to the operating system whatever the
 *  slider says. */
export const BUDGET_SHARE_MIN = 0.1;
export const BUDGET_SHARE_MAX = 0.95;
export const BUDGET_SHARE_DEFAULT = 0.6;

/**
 * The knob as written in the '*' settings row. Optional, and absent means the
 * default: every install that predates this field, and every test that builds
 * a cap by hand, gets 60%.
 */
export interface MachineBudgetSetting {
  /** 0..1. `0.8` = "Topics may use up to 80% of this computer". */
  budgetShare?: number;
}

/** The share as it will actually be applied: written value clamped, missing
 *  value defaulted. One reader for the gate and one for the slider, so the
 *  percentage on screen can never be one the dispatcher does not use. */
export function budgetShare(s: MachineBudgetSetting): number {
  const n = s.budgetShare;
  if (typeof n !== "number" || !Number.isFinite(n)) return BUDGET_SHARE_DEFAULT;
  return Math.max(BUDGET_SHARE_MIN, Math.min(BUDGET_SHARE_MAX, n));
}

/**
 * WHAT IS MEASURED, at the moment of the decision. Core-units everywhere
 * (1 = one saturated core), never a load average: a load average says how long
 * the queue was over the last minute, and this has to answer "how much is being
 * eaten right now".
 *
 * `otherCoreUnits` is what does NOT belong to us. It is the term that turns the
 * budget into `min(budget, free)`. `null` means NOT MEASURED, which is not
 * zero: unmeasured must never be able to shrink the budget, or a platform
 * without the probe would silently own the strictest brake of all.
 */
export interface MachineBudgetSample {
  cores: number;
  totalMemGB: number;
  /** Core-units our own tree is burning now. */
  ourCoreUnits: number;
  /** Core-units everything else is burning now, or `null` when not measured. */
  otherCoreUnits: number | null;
  /** Gigabytes our own tree is holding now (footprint where the kernel says it). */
  ourMemGB: number;
  /** Gigabytes really available to the machine, or `null` when not measured. */
  availableMemGB: number | null;
  /** Agents already in flight. Zero is the case that keeps the door open. */
  running: number;
}

/** The budget in the units of the two axes, plus what is usable of it now. */
export interface MachineBudget {
  /** `share x cores`, the ceiling we set ourselves. */
  cpuCoreUnits: number;
  /** `min(cpuCoreUnits, cores - other)`, the ceiling reality allows right now. */
  usableCoreUnits: number;
  /** `share x totalMemGB`. */
  memGB: number;
  /** `min(memGB, ourMemGB + availableMemGB)`: what the machine can still give. */
  usableMemGB: number;
}

export function machineBudget(sample: MachineBudgetSample, share: number): MachineBudget {
  const cores = sample.cores > 0 ? sample.cores : 1;
  const cpuCoreUnits = Math.max(0.5, cores * share);
  // What the others leave free. A machine can be measured over its own core
  // count (the sum of instantaneous percentages of a scheduler under pressure
  // does exceed it), so this floors at zero instead of going negative.
  const freeOfOthers = sample.otherCoreUnits == null
    ? cpuCoreUnits
    : Math.max(0, cores - Math.max(0, sample.otherCoreUnits));
  const memGB = Math.max(0.25, sample.totalMemGB * share);
  // Ours + free is what memory we could reach: the pages we already hold do not
  // have to be found again. Not measured (`null`) means the budget stands alone.
  const reachableMemGB = sample.availableMemGB == null
    ? memGB
    : Math.max(0, sample.ourMemGB) + Math.max(0, sample.availableMemGB);
  return {
    cpuCoreUnits,
    usableCoreUnits: Math.min(cpuCoreUnits, freeOfOthers),
    memGB,
    usableMemGB: Math.min(memGB, reachableMemGB),
  };
}

/**
 * THE COST OF ONE MORE AGENT, in core-units, and why it is not the mean.
 *
 * A dispatched agent is mostly waiting on the API; what costs is the GATES it
 * launches (a tsc, an eslint, a unit shard). The estimate is the MEDIAN of the
 * recent ones and not the mean, because one delivery running four shards at
 * once would otherwise price every future agent as if it were that one.
 *
 * The floor exists so an empty history cannot price admission at zero, which
 * would admit the whole queue on the first tick: that is exactly the failure
 * this module was written for. The ceiling exists so one pathological sample
 * cannot close the door for good.
 */
export const AGENT_COST_FLOOR_CORE_UNITS = 0.5;
export const AGENT_COST_CEILING_CORE_UNITS = 4;

export function estimatedAgentCost(recentCoreUnits: readonly number[]): number {
  const clean = recentCoreUnits.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!clean.length) return AGENT_COST_FLOOR_CORE_UNITS;
  const mid = Math.floor(clean.length / 2);
  const median = clean.length % 2 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
  return Math.max(AGENT_COST_FLOOR_CORE_UNITS, Math.min(AGENT_COST_CEILING_CORE_UNITS, median));
}

/**
 * THE HYSTERESIS, and it is the whole reason this is a state machine and not a
 * comparison.
 *
 * A bare threshold oscillates around itself: at the moment the queue is
 * admitted the measure has not moved yet (a `ps` sample lags a spawn by
 * seconds), so the next tick admits again, and again, and the eight cards of
 * 19:27 are that loop. Once we are holding, we do not resume at the threshold:
 * we resume at 80% of it. The gap is what a measurement needs to catch up with
 * what has already been started.
 */
export const ADMIT_RESUME_FRACTION = 0.8;

export type BudgetGateState = "admitting" | "holding";

export interface AdmissionVerdict {
  /** May ONE more agent start right now. Never more than one: see below. */
  admit: boolean;
  /** The state to carry into the next tick. */
  state: BudgetGateState;
  /** Which axis said no, `null` when nobody did. */
  blockedBy: "cpu" | "memory" | null;
  /** True when the pass is owed ONLY to nothing running yet. */
  firstAgentExempt: boolean;
  /** The numbers the sentence on the card is written from. */
  usedCoreUnits: number;
  usableCoreUnits: number;
  budgetCoreUnits: number;
  costCoreUnits: number;
}

/**
 * ONE AGENT PER TICK, and the door closes on the estimate.
 *
 * `admit` answers for exactly one card. The caller that has eight in Todo gets
 * one `true`, dispatches it, and asks again on the next tick with a measure
 * that includes it. The old gate answered "yes" once and the caller drained the
 * whole queue against a single reading, which is how a threshold that looked
 * conservative admitted eight agents at load 12.
 *
 * THE EXCEPTION, inherited from the previous contract and still the point: with
 * zero agents alive it admits however loaded the machine is. Without that line
 * whoever keeps their own Mac busy owns a board that never starts, and the way
 * that gets discovered is somebody deciding the dispatcher is broken.
 */
export function admissionVerdict(
  sample: MachineBudgetSample,
  share: number,
  costCoreUnits: number,
  previous: BudgetGateState = "admitting",
): AdmissionVerdict {
  const budget = machineBudget(sample, share);
  const used = Math.max(0, sample.ourCoreUnits);
  const cost = Math.max(0, costCoreUnits);
  // Holding does not end where it began: it ends lower (see ADMIT_RESUME_FRACTION).
  const ceiling = previous === "holding"
    ? budget.usableCoreUnits * ADMIT_RESUME_FRACTION
    : budget.usableCoreUnits;
  const overCpu = used + cost > ceiling;
  const overMem = sample.availableMemGB != null && sample.ourMemGB > budget.usableMemGB;
  const blockedBy: "cpu" | "memory" | null = overCpu ? "cpu" : overMem ? "memory" : null;
  const firstAgentExempt = blockedBy != null && sample.running <= 0;
  return {
    admit: blockedBy == null || firstAgentExempt,
    // The exemption does not clear the state: the machine is still over, and
    // the agent that just went through is about to make it more so.
    state: blockedBy == null ? "admitting" : "holding",
    blockedBy,
    firstAgentExempt,
    usedCoreUnits: used,
    usableCoreUnits: budget.usableCoreUnits,
    budgetCoreUnits: budget.cpuCoreUnits,
    costCoreUnits: cost,
  };
}

/**
 * THE OTHER HALF: what to do about work ALREADY RUNNING when the budget is
 * blown. Refusing the next agent does nothing for a machine that is at load 155
 * with what it started an hour ago.
 *
 * TWO CONSECUTIVE SAMPLES, not one. A single reading over the line is a tsc
 * that has just started and will be done in twenty seconds; freezing on it
 * would make the board stutter around every normal gate. Two readings in a row
 * is a state, not a spike.
 */
export const FREEZE_SAMPLES = 2;
/** Thawing comes back lower than freezing, same reason the admission does. */
export const THAW_FRACTION = 0.7;

/**
 * WHO GETS FROZEN, in order, and the order IS the policy.
 *
 * Cheapest to lose first. A check runner (tsc, eslint, bun test, vite) holds no
 * network connection, answers to nobody while it runs and cares only about its
 * own wall clock, which the board's watchdog already knows how to stretch: it
 * survives a pause with nothing lost. So checks go first, newest first, because
 * the newest is the one closest to having started for nothing.
 *
 * AGENTS ARE NOT FROZEN BY SIGNAL, and that is a decision, not an omission
 * (card 363bbbc8). Two reasons. A `claude` CLI paused mid-stream may lose the
 * API connection, and nobody has measured how long it survives; and the CPU is
 * not there anyway: with eight agents in flight the agents themselves summed to
 * 5.7% of this machine while their gates ran seven full suites, three tsc and
 * an eslint. Freezing the expensive thing and holding the queue is the whole
 * win; SIGSTOP on the cheap thing would only buy a broken stream.
 */
export type FreezeKind = "check" | "agent";

export interface FreezeTarget {
  /** Stable id (the check run's id, the task id): the plan speaks in these. */
  id: string;
  kind: FreezeKind;
  /** Epoch ms. Newest goes first, within a kind. */
  startedAt: number;
  /** What it is costing now, in core-units. Only used to say so in the log. */
  coreUnits?: number;
}

export interface FreezeState {
  /** Consecutive samples over the budget. */
  overSamples: number;
  /** Consecutive samples under the thaw line. */
  underSamples: number;
  /** Ids frozen so far, in the order they were frozen. */
  frozen: readonly string[];
}

export const EMPTY_FREEZE_STATE: FreezeState = { overSamples: 0, underSamples: 0, frozen: [] };

export interface FreezePlan {
  state: FreezeState;
  /** At most one id to freeze this sample. */
  freeze: string | null;
  /** At most one id to thaw this sample (the last one frozen). */
  thaw: string | null;
}

/**
 * ONE VICTIM PER SAMPLE, in both directions.
 *
 * Freezing everything that is over the line at once is the same stampede as
 * admitting everything under it: the measure has not caught up, and a machine
 * that freezes four gates in one tick then thaws four in the next has replaced
 * a load problem with an oscillation. One at a time, re-measure, decide again.
 *
 * A target that has disappeared between two samples (the check finished on its
 * own) is dropped from `frozen` without a thaw: there is nothing left to
 * continue, and keeping the id would block the thaw of everything under it.
 */
export function freezePlan(
  input: { used: number; budget: number; targets: readonly FreezeTarget[] },
  state: FreezeState = EMPTY_FREEZE_STATE,
): FreezePlan {
  const budget = Math.max(0.0001, input.budget);
  const alive = new Set(input.targets.map((t) => t.id));
  const frozen = state.frozen.filter((id) => alive.has(id));
  const over = input.used > budget;
  const under = input.used < budget * THAW_FRACTION;
  const overSamples = over ? state.overSamples + 1 : 0;
  const underSamples = under ? state.underSamples + 1 : 0;

  if (overSamples >= FREEZE_SAMPLES) {
    const victim = nextVictim(input.targets, frozen);
    if (victim) {
      return {
        // The counter resets after acting: the next freeze needs its own two
        // samples, so a single episode cannot walk down the whole list in two
        // ticks while the effect of the first pause is still on its way.
        state: { overSamples: 0, underSamples: 0, frozen: [...frozen, victim.id] },
        freeze: victim.id,
        thaw: null,
      };
    }
  }
  if (underSamples >= FREEZE_SAMPLES && frozen.length) {
    const id = frozen[frozen.length - 1]!;
    return { state: { overSamples: 0, underSamples: 0, frozen: frozen.slice(0, -1) }, freeze: null, thaw: id };
  }
  return { state: { overSamples, underSamples, frozen }, freeze: null, thaw: null };
}

/** Checks before agents; inside a kind, the one that started last. */
function nextVictim(targets: readonly FreezeTarget[], frozen: readonly string[]): FreezeTarget | null {
  const taken = new Set(frozen);
  const free = targets.filter((t) => !taken.has(t.id));
  const rank = (t: FreezeTarget) => (t.kind === "check" ? 0 : 1);
  free.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
  return free[0] ?? null;
}

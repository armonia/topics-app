/**
 * HOW MUCH WIDER A TEST'S TIME WINDOW HAS TO BE ON THIS MACHINE, RIGHT NOW.
 *
 * WHY IT EXISTS. A handful of tests wait for an event inside a window written
 * as a constant: the pty bridge must accept a connection within its 2 s idle
 * backstop, the chat watchdog must finalize within a few hundred milliseconds,
 * a recursive watcher must hand over one event. Those constants were sized on a
 * quiet box. Under the fleet they stop describing the code: measured on card
 * 0f4cbccb (2026-09-07, load ~11 on 12 cores), two consecutive runs of the
 * sharded suite on the SAME tree went red on DIFFERENT tests, none of them
 * touched by the change, and all of them green when run alone straight after.
 * That red costs an agent a ~4 minute round trip, whose rerun raises the load,
 * which fails the next test: under a fleet it feeds itself.
 *
 * Raising the constants one by one is the fix that already failed (file-watcher
 * went to 30 s on 06/09 and fell over anyway) and it has a real cost: a window
 * wide enough for a loaded machine no longer catches a hang on a quiet one. So
 * the window is written ONCE, for a quiet machine, and multiplied by this
 * factor - 1 when the box is idle, up to 4 when it is buried.
 *
 * This file is the arithmetic and nothing else: no clock, no `os`, no process.
 * Who measures the load is `tests/helpers/time-slack.ts` (the tests) and the
 * two runners that hand the number down, so every shard of one round shares it.
 *
 * NOT for production timers. A product that needs a longer timeout under load
 * has a different problem, and this is not its answer.
 */

/** The env every runner sets, and a person can force by hand. */
export const TIME_SLACK_ENV = "TOPICS_TEST_TIME_SLACK";

/**
 * The ceiling for these explicit wait helpers, in both serial and sharded
 * runs. The runner's per-test timeout is independent and stays unchanged:
 * this factor must not silently widen the limit of the whole test.
 */
export const MAX_TIME_SLACK = 4;

/**
 * Load per core, doubled. One core fully busy per core (pressure 1) is the
 * point at which the suite measured ~2x on wall clock, so that is 2; half a
 * core each is 1, i.e. no change at all on a quiet machine.
 */
const SLACK_PER_PRESSURE = 2;

/** A factor is only worth one decimal: `x2.3`, not `x2.2857`. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clamped to [1, MAX_TIME_SLACK]: a factor can only ever widen, and only so far. */
function clamp(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return round1(Math.min(MAX_TIME_SLACK, Math.max(1, n)));
}

/**
 * The forced value carried by the env, or null when there is none to honour.
 *
 * Anything unreadable (empty, a word, zero, a negative) is NOT an instruction:
 * it falls through to the measurement rather than pinning the factor at 1,
 * because a typo in an env should not silently switch the whole thing off.
 */
export function parseForcedSlack(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return clamp(n);
}

/**
 * The factor for a machine at `load` with `cores` cores.
 *
 * `forced` wins outright: whoever set the env made a choice, and this does not
 * overrule a person (the same rule `planUnderLoad` follows for its own envs).
 */
export function timeSlack(input: { load: number; cores: number; forced?: string | number | null }): number {
  const forced = typeof input.forced === "number"
    ? parseForcedSlack(String(input.forced))
    : parseForcedSlack(input.forced);
  if (forced !== null) return forced;
  const cores = Math.max(1, input.cores);
  const load = Math.max(0, input.load);
  if (!Number.isFinite(load)) return 1;
  return clamp((load / cores) * SLACK_PER_PRESSURE);
}

/** The one line a runner prints when it has decided the factor for a whole run. */
export function timeSlackNote(slack: number, load: number, cores: number): string {
  return `time slack x${slack.toFixed(1)}, load ${load.toFixed(1)}/${Math.max(1, cores)}`;
}

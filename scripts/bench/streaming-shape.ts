/**
 * THE STREAMING BENCH — the shape of the record.
 *
 * The writer's half of the file `scripts/bench/streaming.ts` reads. Everything
 * here is pure: raw samples in, medians and the published JSON out, no browser
 * and no filesystem. That is why it sits next to the judge and not next to the
 * spec — the two halves of `test-results/bench-streaming.json` are written and
 * read three metres apart, and both can be exercised by
 * `scripts/bench/streaming-shape.test.ts` in milliseconds instead of by a run
 * that needs a server, a built bundle and a browser.
 *
 *   the probe          tests/e2e/helpers/bench-streaming-probe.ts (in-page)
 *   the drive          tests/e2e/bench-streaming.spec.ts          (Playwright)
 *   the shape          here                                       (pure)
 *   the verdict        scripts/bench/streaming.ts                 (pure)
 *
 * The types the record is made of are TAKEN FROM THE JUDGE, not re-declared
 * here. `Scenario`, `ScenarioMedian` and `QuietBaseline` in `streaming.ts` are
 * what a reader of the JSON is entitled to; writing a second copy of those
 * twenty-two field names is how the two ends of one file drift apart, one field
 * at a time, in green. The import is type-only, so nothing of the CLI in
 * `streaming.ts` reaches the browser process that imports this.
 */
import type { QuietBaseline, Scenario, ScenarioMedian } from "./streaming";

export type { QuietBaseline };

/** Text deltas or tool output: the two paths a chunk can arrive on. */
export type BenchMode = Scenario["mode"];

/** The two sides of the comparison this bench exists to make. */
export type Transcript = Scenario["transcript"];

/** What an idle page costs the occupancy probe, measured before the bench runs. */
export interface Calibration {
  pings: number;
  /** Pings a millisecond on an idle page. The denominator of the busy-time reading. */
  idleRatePerMs: number;
  medianDelayMs: number;
  p95DelayMs: number;
}

/** What the in-page probe hands back. Everything already reduced: no arrays of frames. */
export interface BurstRaw {
  /** False when the probe could not find the virtualized list to scope "outside" against. */
  listResolved: boolean;
  /** False when the probe could not read progress at all (selector drift, collapsed row). */
  progressReadable: boolean;
  /**
   * The chat pane hit its React error boundary. Worth naming: pushed hard
   * enough (the falsification knob at 2 µs a message, i.e. ~4 ms of work per
   * chunk on a 2000-message thread), the pane crashes with React #185 rather
   * than degrading, and without this flag the bench reported only that it could
   * not find a list.
   */
  paneCrashed: boolean;
  frames: number;
  worstGapMs: number;
  medianGapMs: number;
  tStart: number;
  /** Page-clock instant at which the driver had handed off the last frame. */
  tMark: number | null;
  /** Page-clock instant of the first frame at which `applied >= target`. */
  tComplete: number | null;
  appliedAtStart: number;
  appliedAtEnd: number;
  /** True when the burst closed on the clock instead of on the target. */
  hitDeadline: boolean;
  longtaskCount: number;
  longtaskMs: number;
  loafSupported: boolean;
  loafCount: number;
  loafScriptMs: number;
  loafBlockingMs: number;
  /** Sum of the delays that overshot the calibrated floor: the visible stalls. */
  blockedMs: number;
  /** Probe round-trips completed during the burst. Divided by the idle rate, this is busy time. */
  pings: number;
  shiftInside: number;
  shiftOutside: number;
  shiftUnattributed: number;
  mutationsInside: number;
  mutationsOutside: number;
  outsideMovers: string[];
}

/**
 * One burst, as the report speaks about it.
 *
 * Every number in it is a field of `ScenarioMedian` (scripts/bench/streaming.ts),
 * where each one is named and explained once for the reader who will be looking
 * at the published table — page-clock against main-thread, absorbed against
 * handed off. What the median cannot carry is here: a set of names is not a
 * number, and "was long-animation-frame timing even available" is a fact about
 * the run rather than a measurement of it.
 */
export interface BurstResult extends ScenarioMedian {
  /** Everything outside the message list that moved during this burst. */
  outside_movers: string[];
  /** False when this browser has no long-animation-frame timing to give. */
  loaf_supported: boolean;
}

/** One scenario as published, plus the individual bursts the median came from. */
export interface ScenarioResult extends Scenario {
  runs: BurstResult[];
}

/* ─────────────────────────────────────────────────── one sample at a time ── */

export interface BurstContext {
  mode: BenchMode;
  /** Chunks the driver handed off in this burst. The numerator of `handoff_per_s`. */
  chunks: number;
  /** Wall time the DRIVER spent handing them off, on the driver's clock. */
  handoffMs: number;
  calibration: Calibration;
}

/**
 * One raw reading into one published burst, or an exception.
 *
 * The refusals are half the value and they are here, not at the call site, on
 * purpose: every one of them is a way for a probe to report success without
 * having measured anything, which is the one result a bench must never publish.
 * Pure, so `streaming-shape.test.ts` can hand each of them a raw reading and
 * see the refusal instead of trusting that it is still wired up.
 */
export function shapeBurst(raw: BurstRaw | undefined, ctx: BurstContext): BurstResult {
  if (!raw) throw new Error("bench probe: read() returned nothing");
  if (raw.paneCrashed) {
    throw new Error(
      "bench probe: the chat pane hit its React error boundary during the burst. " +
        "Nothing measured here describes the product; the page stopped being the product.",
    );
  }
  if (!raw.listResolved) throw new Error("bench probe: no virtualized list to scope 'outside' against");
  if (!raw.progressReadable) throw new Error("bench probe: could not read progress from the page");
  if (raw.tComplete === null || raw.tMark === null) {
    throw new Error("bench probe: the burst never completed on the page clock");
  }

  const absorbed = Math.max(0, raw.appliedAtEnd - raw.appliedAtStart);
  if (absorbed === 0) {
    throw new Error(`bench probe: the ${ctx.mode} burst painted nothing at all`);
  }
  const absorbMs = raw.tComplete - raw.tStart;
  // BUSY TIME AS A RATE DEFICIT. On an idle page the probe completes
  // `idleRatePerMs` round-trips a millisecond; during the burst it completed
  // `pings`. The milliseconds it never got are the milliseconds somebody else
  // was holding the thread. Clamped at zero: a probe that ran FASTER than its
  // calibration measured the calibration, not a negative amount of work.
  const idleEquivalentMs = idleEquivalent(raw.pings, ctx.calibration);
  const busyMs = Math.max(0, absorbMs - idleEquivalentMs);
  return {
    applied_at_end: raw.appliedAtEnd,
    chunks_absorbed: absorbed,
    fell_behind: raw.hitDeadline ? 1 : 0,
    absorbed_per_s: round2((absorbed / absorbMs) * 1000),
    handoff_per_s: round2((ctx.chunks / ctx.handoffMs) * 1000),
    drain_ms: round2(raw.tComplete - raw.tMark),
    absorb_ms: round2(absorbMs),
    cost_us_per_chunk: round2((absorbMs * 1000) / absorbed),
    busy_ms: round2(busyMs),
    busy_us_per_chunk: round2((busyMs * 1000) / absorbed),
    blocked_ms: round2(raw.blockedMs),
    longtask_count: raw.longtaskCount,
    longtask_ms: round2(raw.longtaskMs),
    loaf_count: raw.loafCount,
    loaf_script_ms: round2(raw.loafScriptMs),
    loaf_blocking_ms: round2(raw.loafBlockingMs),
    frames: raw.frames,
    worst_gap_ms: round2(raw.worstGapMs),
    median_gap_ms: round2(raw.medianGapMs),
    layout_shift_outside_list: round4(raw.shiftOutside + raw.shiftUnattributed),
    layout_shift_inside_list: round4(raw.shiftInside),
    mutations_outside_list: raw.mutationsOutside,
    outside_movers: raw.outsideMovers,
    loaf_supported: raw.loafSupported,
  };
}

/** The same reading, taken with no chunks in it: the subtrahend. */
export function shapeQuiet(raw: BurstRaw | undefined, calibration: Calibration): QuietBaseline {
  if (!raw || raw.tComplete === null) throw new Error("bench probe: the quiet window produced nothing");
  if (raw.paneCrashed) throw new Error("bench probe: the chat pane was already broken before the bench started");
  const elapsed = raw.tComplete - raw.tStart;
  return {
    window_ms: round2(elapsed),
    frames: raw.frames,
    mutations_outside_list: raw.mutationsOutside,
    layout_shift_outside_list: round4(raw.shiftOutside + raw.shiftUnattributed),
    busy_ms: round2(Math.max(0, elapsed - idleEquivalent(raw.pings, calibration))),
    outside_movers: raw.outsideMovers,
  };
}

/** Milliseconds an idle page would have needed for that many probe round-trips. */
function idleEquivalent(pings: number, calibration: Calibration): number {
  return calibration.idleRatePerMs > 0 ? pings / calibration.idleRatePerMs : 0;
}

export function summarise(
  mode: BenchMode,
  transcript: Transcript,
  messages: number,
  chunksPerBurst: number,
  runs: BurstResult[],
): ScenarioResult {
  const pick = (f: (r: BurstResult) => number): number => round2(median(runs.map(f)));
  const movers = new Set<string>();
  for (const r of runs) for (const m of r.outside_movers) movers.add(m);
  return {
    mode,
    transcript,
    transcript_messages: messages,
    chunks_per_burst: chunksPerBurst,
    reps: runs.length,
    median: {
      applied_at_end: pick((r) => r.applied_at_end),
      chunks_absorbed: pick((r) => r.chunks_absorbed),
      fell_behind: pick((r) => r.fell_behind),
      absorbed_per_s: pick((r) => r.absorbed_per_s),
      handoff_per_s: pick((r) => r.handoff_per_s),
      drain_ms: pick((r) => r.drain_ms),
      absorb_ms: pick((r) => r.absorb_ms),
      cost_us_per_chunk: pick((r) => r.cost_us_per_chunk),
      busy_ms: pick((r) => r.busy_ms),
      busy_us_per_chunk: pick((r) => r.busy_us_per_chunk),
      blocked_ms: pick((r) => r.blocked_ms),
      longtask_count: pick((r) => r.longtask_count),
      longtask_ms: pick((r) => r.longtask_ms),
      loaf_count: pick((r) => r.loaf_count),
      loaf_script_ms: pick((r) => r.loaf_script_ms),
      loaf_blocking_ms: pick((r) => r.loaf_blocking_ms),
      frames: pick((r) => r.frames),
      worst_gap_ms: pick((r) => r.worst_gap_ms),
      median_gap_ms: pick((r) => r.median_gap_ms),
      layout_shift_outside_list: round4(median(runs.map((r) => r.layout_shift_outside_list))),
      layout_shift_inside_list: round4(median(runs.map((r) => r.layout_shift_inside_list))),
      mutations_outside_list: pick((r) => r.mutations_outside_list),
    },
    loaf_supported: runs.every((r) => r.loaf_supported),
    outside_movers: [...movers],
    runs,
  };
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/* ────────────────────────────────────────────────── the published record ── */

export interface StreamingProtocol {
  chunks_per_burst: number;
  reps: number;
  token_chars: number;
  calibration_ms: number;
  burst_deadline_ms: number;
  long_transcript_messages: number;
  short_transcript_messages: number;
}

export interface StreamingReportInput {
  /** Microseconds of per-chunk work per transcript message. 0 = the knob is off. */
  on2UsPerMessage: number;
  protocol: StreamingProtocol;
  witness: Record<string, number>;
  quiet: Record<string, QuietBaseline>;
  scenarios: Record<string, ScenarioResult>;
  machine: { platform: string; arch: string; cpu: string; cores: number };
  measuredAt?: Date;
}

/**
 * `null`, never 0, when the denominator is 0.
 *
 * A RATIO WITH A ZERO UNDER IT IS NOT A ZERO RATIO. The first draft returned 0
 * when the denominator was 0, and 0 reads as "the cost did not grow" — the exact
 * opposite of "there is no number here". `null` makes the reader
 * (scripts/bench/streaming.ts) say "not measurable" instead of publishing the
 * best possible news.
 */
export function costRatio(a: number, b: number): number | null {
  return b > 0 ? round2(a / b) : null;
}

/**
 * The whole measurement as it goes to disk.
 *
 * Missing scenarios throw rather than serialise a hole: a report is judged by
 * `scripts/bench/streaming.ts`, and a hole there reads as one more thing that
 * happened to be within budget.
 */
export function buildStreamingReport(input: StreamingReportInput): Record<string, unknown> {
  const s = (key: string): ScenarioResult => {
    const found = input.scenarios[key];
    if (!found) throw new Error(`scenario ${key} was never measured`);
    return found;
  };

  return {
    $schema: "bench-streaming-v1",
    measured_at: (input.measuredAt ?? new Date()).toISOString(),
    machine: input.machine,
    knob: { on2_us_per_message: input.on2UsPerMessage },
    protocol: {
      ...input.protocol,
      note:
        "absorbed_per_s, cost_us_per_chunk, busy_ms and drain_ms are page-clock. " +
        "handoff_per_s times the DRIVER, which returns before a frame has arrived, " +
        "so it is a witness and never a verdict. busy_ms is a rate deficit against " +
        "the idle probe rate measured on this same page while it was idle. The " +
        "occupancy probe is RESIDENT during every burst, so the absolute rates are " +
        "slightly pessimistic; the short-vs-long ratio is not, because it pays the " +
        "same tax on both sides.",
    },
    witness: input.witness,
    // The subtrahend for every "outside the list" count above.
    quiet_baseline: input.quiet,
    scenarios: input.scenarios,
    // THE HEADLINE. The cost of a chunk must not know how long the
    // conversation is. Two independent readings of the same claim: what the
    // main thread spent, and what the page managed to paint.
    cost_of_length: {
      text_busy_long_over_short: costRatio(
        s("text_long").median.busy_us_per_chunk,
        s("text_short").median.busy_us_per_chunk,
      ),
      text_cost_long_over_short: costRatio(
        s("text_long").median.cost_us_per_chunk,
        s("text_short").median.cost_us_per_chunk,
      ),
      tool_busy_long_over_short: costRatio(
        s("tool_long").median.busy_us_per_chunk,
        s("tool_short").median.busy_us_per_chunk,
      ),
      tool_cost_long_over_short: costRatio(
        s("tool_long").median.cost_us_per_chunk,
        s("tool_short").median.cost_us_per_chunk,
      ),
    },
  };
}

import { describe, expect, it } from "bun:test";
import {
  HARNESS_BOUND_DRAIN_MS,
  LIMITS,
  judge,
  ratio,
  readMeasurement,
  type QuietBaseline,
  type Scenario,
  type ScenarioMedian,
  type StreamMeasurement,
} from "./streaming";

/**
 * THE READER, READ.
 *
 * The real red comes from a browser: `bun run scripts/bench/streaming.ts --on2 4`
 * burns four microseconds per transcript message inside the task that parses
 * every arriving chunk, and the long transcript falls off a cliff while the
 * short one does not move. What that run CANNOT cover is everything around the
 * number — a witness that went missing, a ratio with a zero under it, a
 * measurement left over from a previous run, and the rule that any of those
 * outranks a genuine overrun. Those need fixtures, and fixtures are the only
 * honest way to check them: `judge` decides, it does not measure, so feeding it
 * real numbers would make it verifiable only when a Chromium happens to be
 * around.
 */

const MEDIAN: ScenarioMedian = {
  applied_at_end: 1501,
  chunks_absorbed: 1500,
  fell_behind: 0,
  absorbed_per_s: 2700,
  handoff_per_s: 3800,
  drain_ms: 19,
  absorb_ms: 555,
  cost_us_per_chunk: 370,
  busy_ms: 82,
  busy_us_per_chunk: 54,
  blocked_ms: 131,
  longtask_count: 0,
  longtask_ms: 0,
  loaf_count: 0,
  loaf_script_ms: 0,
  loaf_blocking_ms: 0,
  frames: 69,
  worst_gap_ms: 25,
  median_gap_ms: 8.3,
  layout_shift_outside_list: 0,
  layout_shift_inside_list: 0.02,
  mutations_outside_list: 27,
};

const scenario = (
  mode: "text" | "tool",
  transcript: "short" | "long",
  median: Partial<ScenarioMedian> = {},
  movers: string[] = ['dom [data-testid="chat-input-area"]'],
): Scenario => ({
  mode,
  transcript,
  transcript_messages: transcript === "long" ? 2000 : 6,
  chunks_per_burst: 1500,
  reps: 3,
  median: { ...MEDIAN, ...median },
  loaf_supported: true,
  outside_movers: movers,
});

const QUIET: QuietBaseline = {
  window_ms: 1000,
  frames: 60,
  mutations_outside_list: 12,
  layout_shift_outside_list: 0,
  busy_ms: 3,
  outside_movers: ['dom [data-testid="metrics-device"]'],
};

/** A healthy machine on a healthy build: the shape everything else deviates from. */
const HEALTHY: StreamMeasurement = {
  measured_at: "2026-08-15T12:00:00.000Z",
  machine: { platform: "darwin", arch: "arm64", cpu: "Apple M-series", cores: 10 },
  knob: { on2_us_per_message: 0 },
  protocol: { chunks_per_burst: 1500, reps: 3 },
  witness: {
    long_transcript_messages: 2000,
    short_transcript_messages: 6,
    long_scroll_run_px: 62_000,
    short_scroll_run_px: 0,
  },
  quiet_baseline: { long: QUIET, short: QUIET },
  scenarios: {
    text_long: scenario("text", "long"),
    text_short: scenario("text", "short"),
    tool_long: scenario("tool", "long", { cost_us_per_chunk: 683, busy_us_per_chunk: 286 }),
    tool_short: scenario("tool", "short", { cost_us_per_chunk: 684, busy_us_per_chunk: 282 }),
  },
};

interface Patch {
  measured_at?: string;
  witness?: Partial<Record<string, number>>;
  scenarios?: Record<string, Scenario>;
  quiet_baseline?: Record<string, QuietBaseline>;
}

const withPatch = (patch: Patch): StreamMeasurement => ({
  ...HEALTHY,
  ...("measured_at" in patch ? { measured_at: patch.measured_at } : {}),
  witness: { ...HEALTHY.witness, ...(patch.witness ?? {}) } as Record<string, number>,
  quiet_baseline: patch.quiet_baseline ?? HEALTHY.quiet_baseline,
  scenarios: { ...HEALTHY.scenarios, ...(patch.scenarios ?? {}) },
});

describe("judge", () => {
  it("is green when a chunk costs the same in a long thread as in a short one", () => {
    const v = judge(HEALTHY);
    expect(v.code).toBe(0);
    expect(v.exceeded).toEqual([]);
    expect(v.blockers).toEqual([]);
    expect(v.rows.length).toBe(2);
  });

  it("goes red when the wall-clock cost of a chunk scales with the transcript", () => {
    // The knob's signature: the short transcript does not move, the long one
    // pays per message. 370 µs -> 8000 µs is what 4 µs x 2000 messages buys.
    const v = judge(
      withPatch({
        scenarios: { text_long: scenario("text", "long", { cost_us_per_chunk: 8000 }) },
      }),
    );
    expect(v.code).toBe(1);
    expect(v.exceeded.join(" ")).toContain("2000-message");
    expect(v.exceeded.join(" ")).toContain("21.62x");
  });

  it("goes red when the main thread, not just the wall clock, scales with the transcript", () => {
    // The two readings are independent on purpose: a client can keep painting on
    // time while burning the thread, and a bench that only watched one of them
    // would call that healthy.
    const v = judge(
      withPatch({
        scenarios: { tool_long: scenario("tool", "long", { busy_us_per_chunk: 1200 }) },
      }),
    );
    expect(v.code).toBe(1);
    expect(v.exceeded.join(" ")).toContain("main thread");
  });

  it("keeps a ratio just inside the limit green", () => {
    const v = judge(
      withPatch({
        scenarios: {
          text_long: scenario("text", "long", {
            cost_us_per_chunk: MEDIAN.cost_us_per_chunk * LIMITS.cost_ratio.max,
          }),
        },
      }),
    );
    expect(v.code).toBe(0);
  });

  it("blames the stream for layout shift outside the list only above the quiet baseline", () => {
    // Same shift, two readings. With a quiet page that shifts 0.1 per second,
    // a 0.05 shift over half a second of streaming is the wall clock, not the
    // stream — and a bench that could not tell them apart would report the
    // sidebar's own timer as a streaming defect forever.
    const noisyQuiet: QuietBaseline = { ...QUIET, layout_shift_outside_list: 0.1 };
    const shifted = scenario("text", "long", { layout_shift_outside_list: 0.05, absorb_ms: 500 });
    expect(
      judge(
        withPatch({
          quiet_baseline: { long: noisyQuiet, short: noisyQuiet },
          scenarios: { text_long: shifted },
        }),
      ).code,
    ).toBe(0);
    expect(
      judge(
        withPatch({
          quiet_baseline: { long: QUIET, short: QUIET },
          scenarios: { text_long: shifted },
        }),
      ).code,
    ).toBe(1);
  });

  it("names the movers when it blames the stream for a shift", () => {
    const v = judge(
      withPatch({
        scenarios: {
          text_long: scenario(
            "text",
            "long",
            { layout_shift_outside_list: 0.4 },
            ['shift [data-testid="metrics-device"]'],
          ),
        },
      }),
    );
    expect(v.code).toBe(1);
    expect(v.exceeded.join(" ")).toContain("metrics-device");
  });

  it("refuses to judge a ratio with a zero under it instead of calling it perfect", () => {
    // The trap this exists for: `0 / 0` is not "no growth", it is "no reading",
    // and reporting it as 1.0 would publish the best possible news about a
    // measurement that never happened.
    const v = judge(
      withPatch({ scenarios: { text_short: scenario("text", "short", { cost_us_per_chunk: 0 }) } }),
    );
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("zero under it");
  });

  it("refuses a measurement whose long transcript was not long", () => {
    const v = judge(withPatch({ witness: { long_transcript_messages: 20 } }));
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("not meaningfully longer");
  });

  it("refuses a measurement with no transcript-length witness at all", () => {
    const m = withPatch({});
    delete (m.witness as Record<string, number>).long_transcript_messages;
    const v = judge(m);
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("witnesses are missing");
  });

  it("refuses a measurement whose long thread never produced a scroll run", () => {
    // The client-side proof that the whole thread was really in the store. Zero
    // here means the expensive side of the comparison was never expensive.
    const v = judge(withPatch({ witness: { long_scroll_run_px: 0 } }));
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("scroll run");
  });

  it("refuses a measurement older than the run that asked for it", () => {
    const v = judge(HEALTHY, new Date("2026-08-15T13:00:00.000Z"));
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("BEFORE this run started");
  });

  it("refuses a measurement that cannot say when it was taken", () => {
    const m = withPatch({});
    delete m.measured_at;
    expect(judge(m).code).toBe(2);
  });

  it("refuses when one of the two transcripts was never measured", () => {
    const m = withPatch({});
    delete m.scenarios!.tool_short;
    const v = judge(m);
    expect(v.code).toBe(2);
    expect(v.blockers.join(" ")).toContain("never measured");
  });

  it("lets a blocker outrank a genuine overrun", () => {
    // A red on a measurement that does not count is still a statement about
    // nothing, and it is the kind of red that teaches people to re-run.
    const v = judge(
      withPatch({
        witness: { long_scroll_run_px: 0 },
        scenarios: { text_long: scenario("text", "long", { cost_us_per_chunk: 8000 }) },
      }),
    );
    expect(v.code).toBe(2);
    expect(v.exceeded.length).toBeGreaterThan(0);
  });

  it("says the absorbed rate is a floor when the client was never behind", () => {
    const v = judge(HEALTHY);
    expect(v.notes.join(" ")).toContain("FLOOR");
  });

  it("says the absorbed rate is the client's ceiling when a backlog remained", () => {
    const v = judge(
      withPatch({
        scenarios: {
          text_long: scenario("text", "long", { drain_ms: HARNESS_BOUND_DRAIN_MS + 400 }),
        },
      }),
    );
    expect(v.notes.join(" ")).toContain("ceiling");
  });

  it("reports the ceiling it actually found when the client did not keep up", () => {
    // The throughput question only has a real answer when something fell
    // behind. This is the note that carries it, and it must name the number of
    // chunks that landed rather than the number that were sent.
    const v = judge(
      withPatch({
        scenarios: {
          text_long: scenario("text", "long", {
            fell_behind: 1,
            chunks_absorbed: 620,
            absorbed_per_s: 31,
            cost_us_per_chunk: 32_000,
          }),
        },
      }),
    );
    expect(v.code).toBe(1);
    expect(v.notes.join(" ")).toContain("did NOT keep up");
    expect(v.notes.join(" ")).toContain("620");
  });

  it("says so when long-animation-frame timing is not available", () => {
    const missing = { ...scenario("text", "long"), loaf_supported: false };
    const v = judge(withPatch({ scenarios: { text_long: missing } }));
    expect(v.notes.join(" ")).toContain("not available here");
  });
});

describe("ratio", () => {
  it("is null, never zero, when the denominator is zero", () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
  });

  it("is null when either side is not a number", () => {
    expect(ratio(Number.NaN, 3)).toBeNull();
    expect(ratio(3, Number.POSITIVE_INFINITY)).toBeNull();
    expect(ratio(Number.POSITIVE_INFINITY, 3)).toBeNull();
  });

  it("rounds to two decimals", () => {
    expect(ratio(370, 363)).toBe(1.02);
  });
});

describe("readMeasurement", () => {
  it("rejects valid JSON that is not a measurement", () => {
    const path = `${import.meta.dir}/streaming.ts`;
    expect(() => readMeasurement(path)).toThrow();
  });
});

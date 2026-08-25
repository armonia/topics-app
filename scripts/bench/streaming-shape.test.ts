/**
 * @covers STREAMB-01
 */
import { describe, expect, it } from "bun:test";
import {
  buildStreamingReport,
  costRatio,
  median,
  shapeBurst,
  shapeQuiet,
  summarise,
  type BurstRaw,
  type BurstResult,
  type Calibration,
} from "./streaming-shape";

/**
 * THE WRITER, READ.
 *
 * `judge` in streaming.ts is checked by streaming.test.ts against fixtures for
 * the same reason this file exists: the browser run proves the numbers, and
 * nothing else. What a browser cannot show, because a healthy page never
 * produces it, is the harness FAILING to measure — a probe that never found the
 * list, a burst that painted nothing, a page that crashed mid-burst. Those are
 * exactly the readings that must not become a published number, and they are
 * one `if` each. Fixtures are the only honest way to see them refuse.
 */

const CALIBRATION: Calibration = {
  pings: 300_000,
  idleRatePerMs: 500,
  medianDelayMs: 0.002,
  p95DelayMs: 0.004,
};

/** A burst that went well: 1000 chunks painted in 400 ms of page clock. */
const raw = (over: Partial<BurstRaw> = {}): BurstRaw => ({
  listResolved: true,
  progressReadable: true,
  paneCrashed: false,
  frames: 24,
  worstGapMs: 33.333,
  medianGapMs: 16.666,
  tStart: 1000,
  tMark: 1350,
  tComplete: 1400,
  appliedAtStart: 1,
  appliedAtEnd: 1001,
  hitDeadline: false,
  longtaskCount: 1,
  longtaskMs: 62.5,
  loafSupported: true,
  loafCount: 3,
  loafScriptMs: 41.25,
  loafBlockingMs: 12.5,
  blockedMs: 7.5,
  // 400 ms at the idle rate would be 200_000 round-trips; it got 150_000, so
  // 100 ms of the burst belonged to somebody else.
  pings: 150_000,
  shiftInside: 0.011_11,
  shiftOutside: 0.002_22,
  shiftUnattributed: 0.001_11,
  mutationsInside: 900,
  mutationsOutside: 4,
  outsideMovers: ['dom [data-testid="session-tab-strip"]'],
  ...over,
});

const CONTEXT = { mode: "text" as const, chunks: 1000, handoffMs: 250, calibration: CALIBRATION };

describe("shapeBurst", () => {
  it("reads a healthy burst on the page clock, not the driver's", () => {
    const r = shapeBurst(raw(), CONTEXT);
    expect(r.chunks_absorbed).toBe(1000);
    expect(r.absorb_ms).toBe(400);
    // 400 ms for 1000 chunks.
    expect(r.cost_us_per_chunk).toBe(400);
    expect(r.absorbed_per_s).toBe(2500);
    // The driver handed off in 250 ms and the page caught up 50 ms after the
    // mark: both are recorded, and neither is the cost.
    expect(r.handoff_per_s).toBe(4000);
    expect(r.drain_ms).toBe(50);
    // The rate deficit: 400 ms elapsed, 300 ms of it at the idle rate.
    expect(r.busy_ms).toBe(100);
    expect(r.busy_us_per_chunk).toBe(100);
    expect(r.fell_behind).toBe(0);
  });

  it("counts a burst that closed on the deadline as fallen behind, with what it got", () => {
    const r = shapeBurst(raw({ hitDeadline: true, appliedAtEnd: 613 }), CONTEXT);
    expect(r.fell_behind).toBe(1);
    expect(r.chunks_absorbed).toBe(612);
  });

  it("attributes unattributed layout shift OUTSIDE the list", () => {
    // A shift with no sources cannot be proven to be the message list's, and a
    // bench that credits itself with the benefit of the doubt is not a bench.
    const r = shapeBurst(raw(), CONTEXT);
    expect(r.layout_shift_outside_list).toBe(0.0033);
    expect(r.layout_shift_inside_list).toBe(0.0111);
  });

  it("never reports a NEGATIVE busy time when the probe outran its calibration", () => {
    const r = shapeBurst(raw({ pings: 400_000 }), CONTEXT);
    expect(r.busy_ms).toBe(0);
  });

  it.each([
    ["read() returned nothing", undefined, /read\(\) returned nothing/],
    ["the pane crashed", raw({ paneCrashed: true }), /React error boundary/],
    ["there was no list to scope against", raw({ listResolved: false }), /no virtualized list/],
    ["progress was unreadable", raw({ progressReadable: false }), /could not read progress/],
    ["the burst never closed", raw({ tComplete: null }), /never completed on the page clock/],
    ["the driver never marked", raw({ tMark: null }), /never completed on the page clock/],
    ["nothing painted", raw({ appliedAtEnd: 1 }), /painted nothing at all/],
  ])("refuses to publish a number when %s", (_name, sample, message) => {
    expect(() => shapeBurst(sample, CONTEXT)).toThrow(message);
  });
});

describe("shapeQuiet", () => {
  it("measures the window and what moved in it, with no target to reach", () => {
    const q = shapeQuiet(raw({ tComplete: 2000, pings: 250_000 }), CALIBRATION);
    expect(q.window_ms).toBe(1000);
    expect(q.mutations_outside_list).toBe(4);
    // 1000 ms of window, 500 ms of it at the idle rate.
    expect(q.busy_ms).toBe(500);
  });

  it("refuses a window that never elapsed, and a page that was already broken", () => {
    expect(() => shapeQuiet(raw({ tComplete: null }), CALIBRATION)).toThrow(/produced nothing/);
    expect(() => shapeQuiet(raw({ paneCrashed: true }), CALIBRATION)).toThrow(/already broken/);
  });
});

describe("summarise", () => {
  const run = (over: Partial<BurstResult>): BurstResult => ({ ...shapeBurst(raw(), CONTEXT), ...over });

  it("takes the MEDIAN of the bursts, not the mean, and keeps every run", () => {
    const runs = [
      run({ cost_us_per_chunk: 400 }),
      run({ cost_us_per_chunk: 4000 }),
      run({ cost_us_per_chunk: 420 }),
    ];
    const s = summarise("text", "long", 2000, 1000, runs);
    expect(s.median.cost_us_per_chunk).toBe(420);
    expect(s.reps).toBe(3);
    expect(s.runs).toHaveLength(3);
  });

  it("unions the movers across bursts and demands loaf support from ALL of them", () => {
    const s = summarise("tool", "short", 6, 1000, [
      run({ outside_movers: ["dom a"], loaf_supported: true }),
      run({ outside_movers: ["dom b", "dom a"], loaf_supported: false }),
    ]);
    expect(s.outside_movers.sort()).toEqual(["dom a", "dom b"]);
    expect(s.loaf_supported).toBe(false);
  });
});

describe("median", () => {
  it("is a measured value on an odd count and the midpoint on an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("costRatio", () => {
  it("is null and never 0 when the denominator is 0", () => {
    // 0 reads as "the cost did not grow", which is the opposite of "there is no
    // number here". The judge prints "n/a" for null and blocks the verdict.
    expect(costRatio(400, 0)).toBeNull();
    expect(costRatio(404, 400)).toBe(1.01);
  });
});

describe("buildStreamingReport", () => {
  const scenario = (mode: "text" | "tool", transcript: "short" | "long", costUs: number, busyUs: number) => ({
    ...summarise(mode, transcript, transcript === "long" ? 2000 : 6, 1000, [
      { ...shapeBurst(raw(), CONTEXT), cost_us_per_chunk: costUs, busy_us_per_chunk: busyUs },
    ]),
  });

  const input = {
    on2UsPerMessage: 0,
    machine: { platform: "darwin 25.2.0", arch: "arm64", cpu: "Apple M2 Max", cores: 12 },
    protocol: {
      chunks_per_burst: 1000,
      reps: 3,
      token_chars: 4,
      calibration_ms: 600,
      burst_deadline_ms: 20_000,
      long_transcript_messages: 2000,
      short_transcript_messages: 6,
    },
    witness: { long_transcript_messages: 2000, short_transcript_messages: 6, long_scroll_run_px: 66_559 },
    quiet: { long: shapeQuiet(raw({ tComplete: 2000 }), CALIBRATION) },
    scenarios: {
      text_long: scenario("text", "long", 404, 21),
      text_short: scenario("text", "short", 400, 20),
      tool_long: scenario("tool", "long", 660, 210),
      tool_short: scenario("tool", "short", 600, 200),
    },
    measuredAt: new Date("2026-08-15T12:00:00.000Z"),
  };

  it("publishes the headline as four ratios of long over short", () => {
    const report = buildStreamingReport(input) as { cost_of_length: Record<string, number | null> };
    expect(report.cost_of_length.text_cost_long_over_short).toBe(1.01);
    expect(report.cost_of_length.text_busy_long_over_short).toBe(1.05);
    expect(report.cost_of_length.tool_cost_long_over_short).toBe(1.1);
    expect(report.cost_of_length.tool_busy_long_over_short).toBe(1.05);
  });

  it("carries the witnesses the judge blocks on, and the knob it warns about", () => {
    const report = buildStreamingReport({ ...input, on2UsPerMessage: 4 }) as {
      measured_at: string;
      witness: Record<string, number>;
      knob: { on2_us_per_message: number };
    };
    expect(report.measured_at).toBe("2026-08-15T12:00:00.000Z");
    expect(report.witness.long_scroll_run_px).toBe(66_559);
    expect(report.knob.on2_us_per_message).toBe(4);
  });

  it("throws rather than serialise a hole where a scenario should be", () => {
    // A missing scenario reaches `judge` as one fewer thing that could be over
    // budget, i.e. as good news. It has to stop here instead.
    const { tool_short: _dropped, ...rest } = input.scenarios;
    expect(() => buildStreamingReport({ ...input, scenarios: rest })).toThrow(/tool_short was never measured/);
  });
});

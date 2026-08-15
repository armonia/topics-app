/**
 * The verdict half of the AI-latency bench, under test.
 *
 * WHAT IS WORTH TESTING HERE. Not that `>` compares numbers. What is worth
 * testing is that the gate goes red for the RIGHT reason, and that the two
 * outcomes a latency benchmark most easily gets wrong are impossible:
 *
 *   · a leg that was never measured reported as a pass, and
 *   · the model's share, which is not ours, printed as a fast zero when nothing
 *     answered.
 *
 * Both were real design risks. The default mode calls no provider on purpose,
 * so `acceptedToFirstProviderEvent` is absent on every ordinary run: an
 * implementation that folded "absent" into "0 ms" would publish a benchmark
 * claiming the model answers instantly.
 */
import { describe, expect, it } from "bun:test";
import {
  judge,
  LEGS,
  MODEL_LEG_KEY,
  parseArgs,
  REQUEST_BODY_CHARS_CEILING,
  renderReport,
  type BenchResult,
  type Measured,
  type Metric,
} from "./ai-latency";

function measured(ms: number, spread = 0): Measured {
  return {
    label: "leg",
    what: "what it covers",
    ours: true,
    measurable: true,
    unit: "ms",
    samples: [ms - spread, ms, ms + spread],
    medianMs: ms,
    minMs: ms - spread,
    maxMs: ms + spread,
  };
}

/** A result in which every one of our legs sits comfortably inside budget. */
function healthy(overrides: Record<string, Metric> = {}): BenchResult {
  const metrics: Record<string, Metric> = {};
  for (const leg of LEGS) metrics[leg.key] = measured(leg.budget.medianMs / 4);
  metrics[MODEL_LEG_KEY] = {
    label: "accepted -> first provider event",
    what: "the model and the network",
    ours: false,
    measurable: false,
    reason: "not measured by construction: the default mode never calls a model.",
  };
  return {
    measured_at: "2026-08-15T14:00:00.000Z",
    mode: "injected",
    machine: "Apple M2 Max, 12 cores, darwin 25.2.0",
    shell: "chromium headless 1280x800",
    samples: { send: 7, delivery: 7 },
    injected_stalls_ms: { send: 0, deliver: 0, accept: 0 },
    models_that_answered: { seen: ["<synthetic>"] },
    metrics: { ...metrics, ...overrides },
    request_body_chars: { median: 800, min: 450, max: 1200 },
  };
}

describe("judge - the four legs that are ours", () => {
  it("passes when every leg is inside its budget", () => {
    const verdict = judge(healthy());
    expect(verdict.failures).toEqual([]);
    expect(verdict.exitCode).toBe(0);
  });

  it("fails on the median, and names the leg and the samples", () => {
    const leg = LEGS[0];
    const verdict = judge(healthy({ [leg.key]: measured(leg.budget.medianMs + 1) }));
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.join("\n")).toContain(leg.label);
    expect(verdict.failures.join("\n")).toContain("median");
  });

  it("fails on ONE bad sample even when the median is fine", () => {
    // The half a median cannot see. This is the shape of the defect
    // tests/e2e/ink-budget.json was written after: four samples at 13 ms and one
    // at 196 ms reads as a healthy median.
    const leg = LEGS[2];
    const oneStall: Measured = {
      ...measured(10),
      samples: [10, 11, 10, 12, leg.budget.maxMs + 200],
      medianMs: 11,
      minMs: 10,
      maxMs: leg.budget.maxMs + 200,
    };
    const verdict = judge(healthy({ [leg.key]: oneStall }));
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.join("\n")).toContain("one sample at");
  });

  it("treats a leg that was not measured as a failure, never as a pass", () => {
    const leg = LEGS[1];
    const verdict = judge(
      healthy({
        [leg.key]: {
          label: leg.label,
          what: "",
          ours: true,
          measurable: false,
          reason: "the probe never fired",
        },
      }),
    );
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.join("\n")).toContain("the probe never fired");
  });

  it("treats a leg missing from the file as a failure", () => {
    const result = healthy();
    delete result.metrics[LEGS[3].key];
    const verdict = judge(result);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.join("\n")).toContain("not measured at all");
  });
});

describe("judge - the model's share is reported, never judged and never zeroed", () => {
  it("does not fail an ordinary run just because no model was called", () => {
    const verdict = judge(healthy());
    expect(verdict.exitCode).toBe(0);
    expect(verdict.notes.join("\n")).toContain("Model share not measured");
  });

  it("exits 3 when --real was asked for and nothing answered", () => {
    const verdict = judge(healthy(), { real: true });
    expect(verdict.exitCode).toBe(3);
  });

  it("never puts a model number over budget, because it has no budget", () => {
    const slowModel: Measured = { ...measured(9_000, 2_000), ours: false };
    const verdict = judge(healthy({ [MODEL_LEG_KEY]: slowModel }), { real: true });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.failures).toEqual([]);
    expect(verdict.rows.join("\n")).toContain("NOT ours");
  });
});

describe("judge - the request body is gated by size, not by duration", () => {
  it("fails when the body breaks the tail ceiling", () => {
    const result = healthy();
    result.request_body_chars = { median: 900, min: 450, max: REQUEST_BODY_CHARS_CEILING + 1 };
    const verdict = judge(result);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.join("\n")).toContain("chatRequestPayload");
  });

  it("passes at exactly the ceiling", () => {
    const result = healthy();
    result.request_body_chars = { median: 900, min: 450, max: REQUEST_BODY_CHARS_CEILING };
    expect(judge(result).exitCode).toBe(0);
  });
});

describe("judge - the run says out loud whether it spent money", () => {
  it("reports a free run as free", () => {
    expect(judge(healthy()).notes.join("\n")).toContain("called no model");
  });

  it("reports a paid run as paid, naming the model", () => {
    const result = healthy();
    result.models_that_answered = { seen: ["<synthetic>", "claude-opus-5"] };
    expect(judge(result).notes.join("\n")).toContain("claude-opus-5");
  });

  it("says when the numbers come from a falsification run", () => {
    const result = healthy();
    result.injected_stalls_ms = { send: 0, deliver: 120, accept: 0 };
    expect(judge(result).notes.join("\n")).toContain("FALSIFICATION RUN");
  });
});

describe("renderReport", () => {
  it("names the machine, because a latency number without one means nothing", () => {
    const result = healthy();
    const text = renderReport(result, judge(result));
    expect(text).toContain(result.machine);
    expect(text).toContain(result.shell);
    expect(text).toContain("injected");
  });
});

describe("parseArgs", () => {
  it("defaults every stall to zero", () => {
    expect(parseArgs([])).toEqual({
      noRun: false,
      real: false,
      stallSendMs: 0,
      stallDeliverMs: 0,
      stallAcceptMs: 0,
    });
  });

  it("reads the three falsification knobs", () => {
    const args = parseArgs(["--stall-send", "150", "--stall-deliver", "120", "--stall-accept", "90"]);
    expect(args).toEqual({
      noRun: false,
      real: false,
      stallSendMs: 150,
      stallDeliverMs: 120,
      stallAcceptMs: 90,
    });
  });

  it("refuses a stall that is not a positive number, instead of silently running a baseline", () => {
    expect(parseArgs(["--stall-send", "nope"])).toEqual({
      error: "--stall-send wants a positive number of milliseconds",
    });
    expect(parseArgs(["--stall-deliver", "0"])).toEqual({
      error: "--stall-deliver wants a positive number of milliseconds",
    });
  });
});

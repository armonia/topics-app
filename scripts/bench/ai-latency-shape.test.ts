/**
 * @covers LAT-AI-01
 */
import { describe, expect, it } from "bun:test";
import { judge } from "./ai-latency";
import {
  buildAiLatencyReport,
  median,
  shapeModelLeg,
  summarise,
  type AiLatencyReportInput,
} from "./ai-latency-shape";

/**
 * THE WRITER, READ.
 *
 * The e2e run proves the milliseconds. It cannot prove the thing this bench was
 * built around: that a leg nobody measured is published as a REASON and never
 * as a zero. In the default mode only one of the four "not measured" branches
 * is ever taken, and the other three are reachable solely by paying a provider
 * for a turn that fails in a particular way. Fixtures, then.
 */

describe("summarise", () => {
  it("reports the median, the range and the samples, all to a tenth of a ms", () => {
    const m = summarise("send", "what it covers", true, [0.24, 0.19, 0.71, 0.2, 0.22]);
    expect(m.medianMs).toBe(0.2);
    expect(m.minMs).toBe(0.2);
    expect(m.maxMs).toBe(0.7);
    expect(m.samples).toEqual([0.2, 0.2, 0.7, 0.2, 0.2]);
    expect(m.measurable).toBe(true);
    expect(m.ours).toBe(true);
  });

  it("refuses to average nothing", () => {
    expect(() => median([])).toThrow(/no samples/);
  });
});

describe("shapeModelLeg", () => {
  const base = { real: true, modelIsReachable: true, probeModel: "claude-opus-5", providersReady: ["claude-code"], samples: [820, 910, 780] };

  it("measures the provider's share only when a provider actually answered", () => {
    const leg = shapeModelLeg(base);
    expect(leg.measurable).toBe(true);
    expect(leg.ours).toBe(false);
    if (leg.measurable) expect(leg.medianMs).toBe(820);
  });

  it("says the default mode never called a model, rather than reporting 0 ms", () => {
    const leg = shapeModelLeg({ ...base, real: false, samples: [] });
    expect(leg.measurable).toBe(false);
    if (!leg.measurable) expect(leg.reason).toMatch(/absent\s+rather than fast/);
  });

  it("names the synthetic model when --real was asked for and nothing answered", () => {
    // The trap this branch exists for: /api/providers/snapshot calls three
    // providers "ready" on a server where none of them is logged in.
    const leg = shapeModelLeg({ ...base, modelIsReachable: false, probeModel: "<synthetic>", samples: [] });
    expect(leg.measurable).toBe(false);
    if (!leg.measurable) {
      expect(leg.reason).toContain('"<synthetic>"');
      expect(leg.reason).toContain("claude-code");
      expect(leg.reason).toContain("This is not a zero.");
    }
  });

  it("says so when a model answered the probe but no sample produced a chunk", () => {
    const leg = shapeModelLeg({ ...base, samples: [] });
    expect(leg.measurable).toBe(false);
    if (!leg.measurable) expect(leg.reason).toMatch(/no measured sample produced a content chunk/);
  });
});

describe("buildAiLatencyReport", () => {
  const input: AiLatencyReportInput = {
    real: false,
    platform: "darwin arm64",
    machine: "Apple M2 Max, 12 cores, darwin 25.2.0",
    shell: "chromium headless 1280x800",
    samples: { send: 7, delivery: 7 },
    stalls: { send: 0, deliver: 0, accept: 0 },
    providersReady: ["openclaw", "claude-code", "gemini"],
    turnModels: ["<synthetic>", "<synthetic>", "<synthetic>"],
    legs: {
      composerToWire: [0.2, 0.2, 0.3],
      wireToAccepted: [9.7, 12.1, 15.8],
      firstTokenToInk: [12.4, 16.2, 27.6],
      midStreamTokenToInk: [17.8, 20.0, 29.1],
    },
    modelLeg: shapeModelLeg({ real: false, modelIsReachable: false, probeModel: null, providersReady: [], samples: [] }),
    bodyChars: [780, 819, 902],
    measuredAt: new Date("2026-08-15T12:00:00.000Z"),
  };

  it("writes a record the judge reads and passes", () => {
    // The two halves of one file, checked against each other without a browser:
    // a field the writer renames stops being a field the judge can find.
    const verdict = judge(buildAiLatencyReport(input));
    expect(verdict.failures).toEqual([]);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.notes.some((n) => n.includes("called no model"))).toBe(true);
  });

  it("names the mode, dedupes the models seen, and keeps the body a SIZE", () => {
    const report = buildAiLatencyReport(input);
    expect(report.mode).toBe("injected");
    expect(report.models_that_answered.seen).toEqual(["<synthetic>"]);
    expect(report.request_body_chars.median).toBe(819);
    expect(report.request_body_chars.max).toBe(902);
    expect(report.metrics.wireToAccepted.medianMs).toBe(12.1);
  });

  it("carries the injected stalls, so a falsification run cannot be read as a baseline", () => {
    const report = buildAiLatencyReport({ ...input, stalls: { send: 150, deliver: 0, accept: 0 } });
    const verdict = judge(report);
    expect(report.injected_stalls_ms.send).toBe(150);
    expect(verdict.notes.some((n) => n.startsWith("FALSIFICATION RUN"))).toBe(true);
  });

  it("makes a run that DID call a model say so in its own output", () => {
    const report = buildAiLatencyReport({ ...input, turnModels: ["<synthetic>", "claude-opus-5"] });
    expect(judge(report).notes.some((n) => n.includes("It cost tokens."))).toBe(true);
  });
});

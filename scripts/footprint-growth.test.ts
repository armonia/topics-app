import { describe, expect, it } from "bun:test";
import {
  judgeGrowth,
  MIN_SAMPLES,
  pickRenderer,
  RENDERER_PROCESS_NAME,
  slopeMBPerMin,
} from "./footprint-growth";

const MINUTE = 60_000;

/** A series that climbs `mbPerMin` from `startMB`, one sample a minute. */
function ramp(startMB: number, mbPerMin: number, samples: number) {
  return Array.from({ length: samples }, (_, i) => ({ t: i * MINUTE, mb: startMB + i * mbPerMin }));
}

describe("pickRenderer", () => {
  it("takes the heaviest WebContent, not the first", () => {
    const rows = [
      { pid: 1, name: "Topics", footprintMB: 300 },
      { pid: 2, name: RENDERER_PROCESS_NAME, footprintMB: 120 },
      { pid: 3, name: RENDERER_PROCESS_NAME, footprintMB: 2337 },
    ];
    expect(pickRenderer(rows)?.pid).toBe(3);
  });

  it("is null when the app is not running", () => {
    expect(pickRenderer([{ pid: 1, name: "Topics", footprintMB: 300 }])).toBeNull();
    expect(pickRenderer([])).toBeNull();
  });
});

describe("slopeMBPerMin", () => {
  it("reads the climb of a steady ramp", () => {
    expect(slopeMBPerMin(ramp(400, 4, 20))).toBeCloseTo(4, 5);
  });

  it("ignores the startup burst, which is in the first half", () => {
    const series = [
      ...ramp(100, 200, 6), // boot: hundreds of MB a minute
      ...Array.from({ length: 10 }, (_, i) => ({ t: (6 + i) * MINUTE, mb: 1300 })),
    ];
    expect(slopeMBPerMin(series)).toBeCloseTo(0, 5);
  });

  it("is zero on a series too short to have a second half", () => {
    expect(slopeMBPerMin([{ t: 0, mb: 500 }])).toBe(0);
  });
});

describe("judgeGrowth: the bar", () => {
  it("is RED on the rate the card measured", () => {
    // 2337 MB in 9h34m is about 4 MB/min.
    const verdict = judgeGrowth(ramp(400, 4, 20), 0.5);
    expect(verdict.ok).toBe(false);
    expect(verdict.slopeMBPerMin).toBeCloseTo(4, 5);
    expect(verdict.reason).toContain("GROWS");
    expect(verdict.firstMB).toBe(400);
  });

  it("is GREEN on a flat curve", () => {
    const verdict = judgeGrowth(ramp(1844, 0, 20), 0.5);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("FLAT");
  });

  it("is GREEN while the footprint shrinks: a collection is not a failure", () => {
    expect(judgeGrowth(ramp(900, -5, 20), 0.5).ok).toBe(true);
  });

  it("claims nothing when there are too few samples", () => {
    const verdict = judgeGrowth(ramp(400, 50, MIN_SAMPLES - 1), 0.5);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("nothing claimed");
  });
});

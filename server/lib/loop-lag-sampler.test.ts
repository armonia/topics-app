/**
 * @covers LOOPLAG-01
 *
 * The point of these tests is the SILENCE as much as the line: a sampler that
 * prints on a healthy loop would be one more thing to scroll past in the same
 * log where the stalls are supposed to stand out.
 */
import { describe, expect, it } from "bun:test";
import {
  loopLagLine,
  startLoopLagSampler,
  type LoopLagSample,
} from "./loop-lag-sampler";

const healthy: LoopLagSample = {
  footprintMB: 543,
  compressedMB: 364,
  residentMB: 180,
  diskFaults: 1000,
  load1: 18.5,
};

describe("loopLagLine", () => {
  it("says nothing while the loop keeps its schedule", () => {
    const line = loopLagLine({
      now: new Date("2026-09-07T17:00:00.000Z"),
      lagMs: 40,
      thresholdMs: 1000,
      sample: healthy,
      previousDiskFaults: 990,
    });
    expect(line).toBeNull();
  });

  it("writes one line per stall, with the page-ins taken DURING it", () => {
    const line = loopLagLine({
      now: new Date("2026-09-07T17:00:00.000Z"),
      lagMs: 6508,
      thresholdMs: 1000,
      sample: healthy,
      previousDiskFaults: 940,
    });
    expect(line).toContain("[LAG] loop stopped 6508ms");
    expect(line).toContain("footprint=543MB");
    expect(line).toContain("compressed=364MB");
    // 1000 - 940: the delta is the event, the total would be a state.
    expect(line).toContain("disk-faults=+60");
    expect(line).toContain("load1=18.50");
  });

  it("prints a number it does not have as `?`, never as zero", () => {
    const line = loopLagLine({
      now: new Date("2026-09-07T17:00:00.000Z"),
      lagMs: 2000,
      thresholdMs: 1000,
      sample: { footprintMB: null, compressedMB: null, residentMB: null, diskFaults: null, load1: 0.5 },
      previousDiskFaults: null,
    });
    expect(line).toContain("footprint=?MB");
    expect(line).toContain("compressed=?MB");
    expect(line).toContain("disk-faults=?");
    expect(line).not.toContain("=0MB");
  });
});

describe("startLoopLagSampler", () => {
  it("measures the lag against when the tick was DUE, not against the previous tick", async () => {
    const lines: string[] = [];
    // A clock that jumps a second per reading: every tick arrives long after it
    // was due, which is what a stopped loop looks like from inside.
    let clock = 0;
    const timer = startLoopLagSampler({
      log: (l) => lines.push(l),
      tickMs: 5,
      thresholdMs: 100,
      now: () => (clock += 1000),
      sample: () => ({ footprintMB: 543, compressedMB: 364, residentMB: 180, diskFaults: 7 }),
      load1: () => 18.5,
    });
    await Bun.sleep(40);
    clearInterval(timer);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("[LAG] loop stopped 995ms");
  });
});

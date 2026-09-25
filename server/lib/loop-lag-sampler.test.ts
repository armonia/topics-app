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
  readSelfMemory,
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

describe("where a stall's time went", () => {
  it("says how much of the stall was CPU and how much was waiting in the scheduler's queue", () => {
    const line = loopLagLine({
      now: new Date("2026-09-25T17:00:00.000Z"),
      lagMs: 287_000,
      thresholdMs: 1000,
      // Runnable counts running AND waiting: 912 of work + 3127 in the queue.
      sample: { ...healthy, cpuMs: 10_912, runnableMs: 24_039 },
      previousDiskFaults: 1000,
      previousCpuMs: 10_000,
      previousRunnableMs: 20_000,
    });
    expect(line).toContain("cpu=+912ms queued=+3127ms");
  });

  it("the first stall, with nothing to compare against, says `?`", () => {
    const line = loopLagLine({ now: new Date(0), lagMs: 2000, thresholdMs: 1000, sample: { ...healthy, cpuMs: 5, runnableMs: 7 }, previousDiskFaults: null });
    expect(line).toContain("cpu=? queued=?");
  });

  it.if(process.platform === "darwin")("reads this process's runnable time in ms: at least the CPU it spent busy, next to its footprint", () => {
    const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    const before = readSelfMemory();
    const cpuBefore = cpu();
    const end = performance.now() + 300;
    while (performance.now() < end) { /* busy: runnable the whole time */ }
    const after = readSelfMemory();
    const spent = cpu() - cpuBefore;
    expect(before.footprintMB).toBeGreaterThan(0);
    const runnable = after.runnableMs! - before.runnableMs!;
    // Mach ticks read as ms would be 41x too big, nanoseconds as ms 1e6 too big:
    // the unit is right when running time sits inside it and the wall bounds it.
    expect(runnable).toBeGreaterThanOrEqual(spent * 0.9);
    expect(runnable).toBeLessThan(300 * 12 + 100);
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

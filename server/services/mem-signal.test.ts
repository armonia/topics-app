/**
 * The memory signal reads a window, not an instant: the lowest reading of 2
 * minutes for the floor, and swap-ins together with growing memory debt for
 * sustained swap. Fixtures from the live probes of 15/09/2026 and 11/09/2026.
 *
 * @covers KANBAN-75
 * @covers KANBAN-82
 */
import { describe, expect, test } from "bun:test";
import {
  createMemSignal,
  formatMemorySignalLine,
  heldMemory,
  DEBT_GB_PER_MIN,
  parseSwapTotalMB,
  parseSwapUsedMB,
  signed,
  SWAP_CEILING_SHARE,
  swapReasonIt,
  swapSigns,
  swapVerdict,
  type MemSample,
  type SwapVerdict,
} from "./mem-signal";
import { parseVmStat } from "./dispatch-capacity";

const T0 = 1_760_000_000_000;
const PAGE = 16_384;
const s = (sec: number, over: Partial<MemSample> = {}): MemSample => ({
  at: T0 + sec * 1000, availGB: 10, swapins: 0, compressorPages: 500_000, pageSize: PAGE, swapUsedMB: 10_000, swapTotalMB: 16_384, load1: 5, ...over,
});
const at = (sec: number) => T0 + sec * 1000;
/** Readings every `step` seconds from `from`, one value each. */
const readings = (from: number, step: number, values: number[]): MemSample[] =>
  values.map((gb, i) => s(from + i * step, { availGB: gb }));

describe("heldMemory: the lowest reading of a full 2-minute window", () => {
  test("M1: the 10:37 spike does not lift the window; 11 GB only after 120 s of readings at 11", () => {
    const samples = [...readings(0, 10, Array(12).fill(5.8)), s(120, { availGB: 14.5 }), s(130, { availGB: 5.5 })];
    const spike = heldMemory(samples, at(130), true);
    expect(spike.latestGB).toBe(5.5);
    expect(spike.heldGB!).toBeLessThanOrEqual(5.8);
    const recovered = [...samples, ...readings(140, 10, Array(13).fill(11))];
    expect(heldMemory(recovered, at(250), true).heldGB).toBe(5.5);
    expect(heldMemory(recovered, at(260), true).heldGB).toBe(11);
  });

  test("M2: at boot an empty window holds nothing up and has no value until it is full", () => {
    expect(heldMemory([], at(0), true)).toEqual({ measurable: true, latestGB: null, heldGB: null, coveredMs: 0 });
    const samples = readings(0, 10, Array(13).fill(12));
    expect(heldMemory(samples.slice(0, 12), at(110), true).heldGB).toBeNull();
    expect(heldMemory(samples.slice(0, 12), at(110), true).coveredMs).toBe(110_000);
    expect(heldMemory(samples, at(120), true).heldGB).toBe(12);
  });

  test("M3: a 45 s hole empties the window, a 25 s hole does not", () => {
    const before = readings(0, 10, Array(10).fill(12));
    const hole45 = [...before, ...readings(135, 10, Array(6).fill(12))];
    expect(heldMemory(hole45, at(185), true).heldGB).toBeNull();
    const hole25 = [...before, ...readings(115, 10, Array(8).fill(12))];
    expect(heldMemory(hole25, at(185), true).heldGB).toBe(12);
  });

  test("M4: a newest reading 31 s old is no reading", () => {
    const samples = readings(0, 10, Array(15).fill(12));
    const stale = heldMemory(samples, at(140 + 31), true);
    expect(stale.latestGB).toBeNull();
    expect(stale.heldGB).toBeNull();
  });

  test("off macOS memory is not measurable and never has a value", () => {
    expect(heldMemory(readings(0, 10, Array(15).fill(1)), at(140), false).measurable).toBe(false);
  });
});

/** One sample every 5 s for `seconds`, each field advanced by `step(i)`. */
function swapSeries(seconds: number, step: (i: number) => { swapins: number; compressorPages: number; swapUsedMB: number }, start = { swapins: 1_000_000, compressorPages: 700_000, swapUsedMB: 10_000 }, swapTotalMB: number | null = 16_384): MemSample[] {
  const out: MemSample[] = [];
  let cur = { ...start };
  for (let i = 0; i * 5 <= seconds; i++) {
    if (i > 0) {
      const d = step(i);
      cur = { swapins: cur.swapins + d.swapins, compressorPages: cur.compressorPages + d.compressorPages, swapUsedMB: cur.swapUsedMB + d.swapUsedMB };
    }
    out.push(s(i * 5, { ...cur, swapTotalMB, availGB: 4 }));
  }
  return out;
}
const perMinGBToPages5s = (gbPerMin: number) => Math.round(((gbPerMin / 12) * 1e9) / PAGE);

describe("swapVerdict: pages read back from disk while the memory debt still grows", () => {
  test("M5a: 14:06, thrash (swapins +64/+168 per 5 s, compressor +43,850/+73,683 pages per 5 s, swap flat) is sustained", () => {
    const v = swapVerdict(swapSeries(60, (i) => i % 2
      ? { swapins: 64, compressorPages: 43_850, swapUsedMB: 0 }
      : { swapins: 168, compressorPages: 73_683, swapUsedMB: 0 }), at(60));
    expect(v.sustained).toBe(true);
    expect(v.pagesReadBackPerS!).toBeGreaterThan(20);
    expect(v.debtGBPerMin!).toBeGreaterThan(8.8);
  });

  test("M5b: 11:23, recovery (65 swapins/s, compressor 586,576 to 499,744, swap 10,788 to 10,692 MB in 110 s) is not", () => {
    const steps = 22;
    const v = swapVerdict(swapSeries(110, () => ({ swapins: 325, compressorPages: (499_744 - 586_576) / steps, swapUsedMB: (10_692 - 10_788) / steps }),
      { swapins: 1_000_000, compressorPages: 586_576, swapUsedMB: 10_788 }), at(110));
    expect(v.pagesReadBackPerS!).toBeCloseTo(65, 0);
    expect(v.debtGBPerMin!).toBeLessThan(0);
    expect(v.sustained).toBe(false);
  });

  test("M5c: 14:50, calm with swap debt (swapins +12/+16 per 5 s, compressor and swap flat) is not", () => {
    const v = swapVerdict(swapSeries(60, (i) => ({ swapins: i % 2 ? 12 : 16, compressorPages: 0, swapUsedMB: 0 }), { swapins: 1_000_000, compressorPages: 477_000, swapUsedMB: 10_030 }), at(60));
    expect(v.sustained).toBe(false);
  });

  test("M5d: 11/09, a healthy board (4 swapins in 91 s) with a shard ramping the compressor +1.5 GB/min is not", () => {
    const v = swapVerdict(swapSeries(90, (i) => ({ swapins: i % 4 === 0 ? 1 : 0, compressorPages: perMinGBToPages5s(1.5), swapUsedMB: 0 })), at(90));
    expect(v.debtGBPerMin!).toBeGreaterThan(1);
    expect(v.sustained).toBe(false);
  });

  test("M5e: a saturated compressor moving segments to swap (compressor -0.2 GB/min, swap +1.2 GB/min, 15 swapins/s) is sustained", () => {
    const v = swapVerdict(swapSeries(60, () => ({ swapins: 75, compressorPages: -perMinGBToPages5s(0.2), swapUsedMB: 100 })), at(60));
    expect(v.sustained).toBe(true);
  });

  test("M5i: 16/09 14:41, both stores full (956 pages/s read back, debt +0.4 GB/min) is sustained", () => {
    // Live line, board idle: swapUsedGB 15.5 of 16, comprGB 15.1, load1 92.7,
    // and the old rule answered "calm" because the debt could not grow.
    const v = swapVerdict(swapSeries(60, () => ({ swapins: 4_782, compressorPages: perMinGBToPages5s(0.4), swapUsedMB: 0 })), at(60));
    expect(v.pagesReadBackPerS!).toBeCloseTo(956, 0);
    expect(v.debtGBPerMin!).toBeLessThan(0.5);
    expect(v.sustained).toBe(true);
  });

  test("M5k: the fastest recovery in the log (718 pages/s, debt -0.4 GB/min) is not sustained", () => {
    // 16/09 12:54:29 live: the rate alone would have braked a Mac emptying
    // itself; four more recoveries in that log read 254 to 438 pages/s.
    const v = swapVerdict(swapSeries(60, () => ({ swapins: 3_592, compressorPages: -perMinGBToPages5s(0.4), swapUsedMB: 0 })), at(60));
    expect(v.pagesReadBackPerS!).toBeCloseTo(718, 0);
    expect(v.debtGBPerMin!).toBeLessThan(0);
    expect(v.sustained).toBe(false);
  });

  test("M5j: just under the second door (199 pages/s, debt flat) is not sustained", () => {
    const v = swapVerdict(swapSeries(60, () => ({ swapins: 995, compressorPages: 0, swapUsedMB: 0 })), at(60));
    expect(v.pagesReadBackPerS!).toBeCloseTo(199, 0);
    expect(v.sustained).toBe(false);
  });

  test("M5f-h: 30 swapins/s with debt +0.3 GB/min, a counter going down, 50 s of coverage are not", () => {
    expect(swapVerdict(swapSeries(60, () => ({ swapins: 150, compressorPages: perMinGBToPages5s(0.3), swapUsedMB: 0 })), at(60)).sustained).toBe(false);
    const thrash = swapSeries(60, () => ({ swapins: 150, compressorPages: 60_000, swapUsedMB: 0 }));
    thrash[thrash.length - 1] = { ...thrash[thrash.length - 1]!, swapins: 10 };
    expect(swapVerdict(thrash, at(60)).sustained).toBe(false);
    expect(swapVerdict(swapSeries(50, () => ({ swapins: 150, compressorPages: 60_000, swapUsedMB: 0 })), at(50)).sustained).toBe(false);
  });
});

/**
 * THE SECOND DOOR, on the 16/09/2026 lines of the live server (`[memsig]`, one a
 * minute, 11:50-12:35). The total is NOT a constant: macOS adds swap files while
 * it runs. Those lines never carried the total - `[memsig]` only prints it since
 * this change - so the 16384 MB the cases below use is an ASSUMPTION inherited
 * from the `atCeiling` default, NOT a reading of that hour: the live file read
 * 17408 MB on 16/09 at 15:00, and rows above 16384 MB used appear in the log
 * from 15/09 23:14. With 17408 MB as the denominator four of the five lines of
 * S2 sit below the share and this door would not open on them. That is why the
 * share is declared provisional in `mem-signal.ts` and why the total is now on
 * every line: the calibration is due when some days of logs carry it.
 */
describe("swapVerdict: a swap file at its ceiling is the second door", () => {
  /** A minute of samples at `pagesPerS` with the debt moving `debtGBPerMin`, swap pinned at `usedMB`. */
  /**
   * TWO minutes, not one: the ceiling door asks for the window BEFORE it to be
   * at 10 pages/s or more, so a case built on 60 s alone would never open it.
   * `heldPagesPerS` is that earlier minute, high by default like the live
   * episodes; the isolated-spike case passes a quiet one.
   */
  const atCeiling = (pagesPerS: number, debtGBPerMin: number, usedMB: number, totalMB: number | null = 16_384, heldPagesPerS = pagesPerS) =>
    swapVerdict(swapSeries(120, (i) => ({ swapins: (i * 5 <= 60 ? heldPagesPerS : pagesPerS) * 5, compressorPages: perMinGBToPages5s(debtGBPerMin), swapUsedMB: 0 }),
      { swapins: 1_000_000, compressorPages: 700_000, swapUsedMB: usedMB }, totalMB), at(120));

  test("S1: the worst minute of the 40 - 167.7 pages/s with the debt falling - is sustained, and used to read calm", () => {
    const v = atCeiling(167.7, -1.7, 15_200);
    expect(v.pagesReadBackPerS!).toBeCloseTo(167.7, 1);
    expect(v.debtGBPerMin!).toBeLessThan(0);
    expect(v.swapPct!).toBeCloseTo(0.928, 3);
    expect(v.sustained).toBe(true);
  });

  test("S2: the five real lines - only the first passed the AND, all five are at the ceiling", () => {
    const lines = [
      { swapinPerS: 170.1, debt: +0.7, usedMB: 14_800, vecchio: true },
      { swapinPerS: 167.7, debt: -1.7, usedMB: 15_200, vecchio: false },
      { swapinPerS: 64.1, debt: -1.2, usedMB: 15_400, vecchio: false },
      { swapinPerS: 36.3, debt: -0.1, usedMB: 15_300, vecchio: false },
      { swapinPerS: 27.8, debt: +0.1, usedMB: 15_100, vecchio: false },
    ];
    for (const r of lines) {
      const v = atCeiling(r.swapinPerS, r.debt, r.usedMB);
      expect({ ...r, sustained: v.sustained }).toEqual({ ...r, sustained: true });
      // What the AND alone said, which is the defect: four of the five calm.
      expect(v.debtGBPerMin! >= 0.5).toBe(r.vecchio);
      expect(v.swapPct!).toBeGreaterThanOrEqual(SWAP_CEILING_SHARE);
    }
  });

  test("S3: a healthy machine is NOT touched - the pages term is the guard, and it alone", () => {
    // A board reading 0.04-3 pages/s with the swap file 96.5% full (this Mac's
    // reading at 12:45) stays calm: the ceiling never gets a vote on its own.
    for (const perS of [0.04, 0.3, 1.9, 3, 9.9]) {
      expect(atCeiling(perS, 0, 15_805).sustained).toBe(false);
    }
    // And the one line of the 40 that was under the ceiling (14.3 GB, 87.3%)
    // with 12.1 pages/s and the debt flat is still calm: there was room left.
    expect(atCeiling(12.1, +0.1, 14_300).sustained).toBe(false);
    expect(atCeiling(12.1, +0.1, 14_300).swapPct!).toBeLessThan(SWAP_CEILING_SHARE);
  });

  test("S4: no swap file, an unreadable total and the first samples after a reboot do not vote", () => {
    // Swap turned off: `total = 0.00M` is a real answer, not a division by zero.
    expect(atCeiling(170, -1.7, 0, 0).swapPct).toBeNull();
    expect(atCeiling(170, -1.7, 0, 0).sustained).toBe(false);
    // The line unreadable (off macOS, `sysctl` mute): the rule falls back to the debt.
    expect(atCeiling(170, -1.7, 15_200, null).sustained).toBe(false);
    expect(atCeiling(170, +0.9, 15_200, null).sustained).toBe(true);
    // Just after a reboot: an empty file and nothing read back yet.
    expect(atCeiling(0.1, 0, 0, 0).sustained).toBe(false);
  });

  test("S5: while macOS GROWS the swap file the two terms hand off", () => {
    // Used climbs 15.2 -> 17.0 GB while the total goes 16384 -> 20480: the share
    // drops to 83% (no ceiling) and the debt term is the one that fires, which is
    // why neither term alone is the rule.
    const growing = swapSeries(60, () => ({ swapins: 150, compressorPages: 0, swapUsedMB: 150 }),
      { swapins: 1_000_000, compressorPages: 700_000, swapUsedMB: 15_200 }, 20_480);
    const v = swapVerdict(growing, at(60));
    expect(v.swapPct!).toBeLessThan(SWAP_CEILING_SHARE);
    expect(v.debtGBPerMin!).toBeGreaterThan(DEBT_GB_PER_MIN);
    expect(v.sustained).toBe(true);
  });

  test("S6: the share is read on the NEWEST sample, and survives a window that is not full", () => {
    const short = swapSeries(30, () => ({ swapins: 150, compressorPages: 0, swapUsedMB: 0 }),
      { swapins: 1_000_000, compressorPages: 700_000, swapUsedMB: 15_800 });
    const v = swapVerdict(short, at(30));
    expect(v.sustained).toBe(false);
    expect(v.pagesReadBackPerS).toBeNull();
    // Even with no verdict the share is measured: it is what the `[memsig]` line prints.
    expect(v.swapPct!).toBeCloseTo(0.964, 3);
    expect(swapVerdict([], at(0)).swapPct).toBeNull();
  });
});

describe("createMemSignal", () => {
  test("M6: a probe that hangs is not called again by the next beat", async () => {
    let calls = 0;
    let answer: (v: Omit<MemSample, "at"> | null) => void = () => {};
    const signal = createMemSignal({ measurable: true, now: () => at(0), probe: () => { calls += 1; return new Promise((r) => { answer = r; }); } });
    const first = signal.sample();
    const second = signal.sample();
    expect(calls).toBe(1);
    answer({ availGB: 9, swapins: 1, compressorPages: 1, pageSize: PAGE, swapUsedMB: 1, swapTotalMB: 16_384, load1: 1 });
    await Promise.all([first, second]);
    expect(signal.samples().length).toBe(1);
    const third = signal.sample();
    expect(calls).toBe(2);
    answer(null);
    await third;
  });

  test("a failed or throwing probe pushes nothing, and samples older than 180 s are dropped", async () => {
    let t = at(0);
    let mode: "ok" | "null" | "throw" = "ok";
    const signal = createMemSignal({
      measurable: true, now: () => t,
      probe: async () => {
        if (mode === "throw") throw new Error("fork failed");
        return mode === "null" ? null : { availGB: 9, swapins: 1, compressorPages: 1, pageSize: PAGE, swapUsedMB: 1, swapTotalMB: 16_384, load1: 1 };
      },
    });
    await signal.sample();
    mode = "null"; t += 10_000; await signal.sample();
    mode = "throw"; t += 10_000; await signal.sample();
    expect(signal.samples().length).toBe(1);
    mode = "ok"; t = at(200); await signal.sample();
    expect(signal.samples().map((x) => x.at)).toEqual([at(200)]);
  });
});

describe("parsers and the [memsig] line", () => {
  test("vm_stat swap-ins and compressor, sysctl swap used", () => {
    const vm = parseVmStat([
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                 4109.",
      "Pages speculative:                          7160.",
      "Pages purgeable:                            9464.",
      "File-backed pages:                        354240.",
      "Pages occupied by compressor:             476226.",
      "Swapins:                                 9123456.",
      "Swapouts:                                9876543.",
    ].join("\n"));
    expect(vm.availGB!).toBeCloseTo(6.1, 1);
    expect(vm.swapins).toBe(9_123_456);
    expect(vm.compressorPages).toBe(476_226);
    expect(parseSwapUsedMB("total = 11264.00M  used = 10030.25M  free = 1233.75M  (encrypted)")).toBeCloseTo(10_030.25, 2);
    expect(parseSwapUsedMB("nothing")).toBeNull();
    // The total was in the same line all along and was thrown away (16/09/2026).
    expect(parseSwapTotalMB("total = 16384.00M  used = 15805.31M  free = 578.69M  (encrypted)")).toBeCloseTo(16_384, 2);
    // Swap off: zero is an ANSWER, and `swapVerdict` must not divide by it.
    expect(parseSwapTotalMB("total = 0.00M  used = 0.00M  free = 0.00M")).toBe(0);
    expect(parseSwapTotalMB("nothing")).toBeNull();
  });

  test("one line with every field, and ? where there is no value", () => {
    const line = formatMemorySignalLine({
      at: Date.UTC(2026, 8, 15, 14, 6, 10),
      held: { measurable: true, latestGB: 4.4, heldGB: 3.9, coveredMs: 120_000 },
      swap: { sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, swapPct: 0.9647, coveredMs: 60_000 },
      latest: s(0, { compressorPages: 826_687, swapUsedMB: 10_070, load1: 75.9 }),
      inFlight: 2, checkRuns: 1, heaviestCheckGB: 8.2,
      // The two fields the freeze added (16/09). They are what tells a line
      // read afterwards whether the swap of that minute was measured with agent
      // trees STOPPED: without them the same `swapin/s` describes two different
      // machines, and E0 of the bar could not say what a freeze bought.
      frozenTrees: 1, frozenGB: 2.4,
      // The two fields of 16/09: the share of the swap file, which is the second
      // door's term, and WHO is holding memory outside Topics. Without the first
      // the bar cannot tell a `calm` that is right from the one this PR fixed;
      // without the second a line about a held queue names nobody.
      foreign: [{ name: "Claude", gb: 8.1, procs: 12 }, { name: "next-server", gb: 2.9, procs: 1 }],
    });
    expect(line).toBe("2026-09-15T14:06:10.000Z [memsig] avail=4.4 held2m=3.9 cover=120s swapin/s=33.6 debt/min=+8.8 comprGB=13.5 swapUsedGB=10.1 swapTotalGB=16.4 swapPct=96.5 load1=75.9 swap=sustained inFlight=2 checkRuns=1 heaviestCheckGB=8.2 frozen=1 frozenGB=2.4 altri=Claude:8.1,next-server:2.9");
    const empty = formatMemorySignalLine({
      at: 0, held: { measurable: true, latestGB: null, heldGB: null, coveredMs: 0 },
      swap: { sustained: false, pagesReadBackPerS: null, debtGBPerMin: null, swapPct: null, coveredMs: 0 }, latest: null, inFlight: 0, checkRuns: 0, heaviestCheckGB: null,
    });
    expect(empty).toContain("avail=? held2m=? cover=0s swapin/s=? debt/min=? comprGB=? swapUsedGB=? swapTotalGB=? swapPct=? load1=? swap=calm");
    // A caller that knows nothing about freezes says zero, not `?`: nothing
    // frozen is a MEASUREMENT here, and the bar sums these numbers.
    expect(empty).toEndWith("frozen=0 frozenGB=0.0 altri=-");
  });
});

/**
 * THE DENOMINATOR AND THE SIGN, the two things the ceiling door broke.
 *
 * `swapPct` decides half the verdict and its denominator was never written
 * anywhere: the live server logged `swapUsedGB` alone for 869 lines, so no
 * share in this repo was ever read off a machine - they were all divided by an
 * assumed 16384. And `sustained` no longer implies a growing debt, so every
 * line that hard-coded a `+` in front of it started printing `+-1.9`.
 *
 * @covers KANBAN-75
 */
describe("the terms of the verdict must be readable after the fact", () => {
  const verdict = (over: Partial<SwapVerdict> = {}): SwapVerdict =>
    ({ sustained: true, pagesReadBackPerS: 167.7, debtGBPerMin: -1.9, swapPct: 0.9277, coveredMs: 60_000, ...over });

  test("S6: the swap file TOTAL is in the line, because a share without its denominator cannot be calibrated", () => {
    const line = formatMemorySignalLine({
      at: Date.UTC(2026, 8, 16, 12, 46, 59),
      held: { measurable: true, latestGB: 3.6, heldGB: 3.6, coveredMs: 120_000 },
      swap: verdict({ pagesReadBackPerS: 284, debtGBPerMin: 1.7, swapPct: 17_200 / 17_408 }),
      // The live 12:46:59 reading: 17.2 GB USED, which is more than the 16384 MB
      // the share of every line before it had been divided by.
      latest: s(0, { swapUsedMB: 17_200, swapTotalMB: 17_408 }),
      inFlight: 0, checkRuns: 0, heaviestCheckGB: null,
    });
    expect(line).toContain("swapUsedGB=17.2 swapTotalGB=17.4 swapPct=98.8");
  });

  test("S7: a sustained verdict with a FALLING debt never prints `+-`, and says which term fired", () => {
    expect(signed(-1.9)).toBe("-1.9");
    expect(signed(0)).toBe("+0.0");
    expect(signed(null)).toBe("?");
    // The real 12:22:24 minute: 167.7 pages/s, debt -1.9, file 92.8% full.
    expect(swapSigns(verdict())).toBe("swapins 167.7/s, memory debt -1.9 GB/min, swap file 92.8% full");
    expect(swapSigns(verdict())).not.toContain("+-");
    // Italian, for the card: with the debt falling the reason is the CEILING,
    // and a note that says "debito +-1.9" names neither term.
    expect(swapReasonIt(verdict())).toBe("il Mac ha il file di swap pieno al 92.8% e rilegge 167.7 pagine/s dal disco (debito -1.9 GB/min)");
    // With the debt growing the old sentence is still the true one.
    expect(swapReasonIt(verdict({ debtGBPerMin: 8.8, pagesReadBackPerS: 33.6 })))
      .toBe("il Mac è in swap da un minuto (33.6 pagine/s rilette dal disco, debito di memoria +8.8 GB/min)");
    for (const v of [verdict(), verdict({ debtGBPerMin: 8.8 }), verdict({ debtGBPerMin: null, swapPct: null })]) {
      expect(swapSigns(v) + swapReasonIt(v)).not.toContain("+-");
    }
  });
});

/**
 * A DEBT IN FREE FALL AT THE CEILING IS NOT RECOVERY, and this pins the
 * decision so that nobody has to re-derive it from the log.
 *
 * The obvious narrowing - let the ceiling vote only while the debt is inside a
 * narrow band - was tried against the live lines and REFUSED: the two minutes
 * that read most like recovery, 12:22 (-1.7 GB/min at 167.7 pages/s) and 12:48
 * (-4.1 at 134.6), are each wedged between minutes the AND ALONE already called
 * sustained (12:21 +0.7 at 170.1/s, 12:46 +1.7 at 284.0/s, 12:49 +0.8 at
 * 171.7/s). A compressor dropping 4.5 GB in one minute there is a process dying
 * under the pressure, not the pressure lifting - and the band would also throw
 * away the very line this door was written for.
 *
 * @covers KANBAN-75
 */
describe("swapVerdict: at the ceiling a falling debt does not veto, below it nothing changes", () => {
  /** Two minutes at the same rate: the ceiling door wants the window before it too. */
  const minute = (pagesPerS: number, debtGBPerMin: number, usedMB: number, totalMB: number | null = 16_384, heldPagesPerS = pagesPerS) =>
    swapVerdict(swapSeries(120, (i) => ({ swapins: (i * 5 <= 60 ? heldPagesPerS : pagesPerS) * 5, compressorPages: perMinGBToPages5s(debtGBPerMin), swapUsedMB: 0 }),
      { swapins: 1_000_000, compressorPages: 700_000, swapUsedMB: usedMB }, totalMB), at(120));

  test("S8: 12:48, 134.6 pages/s with the debt at -4.1 and the file 92.8% full, between two sustained minutes", () => {
    const v = minute(134.6, -4.1, 15_200);
    expect(v.debtGBPerMin!).toBeLessThan(-4);
    expect(v.swapPct!).toBeGreaterThanOrEqual(SWAP_CEILING_SHARE);
    expect(v.sustained).toBe(true);
    // The minute before and the minute after, on the debt term alone.
    expect(minute(284, +1.7, 15_200).sustained).toBe(true);
    expect(minute(171.7, +0.8, 15_200).sustained).toBe(true);
  });

  test("S10: an isolated spike at the ceiling is NOT sustained - 12:54, 718 pages/s between two quiet minutes", () => {
    // 16/09 12:54:29 read 718.5 pages/s with 6.6 before and 21.2 after, while the
    // machine gave memory back (swap 16.7 -> 15.4 GB). Persistence is what tells
    // it from 12:22, where the minute before read 170 pages/s.
    const spike = minute(718.5, -0.4, 15_400, 16_384, 6.6);
    expect(spike.pagesReadBackPerS!).toBeGreaterThan(200);
    expect(spike.swapPct!).toBeGreaterThanOrEqual(SWAP_CEILING_SHARE);
    expect(spike.sustained).toBe(false);
    // Same rate, same file, but the minute before was already thrashing: sustained.
    expect(minute(718.5, -0.4, 15_400, 16_384, 170).sustained).toBe(true);
  });

  test("S9: the same shape BELOW the ceiling is still calm - that is M5b, and it is what recovery looks like", () => {
    // 11:23 of 15/09: 65 pages/s, debt falling, 10788 MB of 16384 = 65.8%.
    const v = minute(65, -4.1, 10_788);
    expect(v.swapPct!).toBeLessThan(SWAP_CEILING_SHARE);
    expect(v.sustained).toBe(false);
  });
});

/**
 * THE WINDOW SURVIVES A RESTART (KANBAN-82).
 *
 * With `TOPICS_SERVER_WATCH=1` the server restarts on every save under
 * `server/`, and a list born empty answered `null` for 120 s: every admission
 * and every resume held, on a free machine as on a full one. Measured 28 windows
 * zeroed across 44 restarts in 25.7 h of 16-17/09/2026, about 56 minutes a day
 * of queue stopped for a reason that was not memory.
 *
 * The store is a variable here, which is the point of injecting it: the cut
 * being proved is `MEM_SAMPLE_GAP_MS` against the clock, not a file on a disk.
 */
describe("createMemSignal: the 2-minute window across a restart", () => {
  const memStore = () => {
    let text: string | null = null;
    return { read: () => text, write: (t: string) => { text = t; }, get text() { return text; } };
  };
  /** Thirteen good readings ending at `lastSec`, one every 10 s: a full window. */
  const full = (lastSec: number, gb = 4.8) => readings(lastSec - 120, 10, Array(13).fill(gb));

  test("a three-second restart inherits the window, and the minimum is the inherited one", async () => {
    const store = memStore();
    store.write(JSON.stringify({ v: 1, samples: full(0, 4.8) }));
    // The new process asks three seconds after the last sample was written.
    const now = at(3);
    const signal = createMemSignal({ probe: async () => null, now: () => now, measurable: true, store });
    const held = signal.held();
    expect(held.heldGB).toBe(4.8);
    expect(held.coveredMs).toBeGreaterThanOrEqual(120_000);
  });

  test("the cut on reload is MEM_SAMPLE_GAP_MS: at 30 s the window is inherited, at 31 s it is not", async () => {
    // THE BOUNDARY THE SPEC NAMES, and the only reading that proves WHICH cut
    // fires. A ten-minute pause also answers "I am measuring it", but at 600 s
    // the cut is `KEEP_MS` (180 s) - the sample is gone from the list before
    // the gap is ever consulted, so that case cannot tell the two rules apart.
    // One store, both sides of 30 s, and the long pause on top.
    const store = memStore();
    store.write(JSON.stringify({ v: 1, samples: full(0, 4.8) }));
    expect(createMemSignal({ probe: async () => null, now: () => at(30), measurable: true, store }).held().heldGB).toBe(4.8);
    const far = createMemSignal({ probe: async () => null, now: () => at(31), measurable: true, store });
    expect(far.held().heldGB).toBeNull();
    expect(far.held().latestGB).toBeNull();
    // What the gap cuts is the RUN, not the list: the readings are still here,
    // and the next live sample rebuilds a window from them in 120 s, not 300.
    expect(far.samples()).toHaveLength(13);
    // The spec's own long pause, which `KEEP_MS` empties outright.
    const old = createMemSignal({ probe: async () => null, now: () => at(600), measurable: true, store });
    expect(old.held().heldGB).toBeNull();
    expect(old.samples()).toHaveLength(0);
  });

  test("the rule «I do not start on a single reading» is untouched: one inherited sample is not a window", async () => {
    const store = memStore();
    store.write(JSON.stringify({ v: 1, samples: [s(0, { availGB: 4.8 })] }));
    const signal = createMemSignal({ probe: async () => null, now: () => at(3), measurable: true, store });
    expect(signal.held().heldGB).toBeNull();
    expect(signal.held().latestGB).toBe(4.8);
  });

  test("every sample is written back, so a restart never inherits a stale newest reading", async () => {
    const store = memStore();
    let now = at(0);
    const signal = createMemSignal({
      probe: async () => ({ availGB: 7, swapins: 0, compressorPages: 1, pageSize: PAGE, swapUsedMB: 0, swapTotalMB: 0, load1: 1 }),
      now: () => now,
      measurable: true,
      store,
    });
    await signal.sample();
    now = at(10);
    await signal.sample();
    const written = JSON.parse(store.text!) as { samples: MemSample[] };
    expect(written.samples.map((x) => x.at)).toEqual([at(0), at(10)]);
  });

  test("a corrupt file, a sample dated in the future and an ancient one are dropped, not trusted", async () => {
    // A clock that moved back would otherwise pin the newest run on a sample
    // that never ages; a file that does not parse must cost a warm-up, not a throw.
    const broken = { read: () => "{ not json", write: () => {} };
    expect(createMemSignal({ probe: async () => null, now: () => at(0), measurable: true, store: broken }).samples().length).toBe(0);
    const weird = {
      read: () => JSON.stringify({ v: 1, samples: [s(60, { availGB: 4 }), s(-600, { availGB: 4 }), s(-10, { availGB: 4 })] }),
      write: () => {},
    };
    const signal = createMemSignal({ probe: async () => null, now: () => at(0), measurable: true, store: weird });
    expect(signal.samples().map((x) => x.at)).toEqual([at(-10)]);
  });

  test("no store = the behaviour before KANBAN-82: the window starts empty", () => {
    const signal = createMemSignal({ probe: async () => null, now: () => at(0), measurable: true });
    expect(signal.samples().length).toBe(0);
  });
});

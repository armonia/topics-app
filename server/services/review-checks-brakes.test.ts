/**
 * The brakes of a pre-review round on a loaded machine: the gate semaphore that
 * `CI` used to switch off, the memory floor before a new command, and the
 * shutdown that takes the running trees with it. Real processes, like the
 * timing cases of review-checks.test.ts, with the same stretched windows.
 *
 * @covers KANBAN-15
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slackMs } from "../../tests/helpers/time-slack";
import { freezableRuns, type FreezableRun } from "./budget-governor";
import { runReviewChecks } from "./review-checks";
import { ChecksInterruptedError } from "./checks-gate";
import {
  _resetReleaseSpacing,
  _resetReviewChecksStop,
  _resetSwapBrake,
  createSwapBrake,
  forgetDelivery,
  killCheckTree,
  memoryWaiter,
  releaseDecision,
  stopReviewChecks,
  swapInterruptedDelivery,
  type MemoryFloor,
  type WaitBudget,
} from "./review-checks-brakes";
import { heldMemory, type HeldMemory, type MemSample, type SwapVerdict } from "./mem-signal";
import { _resetCardMemPeaks, recentCardMemPeaksGB } from "../lib/card-memory-peaks";

const CALM: SwapVerdict = { sustained: false, pagesReadBackPerS: 1, debtGBPerMin: 0, swapPct: null, coveredMs: 60_000 };
const SUSTAINED: SwapVerdict = { sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, swapPct: null, coveredMs: 60_000 };
/**
 * THE POSE THE NEW CODE ACTUALLY LIVES IN, and the one no test held before:
 * sustained THROUGH THE CEILING, with the debt FALLING. Verbatim the 12:22:24
 * line of 16/09/2026 - 167.7 pages/s read back, debt -1.9 GB/min, swap file
 * 92.8% full - which under the old AND was called calm and is the very line the
 * second door was written for.
 */
const AT_CEILING: SwapVerdict = { sustained: true, pagesReadBackPerS: 167.7, debtGBPerMin: -1.9, swapPct: 0.9277, coveredMs: 60_000 };
const fullWindow = (gb: number): HeldMemory => ({ measurable: true, latestGB: gb, heldGB: gb, coveredMs: 120_000 });
/** The round's two clocks, one per budget: a fresh round has spent neither. */
const NOTHING_SPENT: Record<WaitBudget, number> = { calmFloor: 0, other: 0 };
const spent = (some: Partial<Record<WaitBudget, number>>): Record<WaitBudget, number> => ({ ...NOTHING_SPENT, ...some });

/** Both sides of a timing case stretched by the same factor: the ratio is the claim. */
const stretched = (ms: number): number => slackMs(ms);
const sleepFor = (ms: number): string => (stretched(ms) / 1000).toFixed(2);

/**
 * WHAT HOLDS A CHECK BACK ON A LOADED MACHINE, measured on real processes.
 *
 * The night of 15/09/2026 had three holes in the same wall: the board's checks
 * ran with `CI=1`, which switched the gate semaphore off, so two unit trees of
 * 11 GB ran side by side; nothing read free memory before starting the next
 * command; and a server reload left the running trees alive as orphans of pid 1
 * while the new server started the same cards' checks again.
 */
describe("checks under load: the semaphore, the memory floor, the shutdown", () => {
  let cwd = "";
  beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "review-checks-load-")); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  const withEnv = async <T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> => {
    const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { return await body(); } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("CI does not switch the semaphore off: two board checks of the same gate run one after the other", async () => {
    // Through the real `slot.ts`, with a private lock directory and no count in
    // the server's env, which is how the production server runs. Without the
    // explicit count `CI=1` makes `slotCount` 0, neither run takes the name
    // lock, and neither reports a queue.
    const slotDir = mkdtempSync(join(tmpdir(), "review-checks-slots-"));
    try {
      const cmd = `${process.execPath} run ${join(import.meta.dir, "../../scripts/slot.ts")} review-checks-probe -- 'sleep ${sleepFor(1500)}'`;
      const [a, b] = await withEnv(
        { TOPICS_GATE_SLOTS: undefined, TOPICS_GATE_SLOT_DIR: slotDir, TOPICS_GATE_HELD: undefined },
        () => Promise.all([
          runReviewChecks([{ name: "probe", cmd }], { cwd, timeoutMs: stretched(20_000) }),
          runReviewChecks([{ name: "probe", cmd }], { cwd, timeoutMs: stretched(20_000) }),
        ]),
      );
      expect(a[0].ok && b[0].ok).toBe(true);
      // One of the two took the lock at once, the other waited for it.
      const queues = [a[0].queuedMs, b[0].queuedMs];
      expect(queues.every((q) => typeof q === "number")).toBe(true);
      expect(Math.max(...(queues as number[]))).toBeGreaterThanOrEqual(1000);
    } finally {
      rmSync(slotDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("an explicit count, 0 included, reaches the command untouched", async () => {
    const runs = await withEnv({ TOPICS_GATE_SLOTS: "0" }, () =>
      runReviewChecks([{ name: "env", cmd: "echo slots=$TOPICS_GATE_SLOTS" }], { cwd }));
    expect(runs[0].tail).toContain("slots=0");
  });

  test("under the memory floor a command waits before starting, and the wait is not its time", async () => {
    // 1.5 s under the floor against a 1 s cap: the command only starts once the
    // memory is back, so the cap (armed at spawn) never sees the wait.
    const releaseAt = Date.now() + stretched(1500);
    const started = Date.now();
    const runs = await runReviewChecks([{ name: "dopo la memoria", cmd: "true" }], {
      cwd,
      timeoutMs: stretched(1000),
      memoryFloor: { held: () => fullWindow(Date.now() < releaseAt ? 2 : 20), swap: () => CALM, floorGB: 6, pollMs: 25 },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(stretched(1500));
    expect(runs[0].ok).toBe(true);
    expect(runs[0].timedOut).toBe(false);
  }, 20_000);

  test("the memory wait fails open: the round waits its limit ONCE, then every command runs", async () => {
    const started = Date.now();
    const runs = await runReviewChecks(
      [{ name: "a", cmd: "true" }, { name: "b", cmd: "true" }, { name: "c", cmd: "true" }],
      { cwd, memoryFloor: { held: () => fullWindow(1), swap: () => CALM, floorGB: 6, maxWaitMs: stretched(800), pollMs: 25 } },
    );
    expect(runs.map((r) => r.ok)).toEqual([true, true, true]);
    // One limit for the round (0.8 s), not one per command (2.4 s). Both sides
    // stretched by the same factor, so the ratio is what is measured.
    expect(Date.now() - started).toBeLessThan(stretched(2000));
  }, 20_000);

  test("a server shutdown kills the running tree, starts nothing after it, and records no verdict", async () => {
    const marker = join(cwd, "ran-after-shutdown");
    const started = join(cwd, "shutdown-probe-started");
    const round = runReviewChecks(
      // 120 s, three times the widest window below (10 s x the slack cap of 4):
      // a round that waited for the command instead of killing it cannot pass.
      // The `( &)` grandchild is reparented to pid 1 before any snapshot of the
      // descendants, and holds the round's pipe: only the process group reaches it.
      [{ name: "lungo", cmd: `(sleep 120 &); touch ${started}; sleep 120` }, { name: "dopo", cmd: `touch ${marker}` }],
      { cwd, taskId: "shutdown-probe", timeoutMs: 300_000 },
    );
    const outcome = round.then(() => "resolved", (e: unknown) => e);
    let run = freezableRuns().find((r) => r.taskId === "shutdown-probe");
    for (let i = 0; !(run && existsSync(started)) && i < 400; i++) {
      await Bun.sleep(25);
      run = freezableRuns().find((r) => r.taskId === "shutdown-probe");
    }
    expect(run).toBeDefined();
    expect(existsSync(started)).toBe(true);
    const stoppedAt = Date.now();
    try {
      expect(await stopReviewChecks()).toBe(1);
      expect(await outcome).toBeInstanceOf(ChecksInterruptedError);
    } finally {
      _resetReviewChecksStop();
    }
    // Killed, not waited for: `sleep 120` did not run to its end.
    expect(Date.now() - stoppedAt).toBeLessThan(stretched(10_000));
    expect(() => process.kill(run!.pid, 0)).toThrow();
    expect(existsSync(marker)).toBe(false);
  }, 150_000);

  test("a timed-out command takes the grandchild its shell orphaned with it, and the round returns", async () => {
    const started = join(cwd, "timeout-probe-started");
    const at = Date.now();
    const runs = await runReviewChecks(
      [{ name: "orfano", cmd: `(sleep 120 &); touch ${started}; sleep 120` }],
      { cwd, timeoutMs: stretched(1500) },
    );
    expect(existsSync(started)).toBe(true);
    expect(runs[0].timedOut).toBe(true);
    // Not held by the orphan's pipe until its 120 s end.
    expect(Date.now() - at).toBeLessThan(stretched(10_000));
  }, 150_000);

  test("the shutdown, the route and the governor are wired: gracefulShutdown stops the checks after the thaw, the route passes the floor, the governor reads the CPU only", () => {
    const server = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
    // The governor's reading is `governorReading`, the CPU only (low memory
    // freezing nothing is tested on it in shared/machine-budget.test.ts): no
    // memory term comes back through the call site either.
    const governor = server.slice(server.indexOf("const budgetGovernor = createBudgetGovernor("));
    const read = governor.slice(0, governor.indexOf("signalTree:"));
    expect(read).toContain("return governorReading(sample, share);");
    expect(read).not.toContain("DISPATCH_MEM_FLOOR");
    const body = server.slice(server.indexOf("async function gracefulShutdown("));
    const end = body.indexOf("process.exit(0)");
    expect(end).toBeGreaterThan(0);
    const teardown = body.slice(0, end);
    const thaw = teardown.indexOf("await budgetGovernor.thawAll()");
    const stop = teardown.indexOf("await stopReviewChecks()");
    expect(thaw).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(thaw);
    // The production server hands the real probe to the route, and the route
    // hands it to the round. The route tests pass none, so they never wait.
    expect(server).toMatch(/checksMemoryFloor:\s*\{\s*held:\s*\(\)\s*=>\s*memSignal\.held\(\),\s*swap:\s*\(\)\s*=>\s*memSignal\.swap\(\),\s*floorGB:\s*DISPATCH_MEM_FLOOR_NATIVE_GB\s*\}/);
    // The brake reads the verdict of the sample just taken on the same beat.
    const beat = server.slice(server.indexOf("const dispatchTimer = setInterval("));
    expect(beat.indexOf("memSignal.sample()")).toBeGreaterThan(-1);
    // The third argument is the swap freezer's last action: the two levers that
    // act under sustained swap share one 120 s window (`shared/swap-freeze.ts`).
    expect(beat.indexOf("swapBrake.tick(memSignal.swap(), freezableRuns(), swapFreezer.lastActionAt())"))
      .toBeGreaterThan(beat.indexOf("memSignal.sample()"));
    // The brake kills a check the way the round's own kill does: with its process group.
    expect(server).toMatch(/createSwapBrake\(\{\s*kill:\s*killCheckTree,/);
    const route = readFileSync(join(import.meta.dir, "../routes/tasks.ts"), "utf8");
    expect(route).toContain("memoryFloor: opts?.checksMemoryFloor,");
  });
});

/** A fake clock whose sleepers wake only when the test steps it: several waiters share one time. */
function steppedClock(start = 1_760_000_000_000) {
  let t = start;
  let sleepers: Array<() => void> = [];
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    now: () => t,
    sleep: () => new Promise<void>((r) => { sleepers.push(r); }),
    async step(ms: number) {
      t += ms;
      const due = sleepers;
      sleepers = [];
      for (const wake of due) wake();
      await settle();
    },
    settle,
  };
}

/** A window built from readings every 10 s, `reading(sec)` seconds after `start`. */
function windowOver(clock: { now: () => number }, start: number, reading: (sec: number) => number): () => HeldMemory {
  return () => {
    const samples: MemSample[] = [];
    for (let at = start; at <= clock.now(); at += 10_000) {
      samples.push({ at, availGB: reading((at - start) / 1000), swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, swapTotalMB: 16_384, load1: 1 });
    }
    return heldMemory(samples, clock.now(), true);
  };
}

describe("the checks waiter: the window, the swap, one release per window", () => {
  let warn: ReturnType<typeof spyOn>;
  const lines = (): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));
  beforeAll(() => { warn = spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { _resetReleaseSpacing(); warn.mockClear(); });
  afterAll(() => { warn.mockRestore(); });

  /** Steps the clock by `pollMs` until `done()` or `maxMs`; returns the elapsed seconds. */
  async function runUntil(clock: ReturnType<typeof steppedClock>, done: () => boolean, maxMs: number, pollMs = 5_000): Promise<number> {
    const from = clock.now();
    await clock.settle();
    while (!done() && clock.now() - from < maxMs) await clock.step(pollMs);
    return (clock.now() - from) / 1000;
  }

  test("the floor holds calm AND swapping, and it is the BUDGET that changes: 5.9 waits on room either way, 11 sustained waits on swap, an empty window waits, off macOS nothing waits", () => {
    const base = { floorGB: 6, otherRoundRelease: null, now: 0, spent: NOTHING_SPENT, maxWaitMs: 30 * 60_000 };
    // The reading that held every round of 16-17/09 and never came back: 42 of
    // the 44 `[memsig]` samples of card c4f53a85's round were under 6 GB, 40 of
    // them with `swap=calm`. It still holds - what the calm verdict buys is a
    // budget of three minutes instead of thirty.
    expect(releaseDecision({ ...base, swap: CALM, held: fullWindow(5.9) }).wait).toBe("room");
    expect(releaseDecision({ ...base, swap: SUSTAINED, held: fullWindow(5.9) }).wait).toBe("swap");
    expect(releaseDecision({ ...base, swap: CALM, held: fullWindow(6) }).release).toBe(true);
    expect(releaseDecision({ ...base, swap: SUSTAINED, held: fullWindow(11) }).wait).toBe("swap");
    expect(releaseDecision({ ...base, swap: CALM, held: { measurable: true, latestGB: 20, heldGB: null, coveredMs: 40_000 } }).wait).toBe("measuring");
    expect(releaseDecision({ ...base, held: { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 }, swap: SUSTAINED }).release).toBe(true);
    // The two budgets, at the second that separates them.
    const calmUnder = { ...base, swap: CALM, held: fullWindow(5.2) };
    expect(releaseDecision({ ...calmUnder, spent: spent({ calmFloor: 3 * 60_000 - 1 }) }).release).toBe(false);
    expect(releaseDecision({ ...calmUnder, spent: spent({ calmFloor: 3 * 60_000 }) }))
      .toEqual({ release: true, wait: null, anyway: true, heldBy: "room", budgetMs: 3 * 60_000, spentMs: 3 * 60_000 });
    const swappingUnder = { ...base, swap: SUSTAINED, held: fullWindow(5.2) };
    expect(releaseDecision({ ...swappingUnder, spent: spent({ other: 3 * 60_000 }) }).release).toBe(false);
    expect(releaseDecision({ ...swappingUnder, spent: spent({ other: 30 * 60_000 }) }))
      .toEqual({ release: true, wait: null, anyway: true, heldBy: "swap", budgetMs: 30 * 60_000, spentMs: 30 * 60_000 });
    // The spacing and the turn keep the long budget on a calm Mac: they resolve
    // by themselves inside 120 s, and cutting them short is the 15/09 herd again.
    const spaced = { ...base, swap: CALM, held: fullWindow(11), otherRoundRelease: { at: 0, running: true }, now: 60_000 };
    expect(releaseDecision({ ...spaced, spent: spent({ other: 3 * 60_000 }) }))
      .toEqual({ release: false, wait: "spacing", anyway: false, heldBy: "spacing", budgetMs: 30 * 60_000, spentMs: 3 * 60_000 });
  });

  /**
   * ONE CLOCK EACH: THE TIME SPENT WAITING FOR THE SWAP IS NOT TIME SPENT
   * WAITING FOR THE FLOOR. With the two budgets pooled in one number, a round
   * that had waited ten minutes in sustained swap was released the instant the
   * verdict turned calm, its reading unchanged and still under the floor - an
   * episode of thrash bought the exemption from the floor for the whole round.
   */
  test("the swap clock does not pay the floor's valve, nor the other way round", () => {
    const under = { floorGB: 6, otherRoundRelease: null, now: 0, maxWaitMs: 30 * 60_000, held: fullWindow(5.2) };
    // Ten minutes spent on the swap, the verdict turns calm, the memory has not
    // moved: the floor's own three minutes have not started.
    const turnedCalm = releaseDecision({ ...under, swap: CALM, spent: spent({ other: 10 * 60_000 }) });
    expect(turnedCalm.release).toBe(false);
    expect(turnedCalm).toEqual({ release: false, wait: "room", anyway: false, heldBy: "room", budgetMs: 3 * 60_000, spentMs: 0 });
    // Three of those minutes under the floor, and it goes.
    expect(releaseDecision({ ...under, swap: CALM, spent: { calmFloor: 3 * 60_000, other: 10 * 60_000 } }).release).toBe(true);
    // The other way round too: a round that spent the calm valve does not carry
    // it over to the swap, which keeps its own thirty minutes.
    const thenSwapping = releaseDecision({ ...under, swap: SUSTAINED, spent: spent({ calmFloor: 3 * 60_000 }) });
    expect(thenSwapping).toEqual({ release: false, wait: "swap", anyway: false, heldBy: "swap", budgetMs: 30 * 60_000, spentMs: 0 });
  });

  /**
   * THE FLOOR IS OBSERVABLE AGAIN, which is the whole point of putting it back.
   * The rule it replaces read the floor only inside the sustained branch, which
   * returns before it: over 160 states `floorGB` 0 and 1000 decided the same in
   * every one. Here they must differ, and they do - on a calm Mac and on a
   * swapping one alike, in the decision and not only in the log line.
   */
  test("floorGB 0 against floorGB 1000: nine states START or WAIT differently, and they are the calm ones", () => {
    const base = { otherRoundRelease: null, olderWaiter: false, now: 0, spent: NOTHING_SPENT, maxWaitMs: 30 * 60_000 };
    const readings = [0, 1, 2, 5.2, 5.9, 6, 8, 11, 20, null];
    const differ = { calm: 0, sustained: 0 };
    for (const [label, swap] of [["calm", CALM], ["sustained", SUSTAINED]] as const) {
      for (const gb of readings) {
        const held: HeldMemory = gb == null
          ? { measurable: true, latestGB: 20, heldGB: null, coveredMs: 40_000 }
          : fullWindow(gb);
        const low = releaseDecision({ ...base, swap, held, floorGB: 0 });
        const high = releaseDecision({ ...base, swap, held, floorGB: 1000 });
        // What is compared is the DECISION, never the label of the log line:
        // the rule this replaces changed the label under sustained swap while
        // holding the round either way, which is how an unobservable floor
        // passed for a live one.
        if (low.release !== high.release) differ[label]++;
      }
    }
    // Every calm reading with a window: started by a floor of 0, held by one of
    // 1000. Under a sustained verdict the swap holds the round whatever the
    // floor says, which is why calm was the only state the floor ever decided.
    expect(differ).toEqual({ calm: 9, sustained: 0 });
  });

  test("W1, the 15/09 deadcode: one reading at 6.0 after 5.2 does not release; 120 s of readings at 6.6 do, and the release is logged", async () => {
    const clock = steppedClock();
    const start = clock.now();
    // 5.2 for two minutes, 6.0 at 130 s (now), then 6.6.
    const held = windowOver(clock, start - 130_000, (sec) => (sec < 130 ? 5.2 : sec === 130 ? 6.0 : 6.6));
    const wait = memoryWaiter({ held, swap: () => CALM, floorGB: 6, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    let released = false;
    void wait("deadcode").then(() => { released = true; });
    await clock.settle();
    expect(released).toBe(false);
    const waited = await runUntil(clock, () => released, 10 * 60_000);
    expect(released).toBe(true);
    // The 6.0 reading is now: the window holds no 5.2 any more 120 s from now,
    // and 120 s is inside the three minutes the calm valve gives the floor.
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThanOrEqual(125);
    expect(lines().some((l) => l.includes('"deadcode" waits: lowest free memory of the last 2 min 5.2 GB'))).toBe(true);
    expect(lines().some((l) => l.includes('"deadcode" starts after'))).toBe(true);
    expect(lines().some((l) => l.includes("starts anyway"))).toBe(false);
  });

  test("T5.2, the 17/09 round: the same 5.2 GB window waits three minutes on a calm Mac and thirty on a swapping one", async () => {
    // Card c4f53a85, 23:41:29Z-00:26Z of 16-17/09/2026: the four local commands
    // spent the round's whole 30-minute budget waiting against 80 s of running,
    // with `[memsig]` reading `swap=calm` in 40 of the 42 samples that were
    // under the floor. That round is this test's calm half.
    for (const swapping of [false, true]) {
      _resetReleaseSpacing();
      warn.mockClear();
      const clock = steppedClock();
      // 5.2 for two minutes: the shape of the readings the floor never cleared.
      const held = windowOver(clock, clock.now() - 130_000, () => 5.2);
      const wait = memoryWaiter({
        held, swap: () => (swapping ? SUSTAINED : CALM),
        floorGB: 6, maxWaitMs: 30 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep,
      });
      let released = false;
      void wait("check:deadcode").then(() => { released = true; });
      await clock.settle();
      expect(released).toBe(false);
      const waited = await runUntil(clock, () => released, 60 * 60_000);
      expect(released).toBe(true);
      expect(waited).toBe(swapping ? 30 * 60 : 3 * 60);
      if (swapping) {
        expect(lines().some((l) => l.includes('"check:deadcode" waits: the Mac is in sustained swap (swapins 33.6/s'))).toBe(true);
        expect(lines().some((l) => l.includes('still in swap after 30 min (round: 30 min of a 30 min budget): "check:deadcode" starts anyway'))).toBe(true);
      } else {
        expect(lines().some((l) => l.includes('"check:deadcode" waits: lowest free memory of the last 2 min 5.2 GB, under the 6 GB floor'))).toBe(true);
        expect(lines().some((l) => l.includes('no room after 3 min (round: 3 min of a 3 min budget): "check:deadcode" starts anyway'))).toBe(true);
      }
    }
  });

  /**
   * AN EPISODE OF THRASH DOES NOT BUY THE ROUND ITS EXEMPTION FROM THE FLOOR.
   * With the two budgets pooled in one `spentMs` this round started the instant
   * the swap verdict turned calm, ten minutes in, with its reading unchanged at
   * 5.2 GB under a 6 GB floor: the floor had held it for zero seconds and the
   * three-minute valve was paid for by the swap. The wait each budget buys is
   * the wait it was waited for.
   */
  test("sustained then calm on the same 5.2 GB: the floor's three minutes start when the swap ends, not before", async () => {
    const clock = steppedClock();
    const t0 = clock.now();
    // The memory never moves; only the verdict does, at ten minutes.
    const held = windowOver(clock, t0 - 130_000, () => 5.2);
    const swap = () => ((clock.now() - t0) / 60_000 < 10 ? SUSTAINED : CALM);
    const wait = memoryWaiter({ held, swap, floorGB: 6, maxWaitMs: 30 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    let released = false;
    void wait("test:unit").then(() => { released = true; });
    const waited = await runUntil(clock, () => released, 60 * 60_000);
    expect(released).toBe(true);
    expect(waited).toBe(13 * 60);
    // Held by the swap first, by the floor after it, and the fail-open line
    // carries the two durations apart: thirteen minutes of wait, three of them
    // against the budget that let it go.
    expect(lines().some((l) => l.includes('"test:unit" waits: the Mac is in sustained swap'))).toBe(true);
    expect(lines().some((l) => l.includes('"test:unit" waits: lowest free memory of the last 2 min 5.2 GB, under the 6 GB floor'))).toBe(true);
    expect(lines().filter((l) => l.includes("starts anyway")))
      .toEqual(['[review-checks] no room after 13 min (round: 3 min of a 3 min budget): "test:unit" starts anyway']);
  });

  /**
   * THE LINE IS THE ONLY TRACE THE ROUND LEAVES - the error log has no
   * timestamp - so its duration must be this command's own wait. It used to
   * print the round's BUDGET there: on 17/09 three commands of card c4f53a85,
   * two of which never waited a poll, all three said "after 30 min".
   */
  test("the fail-open line times THIS command: the two that never waited say 0 s, and name what the round had spent", async () => {
    const clock = steppedClock();
    const wait = memoryWaiter({
      held: () => fullWindow(5.2), swap: () => CALM,
      floorGB: 6, maxWaitMs: 30 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep,
    });
    const t0 = clock.now();
    const at: Record<string, number> = {};
    void (async () => {
      for (const name of ["typecheck", "check:deadcode", "static-rails"]) {
        (await wait(name))();
        at[name] = (clock.now() - t0) / 1000;
      }
    })();
    await runUntil(clock, () => at["static-rails"] !== undefined, 60 * 60_000);
    expect([at.typecheck, at["check:deadcode"], at["static-rails"]]).toEqual([3 * 60, 3 * 60, 3 * 60]);
    expect(lines().filter((l) => l.includes("starts anyway"))).toEqual([
      '[review-checks] no room after 3 min (round: 3 min of a 3 min budget): "typecheck" starts anyway',
      '[review-checks] no room after 0 s (round: 3 min of a 3 min budget): "check:deadcode" starts anyway',
      '[review-checks] no room after 0 s (round: 3 min of a 3 min budget): "static-rails" starts anyway',
    ]);
  });

  test("the valve is per ROUND, not per command: the second command of a round that has spent the budget does not wait at all", async () => {
    // The live log printed the same "no room after 30 min" line for
    // `check:deadcode` and `static-rails` back to back on 17/09: the second one
    // never waited, `spentMs` was already spent by the first.
    const clock = steppedClock();
    const wait = memoryWaiter({
      held: () => fullWindow(5.2), swap: () => SUSTAINED,
      floorGB: 6, maxWaitMs: 10 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep,
    });
    const t0 = clock.now();
    const at: Record<string, number> = {};
    void (async () => {
      (await wait("check:deadcode"))();
      at.deadcode = (clock.now() - t0) / 1000;
      await wait("static-rails");
      at.rails = (clock.now() - t0) / 1000;
    })();
    await runUntil(clock, () => at.rails !== undefined, 60 * 60_000);
    expect(at.deadcode).toBe(10 * 60);
    expect(at.rails).toBe(10 * 60);
    // And the line of the command that never waited names the swap, the state
    // the Mac is actually in, not "no room" read from a reason it never logged
    // - while its duration is its own, which is zero.
    expect(lines().filter((l) => l.includes("starts anyway"))).toEqual([
      '[review-checks] still in swap after 10 min (round: 10 min of a 10 min budget): "check:deadcode" starts anyway',
      '[review-checks] still in swap after 0 s (round: 10 min of a 10 min budget): "static-rails" starts anyway',
    ]);
    expect(lines().some((l) => l.includes("no room"))).toBe(false);
  });

  test("W3: two rounds waiting on a roomy window release one command, and the other goes when it exits or 120 s later", async () => {
    for (const exitsAfterSec of [30, 300]) {
      _resetReleaseSpacing();
      const clock = steppedClock();
      const floor: MemoryFloor = { held: () => fullWindow(11), swap: () => CALM, floorGB: 6, pollMs: 5_000, now: clock.now, sleep: clock.sleep };
      const first = memoryWaiter(floor);
      const second = memoryWaiter(floor);
      const releasedAt: Record<string, number> = {};
      const t0 = clock.now();
      let exitFirst: () => void = () => {};
      void first("test:unit").then((done) => { releasedAt.first = (clock.now() - t0) / 1000; exitFirst = done; });
      await clock.settle();
      void second("lint").then(() => { releasedAt.second = (clock.now() - t0) / 1000; });
      await clock.settle();
      expect(releasedAt.first).toBe(0);
      expect(releasedAt.second).toBeUndefined();
      await runUntil(clock, () => clock.now() - t0 >= exitsAfterSec * 1000, exitsAfterSec * 1000);
      if (exitsAfterSec === 30) {
        exitFirst();
        await runUntil(clock, () => releasedAt.second !== undefined, 60_000);
        expect(releasedAt.second).toBeLessThanOrEqual(35);
      } else {
        expect(releasedAt.second).toBeGreaterThanOrEqual(120);
        expect(releasedAt.second).toBeLessThanOrEqual(125);
      }
      expect(lines().some((l) => l.includes('"lint" waits: "test:unit" of another delivery started'))).toBe(true);
    }
  });

  test("W3, a first round of three commands: the other round goes when the first command exits, and the next command of the first round waits its turn", async () => {
    // The next command of a round asks in the same microtask turn its
    // predecessor exits, before the other round's 5 s poll: without the turn it
    // took the spacing back each time and the other round waited 95 s here.
    for (const secondRunsSec of [40, 300]) {
      _resetReleaseSpacing();
      const clock = steppedClock();
      const floor: MemoryFloor = { held: () => fullWindow(11), swap: () => CALM, floorGB: 6, pollMs: 5_000, now: clock.now, sleep: clock.sleep };
      const first = memoryWaiter(floor);
      const second = memoryWaiter(floor);
      const t0 = clock.now();
      const sec = () => (clock.now() - t0) / 1000;
      const at: Record<string, number> = {};
      const runFor = async (ms: number) => { const until = clock.now() + ms; while (clock.now() < until) await clock.sleep(); };
      void (async () => {
        for (const name of ["typecheck", "lint", "deadcode"]) {
          const exited = await first(name);
          at[name] = sec();
          await runFor(30_000);
          exited();
        }
      })();
      await clock.settle();
      void (async () => {
        const exited = await second("static-rails");
        at.second = sec();
        await runFor(secondRunsSec * 1000);
        exited();
        at.secondExit = sec();
      })();
      await runUntil(clock, () => at.lint !== undefined && at.second !== undefined, 20 * 60_000);
      expect(at.typecheck).toBe(0);
      expect(at.second).toBeGreaterThanOrEqual(30);
      expect(at.second).toBeLessThanOrEqual(35);
      if (secondRunsSec === 40) {
        expect(at.lint).toBeGreaterThanOrEqual(at.secondExit);
        expect(at.lint).toBeLessThanOrEqual(at.secondExit + 5);
      } else {
        expect(at.secondExit).toBeUndefined();
        expect(at.lint).toBeGreaterThanOrEqual(at.second + 120);
        expect(at.lint).toBeLessThanOrEqual(at.second + 125);
      }
      expect(lines().some((l) => l.includes('"lint" waits: another delivery has been waiting longer'))).toBe(true);
    }
  });

  test("a round's own next command is not spaced from its predecessor, which has exited", async () => {
    const clock = steppedClock();
    const wait = memoryWaiter({ held: () => fullWindow(11), swap: () => CALM, floorGB: 6, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    const t0 = clock.now();
    (await wait("typecheck"))();
    await wait("lint");
    expect(clock.now()).toBe(t0);
  });

  test("W4b: swap that never ends does NOT hold a round for ever - the budget is spent and it starts", async () => {
    // The invariant that justified "no fail-open on swap" was that a sustained
    // verdict implies a debt growing by 0.5 GB/min, which no machine holds for
    // long. The ceiling door removes it: this Mac reads over 90% of its swap
    // file in 566 of the 874 `[memsig]` lines of 15-16/09, and the longest
    // unbroken sustained episode goes from 4 minutes to 19. A round that never
    // starts records no verdict at all and the delivery just goes round again.
    const clock = steppedClock();
    const wait = memoryWaiter({ held: () => fullWindow(11), swap: () => AT_CEILING, floorGB: 6, maxWaitMs: 5 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    let released = false;
    void wait("test:unit").then(() => { released = true; });
    const waited = await runUntil(clock, () => released, 60 * 60_000);
    expect(released).toBe(true);
    expect(waited).toBe(5 * 60);
    expect(lines().some((l) => l.includes('still in swap after 5 min (round: 5 min of a 5 min budget): "test:unit" starts anyway'))).toBe(true);
    // And the line that explained the wait carries the sign and the share.
    expect(lines().some((l) => l.includes('"test:unit" waits: the Mac is in sustained swap (swapins 167.7/s, memory debt -1.9 GB/min, swap file 92.8% full)'))).toBe(true);
    expect(lines().some((l) => l.includes("+-"))).toBe(false);
  });

  test("W4c: the budget is spent whatever holds the round, and a fresh round still waits", () => {
    const base = { held: fullWindow(11), swap: AT_CEILING, floorGB: 6, otherRoundRelease: null, now: 0, maxWaitMs: 30 * 60_000 };
    expect(releaseDecision({ ...base, spent: NOTHING_SPENT }))
      .toEqual({ release: false, wait: "swap", anyway: false, heldBy: "swap", budgetMs: 30 * 60_000, spentMs: 0 });
    expect(releaseDecision({ ...base, spent: spent({ other: 30 * 60_000 }) }))
      .toEqual({ release: true, wait: null, anyway: true, heldBy: "swap", budgetMs: 30 * 60_000, spentMs: 30 * 60_000 });
    // Not a blanket fail-open: one second short of the budget it still waits.
    expect(releaseDecision({ ...base, spent: spent({ other: 30 * 60_000 - 1 }) }).wait).toBe("swap");
  });

  test("W4: sustained swap beats the fail-open on room: nothing starts while it lasts, and it is the swap that ends it", async () => {
    // A round restarted after a swap interruption must not start straight back
    // into the thrash that is still under way: the room has been over the floor
    // the whole time here and the budget (20 min) is nowhere near spent - what
    // holds the round for nine minutes is the swap, and only the swap.
    const clock = steppedClock();
    const t0 = clock.now();
    const swap = () => ((clock.now() - t0) / 60_000 < 9 ? SUSTAINED : CALM);
    const wait = memoryWaiter({ held: () => fullWindow(11), swap, floorGB: 6, maxWaitMs: 20 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    let released = false;
    void wait("test:unit").then(() => { released = true; });
    const waited = await runUntil(clock, () => released, 30 * 60_000);
    expect(waited).toBe(9 * 60);
    expect(lines().some((l) => l.includes("waits: the Mac is in sustained swap (swapins 33.6/s, memory debt +8.8 GB/min, swap file ? full)"))).toBe(true);
    expect(lines().some((l) => l.includes("starts anyway"))).toBe(false);
  });

  test("W5, restart after an interruption: the thrash readings keep the first command waiting 120 s after the last of them", async () => {
    const clock = steppedClock();
    const start = clock.now() - 120_000;
    // Two minutes at 4.0 (the kill came at the end of them), then 14.0.
    const held = windowOver(clock, start, (sec) => (sec < 120 ? 4.0 : 14.0));
    const wait = memoryWaiter({ held, swap: () => CALM, floorGB: 6, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    let released = false;
    void wait("test:unit").then(() => { released = true; });
    const waited = await runUntil(clock, () => released, 10 * 60_000);
    // The last 4.0 reading is 10 s before now; the first sample of a clean
    // window is the 14.0 of now, so the release comes 120 s from now - inside
    // the three minutes the calm valve allows, so the window releases it and
    // not the budget.
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThanOrEqual(125);
    expect(lines().some((l) => l.includes('"test:unit" waits: lowest free memory of the last 2 min 4.0 GB, under the 6 GB floor'))).toBe(true);
    expect(lines().some((l) => l.includes("starts anyway"))).toBe(false);
  });
});

describe("the swap brake: the youngest heavy round, 1 per 120 s, 2 per delivery, never red", () => {
  afterEach(() => { _resetSwapBrake(); });
  const GB = 1e9 / 1024;
  const t0 = 1_760_000_000_000;
  const runOf = (name: string, taskId: string, roundMin: number, gb: number, commit = "c1"): FreezableRun =>
    ({ id: `${taskId}:${name}`, pid: 1000 + roundMin, name, taskId, startedAt: t0 + roundMin * 60_000, roundStartedAt: t0 + roundMin * 60_000, commit, treeKB: gb * GB });

  function brakeAt() {
    let t = t0 + 10 * 60_000;
    const killed: number[] = [];
    const notes: Array<[string, string]> = [];
    const logs: string[] = [];
    const brake = createSwapBrake({
      kill: async (pid) => { killed.push(pid); },
      note: (taskId, text) => notes.push([taskId, text]),
      log: (l) => logs.push(l),
      now: () => t,
    });
    return { brake, killed, notes, logs, advance: (sec: number) => { t += sec * 1000; } };
  }

  test("S1: under sustained swap the youngest round holding >= 1 GB is killed, with a card note and a log line", () => {
    const b = brakeAt();
    const a = runOf("test:unit", "aaaaaaaa-1", 0, 8);
    const bb = runOf("test:unit", "bbbbbbbb-2", 3, 2);
    const c = runOf("typecheck", "cccccccc-3", 5, 0.4);
    b.brake.tick(SUSTAINED, [a, bb, c]);
    expect(b.killed).toEqual([bb.pid]);
    expect(b.notes).toHaveLength(1);
    expect(b.notes[0]![0]).toBe("bbbbbbbb-2");
    expect(b.notes[0]![1]).toContain("Check interrotti, non rossi");
    expect(b.notes[0]![1]).toContain("Interruzione 1 di 2");
    expect(b.logs.some((l) => l.startsWith('[checks-swap] interrupted "test:unit" of bbbbbbbb'))).toBe(true);
    expect(swapInterruptedDelivery("bbbbbbbb-2", "c1")).toBe(true);
  });

  test("S1b: interrupted AT THE CEILING, the note and the log name the term that fired and not a `+-`", () => {
    const b = brakeAt();
    const run = runOf("test:unit", "bbbbbbbb-2", 3, 4);
    b.brake.tick(AT_CEILING, [run]);
    const note = b.notes[0]![1];
    const log = b.logs.find((l) => l.startsWith("[checks-swap] interrupted"))!;
    expect(note).not.toContain("+-");
    expect(log).not.toContain("+-");
    // With the debt falling the reason is the full file, and the note says so.
    expect(note).toContain("il Mac ha il file di swap pieno al 92.8% e rilegge 167.7 pagine/s dal disco (debito -1.9 GB/min)");
    expect(log).toContain("swapins 167.7/s, memory debt -1.9 GB/min, swap file 92.8% full");
  });

  /**
   * The freezer stops an agent's heaviest background command on the same 60 s
   * window this brake reads. With a clock each, the second lever would act ten
   * seconds after the first and then read the first one's effect as its own.
   *
   * @covers KANBAN-85
   */
  test("S2b: a freeze by the other lever closes this brake's window too, and the outcome says what happened", () => {
    const b = brakeAt();
    const a = runOf("test:unit", "aaaaaaaa-1", 0, 8);
    // The freezer stamped its own action on this beat: the brake's clock reads
    // the same instant (`brakeAt` starts ten minutes after t0).
    const freezeAt = t0 + 10 * 60_000;
    const held = b.brake.tick(SUSTAINED, [a], freezeAt);
    expect(held, "the other lever acted just now").toEqual({ interrupted: false, skipped: "spacing" });
    expect(b.killed).toEqual([]);
    b.advance(121);
    const acted = b.brake.tick(SUSTAINED, [a], freezeAt);
    expect(acted).toEqual({ interrupted: true, skipped: null });
    expect(b.killed).toEqual([a.pid]);
  });

  test("S2: spacing, nothing again for 120 s", () => {
    const b = brakeAt();
    const a = runOf("test:unit", "aaaaaaaa-1", 0, 8);
    const bb = runOf("test:unit", "bbbbbbbb-2", 3, 2);
    b.brake.tick(SUSTAINED, [a, bb]);
    b.advance(60);
    b.brake.tick(SUSTAINED, [a]);
    expect(b.killed).toEqual([bb.pid]);
    b.advance(61);
    b.brake.tick(SUSTAINED, [a]);
    expect(b.killed).toEqual([bb.pid, a.pid]);
  });

  test("S3: two per delivery, then it runs to the end; a new commit counts again, and a verdict forgets", () => {
    const b = brakeAt();
    const run = runOf("test:unit", "bbbbbbbb-2", 3, 4);
    b.brake.tick(SUSTAINED, [run]);
    b.advance(121);
    b.brake.tick(SUSTAINED, [run]); // the restarted round, same commit
    b.advance(121);
    b.brake.tick(SUSTAINED, [run]);
    b.advance(121);
    b.brake.tick(SUSTAINED, [run]);
    expect(b.killed).toHaveLength(2);
    expect(b.logs.filter((l) => l.includes("it runs to the end"))).toHaveLength(1);
    b.advance(121);
    b.brake.tick(SUSTAINED, [runOf("test:unit", "bbbbbbbb-2", 20, 4, "c2")]);
    expect(b.killed).toHaveLength(3);
    forgetDelivery("bbbbbbbb-2");
    expect(swapInterruptedDelivery("bbbbbbbb-2", "c2")).toBe(false);
  });

  test("S4: no run >= 1 GB kills nothing and says so once per episode; calm swap kills nothing and says nothing", () => {
    const b = brakeAt();
    const small = runOf("typecheck", "cccccccc-3", 5, 0.46);
    b.brake.tick(CALM, [runOf("test:unit", "aaaaaaaa-1", 0, 8)]);
    expect(b.killed).toHaveLength(0);
    expect(b.logs).toHaveLength(0);
    b.brake.tick(SUSTAINED, [small]);
    b.advance(10);
    b.brake.tick(SUSTAINED, [small]);
    expect(b.killed).toHaveLength(0);
    expect(b.logs.filter((l) => l.includes("nothing to interrupt"))).toHaveLength(1);
    b.advance(10);
    b.brake.tick(CALM, []);
    expect(b.logs.at(-1)).toContain("swap no longer sustained after 20 s");
  });

  test("S5, end to end on a real process: the killed round rejects as interrupted for swap, the next command never starts, no peak is recorded", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-checks-swap-"));
    const marker = join(cwd, "ran-after-swap-kill");
    _resetCardMemPeaks();
    try {
      const round = runReviewChecks(
        [{ name: "lungo", cmd: "sleep 120" }, { name: "dopo", cmd: `touch ${marker}` }],
        { cwd, taskId: "swap-probe", commit: "c1", timeoutMs: 300_000, treeSampleMs: 50 },
      );
      const outcome = round.then(() => "resolved", (e: unknown) => e);
      let run = freezableRuns().find((r) => r.taskId === "swap-probe");
      for (let i = 0; !run && i < 200; i++) {
        await Bun.sleep(25);
        run = freezableRuns().find((r) => r.taskId === "swap-probe");
      }
      expect(run).toBeDefined();
      expect(run!.commit).toBe("c1");
      expect(typeof run!.roundStartedAt).toBe("number");
      run!.treeKB = 8 * GB;
      const logs: string[] = [];
      createSwapBrake({ kill: killCheckTree, note: () => {}, log: (l) => logs.push(l) }).tick(SUSTAINED, [run!]);
      const killedAt = Date.now();
      const err = await outcome;
      expect(err).toBeInstanceOf(ChecksInterruptedError);
      expect((err as ChecksInterruptedError).reason).toBe("swap");
      expect(Date.now() - killedAt).toBeLessThan(stretched(10_000));
      expect(() => process.kill(run!.pid, 0)).toThrow();
      expect(existsSync(marker)).toBe(false);
      expect(recentCardMemPeaksGB()).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});

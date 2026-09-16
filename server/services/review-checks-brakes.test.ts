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
} from "./review-checks-brakes";
import { heldMemory, type HeldMemory, type MemSample, type SwapVerdict } from "./mem-signal";
import { _resetCardMemPeaks, recentCardMemPeaksGB } from "../lib/card-memory-peaks";

const CALM: SwapVerdict = { sustained: false, pagesReadBackPerS: 1, debtGBPerMin: 0, coveredMs: 60_000 };
const SUSTAINED: SwapVerdict = { sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, coveredMs: 60_000 };
const fullWindow = (gb: number): HeldMemory => ({ measurable: true, latestGB: gb, heldGB: gb, coveredMs: 120_000 });

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
      samples.push({ at, availGB: reading((at - start) / 1000), swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, load1: 1 });
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

  test("room is the floor alone: 6.0 releases, 5.9 waits, an empty window waits, off macOS nothing waits", () => {
    const base = { swap: CALM, floorGB: 6, otherRoundRelease: null, now: 0, spentMs: 0, maxWaitMs: 1_000 };
    expect(releaseDecision({ ...base, held: fullWindow(6) }).release).toBe(true);
    expect(releaseDecision({ ...base, held: fullWindow(5.9) }).wait).toBe("room");
    expect(releaseDecision({ ...base, held: { measurable: true, latestGB: 20, heldGB: null, coveredMs: 40_000 } }).wait).toBe("measuring");
    expect(releaseDecision({ ...base, held: { measurable: false, latestGB: null, heldGB: null, coveredMs: 0 }, swap: SUSTAINED }).release).toBe(true);
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
    // The 6.0 reading is now: the window holds no 5.2 any more 120 s from now.
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThanOrEqual(125);
    expect(lines().some((l) => l.includes('"deadcode" waits: lowest free memory of the last 2 min 5.2 GB'))).toBe(true);
    expect(lines().some((l) => l.includes('"deadcode" starts after'))).toBe(true);
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

  test("W4: sustained swap beats the fail-open: nothing starts before the swap ends, then it starts anyway", async () => {
    const clock = steppedClock();
    const t0 = clock.now();
    const swap = () => {
      const min = (clock.now() - t0) / 60_000;
      return min >= 4 && min < 9 ? SUSTAINED : CALM;
    };
    const wait = memoryWaiter({ held: () => fullWindow(5), swap, floorGB: 6, maxWaitMs: 5 * 60_000, pollMs: 5_000, now: clock.now, sleep: clock.sleep });
    let released = false;
    void wait("test:unit").then(() => { released = true; });
    const waited = await runUntil(clock, () => released, 20 * 60_000);
    expect(waited).toBe(9 * 60);
    expect(lines().some((l) => l.includes("waits: the Mac is in sustained swap (swapins 33.6/s, memory debt +8.8 GB/min)"))).toBe(true);
    expect(lines().some((l) => l.includes('no room after 5 min: "test:unit" starts anyway, swap not sustained'))).toBe(true);
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
    // window is the 14.0 of now, so the release comes 120 s from now.
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThanOrEqual(125);
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

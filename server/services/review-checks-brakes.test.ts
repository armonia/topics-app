/**
 * The brakes of a pre-review round on a loaded machine: the gate semaphore that
 * `CI` used to switch off, the memory floor before a new command, and the
 * shutdown that takes the running trees with it. Real processes, like the
 * timing cases of review-checks.test.ts, with the same stretched windows.
 *
 * @covers KANBAN-15
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slackMs } from "../../tests/helpers/time-slack";
import { freezableRuns } from "./budget-governor";
import { runReviewChecks } from "./review-checks";
import { ChecksInterruptedError } from "./checks-gate";
import { _resetReviewChecksStop, stopReviewChecks } from "./review-checks-brakes";

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
      memoryFloor: { read: () => (Date.now() < releaseAt ? 2 : 20), floorGB: 6, pollMs: 25 },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(stretched(1500));
    expect(runs[0].ok).toBe(true);
    expect(runs[0].timedOut).toBe(false);
  }, 20_000);

  test("the memory wait fails open: the round waits its limit ONCE, then every command runs", async () => {
    const started = Date.now();
    const runs = await runReviewChecks(
      [{ name: "a", cmd: "true" }, { name: "b", cmd: "true" }, { name: "c", cmd: "true" }],
      { cwd, memoryFloor: { read: () => 1, floorGB: 6, maxWaitMs: stretched(800), pollMs: 25 } },
    );
    expect(runs.map((r) => r.ok)).toEqual([true, true, true]);
    // One limit for the round (0.8 s), not one per command (2.4 s). Both sides
    // stretched by the same factor, so the ratio is what is measured.
    expect(Date.now() - started).toBeLessThan(stretched(2000));
  }, 20_000);

  test("a server shutdown kills the running tree, starts nothing after it, and records no verdict", async () => {
    const marker = join(cwd, "ran-after-shutdown");
    const round = runReviewChecks(
      // 120 s, three times the widest window below (10 s x the slack cap of 4):
      // a round that waited for the command instead of killing it cannot pass.
      [{ name: "lungo", cmd: "sleep 120" }, { name: "dopo", cmd: `touch ${marker}` }],
      { cwd, taskId: "shutdown-probe", timeoutMs: 300_000 },
    );
    const outcome = round.then(() => "resolved", (e: unknown) => e);
    let run = freezableRuns().find((r) => r.taskId === "shutdown-probe");
    for (let i = 0; !run && i < 200; i++) {
      await Bun.sleep(25);
      run = freezableRuns().find((r) => r.taskId === "shutdown-probe");
    }
    expect(run).toBeDefined();
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
    expect(server).toMatch(/checksMemoryFloor:\s*\{\s*read:\s*\(\)\s*=>\s*availableMemGB\(\),\s*floorGB:\s*DISPATCH_MEM_FLOOR_NATIVE_GB\s*\}/);
    const route = readFileSync(join(import.meta.dir, "../routes/tasks.ts"), "utf8");
    expect(route).toContain("memoryFloor: opts?.checksMemoryFloor,");
  });
});

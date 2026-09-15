/**
 * A DELIVERY THAT WAS ONLY WAITING COMES BACK BY ITSELF AFTER THE RELOAD.
 *
 * On 2026-09-15 a planned reload waited 31 minutes for card cdc9f39b, whose
 * `update_task` was parked on our pre-review checks while those checks were
 * parked in the memory waiter on a swapping Mac. The restart gate no longer
 * waits for such a delivery (`cardTurnsHoldingReload`), and cutting it is only
 * free if the delivery is re-issued afterwards: the agent's turn dies with the
 * process, so nothing else would ever ask again.
 *
 * These are the two waits that were holding the reload back, on both sides of
 * the restart: the memory waiter, and the off-lane poll of the pull request CI
 * (a delivery can sit there for an hour). Both are red before
 * `pending_deliveries`: the row did not exist, the map died with the process,
 * and the card stayed `in_progress` with `checks_state` cleared at boot.
 *
 * The clocks are injected: the memory wait is not measured in real seconds, and
 * a test that slept through one would be measuring the machine it runs on.
 *
 * @covers RGATE-07, KANBAN-15, KANBAN-84
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { freezableRuns } from "../services/budget-governor";
import { _resetReviewChecksStop, _resetSwapBrake, stopReviewChecks } from "../services/review-checks-brakes";
import type { ChecksGate } from "../services/checks-gate";
import { E2E_CI_CHECK, type CheckRun } from "../../shared/board";

describe("a reload that cuts a delivery whose checks were only waiting", () => {
  let db: Database; let broadcasts: unknown[]; let cwd = "";

  beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "delivery-survives-reload-")); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });
  beforeEach(() => { db = freshDb(); broadcasts = []; });
  afterEach(() => { _resetReviewChecksStop(); _resetSwapBrake(); });

  type Extra = Record<string, unknown>;

  /** A card in progress with its summary said, and a server that can be booted again. */
  async function delivery(checks: Array<{ name: string; cmd: string }>, base: Extra) {
    const counts = { realigns: 0 };
    let gate: ChecksGate | null = null;
    // `boot` stands for the process the watcher brings up: same database, same
    // worktree, a brand new router with its own (empty) checks registry.
    const boot = (extra: Extra = {}) => createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => { counts.realigns += 1; return { ok: true, note: null }; },
      onChecksGate: (g: ChecksGate) => { gate = g; },
      ...base, ...extra,
    } as Parameters<typeof createTasksRouter>[2]);
    const router = boot();
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "consegna" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto, guarda demo/" });
    await call(router, "PATCH", `/api/boards/${task.projectId}/settings`, { reviewChecks: checks });
    return {
      id: task.id as string, counts, boot,
      gate: () => gate!,
      deliver: (legMs = 20_000) => call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, {
        status: "review", summary: "riassunto della consegna", legMs,
      }),
      read: async () => (await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json()).task,
      comments: async () => ((await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json())
        .comments as Array<{ content: string }>).map((c) => c.content).join("\n"),
      remembered: () => db.prepare("SELECT task_id, commit_sha FROM pending_deliveries").all() as Array<{ task_id: string; commit_sha: string | null }>,
    };
  }

  async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await cond()) return;
      await Bun.sleep(25);
    }
    throw new Error(`never happened: ${what}`);
  }

  /** Free memory under the floor, on a clock this test owns. */
  function memoryFloor(heldGB: () => number) {
    const clock = { now: 0 };
    return {
      held: () => ({ measurable: true, latestGB: heldGB(), heldGB: heldGB(), coveredMs: 120_000 }),
      swap: () => ({ sustained: false, pagesReadBackPerS: 0, debtGBPerMin: 0, coveredMs: 60_000 }),
      floorGB: 6,
      pollMs: 5_000,
      // The waiter fails open on room after 30 minutes of ITS clock, and its
      // clock is this one: with a real budget the fail-open would race the test
      // and start the command we are proving never starts.
      maxWaitMs: 24 * 60 * 60_000,
      now: () => clock.now,
      sleep: async (ms: number) => { clock.now += ms; await Bun.sleep(1); },
    };
  }

  test("the memory waiter: the round is cut with no command started, and the same delivery is re-issued at boot", async () => {
    const started = join(cwd, `started-${Date.now()}`);
    const d = await delivery([{ name: "bar", cmd: `touch ${started}` }], {
      checksMemoryFloor: memoryFloor(() => 1),
    });
    const leg = d.deliver();
    await until(async () => (await d.read()).checksState === "running", "the round is waiting for memory");
    // The two facts the restart gate reads (`deliveryOnlyWaitsOnChecks`): a live
    // run, and no command of ours spawned for it. That pair is what says "this
    // card holds nothing, cutting it costs nothing".
    expect(d.gate().isRunning(d.id)).toBe(true);
    expect(freezableRuns().some((r) => r.taskId === d.id)).toBe(false);

    // The reload: `gracefulShutdown` stops the rounds, the leg answers "still
    // running", and the process goes away with the agent's turn inside it.
    await stopReviewChecks();
    const resp = (await leg)!;
    expect(resp.status).toBe(202);
    expect((await d.read()).status).toBe("in_progress");
    expect(d.remembered()).toEqual([{ task_id: d.id, commit_sha: "abc1234" }]);
    expect(await Bun.file(started).exists()).toBe(false);

    // The new process: nobody asks again - the agent's `update_task` died with
    // the old one - so the server re-issues the delivery itself.
    _resetReviewChecksStop();
    const next = d.boot({ checksMemoryFloor: memoryFloor(() => 8) });
    await until(async () => (await d.read()).status === "review", "the re-issued delivery reached review");
    expect((await d.read()).checksState).toBe("pass");
    expect(await Bun.file(started).exists()).toBe(true);
    // ONE realign for the whole delivery: the restarted round measures the tree
    // the first one had already merged main into.
    expect(d.counts.realigns).toBe(1);
    // Nothing red, and no attempt burnt: the card never left `in_progress` on
    // its own, and the thread says nothing about a failed delivery.
    const said = await d.comments();
    expect(said).not.toContain("ROSSI");
    expect(said).not.toContain("Riallineamento su main fallito");
    expect(d.remembered()).toEqual([]);
    // The second router is the one that answered: keep the reference alive so
    // the boot re-issue is not attributed to the first.
    expect(typeof next).toBe("function");
  }, 60_000);

  test("the off-lane CI poll: a delivery waiting on the pull request CI holds nothing either, and polls again after the boot", async () => {
    let releaseCi: (() => void) | null = null;
    const ciWait = new Promise<void>((resolve) => { releaseCi = resolve; });
    const calls = { ci: 0 };
    const greenCi = (checks: Array<{ name: string; cmd: string }>): CheckRun[] =>
      checks.map((c) => ({ name: c.name, cmd: c.cmd, ok: true, code: 0, ms: 1, timedOut: false, tail: "verde in CI" }));
    const d = await delivery([{ name: "bar", cmd: "true" }, E2E_CI_CHECK], {
      ciEvidence: async (input: { checks: Array<{ name: string; cmd: string }> }) => {
        calls.ci += 1;
        // The first reader is the one the reload finds: still polling GitHub,
        // holding no CPU here, with its lane already given back.
        if (calls.ci === 1) await ciWait;
        return greenCi(input.checks);
      },
    });

    // A short leg: the round outlives it, which is the whole point of the gate.
    const first = (await d.deliver(500))!;
    expect(first.status).toBe(202);
    await until(() => d.gate().isOffLane(d.id), "the run gave its lane back and waits on the CI");
    expect(freezableRuns().some((r) => r.taskId === d.id)).toBe(false);
    expect(d.remembered()).toEqual([{ task_id: d.id, commit_sha: "abc1234" }]);

    // The reload, with the poll still in flight: nothing is measured, nothing
    // is recorded, and the delivery is the row.
    await stopReviewChecks();
    releaseCi!();
    await until(() => !d.gate().isRunning(d.id), "the interrupted round is gone");
    expect((await d.read()).status).toBe("in_progress");

    _resetReviewChecksStop();
    d.boot();
    await until(async () => (await d.read()).status === "review", "the re-issued delivery reached review");
    expect((await d.read()).checksState).toBe("pass");
    // Polled again, from the new process, on the same commit and with no second
    // realign: the CI evidence is read for the delivery, not for the leg.
    expect(calls.ci).toBe(2);
    expect(d.counts.realigns).toBe(1);
    expect(d.remembered()).toEqual([]);
  }, 60_000);
});

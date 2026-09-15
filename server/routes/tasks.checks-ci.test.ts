/**
 * THE E2E ROW OF A DELIVERY IS READ FROM THE PULL REQUEST CI, NEVER RUN HERE.  @covers KANBAN-15
 *
 * A board that declares `github-ci:e2e` gets its local commands run as before;
 * only when all of them are green does the gate give its lane back and ask the
 * CI evidence reader. The row never reaches `sh`, a local red never reaches
 * GitHub, and anything short of a verdict keeps the card out of review.
 *
 * Its own file: `tasks.test.ts` is past the size gate.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { ChecksInterruptedError, type ChecksGate } from "../services/checks-gate";
import { ciNotMeasured } from "../services/ci-evidence";
import { _resetReviewChecksStop } from "../services/review-checks-brakes";
import { E2E_CI_CHECK, type CheckRun } from "../../shared/board";

type CiReader = (input: { cwd: string; sha: string; taskId: string }) => Promise<CheckRun>;

const greenCi: CheckRun = { name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd, ok: true, code: 0, ms: 5, timedOut: false, tail: "e2e green" };
const redCi: CheckRun = {
  name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd, ok: false, code: 1, ms: 5, timedOut: false,
  tail: "e2e red on the pull request CI: e2e (2)\nlog of e2e (2): gh run view --job 9 --log-failed -R o/r",
};

describe("a delivery on a board that declares the CI e2e row", () => {
  let db: Database; let broadcasts: unknown[];
  const cwd = mkdtempSync(join(tmpdir(), "tasks-checks-ci-"));

  beforeEach(() => { db = freshDb(); broadcasts = []; });
  afterEach(() => { _resetReviewChecksStop(); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  async function deliveryWith(commands: string[], ci: CiReader | null) {
    const calls = { ci: 0 };
    let gate: ChecksGate | null = null;
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      onChecksGate: (g: ChecksGate) => { gate = g; },
      ...(ci ? { ciE2eEvidence: async (input: Parameters<CiReader>[0]) => { calls.ci += 1; return ci(input); } } : {}),
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "consegna" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto, guarda demo/" });
    await call(router, "PATCH", `/api/boards/${task.projectId}/settings`, {
      reviewChecks: commands.map((cmd) => ({ name: cmd, cmd })),
    });
    const deliver = (legMs = 10_000) => call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, {
      status: "review", summary: "riassunto della consegna", legMs,
    });
    const read = async () => (await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json()).task;
    const runs = () => JSON.parse(String((db.prepare("SELECT checks_json FROM tasks WHERE id = ?").get(task.id) as { checks_json: string }).checks_json));
    return { id: task.id as string, deliver, read, runs, calls, gate: () => gate! };
  }

  test("the row runs after the commands, never in a shell, and a green CI enters review", async () => {
    const d = await deliveryWith([E2E_CI_CHECK.cmd, "true"], async () => greenCi);
    const resp = (await d.deliver())!;
    expect(resp.status).toBe(200);
    const task = await d.read();
    expect(task.status).toBe("review");
    expect(task.checksState).toBe("pass");
    const runs = d.runs() as CheckRun[];
    expect(runs.map((r) => r.cmd)).toEqual(["true", E2E_CI_CHECK.cmd]);
    expect(d.calls.ci).toBe(1);
  }, 30_000);

  test("a red local command never asks GitHub", async () => {
    const d = await deliveryWith(["false", E2E_CI_CHECK.cmd], async () => greenCi);
    const resp = (await d.deliver())!;
    expect(resp.status).toBe(409);
    expect(d.calls.ci).toBe(0);
    expect((await d.read()).checksState).toBe("fail");
  }, 30_000);

  test("NOT MEASURED from the CI keeps the card out of review with the reason, not the install advice", async () => {
    const d = await deliveryWith(["true", E2E_CI_CHECK.cmd], async () => ciNotMeasured(E2E_CI_CHECK, "the pull request conflicts with main"));
    const resp = (await d.deliver())!;
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.code).toBe("review_needs_green_checks");
    expect(body.error).toContain("conflicts with main");
    expect(body.error).not.toContain("bun install");
    const task = await d.read();
    expect(task.status).toBe("in_progress");
    expect(task.checksState).toBe("unknown");
  }, 30_000);

  test("a red CI job is a fail that names the job and its log command", async () => {
    const d = await deliveryWith(["true", E2E_CI_CHECK.cmd], async () => redCi);
    const resp = (await d.deliver())!;
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toContain("e2e (2)");
    expect(body.error).toContain("--log-failed");
    expect((await d.read()).checksState).toBe("fail");
  }, 30_000);

  test("a declared row with no reader on the server is unknown, never a pass", async () => {
    const d = await deliveryWith(["true", E2E_CI_CHECK.cmd], null);
    const resp = (await d.deliver())!;
    expect(resp.status).toBe(409);
    const task = await d.read();
    expect(task.checksState).toBe("unknown");
    expect(task.status).toBe("in_progress");
  }, 30_000);

  test("while the CI is pending the run holds no lane and the card reads 1/2", async () => {
    let settle: (run: CheckRun) => void = () => {};
    const d = await deliveryWith(["true", E2E_CI_CHECK.cmd], () => new Promise<CheckRun>((r) => { settle = r; }));
    const first = (await d.deliver(300))!;
    expect(first.status).toBe(202);
    for (let i = 0; i < 200 && d.calls.ci === 0; i++) await Bun.sleep(10);
    expect(d.calls.ci).toBe(1);
    expect(d.gate().runningCount()).toBe(0);
    expect(d.gate().isRunning(d.id)).toBe(true);
    expect((await d.read()).checksProgress).toEqual({ done: 1, total: 2 });
    settle(greenCi);
    const done = (await d.deliver())!;
    expect(done.status).toBe(200);
  }, 30_000);

  test("a shutdown during the CI wait answers still running and records no verdict", async () => {
    const d = await deliveryWith(["true", E2E_CI_CHECK.cmd], async () => { throw new ChecksInterruptedError(); });
    const resp = (await d.deliver())!;
    expect(resp.status).toBe(202);
    const body = await resp.json();
    expect(body.code).toBe("review_checks_running");
    const task = await d.read();
    expect(task.status).toBe("in_progress");
    expect(task.checksState).not.toBe("pass");
    expect(task.checksState).not.toBe("fail");
  }, 30_000);
});

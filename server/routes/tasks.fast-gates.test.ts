/**
 * THE FAST STATIC GUARDS RUN BEFORE THE PULL REQUEST EXISTS.  @covers KANBAN-15
 *
 * A delivery from a checkout that declares `gates:fast` runs it as the first
 * command of the round. A red guard rejects the delivery with the guard's own
 * output and the CI evidence reader (the only door to gh / the PR) is never
 * called; a clean checkout goes on to it as before.
 *
 * The fixture's script is a stand-in for the real list: the wiring is what is
 * measured here, the guards have their own tests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { _resetReviewChecksStop } from "../services/review-checks-brakes";
import { E2E_CI_CHECK, type CheckRun } from "../../shared/board";

const GUARD = `
const fs = require("fs");
const bad = fs.readdirSync("tests").filter((f) => f.endsWith(".test.ts") && !fs.readFileSync("tests/" + f, "utf-8").includes("@covers"));
if (bad.length) { console.log("untraced test: " + bad.join(", ")); process.exit(1); }
`;

describe("a delivery runs the fast static guards before it asks for the CI", () => {
  let db: Database; let broadcasts: unknown[];
  const roots: string[] = [];

  beforeEach(() => { db = freshDb(); broadcasts = []; });
  afterEach(() => { _resetReviewChecksStop(); });
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  function worktree(testBody: string): string {
    const cwd = mkdtempSync(join(tmpdir(), "tasks-fast-gates-"));
    roots.push(cwd);
    mkdirSync(join(cwd, "tests"));
    mkdirSync(join(cwd, "node_modules")); // an installed checkout: no dependency install round
    writeFileSync(join(cwd, "guard.cjs"), GUARD);
    writeFileSync(join(cwd, "tests", "a.test.ts"), testBody);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { "gates:fast": "node guard.cjs" } }));
    return cwd;
  }

  async function deliver(cwd: string) {
    let ciCalls = 0;
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      ciEvidence: async () => {
        ciCalls += 1;
        return [{ name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd, ok: true, code: 0, ms: 1, timedOut: false, tail: "green" } satisfies CheckRun];
      },
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "consegna" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto" });
    await call(router, "PATCH", `/api/boards/${task.projectId}/settings`, {
      reviewChecks: [{ name: "ci", cmd: E2E_CI_CHECK.cmd }],
    });
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, {
      status: "review", summary: "riassunto della consegna", legMs: 20_000,
    }))!;
    const runs = JSON.parse(String((db.prepare("SELECT checks_json FROM tasks WHERE id = ?").get(task.id) as { checks_json: string }).checks_json)) as CheckRun[];
    return { resp, runs, ciCalls: () => ciCalls };
  }

  test("a test without @covers is refused with the guard output and no CI is asked", async () => {
    const d = await deliver(worktree("// nothing declared\n"));
    expect(d.resp.status).toBe(409);
    expect(d.runs.map((r) => r.cmd)).toEqual(["bun run gates:fast"]);
    expect(d.runs[0]!.tail).toContain("untraced test: a.test.ts");
    expect(d.ciCalls()).toBe(0);
  }, 40_000);

  test("a clean checkout passes the guards and goes on to the CI", async () => {
    const d = await deliver(worktree("// @covers KANBAN-15\n"));
    expect(d.resp.status).toBe(200);
    expect(d.runs.map((r) => r.cmd)).toEqual(["bun run gates:fast", E2E_CI_CHECK.cmd]);
    expect(d.ciCalls()).toBe(1);
  }, 40_000);
});

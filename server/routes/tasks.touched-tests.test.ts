/**
 * THE TESTS OF THE TOUCHED FILES RUN IN THE PRE-REVIEW.  @covers KANBAN-15
 *
 * CI runs on Linux only: a test never run on the machine that does the
 * pre-review reached review green and red there. A checkout that declares
 * `test:touched:review` runs it AFTER the CI evidence this board declares is
 * green (a heavy local run is wasted on a diff the CI was about to fail
 * anyway); a red one rejects the delivery with the failing test's name, a
 * green one lets the card into review, and a project without the script is
 * measured as before. The fixture's script stands in for the project's
 * selector: the wiring is what is measured here.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { _resetReviewChecksStop } from "../services/review-checks-brakes";
import { hasTouchedTests } from "../services/review-checks";
import { E2E_CI_CHECK, type CheckRun } from "../../shared/board";

// Writes `ran.marker` on every invocation, so a test can tell the command
// never started from one that started and exited early.
const SELECTOR = `
const fs = require("fs");
fs.writeFileSync("ran.marker", "1");
const bad = fs.readdirSync("tests").filter((f) => fs.readFileSync("tests/" + f, "utf-8").includes("RED"));
if (bad.length) { console.log("(fail) touched test: " + bad.join(", ")); process.exit(1); }
`;

describe("a delivery runs the tests of its touched files", () => {
  let db: Database; let broadcasts: unknown[];
  const roots: string[] = [];

  beforeEach(() => { db = freshDb(); broadcasts = []; });
  afterEach(() => { _resetReviewChecksStop(); });
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  function worktree(testBody: string, declared = true): string {
    const cwd = mkdtempSync(join(tmpdir(), "tasks-touched-tests-"));
    roots.push(cwd);
    mkdirSync(join(cwd, "tests"));
    mkdirSync(join(cwd, "node_modules")); // an installed checkout: no dependency install round
    writeFileSync(join(cwd, "selector.cjs"), SELECTOR);
    writeFileSync(join(cwd, "tests", "a.test.ts"), testBody);
    const scripts: Record<string, string> = declared ? { "test:touched:review": "node selector.cjs" } : {};
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
    return cwd;
  }

  async function deliver(cwd: string, ciOk = true) {
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      ciEvidence: async () => [{
        name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd, ok: ciOk, code: ciOk ? 0 : 1, ms: 1, timedOut: false, tail: ciOk ? "green" : "red",
      } satisfies CheckRun],
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
    return { resp, runs };
  }

  test("a red touched test is refused with the test's name in the reason, only once the CI is green", async () => {
    const d = await deliver(worktree("// RED\n"));
    expect(d.resp.status).toBe(409);
    expect(d.runs.map((r) => r.cmd)).toEqual([E2E_CI_CHECK.cmd, "bun run test:touched:review"]);
    expect(d.runs[1]!.tail).toContain("touched test: a.test.ts");
  }, 40_000);

  test("a green touched test runs after the CI and lets the card into review", async () => {
    const d = await deliver(worktree("// fine\n"));
    expect(d.resp.status).toBe(200);
    expect(d.runs.map((r) => r.cmd)).toEqual([E2E_CI_CHECK.cmd, "bun run test:touched:review"]);
  }, 40_000);

  test("a red CI never starts the touched-tests command at all", async () => {
    const cwd = worktree("// fine\n");
    const d = await deliver(cwd, false);
    expect(d.resp.status).toBe(409);
    expect(d.runs.map((r) => r.cmd)).toEqual([E2E_CI_CHECK.cmd, "bun run test:touched:review"]);
    const touched = d.runs[1]!;
    expect(touched.ok).toBe(false);
    expect(touched.notMeasured).toBe(true);
    expect(touched.tail).toContain("skipped");
    expect(existsSync(join(cwd, "ran.marker")), "the selector never ran").toBe(false);
  }, 40_000);

  test("a project without the script is measured as before", async () => {
    const cwd = worktree("// RED\n", false);
    expect(hasTouchedTests(cwd)).toBe(false);
    const d = await deliver(cwd);
    expect(d.resp.status).toBe(200);
    expect(d.runs.map((r) => r.cmd)).toEqual([E2E_CI_CHECK.cmd]);
  }, 40_000);
});

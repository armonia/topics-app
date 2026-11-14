/**
 * @covers LAND-16
 * THE CI PHASE, END TO END THROUGH THE ROUTER (`services/integration-queue.ts`).
 *
 * A person approves a card: it does not close, it enters the CI phase, is
 * measured together with main and lands. A red sends it back to the agent with
 * the decision kept: the agent's next green delivery goes back to the CI phase
 * without passing through the person again. A person's reject takes the
 * decision back.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import type { IntegrationMeasure } from "../services/integration-queue";
import { RED_BOUNCE_NOTE } from "../services/red-bounce";

const MERGED = {
  status: "merged", commit: "a5f83e0e", branch: "topics/ci", repoPath: "/repo",
  touchedClient: false, touchedServer: true, touchedNative: false,
  landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
};

describe("the CI phase", () => {
  let db: Database; let svc: TaskService;
  let verdicts: Array<IntegrationMeasure["verdict"]>; let measured: string[][]; let merges: string[];
  let commit = "abc1234";
  let between: string[] | null = [];
  let landSkips = false;
  let sweep: (() => Promise<number>) | null = null;
  const cwd = mkdtempSync(join(tmpdir(), "tasks-integration-"));

  beforeEach(() => { db = freshDb(); svc = createTaskService(db); verdicts = []; measured = []; merges = []; commit = "abc1234"; between = []; landSkips = false; });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  async function setup() {
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/ci", commit, repoPath: "/repo" }),
      // A file a person looks at: the automatic land never takes it, only the person's approval does.
      ownCommitFiles: async () => [{ path: "client/src/App.tsx", added: false }],
      deliveryFiles: async () => ["client/src/App.tsx"],
      deliveryReferenced: async () => [],
      integrationCollectMs: 0,
      integrationFilesBetween: async () => between,
      onAutoLand: (api: { sweepAutoLand: () => Promise<number> }) => { sweep = api.sweepAutoLand; },
      integrationMeasure: async (_p: string, ids: string[]): Promise<IntegrationMeasure> => {
        measured.push(ids);
        const verdict = verdicts.shift() ?? "pass";
        return { measured: ids, conflicts: [], verdict, commit: "1ae9ca7e", why: verdict === "fail" ? "**Checks ROSSI**: `unit-ci` rosso" : undefined };
      },
      autoMerge: {
        tryMerge: async (taskId: string) => {
          merges.push(taskId);
          return landSkips ? { status: "skipped", code: "dirty-checkout", reason: "il checkout ha modifiche non committate" } : MERGED;
        },
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as never,
      confirmLandedOnMain: async () => true,
      stampLanding: async (taskId: string, verdict: string) => {
        if (verdict !== "ask") svc.recordLandingState({ taskId, state: verdict as never, checkedAt: new Date().toISOString(), witnessed: true });
      },
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "rifai il bottone" }))!.json();
    const id = task.id as string;
    const projectId = task.projectId as string;
    const withCi = [{ name: "ok", cmd: "true" }, { name: "unit-ci", cmd: "github-ci:unit" }];
    svc.updateBoardSettings(projectId, { dispatchAutoMerge: true, reviewChecks: withCi });
    let ciRows = true;
    const deliver = async () => {
      db.prepare("UPDATE tasks SET status = 'in_progress', preview_image = ? WHERE id = ?").run(join(cwd, "shot.png"), id);
      await call(router, "POST", `/api/sessions/s1/tasks/${id}/comments`, { content: `fatto su ${commit}` });
      // The delivery's own bar runs on the local row only (no GitHub here); the CI row is declared again
      // right after, which is what the CI phase reads.
      svc.updateBoardSettings(projectId, { reviewChecks: [{ name: "ok", cmd: "true" }] });
      const r = await call(router, "PATCH", `/api/sessions/s1/tasks/${id}`, { status: "review", summary: "fatto", legMs: 10_000 });
      if (ciRows) svc.updateBoardSettings(projectId, { reviewChecks: withCi });
      return r;
    };
    const settle = async () => { for (let i = 0; i < 40; i++) await Bun.sleep(10); };
    return { router, id, projectId, deliver, settle, read: () => svc.get(id)!.task, noCi: () => { ciRows = false; } };
  }

  test("a person's approval enters the CI phase, is measured and lands; nobody is asked again", async () => {
    const s = await setup();
    await s.deliver();
    expect(s.read().status).toBe("review");
    const r = (await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" }))!;
    expect(r.status).toBe(202);
    expect(s.read()).toMatchObject({ status: "review", stage: "ci", landIntent: "human" });
    await s.settle();
    expect(measured).toEqual([[s.id]]);
    expect(merges).toEqual([s.id]);
    expect(s.read().status).toBe("done");
    expect(s.read().landIntent).toBeUndefined();
  }, 30_000);

  test("a red after the approval goes back to the agent; its next green delivery lands without the person", async () => {
    const s = await setup();
    await s.deliver();
    verdicts = ["fail"];
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" });
    await s.settle();
    const bounced = svc.get(s.id)!;
    expect(bounced.task.status).toBe("in_progress");
    expect(bounced.task.landIntent).toBe("human");
    expect(bounced.comments.some((c) => c.content.startsWith(RED_BOUNCE_NOTE) && c.content.includes("unit-ci"))).toBe(true);
    expect(merges).toEqual([]);
    // The agent fixes it on a new commit and delivers again: straight back to the CI phase, then main.
    commit = "def5678";
    expect((await s.deliver())!.status).toBe(200);
    await s.settle();
    // Here the CI rows were hidden during the delivery (no GitHub in a test), so the delivery's own edge saw
    // no CI phase: the sweep is what puts a card carrying the decision back in it, as after a restart.
    await sweep!();
    await s.settle();
    expect(measured.length).toBe(2);
    expect(merges).toEqual([s.id]);
    expect(s.read().status).toBe("done");
  }, 30_000);

  test("a person's reject with a comment takes the decision back", async () => {
    const s = await setup();
    await s.deliver();
    verdicts = ["fail"];
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" });
    await s.settle();
    expect(s.read().landIntent).toBe("human");
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(s.id);
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "reject", comment: "no, cambia colore" });
    expect(s.read().landIntent).toBeUndefined();
  }, 30_000);

  test("a board without CI rows lands as before: no CI phase", async () => {
    const s = await setup();
    s.noCi();
    await s.deliver();
    const r = (await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" }))!;
    expect(r.status).toBe(200);
    expect(s.read().stage).toBeUndefined();
    expect(measured).toEqual([]);
  }, 30_000);

  test("after a person's ok, a fix that touches a person's place goes back to the person, not to main", async () => {
    const s = await setup();
    await s.deliver();
    verdicts = ["fail"];
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" });
    await s.settle();
    commit = "def5678";
    between = ["server/lib/x.ts", "client/src/Other.tsx"];
    await s.deliver();
    await sweep!();
    await s.settle();
    expect(merges).toEqual([]);
    expect(s.read().status).toBe("review");
    expect(s.read().humanAsk).toContain("client/src/Other.tsx");
    expect(s.read().landIntent).toBeUndefined();
  }, 30_000);

  test("a land that does not go after a green CI is a person's, not a loop of CI runs", async () => {
    const s = await setup();
    await s.deliver();
    landSkips = true;
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" });
    await s.settle();
    for (let i = 0; i < 3; i++) { await sweep!(); await s.settle(); }
    expect(measured.length).toBe(1);
    expect(s.read().status).toBe("review");
    expect(s.read().humanAsk).toContain("Fase CI ferma");
    expect(s.read().landIntent).toBeUndefined();
  }, 30_000);

  test("a CI that never answers stops after two rounds and asks the person", async () => {
    const s = await setup();
    await s.deliver();
    verdicts = ["unmeasured", "unmeasured", "unmeasured"];
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/review`, { decision: "approve" });
    await s.settle();
    for (let i = 0; i < 3; i++) { await sweep!(); await s.settle(); }
    expect(measured.length).toBe(2);
    expect(s.read().humanAsk).toContain("non ha dato un esito");
  }, 30_000);
});

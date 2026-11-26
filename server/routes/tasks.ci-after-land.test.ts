/**
 * @covers LAND-16
 * THE `after` RULE OF THE CI PHASE, END TO END THROUGH THE ROUTER (`routes/tasks-ci-phase.ts`).
 *
 * Approved work lands at once, without the queue, the collection window or the draft pull request: the
 * change is on main when the person approves. The CI measures main afterwards, with the same machine as the
 * `before` phase, and:
 *  - green: a note on the card and nothing else;
 *  - red: the card leaves `done`, goes back to its agent with the log and the decision to land kept, up to
 *    the same three rounds; then a person is asked, and is offered the revert.
 * A restart drops the in-memory queue: the mark on the card is what the sweep puts back.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb, makeCtx, call, setCiPhaseMode } from "./tasks-test-support";
import type { IntegrationMeasure } from "../services/integration-queue";
import { RED_BOUNCE_NOTE } from "../services/red-bounce";

const MERGED = {
  status: "merged", commit: "a5f83e0e", branch: "topics/ci", repoPath: "/repo",
  touchedClient: false, touchedServer: true, touchedNative: false,
  landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
};

describe("the CI phase, `after` rule", () => {
  let db: Database; let svc: TaskService;
  let verdicts: Array<IntegrationMeasure["verdict"]>; let measured: string[][]; let merges: string[];
  let measureGate: Promise<void>;
  let sweep: (() => Promise<number>) | null = null;
  const cwd = mkdtempSync(join(tmpdir(), "tasks-ci-after-"));
  const commit = "abc1234";

  beforeEach(() => {
    db = setCiPhaseMode(freshDb(), "after"); svc = createTaskService(db);
    verdicts = []; measured = []; merges = []; measureGate = Promise.resolve();
  });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  async function setup(extra: Partial<Parameters<typeof createTasksRouter>[2]> = {}) {
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/ci", commit, repoPath: "/repo" }),
      ownCommitFiles: async () => [{ path: "client/src/App.tsx", added: false }],
      deliveryFiles: async () => ["client/src/App.tsx"],
      deliveryReferenced: async () => [],
      integrationCollectMs: 0,
      integrationFilesBetween: async () => [],
      onAutoLand: (api: { sweepAutoLand: () => Promise<number> }) => { sweep = api.sweepAutoLand; },
      integrationMeasure: async (_p: string, ids: string[]): Promise<IntegrationMeasure> => {
        await measureGate;
        measured.push(ids);
        const verdict = verdicts.shift() ?? "pass";
        return { measured: ids, conflicts: [], verdict, commit: "1ae9ca7e", why: verdict === "fail" ? "**Checks ROSSI**: `unit-ci` rosso" : undefined };
      },
      autoMerge: {
        tryMerge: async (taskId: string) => { merges.push(taskId); return MERGED; },
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as never,
      confirmLandedOnMain: async () => true,
      stampLanding: async (taskId: string, verdict: string) => {
        if (verdict !== "ask") svc.recordLandingState({ taskId, state: verdict as never, checkedAt: new Date().toISOString(), witnessed: true });
      },
      ...extra,
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "rifai il bottone" }))!.json();
    const id = task.id as string;
    const projectId = task.projectId as string;
    const withCi = [{ name: "ok", cmd: "true" }, { name: "unit-ci", cmd: "github-ci:unit" }];
    svc.updateBoardSettings(projectId, { dispatchAutoMerge: true, reviewChecks: withCi });
    const deliver = async () => {
      db.prepare("UPDATE tasks SET status = 'in_progress', preview_image = ? WHERE id = ?").run(join(cwd, "shot.png"), id);
      await call(router, "POST", `/api/sessions/s1/tasks/${id}/comments`, { content: `fatto su ${commit}` });
      // The delivery's own bar runs on the local row only (no GitHub here); the CI row comes back right after.
      svc.updateBoardSettings(projectId, { reviewChecks: [{ name: "ok", cmd: "true" }] });
      const r = await call(router, "PATCH", `/api/sessions/s1/tasks/${id}`, { status: "review", summary: "fatto", legMs: 10_000 });
      svc.updateBoardSettings(projectId, { reviewChecks: withCi });
      return r;
    };
    const approve = async () => (await call(router, "POST", `/api/boards/${projectId}/tasks/${id}/review`, { decision: "approve" }))!;
    const settle = async () => { for (let i = 0; i < 40; i++) await Bun.sleep(10); };
    const mark = () => (db.query("SELECT ci_after AS m FROM tasks WHERE id = ?").get(id) as { m: string | null }).m;
    /** The mark stays after the measure, settled: it is what keeps main's watch from opening a second card. */
    const state = () => { const m = mark(); return m ? ((JSON.parse(m) as { settled?: string }).settled ?? "pending") : null; };
    return { router, id, projectId, deliver, approve, settle, mark, state, read: () => svc.get(id)!.task, thread: () => svc.get(id)!.comments };
  }

  test("an approval lands at once, no queue in front; the CI reads main after and a green leaves only a note", async () => {
    const s = await setup();
    await s.deliver();
    measureGate = new Promise<void>(() => {}); // the CI has not answered yet
    expect((await s.approve()).status).toBe(202);
    await s.settle();
    // On main and closed while the CI is still running: this is what the person waited 15-20 minutes for.
    expect(merges).toEqual([s.id]);
    expect(s.read()).toMatchObject({ status: "done" });
    expect(s.read().stage ?? null).not.toBe("ci");
    expect(s.read().landIntent).toBeUndefined();
    expect(JSON.parse(s.mark()!)).toMatchObject({ commit, who: "human" });
    expect(s.state()).toBe("pending");
    measureGate = Promise.resolve();
  }, 30_000);

  test("green: the card stays done, the mark goes, the thread says the CI measured main", async () => {
    const s = await setup();
    await s.deliver();
    await s.approve();
    await s.settle();
    expect(measured).toEqual([[s.id]]);
    expect(s.read().status).toBe("done");
    expect(s.state()).toBe("green");
    expect(s.thread().some((c) => c.content.includes("CI verde") && c.content.includes("dopo l'atterraggio"))).toBe(true);
    expect(s.thread().some((c) => c.content.startsWith(RED_BOUNCE_NOTE))).toBe(false);
  }, 30_000);

  test("red: the card leaves done for its agent with the log, tells it the work is on main, keeps the decision to land", async () => {
    const s = await setup();
    await s.deliver();
    verdicts = ["fail"];
    await s.approve();
    await s.settle();
    const back = svc.get(s.id)!;
    expect(merges).toEqual([s.id]); // landed once, never reverted
    expect(back.task.status).toBe("todo");
    expect(back.task.landIntent).toBe("human");
    expect(s.state()).toBe("bounced");
    const note = back.comments.find((c) => c.content.startsWith(RED_BOUNCE_NOTE));
    expect(note?.content).toContain("unit-ci");
    expect(note?.content).toContain("GIÀ SU MAIN");
    expect(back.task.humanAsk ?? "").toBe("");
  }, 30_000);

  test("red predates this card's own push (same job already failing before): not its fault, stays landed (25/11)", async () => {
    const ENTER_SHA = "1111111111111111111111111111111111111111";
    const BEFORE_SHA = "2222222222222222222222222222222222222222";
    const port = {
      recent: async () => [
        { sha: ENTER_SHA, subject: "this card's push", at: 2000 },
        { sha: BEFORE_SHA, subject: "an earlier push", at: 1000 },
      ],
      verdict: async (sha: string) => (sha === ENTER_SHA || sha === BEFORE_SHA)
        ? { state: "fail" as const, failed: ["unit-ci"], url: null }
        : { state: "none" as const, failed: [], url: null },
      entersAt: async (c: string, sha: string) => c === commit && sha === ENTER_SHA,
    };
    const s = await setup({ mainCiPort: async () => port } as never);
    await s.deliver();
    verdicts = ["fail"];
    await s.approve();
    await s.settle();
    expect(merges).toEqual([s.id]);
    expect(s.read().status).toBe("done"); // stays landed, not bounced
    expect(s.state()).toBe("green");
    expect(s.thread().some((c) => c.content.includes("lo era già prima di questa card"))).toBe(true);
  }, 30_000);

  test("same job red before and after, but on the SAME test: still stays landed, named by test (26/11)", async () => {
    const ENTER_SHA = "3333333333333333333333333333333333333333";
    const BEFORE_SHA = "4444444444444444444444444444444444444444";
    const port = {
      recent: async () => [
        { sha: ENTER_SHA, subject: "this card's push", at: 2000 },
        { sha: BEFORE_SHA, subject: "an earlier push", at: 1000 },
      ],
      verdict: async (sha: string) => (sha === ENTER_SHA || sha === BEFORE_SHA)
        ? { state: "fail" as const, failed: ["unit-ci"], url: null, failedTests: ["flaky.test.ts > a flaky test"] }
        : { state: "none" as const, failed: [], url: null },
      entersAt: async (c: string, sha: string) => c === commit && sha === ENTER_SHA,
    };
    const s = await setup({ mainCiPort: async () => port } as never);
    await s.deliver();
    verdicts = ["fail"];
    await s.approve();
    await s.settle();
    expect(s.read().status).toBe("done");
    expect(s.thread().some((c) => c.content.includes("sugli stessi test di prima"))).toBe(true);
  }, 30_000);

  test("same job red before and after, but a DIFFERENT test: this card's own red, bounces (26/11)", async () => {
    const ENTER_SHA = "5555555555555555555555555555555555555555";
    const BEFORE_SHA = "6666666666666666666666666666666666666666";
    const port = {
      recent: async () => [
        { sha: ENTER_SHA, subject: "this card's push", at: 2000 },
        { sha: BEFORE_SHA, subject: "an earlier push", at: 1000 },
      ],
      verdict: async (sha: string) => sha === ENTER_SHA
        ? { state: "fail" as const, failed: ["unit-ci"], url: null, failedTests: ["app.test.ts > the new behaviour"] }
        : sha === BEFORE_SHA
        ? { state: "fail" as const, failed: ["unit-ci"], url: null, failedTests: ["flaky.test.ts > a flaky test"] }
        : { state: "none" as const, failed: [], url: null },
      entersAt: async (c: string, sha: string) => c === commit && sha === ENTER_SHA,
    };
    const s = await setup({ mainCiPort: async () => port } as never);
    await s.deliver();
    verdicts = ["fail"];
    await s.approve();
    await s.settle();
    const back = svc.get(s.id)!;
    expect(back.task.status).toBe("todo"); // this card's own red, not preexisting
    expect(back.comments.some((c) => c.content.startsWith(RED_BOUNCE_NOTE))).toBe(true);
  }, 30_000);

  test("three rounds without a person: the card waits for one, who is offered the revert", async () => {
    const s = await setup();
    await s.deliver();
    for (let i = 0; i < 3; i++) svc.addComment({ taskId: s.id, author: "system", content: `${RED_BOUNCE_NOTE} (giro ${i + 1} di 3)` });
    verdicts = ["fail"];
    await s.approve();
    await s.settle();
    const t = s.read();
    expect(t.status).toBe("review");
    expect(t.humanAsk).toContain("git revert -m 1");
    expect(t.landIntent).toBeUndefined();
    expect(s.state()).toBe("asked");
  }, 30_000);

  test("a restart drops the queue: the sweep puts back the landed card that still carries its mark", async () => {
    const s = await setup();
    await s.deliver();
    await s.approve();
    await s.settle();
    expect(measured).toEqual([[s.id]]);
    // The process died between the land and the CI's answer: a new one has an empty queue and the mark on the card.
    db.prepare("UPDATE tasks SET ci_after = ? WHERE id = ?").run(JSON.stringify({ commit, who: "human", repo: null, at: new Date().toISOString() }), s.id);
    await sweep!();
    await s.settle();
    expect(measured).toEqual([[s.id], [s.id]]);
    expect(s.state()).toBe("green");
    // A board that turned the CI off since does not measure: the mark is dropped, nothing is asked.
    db.prepare("UPDATE tasks SET ci_after = ? WHERE id = ?").run(JSON.stringify({ commit, who: "human", repo: null, at: new Date().toISOString() }), s.id);
    setCiPhaseMode(db, "off");
    await sweep!();
    await s.settle();
    expect(measured.length).toBe(2);
    expect(s.mark()).toBeNull();
  }, 30_000);

  test("the three values and the old booleans: `before` keeps the queue in front, `off` lands as a board without CI rows", async () => {
    const before = await setup();
    setCiPhaseMode(db, "before");
    await before.deliver();
    await before.approve();
    expect(before.read()).toMatchObject({ status: "review", stage: "ci" });
    await before.settle();
    expect(before.read().status).toBe("done");
    expect(before.mark()).toBeNull();
  }, 30_000);
});

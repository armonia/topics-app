/**
 * @covers LAND-16
 * "LANDED" MEANS THE MERGE WAS SEEN ON MAIN, never "a land was asked" (card c2908b93).
 *
 * Measured on card 572f8a09: a land asked through `board_land` entered the CI
 * phase while the card still carried a `landed` the landing audit had DEDUCED
 * (not witnessed) from its delivery commit. The CI phase took that field at its
 * word: after a land that merged nothing it did not hand the card to a person,
 * the card stayed in the phase and was measured again and again "as already
 * landed", and a session closed it as "already on main" while its commit was
 * not on origin/main.
 *
 * Two contracts, through the router:
 *  - entering the CI phase says "not on main yet" until the merge is
 *    confirmed, and only the confirmed merge writes `landed`;
 *  - a `landed` nobody witnessed does not let the CI phase treat a land that
 *    merged nothing as a land.
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

const MERGED = {
  status: "merged", commit: "a5f83e0e", branch: "topics/ci", repoPath: "/repo",
  touchedClient: false, touchedServer: true, touchedNative: false,
  landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
};
const NOTHING = { status: "nothing", branch: "topics/ci", deliveryDrift: null };

describe("landing_state across the CI phase", () => {
  let db: Database; let svc: TaskService;
  let merge: typeof MERGED | typeof NOTHING;
  /** What the deduction answers when the land asks it ("ask"): null = it stays silent. */
  let deduction: "landed" | null = null;
  let release: () => void = () => {};
  let measureGate: Promise<void> = Promise.resolve();
  const cwd = mkdtempSync(join(tmpdir(), "tasks-ci-landing-"));
  const commit = "abc1234";

  beforeEach(() => {
    db = freshDb(); svc = createTaskService(db); merge = MERGED; deduction = null;
    measureGate = new Promise<void>((r) => { release = r; });
  });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  /** What the landing audit writes when it DEDUCES a verdict: no witness. */
  const deduceLanded = (id: string) =>
    db.prepare("UPDATE tasks SET landing_state = 'landed', landing_witnessed = 0 WHERE id = ?").run(id);
  const landingRow = (id: string) =>
    db.query("SELECT landing_state AS state, landing_witnessed AS witnessed FROM tasks WHERE id = ?").get(id) as { state: string | null; witnessed: number };

  async function setup() {
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/ci", commit, repoPath: "/repo" }),
      ownCommitFiles: async () => [{ path: "client/src/App.tsx", added: false }],
      deliveryFiles: async () => ["client/src/App.tsx"],
      deliveryReferenced: async () => [],
      integrationCollectMs: 0,
      integrationFilesBetween: async () => [],
      integrationMeasure: async (_p: string, ids: string[]): Promise<IntegrationMeasure> => {
        await measureGate;
        return { measured: ids, conflicts: [], verdict: "pass", commit: "1ae9ca7e" };
      },
      autoMerge: {
        tryMerge: async () => merge,
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as never,
      confirmLandedOnMain: async () => true,
      // Same wiring as server.ts: a concrete verdict is a witnessed fact, "ask" goes to the
      // deduction (`auditOneLanding`), which writes without a witness.
      stampLanding: async (taskId: string, verdict: string) => {
        if (verdict !== "ask") svc.recordLandingState({ taskId, state: verdict as never, checkedAt: new Date().toISOString(), witnessed: true });
        else if (deduction) svc.recordLandingState({ taskId, state: deduction, checkedAt: new Date().toISOString() });
      },
      markLandPending: (taskId: string) => {
        svc.recordLandingState({ taskId, state: "unlanded", checkedAt: new Date().toISOString() });
      },
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "pagina strumenti" }))!.json();
    const id = task.id as string;
    const projectId = task.projectId as string;
    const withCi = [{ name: "ok", cmd: "true" }, { name: "unit-ci", cmd: "github-ci:unit" }];
    svc.updateBoardSettings(projectId, { dispatchAutoMerge: true, reviewChecks: withCi });
    db.prepare("UPDATE tasks SET status = 'in_progress', preview_image = ? WHERE id = ?").run(join(cwd, "shot.png"), id);
    await call(router, "POST", `/api/sessions/s1/tasks/${id}/comments`, { content: `fatto su ${commit}` });
    svc.updateBoardSettings(projectId, { reviewChecks: [{ name: "ok", cmd: "true" }] });
    await call(router, "PATCH", `/api/sessions/s1/tasks/${id}`, { status: "review", summary: "fatto", legMs: 10_000 });
    svc.updateBoardSettings(projectId, { reviewChecks: withCi });
    const settle = async () => { for (let i = 0; i < 40; i++) await Bun.sleep(10); };
    return { router, id, projectId, settle, read: () => svc.get(id)!.task };
  }

  test("board land into the CI phase: not 'landed' while queued, 'landed' once the merge is confirmed", async () => {
    const s = await setup();
    expect(s.read().status).toBe("review");
    // The state card 572f8a09 entered the phase with: a landed nobody witnessed.
    deduceLanded(s.id);
    const r = (await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/land`, {}))!;
    expect(r.status).toBe(202);
    expect(s.read()).toMatchObject({ status: "review", stage: "ci" });
    await s.settle();
    // In the queue, measured or not yet: the merge has not happened, so the card must not say it has.
    expect(landingRow(s.id).state).not.toBe("landed");
    release();
    await s.settle();
    expect(s.read().status).toBe("done");
    expect(landingRow(s.id)).toEqual({ state: "landed", witnessed: 1 });
  }, 30_000);

  test("a deduced 'landed' with nothing merged: the CI phase does not treat it as landed, a person reads why", async () => {
    const s = await setup();
    merge = NOTHING;
    // The land merged nothing and asked the deduction, which read the delivery as already on main:
    // on card 572f8a09 a merge commit whose own diff looked empty.
    deduction = "landed";
    await call(s.router, "POST", `/api/boards/${s.projectId}/tasks/${s.id}/land`, {});
    await s.settle();
    release();
    await s.settle();
    const t = s.read();
    expect(t.status).toBe("review");
    // Handed to a person, out of the phase: not left in the queue to be measured again.
    expect(t.humanAsk ?? "").toContain("Fase CI ferma");
    expect(t.landIntent).toBeUndefined();
    expect(t.stage ?? null).not.toBe("ci");
  }, 30_000);
});

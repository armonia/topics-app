/**
 * @covers LAND-05
 * APPROVE ON A BRANCH WITH NO COMMIT CAPTURED YET MUST NOT CLOSE `done`
 * WITHOUT MEASURING ANYTHING (card e73d7a2d, 16/11).
 *
 * `delivery_branch` set, `delivery_commit` NULL used to slip past
 * `enterCiPhase`'s own guard and fall through to the plain approve below it,
 * closing the card `done` with no CI and no land. Approve must capture the
 * branch's own commit now, then enter the CI phase — or reject the approval
 * with a reason when there is truly nothing to measure.
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call, setCiPhaseMode } from "./tasks-test-support";
import type { IntegrationMeasure } from "../services/integration-queue";

describe("approve su un ramo senza delivery_commit ancora catturato", () => {
  test("lo cattura ora e passa dalla fase CI, invece di chiudere done senza misurare", async () => {
    const db = setCiPhaseMode(freshDb(), "before");
    const svc = createTaskService(db);
    let measured = 0;
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      integrationCollectMs: 0,
      integrationFilesBetween: async () => [],
      integrationMeasure: async (_p: string, ids: string[]): Promise<IntegrationMeasure> => {
        measured += 1;
        return { measured: ids, conflicts: [], verdict: "pass", commit: "f00dcafe" };
      },
      taskDeliveryRef: async () => ({ branch: "topics/rippling-outpost", commit: "f00dcafe1234" }),
    } as Parameters<typeof createTasksRouter>[2]);
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "cura" }))!.json();
    svc.updateBoardSettings(t.projectId, {
      dispatchAutoMerge: true,
      reviewChecks: [{ name: "unit-ci", cmd: "github-ci:unit" }],
    });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/rippling-outpost', delivery_commit = NULL WHERE id = ?").run(t.id);

    const r = await call(router, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve" });

    // The CI phase entry itself (not the land behind it, which this harness
    // has no `autoMerge` mock for): the commit was captured now, and the card
    // moved into the `ci` column still in review, instead of closing `done`
    // with nothing measured.
    expect(r?.status).toBe(202);
    const body = await r!.json();
    expect(body.deliveryCommit).toBe("f00dcafe1234");
    expect(body.status).toBe("review");
    expect(body.stage).toBe("ci");

    await Bun.sleep(50);
    expect(measured).toBe(1);
    expect(svc.get(t.id)!.task.deliveryCommit).toBe("f00dcafe1234");
    expect(svc.get(t.id)!.task.status).not.toBe("done");
  });

  test("rifiuta con un motivo quando non c'è proprio niente da catturare", async () => {
    const db = setCiPhaseMode(freshDb(), "before");
    const svc = createTaskService(db);
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      integrationCollectMs: 0,
      integrationMeasure: async (): Promise<IntegrationMeasure> => ({ measured: [], conflicts: [], verdict: "pass", commit: null }),
      taskDeliveryRef: async () => null,
    } as Parameters<typeof createTasksRouter>[2]);
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "cura" }))!.json();
    svc.updateBoardSettings(t.projectId, {
      dispatchAutoMerge: true,
      reviewChecks: [{ name: "unit-ci", cmd: "github-ci:unit" }],
    });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/rippling-outpost', delivery_commit = NULL WHERE id = ?").run(t.id);

    const r = await call(router, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve" });

    expect(r?.status).toBe(409);
    const body = await r!.json();
    expect(body.code).toBe("delivery_commit_missing");
    const row = db.query("SELECT status FROM tasks WHERE id = ?").get(t.id) as { status: string };
    expect(row.status).toBe("review");
  });
});

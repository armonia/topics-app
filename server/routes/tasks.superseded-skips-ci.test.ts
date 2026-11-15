/**
 * @covers LAND-05
 * AN APPROVAL AS SUPERSEDED NEVER ENTERS THE CI PHASE (card 619e3a6d, 15/11).
 *
 * On a board with the CI phase, `approve` on a card whose branch is not on main
 * is a land. `superseded: true` says the opposite, "this branch will never
 * land": it closed the card only when `force` came with it, and without it the
 * branch went to the merge queue.
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import type { IntegrationMeasure } from "../services/integration-queue";

describe("approve come superata su una board con la fase CI", () => {
  test("si chiude superata, non entra in fase CI e non misura niente", async () => {
    const db = freshDb();
    const svc = createTaskService(db);
    let measured = 0;
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      integrationCollectMs: 0,
      integrationFilesBetween: async () => [],
      integrationMeasure: async (_p: string, ids: string[]): Promise<IntegrationMeasure> => {
        measured += 1;
        return { measured: ids, conflicts: [], verdict: "pass", commit: "1ae9ca7e" };
      },
    } as Parameters<typeof createTasksRouter>[2]);
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "cura" }))!.json();
    svc.updateBoardSettings(t.projectId, {
      dispatchAutoMerge: true,
      reviewChecks: [{ name: "unit-ci", cmd: "github-ci:unit" }],
    });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/scartato', delivery_commit = 'abc12345' WHERE id = ?").run(t.id);

    const r = await call(router, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve", superseded: true });
    await Bun.sleep(50);

    expect(r?.status).toBe(200);
    const after = svc.get(t.id)!.task;
    expect(after.status).toBe("done");
    expect(after.landingState).toBe("superseded");
    expect(after.stage ?? null).not.toBe("ci");
    expect(after.landIntent).toBeUndefined();
    expect(measured).toBe(0);
  });
});

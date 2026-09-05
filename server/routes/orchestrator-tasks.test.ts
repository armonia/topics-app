/**
 * Narrow task surface for the one registered global Topic.
 *
 * These are intentionally route tests: the important property is not merely
 * that the registry can be queried, but that an unbound Topic receives its
 * cross-board capability only here while ordinary `/api/sessions` remains
 * project-bound.
 * @covers GLOBAL-ORCHESTRATOR-TASKS-01
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AUTO_PROJECT_ID, projectIdForPath, UNASSIGNED_PROJECT_ID } from "../services/tasks";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx } from "./tasks-test-support";

const GLOBAL_TOPIC_ID = "global-orchestrator-topic";
const GLOBAL_SESSION_KEY = "topic:global-orchestrator";
const PROJECT_ONE = "/proj/one";
const PROJECT_TWO = "/proj/two";
const CATCH_ALL = "/workspace/generale";

function registerGlobalOrchestrator(db: Database): void {
  const now = "2026-09-04T10:00:00.000Z";
  db.run(
    `INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider)
     VALUES (?, ?, NULL, NULL, NULL, 'codex')`,
    [GLOBAL_TOPIC_ID, GLOBAL_SESSION_KEY],
  );
  db.run(
    `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
     VALUES ('global', ?, ?, ?)`,
    [GLOBAL_TOPIC_ID, now, now],
  );
}

describe("global orchestrator task routes", () => {
  let db: Database;
  let broadcasts: any[];
  let router: ReturnType<typeof createTasksRouter>;

  beforeEach(() => {
    db = freshDb();
    broadcasts = [];
    // Deliberately give the mapped Topic a malformed project path in this
    // harness. The normal session surface must still reject it; only the
    // separate registry wrapper may coordinate across boards.
    router = createTasksRouter(makeCtx(db, broadcasts, {
      [GLOBAL_SESSION_KEY]: { projectPath: PROJECT_ONE, name: "coordinator", topicId: GLOBAL_TOPIC_ID },
    }), undefined, {
      listProjectDirs: () => [PROJECT_ONE, PROJECT_TWO, CATCH_ALL],
    });
  });

  test("denies an unregistered session key even when it looks like an orchestrator", async () => {
    const response = (await call(router, "GET", "/api/orchestrator-sessions/topic:global-orchestrator/tasks"))!;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "global_orchestrator_required" });
  });

  test("never widens the ordinary project-bound session surface for the mapped coordinator", async () => {
    registerGlobalOrchestrator(db);

    const response = (await call(
      router,
      "GET",
      `/api/sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks`,
    ))!;

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "no_project" });
  });

  test("a corrupt registered row gets neither ordinary nor global task authority", async () => {
    registerGlobalOrchestrator(db);
    db.run("UPDATE topics SET project_path = ? WHERE id = ?", [PROJECT_ONE, GLOBAL_TOPIC_ID]);

    const ordinary = (await call(
      router,
      "GET",
      `/api/sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks`,
    ))!;
    expect(ordinary.status).toBe(400);
    expect(await ordinary.json()).toMatchObject({ code: "no_project" });

    const global = (await call(
      router,
      "GET",
      `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks`,
    ))!;
    expect(global.status).toBe(403);
    expect(await global.json()).toMatchObject({ code: "global_orchestrator_required" });
  });

  test("creates only on an explicit known board; never auto, unassigned, or catch-all", async () => {
    registerGlobalOrchestrator(db);
    const boardTwo = projectIdForPath(PROJECT_TWO);

    const createdResponse = (await call(
      router,
      "POST",
      `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks`,
      { board_id: boardTwo, text: "Coordinate the release" },
    ))!;
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created).toMatchObject({ projectId: boardTwo, status: "backlog" });
    expect(broadcasts).toContainEqual(expect.objectContaining({ type: "task:created", projectId: boardTwo }));

    for (const board_id of [AUTO_PROJECT_ID, UNASSIGNED_PROJECT_ID, projectIdForPath(CATCH_ALL), "not-a-known-board"]) {
      const rejected = (await call(
        router,
        "POST",
        `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks`,
        { board_id, text: "This must not be created" },
      ))!;
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).code).toBe("invalid_input");
    }
  });

  /**
   * The global PATCH shares the session route's checks gate, so it must share
   * its self-completion too: a delivery answered 202 is remembered and the
   * server re-issues the same PATCH on the global path when the run ends.
   * Without that mirror a coordinator that stops polling would leave the card
   * in_progress forever with a green verdict nobody applies.
   */
  describe("delivery with pending checks", () => {
    let cwd: string;
    beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "orchestrator-tasks-checks-")); });
    afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

    test("self-completes into review after the client stops polling", async () => {
      registerGlobalOrchestrator(db);
      const checked = createTasksRouter(makeCtx(db, broadcasts, {
        [GLOBAL_SESSION_KEY]: { projectPath: PROJECT_ONE, name: "coordinator", topicId: GLOBAL_TOPIC_ID },
      }), undefined, {
        listProjectDirs: () => [PROJECT_ONE, PROJECT_TWO, CATCH_ALL],
        taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      } as any);
      const boardTwo = projectIdForPath(PROJECT_TWO);
      const task = await (await call(checked, "POST", "/api/sessions/s2/tasks", { text: "Deliver from the coordinator" }))!.json();
      await call(checked, "PATCH", `/api/boards/${boardTwo}/settings`, { reviewChecks: [{ name: "slow", cmd: "sleep 0.6" }] });

      const globalPath = `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks/${task.id}`;
      // `summary` is the delivery line the store demands (review_needs_summary),
      // shared with the session route: the re-issued PATCH carries it too.
      const first = (await call(checked, "PATCH", globalPath, {
        status: "review", summary: "Delivered from the coordinator, see demo/", legMs: 100,
      }))!;
      expect(first.status).toBe(202);
      expect((await first.json()).code).toBe("review_checks_running");

      // Nobody polls. The run ends on its own and the verdict lands anyway.
      await Bun.sleep(1_500);
      const after = await (await call(checked, "GET", globalPath))!.json();
      expect(after.task.status).toBe("review");
      expect(after.task.checksState).toBe("pass");
    });
  });

  test("resolves every detailed task action to the task's stored board, not a caller project id", async () => {
    registerGlobalOrchestrator(db);
    const boardOne = projectIdForPath(PROJECT_ONE);
    const boardTwo = projectIdForPath(PROJECT_TWO);
    const secondBoardTask = await (await call(router, "POST", "/api/sessions/s2/tasks", { text: "On board two" }))!.json();

    // The ordinary session surface remains unchanged: s1 cannot use a task id
    // from s2 as an accidental cross-board capability.
    const ordinaryForeign = (await call(router, "GET", `/api/sessions/s1/tasks/${secondBoardTask.id}`))!;
    expect(ordinaryForeign.status).toBe(404);

    const globalPath = `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks/${secondBoardTask.id}`;
    const got = (await call(router, "GET", globalPath))!;
    expect(got.status).toBe(200);
    expect((await got.json()).task).toMatchObject({ id: secondBoardTask.id, projectId: boardTwo });

    // This focused route rejects a caller-selected project field instead of
    // accepting it. The field cannot steer a mutation to board one.
    const forged = (await call(router, "PATCH", globalPath, {
      text: "should not apply",
      projectId: boardOne,
    }))!;
    expect(forged.status).toBe(400);
    expect((await forged.json()).code).toBe("invalid_input");

    // With no caller board field, the server re-reads task id → board two and
    // uses that id for both the service guard and the websocket update.
    const updated = (await call(router, "PATCH", globalPath, { text: "Updated globally" }))!;
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: secondBoardTask.id, projectId: boardTwo, text: "Updated globally" });
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: "task:updated",
      projectId: boardTwo,
      task: expect.objectContaining({ id: secondBoardTask.id, text: "Updated globally" }),
    }));

    const comment = (await call(router, "POST", `${globalPath}/comments`, { content: "Board two is the target." }))!;
    expect(comment.status).toBe(201);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: "task:updated",
      projectId: boardTwo,
      task: expect.objectContaining({ id: secondBoardTask.id }),
    }));
  });
});

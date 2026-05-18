/**
 * KANBAN-DELTA-01 — jump-to-tab API (Phase D).
 *
 * Spec: openspec/changes/add-master-topic-mode/specs/kanban/spec.md
 * Endpoint: POST /api/boards/:projectId/tasks/:id/assign-topic
 */
import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";

const TEST_DATA = "/tmp/topics-board-jumptotab-data";

beforeAll(() => {
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA;
});

async function setup() {
  const { createAppContext } = await import("../../server/utils");
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const { createBoardsRouter } = await import("../../server/routes/boards");
  const ctx = createAppContext("/Users/user/Projects/topics-app");
  (ctx as any).broadcastToAll = () => {};
  const topicsRouter = createTopicsRouter(ctx);
  const boardsRouter = createBoardsRouter(ctx);
  return { ctx, topicsRouter, boardsRouter };
}

async function postJson(router: any, urlStr: string, body: any) {
  const url = new URL(urlStr);
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await router(req, url, url.pathname, "POST");
  return { status: resp?.status ?? 0, body: resp ? await resp.json() : null };
}

async function getJson(router: any, urlStr: string) {
  const url = new URL(urlStr);
  const req = new Request(url, { method: "GET" });
  const resp = await router(req, url, url.pathname, "GET");
  return { status: resp?.status ?? 0, body: resp ? await resp.json() : null };
}

describe("KANBAN-DELTA-01 · POST /api/boards/:projectId/tasks/:id/assign-topic", () => {
  test("binds an existing teammate topic to a task and returns assignedTopicId", async () => {
    const { ctx, topicsRouter, boardsRouter } = await setup();

    // 1) Master Topic
    const master = await postJson(topicsRouter, "http://h/api/topics/master", {
      projectPath: "/tmp/jump-A",
    });
    expect(master.status).toBe(201);

    // 2) Teammate topic (using existing topic POST flow with parent linkage via direct DB)
    const teammate = await postJson(topicsRouter, "http://h/api/topics", {
      name: "Teammate · pkg-x",
      projectPath: "/tmp/jump-A/pkg-x",
    });
    expect(teammate.status).toBe(201);
    ctx.db.run(
      "UPDATE topics SET parent_topic_id = ?, agent_team_role = 'teammate' WHERE id = ?",
      [master.body.id, teammate.body.id],
    );

    // 3) Project row required by tasks.project_id FK
    const projectId = "proj-jump-A";
    ctx.db.run(
      "INSERT OR IGNORE INTO projects (id, name, path, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [projectId, "jump-A", "/tmp/jump-A", "#5865f2", new Date().toISOString(), new Date().toISOString()],
    );

    // 4) Create a task on that project
    const task = await postJson(boardsRouter, `http://h/api/boards/${projectId}/tasks`, {
      text: "ship feature X",
    });
    expect(task.status).toBe(201);

    // 5) Assign the teammate topic
    const assign = await postJson(
      boardsRouter,
      `http://h/api/boards/${projectId}/tasks/${task.body.id}/assign-topic`,
      { assignedTopicId: teammate.body.id },
    );
    expect(assign.status).toBe(200);
    expect(assign.body.assignedTopicId).toBe(teammate.body.id);

    // 6) Verify DB persisted
    const row = ctx.db.query("SELECT assigned_topic_id FROM tasks WHERE id = ?").get(task.body.id) as any;
    expect(row.assigned_topic_id).toBe(teammate.body.id);

    // 7) Listing also exposes it (serializer wiring)
    const list = await getJson(boardsRouter, `http://h/api/boards/${projectId}/tasks`);
    expect(list.status).toBe(200);
    const updated = list.body.tasks.find((t: any) => t.id === task.body.id);
    expect(updated.assignedTopicId).toBe(teammate.body.id);
  });

  test("clears the binding when assignedTopicId is null", async () => {
    const { ctx, topicsRouter, boardsRouter } = await setup();
    const projectId = "proj-jump-B";
    ctx.db.run(
      "INSERT OR IGNORE INTO projects (id, name, path, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [projectId, "jump-B", "/tmp/jump-B", "#5865f2", new Date().toISOString(), new Date().toISOString()],
    );
    const teammate = await postJson(topicsRouter, "http://h/api/topics", {
      name: "Teammate · B",
      projectPath: "/tmp/jump-B/pkg",
    });
    const task = await postJson(boardsRouter, `http://h/api/boards/${projectId}/tasks`, {
      text: "tmp",
    });
    await postJson(boardsRouter, `http://h/api/boards/${projectId}/tasks/${task.body.id}/assign-topic`, {
      assignedTopicId: teammate.body.id,
    });
    const cleared = await postJson(boardsRouter, `http://h/api/boards/${projectId}/tasks/${task.body.id}/assign-topic`, {
      assignedTopicId: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.assignedTopicId).toBeNull();
  });

  test("rejects assignment to a non-existent topic", async () => {
    const { ctx, boardsRouter } = await setup();
    const projectId = "proj-jump-C";
    ctx.db.run(
      "INSERT OR IGNORE INTO projects (id, name, path, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [projectId, "jump-C", "/tmp/jump-C", "#5865f2", new Date().toISOString(), new Date().toISOString()],
    );
    const task = await postJson(boardsRouter, `http://h/api/boards/${projectId}/tasks`, { text: "x" });
    const bad = await postJson(boardsRouter, `http://h/api/boards/${projectId}/tasks/${task.body.id}/assign-topic`, {
      assignedTopicId: "topic-that-does-not-exist",
    });
    expect(bad.status).toBe(400);
  });

  test("404 for unknown task id", async () => {
    const { ctx, boardsRouter } = await setup();
    const projectId = "proj-jump-D";
    ctx.db.run(
      "INSERT OR IGNORE INTO projects (id, name, path, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [projectId, "jump-D", "/tmp/jump-D", "#5865f2", new Date().toISOString(), new Date().toISOString()],
    );
    const bad = await postJson(
      boardsRouter,
      `http://h/api/boards/${projectId}/tasks/missing/assign-topic`,
      { assignedTopicId: null },
    );
    expect(bad.status).toBe(404);
  });
});

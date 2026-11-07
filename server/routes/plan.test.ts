import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { PLAN_HIERARCHY_DDL } from "../db/test-schema";
import { createPlanRouter } from "./plan";
import type { RouteHandler } from "../types";

let db: Database;
let router: RouteHandler;

beforeEach(() => {
  db = freshDb();
  db.run(PLAN_HIERARCHY_DDL);
  router = createPlanRouter(makeCtx(db, []));
  const t = new Date().toISOString();
  db.query(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES ('t1','p1','one','todo',?,?)`).run(t, t);
});

async function ok(method: string, path: string, body?: unknown, status = 200) {
  const res = (await call(router, method, path, body))!;
  expect(res.status).toBe(status);
  return res.json() as Promise<any>;
}

describe("/api/plan", () => {
  test("full flow: area → milestone → link → tree → unlink", async () => {
    const area = await ok("POST", "/api/plan/areas", { projectId: "p1", name: "Auth" }, 201);
    const ms = await ok("POST", "/api/plan/milestones", { areaId: area.id, title: "Login", expectedResult: "works", owner: "Anna", targetDate: "2026-12-01" }, 201);
    await ok("PUT", "/api/plan/links/t1", { milestoneId: ms.id });
    let tree = await ok("GET", "/api/plan?projectId=p1");
    expect(tree.projects[0].areas[0].milestones[0].tasks[0].id).toBe("t1");
    expect(tree.projects[0].areas[0].milestones[0].owner).toBe("Anna");
    expect(tree.projects[0].areas[0].milestones[0].targetDate).toBe("2026-12-01");
    await ok("DELETE", "/api/plan/links/t1");
    tree = await ok("GET", "/api/plan?projectId=p1");
    expect(tree.projects[0].unplaced.tasks).toHaveLength(1);
  });

  test("PATCH updates area and milestone", async () => {
    const area = await ok("POST", "/api/plan/areas", { projectId: "p1", name: "A" }, 201);
    const ms = await ok("POST", "/api/plan/milestones", { areaId: area.id, title: "M" }, 201);
    expect((await ok("PATCH", `/api/plan/areas/${area.id}`, { name: "B" })).name).toBe("B");
    const up = await ok("PATCH", `/api/plan/milestones/${ms.id}`, { owner: "Bo", status: "done" });
    expect(up).toMatchObject({ owner: "Bo", status: "done", title: "M" });
  });

  test("DELETE of area and milestone unlinks, never deletes cards", async () => {
    const area = await ok("POST", "/api/plan/areas", { projectId: "p1", name: "A" }, 201);
    const ms = await ok("POST", "/api/plan/milestones", { areaId: area.id, title: "M" }, 201);
    await ok("PUT", "/api/plan/links/t1", { milestoneId: ms.id });
    await ok("DELETE", `/api/plan/milestones/${ms.id}`);
    expect(db.query(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 1 });
    expect(db.query(`SELECT COUNT(*) AS n FROM plan_task_links`).get()).toEqual({ n: 0 });
    await ok("DELETE", `/api/plan/areas/${area.id}`);
    expect(db.query(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 1 });
  });

  test("sources: add and delete", async () => {
    const s = await ok("POST", "/api/plan/sources", { taskId: "t1", kind: "pr", label: "PR 1", url: "https://x" }, 201);
    expect((await ok("GET", "/api/plan")).projects[0].unplaced.tasks[0].sources).toHaveLength(1);
    await ok("DELETE", `/api/plan/sources/${s.id}`);
    expect((await ok("GET", "/api/plan")).projects[0].unplaced.tasks[0].sources).toHaveLength(0);
  });

  test("errors: 400 on missing fields, 404 on unknown ids", async () => {
    await ok("POST", "/api/plan/areas", { projectId: "p1" }, 400);
    await ok("POST", "/api/plan/milestones", { areaId: "nope", title: "x" }, 404);
    await ok("PUT", "/api/plan/links/t1", { milestoneId: "nope" }, 404);
    await ok("PATCH", "/api/plan/areas/nope", { name: "x" }, 404);
  });

  test("other paths fall through", async () => {
    expect(await call(router, "GET", "/api/other")).toBeNull();
  });
});

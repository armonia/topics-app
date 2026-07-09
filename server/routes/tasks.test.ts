import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, fingerprint TEXT, due_date TEXT,
    chat_id TEXT, created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, assigned_topic_id TEXT, archived INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

// Faithful copy of server/utils.ts:matchRoute (length-strict, decodes params).
function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"), xp = pathname.split("/");
  if (pp.length !== xp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

// Map known session keys → project path, so resolveSession takes the topic branch.
const SESSIONS: Record<string, { projectPath: string; name: string }> = {
  s1: { projectPath: "/proj/one", name: "topic-one" },
  s2: { projectPath: "/proj/two", name: "topic-two" },
};

function makeCtx(db: Database, broadcasts: any[]) {
  return {
    db,
    json: (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute,
    broadcastToAll: (m: any) => { broadcasts.push(m); },
    getTopicBySessionKey: (sk: string) => (SESSIONS[sk] ? ({ projectPath: SESSIONS[sk].projectPath, name: SESSIONS[sk].name } as any) : null),
  } as unknown as AppContext;
}

function call(router: any, method: string, path: string, body?: any) {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://x${path}`, init);
  return router(req, new URL(req.url), new URL(req.url).pathname, method) as Promise<Response | null>;
}

describe("tasks router (session-scoped)", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  test("POST create → 201, todo, broadcasts task:created", async () => {
    const resp = (await call(router, "POST", "/api/sessions/s1/tasks", { text: "Build it", priority: 3 }))!;
    expect(resp.status).toBe(201);
    const task = await resp.json();
    expect(task.status).toBe("todo");
    expect(task.text).toBe("Build it");
    expect(task.projectId.startsWith("one-")).toBe(true); // projectId = basename(projectPath) + hash
    expect(broadcasts.some(b => b.type === "task:created")).toBe(true);
  });

  test("GET list scope=project returns only this project's tasks", async () => {
    await call(router, "POST", "/api/sessions/s1/tasks", { text: "a" });
    await call(router, "POST", "/api/sessions/s2/tasks", { text: "b" });
    const resp = (await call(router, "GET", "/api/sessions/s1/tasks"))!;
    const { tasks } = await resp.json();
    expect(tasks.length).toBe(1);
    expect(tasks[0].text).toBe("a");
  });

  test("GET list scope=all crosses projects", async () => {
    await call(router, "POST", "/api/sessions/s1/tasks", { text: "a" });
    await call(router, "POST", "/api/sessions/s2/tasks", { text: "b" });
    const resp = (await call(router, "GET", "/api/sessions/s1/tasks?scope=all"))!;
    const { tasks } = await resp.json();
    expect(tasks.length).toBe(2);
  });

  test("POST comment → 201, broadcasts task:updated", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "note" }))!;
    expect(resp.status).toBe(201);
    expect(broadcasts.some(b => b.type === "task:updated")).toBe(true);
    const got = await (await call(router, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.comments[0].content).toBe("note");
    expect(got.comments[0].author).toBe("topic-one"); // signed server-side from session
  });

  test("PATCH agent → review opens approval; agent → done is 409", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const rev = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(rev.status).toBe(200);
    expect((await rev.json()).status).toBe("review");
    const done = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "done" }))!;
    expect(done.status).toBe(409);
    expect((await done.json()).code).toBe("agent_cannot_complete");
  });

  test("unbound session → 400 no_project", async () => {
    const resp = (await call(router, "POST", "/api/sessions/unknown/tasks", { text: "x" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).code).toBe("no_project");
  });

  test("cross-project access is 404 (IDOR guard)", async () => {
    const foreign = await (await call(router, "POST", "/api/sessions/s2/tasks", { text: "secret" }))!.json();
    // s1 (project 'one') must not read/patch/comment s2's ('two') task, even with its id.
    expect((await call(router, "GET", `/api/sessions/s1/tasks/${foreign.id}`))!.status).toBe(404);
    expect((await call(router, "PATCH", `/api/sessions/s1/tasks/${foreign.id}`, { status: "in_progress" }))!.status).toBe(404);
    expect((await call(router, "POST", `/api/sessions/s1/tasks/${foreign.id}/comments`, { content: "hi" }))!.status).toBe(404);
    // owner still has access
    expect((await call(router, "GET", `/api/sessions/s2/tasks/${foreign.id}`))!.status).toBe(200);
  });

  test("non-task path falls through (null)", async () => {
    const resp = await call(router, "GET", "/api/sessions/s1/other");
    expect(resp).toBeNull();
  });
});

describe("board router (human, project-scoped)", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  test("human create + PATCH to done (no review gate for humans)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "ship" }))!.json();
    expect(t.status).toBe("todo");
    const done = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "done" }))!;
    expect(done.status).toBe(200);
    expect((await done.json()).status).toBe("done");
  });

  test("review approve moves review → done", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" });
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).status).toBe("done");
  });

  test("DELETE archives → drops off list, broadcasts task:deleted", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    expect((await call(router, "DELETE", `/api/boards/pX/tasks/${t.id}`))!.status).toBe(200);
    const { tasks } = await (await call(router, "GET", "/api/boards/pX/tasks"))!.json();
    expect(tasks.length).toBe(0);
    expect(broadcasts.some(b => b.type === "task:deleted")).toBe(true);
  });

  test("human comment is authored 'user'", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    await call(router, "POST", `/api/boards/pX/tasks/${t.id}/comments`, { content: "hi" });
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.comments[0].author).toBe("user");
  });

  test("review with bad decision → 400", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "maybe" }))!;
    expect(resp.status).toBe(400);
  });
});

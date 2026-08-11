import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { createTaskService, LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, fingerprint TEXT, due_date TEXT,
    chat_id TEXT, created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, assigned_topic_id TEXT REFERENCES topics(id), archived INTEGER NOT NULL DEFAULT 0,
    assigned_agent_id TEXT, in_progress_at TEXT,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, dispatch_state TEXT, dispatch_error TEXT,
    parent_task_id TEXT REFERENCES tasks(id), output_url TEXT, plan_first INTEGER NOT NULL DEFAULT 0,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT, blocked_by_task_id TEXT REFERENCES tasks(id), reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1, preview_image TEXT,
    delivery_branch TEXT, delivery_commit TEXT, landing_state TEXT, landing_checked_at TEXT,
    checks_state TEXT, checks_at TEXT, checks_commit TEXT, checks_json TEXT,
    delivered_by TEXT, delivered_reason TEXT, created_by_topic_id TEXT
  )`);
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    max_agents_auto INTEGER, review_checks TEXT
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
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
// `topicId` feeds the own-steps carve-out (agent may close subtasks of the task
// bound to its topic).
const SESSIONS: Record<string, { projectPath: string; name: string; topicId?: string }> = {
  s1: { projectPath: "/proj/one", name: "topic-one", topicId: "top-s1" },
  s2: { projectPath: "/proj/two", name: "topic-two" },
  // A catch-all ("generale") dispatch: the topic's cwd is a per-task private dir
  // that maps to NO real board — the agent's own task lives on a different
  // project_id, reachable only via assigned_topic_id.
  sCatch: { projectPath: "/home/.openclaw/workspace/tasks/abc123", name: "generale-agent", topicId: "top-catch" },
};

function makeCtx(db: Database, broadcasts: any[]) {
  return {
    db,
    json: (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute,
    broadcastToAll: (m: any) => { broadcasts.push(m); },
    getTopicBySessionKey: (sk: string) => (SESSIONS[sk] ? ({ id: SESSIONS[sk].topicId, projectPath: SESSIONS[sk].projectPath, name: SESSIONS[sk].name } as any) : null),
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

  test("POST create → 201, backlog (agents create into intake, not the run-queue), broadcasts task:created", async () => {
    const resp = (await call(router, "POST", "/api/sessions/s1/tasks", { text: "Build it", priority: 3 }))!;
    expect(resp.status).toBe(201);
    const task = await resp.json();
    expect(task.status).toBe("backlog");
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

  test("POST comment with options → server-composed question block", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, {
      content: "Come procedo?", options: ["opzione A", "opzione B"],
    }))!;
    expect(resp.status).toBe(201);
    const c = await resp.json();
    expect(c.content).toBe("```question\nCome procedo?\n- opzione A\n- opzione B\n```");
  });

  test("POST comment over the agent cap → 400 comment_too_long (humans are uncapped)", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const long = "x".repeat(601);
    const resp = (await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: long }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).code).toBe("comment_too_long");
    // The same text on the HUMAN board surface is accepted.
    const ht = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "y" }))!.json();
    const hres = (await call(router, "POST", `/api/boards/pX/tasks/${ht.id}/comments`, { content: long }))!;
    expect(hres.status).toBe(201);
  });

  test("POST create with parent_task_id nests; cross-board parent is 404", async () => {
    const parent = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "epic" }))!.json();
    const kid = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "part", parent_task_id: parent.id }))!.json();
    expect(kid.parentTaskId).toBe(parent.id);
    // Parent on ANOTHER project (s2) must be unreachable (same IDOR shape).
    const foreign = await (await call(router, "POST", "/api/sessions/s2/tasks", { text: "far" }))!.json();
    const bad = (await call(router, "POST", "/api/sessions/s1/tasks", { text: "part", parent_task_id: foreign.id }))!;
    expect(bad.status).toBe(404);
    // GET of the parent lists the child.
    const got = await (await call(router, "GET", `/api/sessions/s1/tasks/${parent.id}`))!.json();
    expect(got.children.map((c: any) => c.id)).toEqual([kid.id]);
  });

  // L'incidente dell'11/08 riprodotto dalla porta che l'agent usa davvero: il
  // dispatcher rimette il task in coda MENTRE il turno gira (riavvio del server,
  // timeout, requeue) e `assigned_topic_id` va a NULL. Prima della provenienza,
  // da quel momento ogni step della propria checklist tornava 409 e la consegna
  // arrivava con la lista aperta.
  test("PATCH step→done regge il requeue del task padre (checklist dell'agent)", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-s1')");
    const parent = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "il mio task" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-s1', status = 'in_progress' WHERE id = ?").run(parent.id);
    const step = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "step 1", parent_task_id: parent.id }))!.json();
    // …il dispatcher rilascia (release: link azzerato, chip 'queued').
    db.prepare("UPDATE tasks SET assigned_topic_id = NULL, status = 'todo', dispatch_state = 'queued' WHERE id = ?").run(parent.id);
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${step.id}`, { status: "done" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).status).toBe("done");
  });

  test("PATCH agent → review opens approval; agent → done is 409", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    // A mute delivery bounces with coaching (409 review_needs_summary)…
    const mute = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(mute.status).toBe(409);
    expect((await mute.json()).code).toBe("review_needs_summary");
    // …a delivery summary unlocks the handoff.
    await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "fatto, guarda demo/" });
    const rev = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(rev.status).toBe(200);
    expect((await rev.json()).status).toBe("review");
    const done = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "done" }))!;
    expect(done.status).toBe(409);
    expect((await done.json()).code).toBe("agent_cannot_complete");
  });

  test("PATCH agent closes its OWN step (topicId threaded from the session)", async () => {
    // The dispatched task is bound to s1's topic; a step nests under it.
    db.run("INSERT INTO topics (id) VALUES ('top-s1')");
    const main = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "deliverable" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-s1' WHERE id = ?").run(main.id);
    const step = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "step 1", parent_task_id: main.id }))!.json();

    const done = (await call(router, "PATCH", `/api/sessions/s1/tasks/${step.id}`, { status: "done" }))!;
    expect(done.status).toBe(200);
    expect((await done.json()).status).toBe("done");
    // The MAIN task stays behind the human gate even for its own agent.
    const gated = (await call(router, "PATCH", `/api/sessions/s1/tasks/${main.id}`, { status: "done" }))!;
    expect(gated.status).toBe(409);
  });

  test("PATCH output_url round-trips; bad scheme is 400", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const ok = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { output_url: "http://localhost:5173" }))!;
    expect(ok.status).toBe(200);
    expect((await ok.json()).outputUrl).toBe("http://localhost:5173");
    const bad = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { output_url: "file:///etc/passwd" }))!;
    expect(bad.status).toBe(400);
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

  test("catch-all dispatch: agent reaches its OWN task via bound topic, not cwd", async () => {
    // The bug: a "generale" task's dispatch topic runs in a per-task private cwd
    // (~/.openclaw/workspace/tasks/<id8>) that maps to no real board, so scoping
    // by cwd 404'd every one of the agent's own task ops. It must resolve the
    // board from the task bound to the topic (assigned_topic_id) instead.
    db.prepare("INSERT INTO topics (id) VALUES ('top-catch')").run();
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at)
       VALUES ('t-catch', 'generale-tu1hp', 'fix quadra', 'in_progress', 'top-catch', ?, ?)`,
    ).run(ts, ts);

    // The agent (session sCatch, cwd = private task dir) can GET its own task…
    const got = (await call(router, "GET", "/api/sessions/sCatch/tasks/t-catch"))!;
    expect(got.status).toBe(200);
    expect((await got.json()).task.text).toBe("fix quadra");
    // …comment on it…
    const c = (await call(router, "POST", "/api/sessions/sCatch/tasks/t-catch/comments", { content: "sistemato" }))!;
    expect(c.status).toBe(201);
    // …and list its board (scope=project resolves to generale, not the cwd dir).
    const list = await (await call(router, "GET", "/api/sessions/sCatch/tasks"))!.json();
    expect(list.tasks.some((t: any) => t.id === "t-catch")).toBe(true);
  });

  test("catch-all scoping still guards other boards (no cross-board via topic)", async () => {
    db.prepare("INSERT INTO topics (id) VALUES ('top-catch')").run();
    const ts = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at)
       VALUES ('t-mine', 'generale-tu1hp', 'mine', 'in_progress', 'top-catch', ?, ?)`,
    ).run(ts, ts);
    // A task on a DIFFERENT board, not bound to this agent's topic.
    db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at)
       VALUES ('t-other', 'other-board', 'not yours', 'todo', ?, ?)`,
    ).run(ts, ts);
    expect((await call(router, "GET", "/api/sessions/sCatch/tasks/t-other"))!.status).toBe(404);
    expect((await call(router, "GET", "/api/sessions/sCatch/tasks/t-mine"))!.status).toBe(200);
  });
});

describe("board router (human, project-scoped)", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  test("human create + PATCH to done (no review gate for humans)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "ship", status: "todo" }))!.json();
    expect(t.status).toBe("todo");
    const done = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "done" }))!;
    expect(done.status).toBe(200);
    expect((await done.json()).status).toBe("done");
  });

  // I due rami del default di creazione via API. `todo` è la coda di
  // esecuzione: un task che ci nasce fa partire un agente entro pochi secondi
  // su un board con auto-dispatch. Un chiamante esterno (MCP, script,
  // integrazione) che scrive un task sta ANNOTANDO — il "vai" deve essere
  // scritto, non dedotto dal silenzio.
  test("POST senza status → backlog (annotare non è ordinare)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "solo un appunto" }))!.json();
    expect(t.status).toBe("backlog");
  });

  test("POST con status todo esplicito → todo (il «vai» si scrive)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "vai", status: "todo" }))!.json();
    expect(t.status).toBe("todo");
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

  // Le tab del task archiviato: la rotta chiama il teardown e mette gli id
  // toccati nel frame, perché il client deve DIMENTICARE quelle chiavi — non
  // ri-PUTtarle dal suo debounce (services/task-tab-teardown.ts).
  test("DELETE smonta le tab del task e mette il sottoalbero in task:deleted", async () => {
    const seen: string[] = [];
    const r = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      teardownTaskBrowserState: (taskId) => {
        seen.push(taskId);
        return { taskIds: [taskId, "figlio-1"] };
      },
    });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    await call(r, "DELETE", `/api/boards/pX/tasks/${t.id}`);

    expect(seen).toEqual([t.id]);
    const frame = broadcasts.find((b) => b.type === "task:deleted");
    expect(frame.taskIds).toEqual([t.id, "figlio-1"]);
  });

  test("senza il teardown iniettato, task:deleted porta almeno la root", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    await call(router, "DELETE", `/api/boards/pX/tasks/${t.id}`);
    expect(broadcasts.find((b) => b.type === "task:deleted").taskIds).toEqual([t.id]);
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

  test("create born in Todo signals the dispatcher like a drag (onEnterTodo)", async () => {
    const entered: Array<[string, string]> = [];
    const left: string[] = [];
    const fakeDispatcher = {
      onEnterTodo: (pid: string, tid: string) => entered.push([pid, tid]),
      onLeaveTodo: (tid: string) => left.push(tid),
    } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fakeDispatcher);
    // Born in todo → same "vai" signal as a drag into Todo.
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "run me", status: "todo" }))!.json();
    expect(entered).toEqual([["pX", t.id]]);
    // Born in backlog (intake) → no signal.
    await call(r, "POST", "/api/boards/pX/tasks", { text: "later", status: "backlog" });
    expect(entered.length).toBe(1);
  });

  test("comment on a STEP of a root in review re-kicks the agent (reject + resume with step ref)", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-x')");
    const resumed: Array<[string, string]> = [];
    const fake = {
      onEnterTodo() {}, onLeaveTodo() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake);

    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "deliverable", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-x' WHERE id = ?").run(root.id);
    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step uno", status: "backlog", parentTaskId: root.id }))!.json();
    await call(r, "PATCH", `/api/boards/pX/tasks/${root.id}`, { status: "review" }); // human hand-off

    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${step.id}/comments`, { content: "copri anche il caso B" }))!;
    expect(resp.status).toBe(201);
    expect(resumed.length).toBe(1);
    expect(resumed[0][0]).toBe(root.id);
    expect(resumed[0][1]).toContain("step uno");
    expect(resumed[0][1]).toContain("copri anche il caso B");
    // The root is back in the agent's hands…
    const got = await (await call(r, "GET", `/api/boards/pX/tasks/${root.id}`))!.json();
    expect(got.task.status).toBe("in_progress");
    // …and a further step comment while it works is STILL handed to the same
    // agent through resume(): the router delivers every human comment on a
    // dispatched subtree via resume(), whether the root is in review (reject +
    // re-kick) or already in_progress (steering). The buffer-vs-run split for
    // an in_progress root — buffer mid-turn, continue if idle, never a fresh
    // spawn — lives in the REAL dispatcher.resume() and is covered by its own
    // tests; this fake only records that the delivery was routed.
    await call(r, "POST", `/api/boards/pX/tasks/${step.id}/comments`, { content: "nota a margine" });
    expect(resumed.length).toBe(2);
    expect(resumed[1][0]).toBe(root.id);
    expect(resumed[1][1]).toContain("nota a margine");
  });

  test("comment with media reaches the thread AND the resumed agent (paths in the message)", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-m')");
    const resumed: Array<[string, string]> = [];
    const fake = {
      onEnterTodo() {}, onLeaveTodo() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "deliverable", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-m' WHERE id = ?").run(root.id);
    await call(r, "PATCH", `/api/boards/pX/tasks/${root.id}`, { status: "review" });

    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${root.id}/comments`, {
      content: "il layout deve essere così", media: ["/tmp/mockup.png"],
    }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).media).toEqual(["/tmp/mockup.png"]);
    expect(resumed.length).toBe(1);
    expect(resumed[0][1]).toContain("il layout deve essere così");
    expect(resumed[0][1]).toContain("/tmp/mockup.png"); // the agent can read the file
  });

  test("media outside the /api/media allowlist is DROPPED at write time (never stored, never fed to the agent)", async () => {
    const ctx = makeCtx(db, broadcasts) as any;
    ctx.isPathAllowed = (p: string) => p.startsWith("/allowed/");
    const r = createTasksRouter(ctx);
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${t.id}/comments`, {
      content: "con allegati", media: ["/allowed/img.png", "/Users/x/.ssh/id_rsa"],
    }))!;
    expect((await resp.json()).media).toEqual(["/allowed/img.png"]);
  });

  test("adding a step under a root in review re-kicks the agent (no comment ceremony)", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-y')");
    const resumed: Array<[string, string]> = [];
    const fake = {
      onEnterTodo() {}, onLeaveTodo() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake);

    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "deliverable", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-y' WHERE id = ?").run(root.id);
    await call(r, "PATCH", `/api/boards/pX/tasks/${root.id}`, { status: "review" });

    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "nuovo step urgente", status: "backlog", parentTaskId: root.id }))!.json();
    expect(resumed.length).toBe(1);
    expect(resumed[0][0]).toBe(root.id);
    expect(resumed[0][1]).toContain("nuovo step urgente");
    const got = await (await call(r, "GET", `/api/boards/pX/tasks/${root.id}`))!.json();
    expect(got.task.status).toBe("in_progress");
    // While the agent works, further additions just land in the tree.
    await call(r, "POST", "/api/boards/pX/tasks", { text: "altro", status: "backlog", parentTaskId: step.id });
    expect(resumed.length).toBe(1);
    // A top-level task never re-kicks anyone.
    await call(r, "POST", "/api/boards/pX/tasks", { text: "slegato", status: "backlog" });
    expect(resumed.length).toBe(1);
  });

  test("POST move relocates the task and broadcasts to BOTH boards", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "wanderer" }))!.json();
    broadcasts.length = 0;
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${t.id}/move`, { toProjectId: "pY" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).projectId).toBe("pY");
    const pids = broadcasts.filter((b) => b.type === "task:updated").map((b) => b.projectId);
    expect(pids).toContain("pX");
    expect(pids).toContain("pY");
  });

  test("POST stop parks the task (backlog, unbound) and aborts the turn — no auto-requeue", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-z')");
    const aborted: string[] = [];
    const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake, { abortTurn: async (sk: string) => { aborted.push(sk); } });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "sbagliato", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-z', dispatch_state = 'working' WHERE id = ?").run(t.id);

    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${t.id}/stop`, {}))!;
    expect(resp.status).toBe(200);
    const parked = await resp.json();
    expect(parked.status).toBe("backlog");
    expect(parked.assignedTopicId).toBeNull();
    expect(aborted).toEqual(["topic:top-z"]); // "topic:" + id.slice(0,8)
    // The reason is on the thread (visible feedback, not just a chip).
    const got = await (await call(r, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.comments.some((c: any) => /Fermato da te/.test(c.content))).toBe(true);
    // Nothing running anymore → 409.
    expect((await call(r, "POST", `/api/boards/pX/tasks/${t.id}/stop`, {}))!.status).toBe(409);
  });

  test("DELETE su un task con l'agent al lavoro taglia il turno prima di archiviare", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-arch')");
    const aborted: string[] = [];
    const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake, { abortTurn: async (sk: string) => { aborted.push(sk); } });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "ripensamento", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-arch', dispatch_state = 'working' WHERE id = ?").run(t.id);

    const resp = (await call(r, "DELETE", `/api/boards/pX/tasks/${t.id}`))!;
    expect(resp.status).toBe(200);
    // Il turno è stato abortito, non lasciato girare su una riga invisibile.
    expect(aborted).toEqual(["topic:top-arch"]);
    const row = db.prepare("SELECT archived, status, assigned_topic_id, dispatch_state FROM tasks WHERE id = ?").get(t.id) as any;
    expect(row.archived).toBe(1);
    expect(row.assigned_topic_id).toBeNull();
    // E il task non conta più come "in corso": è questo che falsava il tetto di
    // concorrenza (il claim conta le righe in_progress non archiviate).
    expect(row.status).toBe("backlog");
  });

  test("DELETE su un task senza agent non aborta niente", async () => {
    const aborted: string[] = [];
    const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake, { abortTurn: async (sk: string) => { aborted.push(sk); } });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "innocuo", status: "todo" }))!.json();
    expect((await call(r, "DELETE", `/api/boards/pX/tasks/${t.id}`))!.status).toBe(200);
    expect(aborted).toEqual([]);
    const row = db.prepare("SELECT archived, status FROM tasks WHERE id = ?").get(t.id) as any;
    expect(row.archived).toBe(1);
    expect(row.status).toBe("todo"); // nessun parcheggio spurio
  });

  test("PATCH agent refines title/description of its task", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "titolo grezzo dal composer" }))!.json();
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { text: "Titolo pulito", description: "Dettagli utili" }))!;
    expect(resp.status).toBe(200);
    const up = await resp.json();
    expect(up.text).toBe("Titolo pulito");
    expect(up.description).toBe("Dettagli utili");
  });

  test("GET /api/all-boards/projects hashes known dirs (dedup, sorted); POST scaffolds", async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ws = mkdtempSync(join(tmpdir(), "tasks-router-ws-"));
    try {
      const r = createTasksRouter(makeCtx(db, broadcasts), undefined, {
        listProjectDirs: () => ["/x/proj", "/x/proj/", "/y/alpha"],
        workspaceDir: ws,
      });
      const list = await (await call(r, "GET", "/api/all-boards/projects"))!.json();
      expect(list.projects.map((p: any) => p.name)).toEqual(["alpha", "proj"]);
      // Same hash the boards key on (locked by the projectIdForPath test).
      expect(list.projects[1].projectId).toBe("proj-xwac8t");

      const created = (await call(r, "POST", "/api/all-boards/projects", { name: "nuovo-prog" }))!;
      expect(created.status).toBe(201);
      const proj = await created.json();
      expect(proj.path).toBe(join(ws, "nuovo-prog"));
      expect(existsSync(join(ws, "nuovo-prog", "CLAUDE.md"))).toBe(true);
      expect(readFileSync(join(ws, "nuovo-prog", "CLAUDE.md"), "utf8")).toContain("nuovo-prog");
      // Collision = 409, never a silent bind.
      expect((await call(r, "POST", "/api/all-boards/projects", { name: "nuovo-prog" }))!.status).toBe(409);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("un progetto creato per nome nasce nella CARTELLA DEI PROGETTI, non nel workspace", async () => {
    const { mkdtempSync, mkdirSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ws = mkdtempSync(join(tmpdir(), "tasks-router-ws-"));
    const home = mkdtempSync(join(tmpdir(), "tasks-router-home-"));
    const projects = join(home, "Projects");
    mkdirSync(join(projects, "alpha"), { recursive: true });
    mkdirSync(join(projects, "beta"), { recursive: true });
    try {
      // Store finto ma con il contratto vero: creare FUORI dal workspace deve
      // REGISTRARE il progetto, o l'indice non lo conosce e sparisce al reload.
      const rows: Array<{ name: string; slug: string; path: string }> = [];
      const projectStore = {
        slugify: (n: string) => n.toLowerCase(),
        getByPath: (path: string) => rows.find((r) => r.path === path) ?? null,
        create: (input: { name: string; slug: string; path: string }) => {
          if (rows.some((r) => r.slug === input.slug)) throw new Error("slug in uso");
          rows.push(input);
          return input;
        },
      };
      const ctx = makeCtx(db, broadcasts);
      (ctx as unknown as { projectStore: unknown }).projectStore = projectStore;
      const r = createTasksRouter(ctx, undefined, {
        listProjectDirs: () => [join(projects, "alpha"), join(projects, "beta")],
        workspaceDir: ws,
      });

      // Il GET lo DICHIARA, così il client può stamparlo prima di creare.
      const list = await (await call(r, "GET", "/api/all-boards/projects"))!.json();
      expect(list.newProjectDir).toBe(projects);

      const created = (await call(r, "POST", "/api/all-boards/projects", { name: "terzo" }))!;
      expect(created.status).toBe(201);
      const proj = await created.json();
      // Accanto ad alpha e beta — non sepolto in ~/.openclaw/workspace.
      expect(proj.path).toBe(join(projects, "terzo"));
      expect(existsSync(join(projects, "terzo", "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(ws, "terzo"))).toBe(false);
      // Registrato: è così che l'indice continuerà a vederlo.
      expect(projectStore.getByPath(join(projects, "terzo"))).toBeTruthy();

      // Slug già occupato → non lascia la cartella orfana: ne deriva un altro.
      rows.push({ name: "quarto", slug: "quarto", path: "/altrove/quarto" });
      expect((await call(r, "POST", "/api/all-boards/projects", { name: "quarto" }))!.status).toBe(201);
      expect(projectStore.getByPath(join(projects, "quarto"))).toBeTruthy();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("delivery snapshot: entering review records branch + commit, once", async () => {
    // The audit's whole premise: the branch is reaped on landing, so the COMMIT
    // recorded at delivery is the only durable handle on "what was delivered".
    let calls = 0;
    const r = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskDeliveryRef: async () => { calls += 1; return { branch: "topics/purple-finch", commit: "56aaa3f9".padEnd(40, "0") }; },
    });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const rev = await (await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" }))!.json();
    expect(rev.deliveryBranch).toBe("topics/purple-finch");
    expect(rev.deliveryCommit.startsWith("56aaa3f9")).toBe(true);
    expect(calls).toBe(1);
    // A second PATCH that does NOT re-enter review must not re-snapshot: the
    // delivery is the moment of hand-off, not "the last time anything changed".
    await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { priority: 1 });
    expect(calls).toBe(1);
  });

  test("delivery snapshot: «non ho prodotto codice» si dice, e non si inventa un commit", async () => {
    // Un branch che porta SOLO commit ereditati non ha un commit proprio da
    // registrare: la consegna deve dirlo (branch sì, commit vuoto), non puntare
    // alla punta del ramo, che è il lavoro di un'altra sessione.
    const r = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskDeliveryRef: async () => ({ branch: "topics/purple-finch", commit: null }),
    });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const rev = await (await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" }))!.json();
    expect(rev.deliveryBranch).toBe("topics/purple-finch");
    expect(rev.deliveryCommit).toBeNull();
  });

  test("delivery snapshot: an in-place task (no branch worktree) records nothing", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts), undefined, { taskDeliveryRef: async () => null });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const rev = await (await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" }))!.json();
    expect(rev.deliveryCommit).toBeNull();
    expect(rev.landingState).toBeNull();
  });

  test("delivery snapshot: a git failure never refuses the delivery", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskDeliveryRef: async () => { throw new Error("git exploded"); },
    });
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).status).toBe("review");
  });

  test("GET /api/all-boards/tasks is the global cross-project feed", async () => {
    await call(router, "POST", "/api/boards/pX/tasks", { text: "in X" });
    await call(router, "POST", "/api/boards/pY/tasks", { text: "in Y" });
    const resp = (await call(router, "GET", "/api/all-boards/tasks"))!;
    expect(resp.status).toBe(200);
    const { tasks } = await resp.json();
    expect(tasks.length).toBe(2);
    expect(new Set(tasks.map((t: any) => t.projectId))).toEqual(new Set(["pX", "pY"]));
    // status filter still applies across projects
    await call(router, "PATCH", `/api/boards/pX/tasks/${tasks.find((t:any)=>t.projectId==='pX').id}`, { status: "done" });
    const done = await (await call(router, "GET", "/api/all-boards/tasks?status=done"))!.json();
    expect(done.tasks.length).toBe(1);
    expect(done.tasks[0].projectId).toBe("pX");
  });

  test("GET /api/all-boards/tasks/:taskId resolves an id at ANY depth (the feed is rootsOnly)", async () => {
    const root = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "radice" }))!.json();
    const step = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "step", parentTaskId: root.id }))!.json();
    const nested = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "nipote", parentTaskId: step.id }))!.json();

    // La premessa del guasto: il feed non contiene i sottotask.
    const feed = await (await call(router, "GET", "/api/all-boards/tasks"))!.json();
    expect(feed.tasks.map((t: any) => t.id)).toEqual([root.id]);

    // La porta: ognuno di quegli id si risolve, col suo projectId.
    for (const t of [root, step, nested]) {
      const resp = (await call(router, "GET", `/api/all-boards/tasks/${t.id}`))!;
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.task.id).toBe(t.id);
      expect(body.task.projectId).toBe("pX");
    }
  });

  test("GET /api/all-boards/tasks/:taskId — un id ignoto è 200 + task:null, non un errore", async () => {
    const resp = (await call(router, "GET", "/api/all-boards/tasks/non-esiste"))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).task).toBeNull();
  });

  test("GET /api/all-boards/tasks/:taskId risolve anche un task archiviato (deep-link vecchio)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "vecchio" }))!.json();
    await call(router, "DELETE", `/api/boards/pX/tasks/${t.id}`);
    const feed = await (await call(router, "GET", "/api/all-boards/tasks"))!.json();
    expect(feed.tasks.some((x: any) => x.id === t.id)).toBe(false);
    const body = await (await call(router, "GET", `/api/all-boards/tasks/${t.id}`))!.json();
    expect(body.task?.id).toBe(t.id);
  });
});

describe("board settings route", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => { db = freshDb(); broadcasts = []; router = createTasksRouter(makeCtx(db, broadcasts)); });

  test("GET returns defaults (auto off, cap 2)", async () => {
    const s = await (await call(router, "GET", "/api/boards/pX/settings"))!.json();
    expect(s.autoDispatch).toBe(false);
    expect(s.maxAgents).toBe(2);
  });

  test("PATCH upserts + broadcasts board:settings", async () => {
    const resp = (await call(router, "PATCH", "/api/boards/pX/settings", { autoDispatch: true, maxAgents: 3 }))!;
    expect(resp.status).toBe(200);
    const s = await resp.json();
    expect(s.autoDispatch).toBe(true);
    expect(s.maxAgents).toBe(3);
    expect(broadcasts.some((b) => b.type === "board:settings" && b.projectId === "pX")).toBe(true);
    // autoDispatch is global → the pill on EVERY board must hear about it.
    expect(broadcasts.some((b) => b.type === "board:dispatch" && b.autoDispatch === true)).toBe(true);
    // persisted
    expect((await (await call(router, "GET", "/api/boards/pX/settings"))!.json()).autoDispatch).toBe(true);
  });

  test("PATCH rejects an invalid effort with 400", async () => {
    const resp = (await call(router, "PATCH", "/api/boards/pX/settings", { dispatchEffort: "turbo" }))!;
    expect(resp.status).toBe(400);
  });

  test("all-boards/settings: GET default off, PATCH flips globally + broadcasts board:dispatch", async () => {
    let g = await (await call(router, "GET", "/api/all-boards/settings"))!.json();
    expect(g.autoDispatch).toBe(false);

    const resp = (await call(router, "PATCH", "/api/all-boards/settings", { autoDispatch: true }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).autoDispatch).toBe(true);
    expect(broadcasts.some((b) => b.type === "board:dispatch" && b.autoDispatch === true)).toBe(true);

    // Every per-board read now reflects the global switch.
    expect((await (await call(router, "GET", "/api/boards/pX/settings"))!.json()).autoDispatch).toBe(true);
    expect((await (await call(router, "GET", "/api/boards/pY/settings"))!.json()).autoDispatch).toBe(true);

    // Bad body = 400, no broadcast storm.
    expect((await call(router, "PATCH", "/api/all-boards/settings", { autoDispatch: "yes" }))!.status).toBe(400);
  });
});

describe("approve decoupled from landing", () => {
  let db: Database; let broadcasts: any[];
  let merges: string[]; let resumed: Array<[string, string]>; let router: any;

  beforeEach(() => {
    db = freshDb(); broadcasts = []; merges = []; resumed = [];
    const autoMerge = {
      tryMerge: async (taskId: string) => { merges.push(taskId); return { status: "nothing" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    router = createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge });
  });

  async function reviewTask(): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  test("trascinare una card in Done LANDA: `done` deve voler dire atterrato", async () => {
    // Il land era un'azione a parte, e il gesto piu' naturale — trascinare la
    // card in Done — chiudeva il lavoro lasciandolo sul suo ramo, in silenzio.
    // Misurato il 10/08: 17 card chiuse in otto ore col contenuto NON su main.
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await new Promise((r) => setTimeout(r, 0)); // il land e' fire-and-forget
    expect(merges).toContain(id);
  });

  test("una card SENZA ramo di consegna non tenta nessun land", async () => {
    // Il controllo del test qui sopra: una nota chiusa a mano non deve svegliare
    // git, o ogni gesto sulla board diventerebbe un'operazione sul repo.
    const id = await reviewTask();
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await new Promise((r) => setTimeout(r, 0));
    expect(merges).not.toContain(id);
  });

  test("approve accepts the task WITHOUT merging (no azioni da sotto)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "approve" }))!.json();
    expect(t.status).toBe("done");
    expect(merges).toEqual([]); // approve no longer merges
  });

  test("picking the 'Landa su main' option approves + merges (not a reject/resume)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: LAND_ACTION_LABEL }))!.json();
    expect(t.status).toBe("done"); // accepted, not sent back
    expect(merges).toEqual([id]);  // and landed
    expect(resumed).toEqual([]);   // NOT resumed as a rejection
  });

  test("POST /land approves + merges on demand", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!.json();
    expect(t.status).toBe("done");
    expect(merges).toEqual([id]);
  });

  test("un land in CONFLITTO ritira la card da done dicendo perché, e firma la macchina", async () => {
    // La riga di storico diceva «user → In corso»: identica a quella che scrive
    // un umano quando ritira una consegna a mano — mentre qui l'umano aveva
    // cliccato «Landa su main» e il ritiro è del merge. Chi rivede leggeva un
    // dietrofront senza causa e senza il suo autore vero.
    db = freshDb(); broadcasts = []; resumed = [];
    const autoMerge = {
      tryMerge: async () => ({ status: "conflict" }),
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    router = createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge });

    const id = await reviewTask();
    await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {});
    await new Promise((r) => setTimeout(r, 10)); // il land gira fire-and-forget

    const svc = createTaskService(db);
    const t = svc.get(id)!;
    expect(t.task.status).toBe("in_progress");     // ritirata da done
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");              // non «user»: non l'ha mossa l'umano
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "done", to: "in_progress", reason: "il land ha fatto conflitto con main",
    });
    // E l'agent riparte con l'istruzione, come prima.
    expect(resumed.length).toBe(1);
    expect(resumed[0]![1]).toContain("conflitto");
    // L'istruzione dice il gesto GIUSTO: rifare la base del proprio ramo. Diceva
    // «git merge main, oppure rebase», e il merge non toglieva il conflitto —
    // tre card ci sono rimaste incastrate finché non gliel'ho spiegato a mano.
    expect(resumed[0]![1]).toContain("git rebase main");
    expect(resumed[0]![1]).not.toContain("git merge main");
  });

  /**
   * Il guasto dell'11/08 (card `2e6964cb`): il land NON è riuscito, il thread lo
   * scriveva onestamente — «⚠️ Land NON riuscito … Il branch del task NON è su
   * main» — e lo STATO diceva il contrario. Sulla board la card stava in Done
   * come tutte le altre, cioè nell'unica colonna che nessuno riapre, col codice
   * fuori da main e un GC dei worktree che può potare quel ramo.
   */
  async function landSkipping(code: string | undefined): Promise<{ id: string; db: Database; resumed: Array<[string, string]> }> {
    const d = freshDb(); const b: any[] = []; const r: Array<[string, string]> = [];
    const autoMerge = {
      tryMerge: async () => ({ status: "skipped", reason: "non so quali commit siano suoi", code }),
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { r.push([id, msg]); },
    } as any;
    const rt = createTasksRouter(makeCtx(d, b), dispatcher, { autoMerge });
    d.run("INSERT INTO topics (id) VALUES ('top-s')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-s', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('cs', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20)); // il land gira fire-and-forget
    return { id: t.id, db: d, resumed: r };
  }

  test("un land che NON isola i commit ritira la card da done, con la ragione nello STATO", async () => {
    const { id, db: d, resumed: r } = await landSkipping("unisolable");
    const t = createTaskService(d).get(id)!;
    expect(t.task.status).toBe("in_progress");          // NON resta in Done
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");                   // l'ha ritirata la macchina, non l'umano
    // La ragione sta nella riga di storico, non solo nel thread: il thread lo si
    // legge aprendo la card, lo stato si vede dalla board.
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "done", to: "in_progress", reason: "il land non ha saputo isolare i commit della card",
    });
    // E l'agente riparte con il gesto che ripara il ramo.
    expect(r.length).toBe(1);
    expect(r[0]![1]).toContain("git rebase main");
  });

  test("un land fallito per colpa dell'OSPITE torna in review (l'agente non può ripararlo)", async () => {
    const { id, db: d, resumed: r } = await landSkipping("dirty-checkout");
    expect(createTaskService(d).get(id)!.task.status).toBe("review");
    expect(r).toEqual([]);
  });

  test("«non c'era niente da atterrare» lascia la card chiusa: è l'unico skip innocuo", async () => {
    // Il controllo dei due test qui sopra. Se il ritiro scattasse su ogni skip,
    // una nota chiusa a mano rimbalzerebbe fuori da Done a ogni gesto.
    const { id, db: d } = await landSkipping("no-branch");
    expect(createTaskService(d).get(id)!.task.status).toBe("done");
  });

  test("dopo un land il verdetto di atterraggio è ri-chiesto SUBITO per quella card", async () => {
    // `landingState` lo scrive una passata ogni 30 minuti: senza questa chiamata
    // la card mostra il verdetto del giro precedente — rosso su lavoro appena
    // atterrato — e un semaforo in ritardo si smette di guardare.
    const audited: string[] = [];
    const am = {
      tryMerge: async () => ({ status: "nothing" }),
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const rt = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      autoMerge: am,
      auditTaskLanding: async (taskId: string) => { audited.push(taskId); },
    });
    db.run("INSERT INTO topics (id) VALUES ('top-a')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id='top-a', status='review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('ca', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 20));
    expect(audited).toEqual([t.id]);
  });

  test("picking 'Landa e pubblica' approves + lands (routes to land+publish, not a reject)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: PUBLISH_ACTION_LABEL }))!.json();
    // Deterministic routing: the publish label is accepted + landed, and does NOT
    // resume the agent (the publish PUSH itself runs in the fire-and-forget chain
    // — no git in this harness — but the interception routes correctly).
    expect(t.status).toBe("done"); // accepted
    expect(merges).toEqual([id]);  // land ran first (merges.push is synchronous)
    expect(resumed).toEqual([]);   // NOT resumed as a rejection
  });

  /**
   * Il land riceve lo SCATTO della consegna, e ciò che non coincide finisce nel
   * thread. Senza questa riga chi ha aggiunto un commit dopo la consegna — o chi
   * ha consegnato da un ramo che la card non usa più — crede di aver pubblicato
   * quello che ha visto: è così che l'11/08 `lint` è tornato rosso su main senza
   * che nessuno collegasse le due cose.
   */
  test("land: la consegna arriva al merge, e la deriva viene detta nel thread", async () => {
    const seen: any[] = [];
    const am = {
      tryMerge: async (_id: string, _t: string, delivery: any) => {
        seen.push(delivery);
        return { status: "merged", commit: "cafe123", branch: "topics/consegnato", repoPath: "/repo",
          touchedClient: false, touchedServer: false, touchedNative: false,
          landedNotLive: false, checkoutBranch: "main",
          deliveryDrift: "il ramo porta 1 commit aggiunto DOPO la consegna" };
      },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const r2 = createTasksRouter(makeCtx(db, broadcasts), undefined, { autoMerge: am });
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET assigned_topic_id='top-2', status='review', delivery_branch='topics/consegnato', delivery_commit='bdfcf0cb' WHERE id = ?",
    ).run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c9', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());

    await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    // Il land gira staccato dalla risposta: si aspetta che la catena dreni.
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toEqual([{ branch: "topics/consegnato", commit: "bdfcf0cb" }]);
    const said = db.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(t.id) as Array<{ content: string }>;
    expect(said.some((c) => c.content.includes("Land ≠ consegna") && c.content.includes("DOPO la consegna"))).toBe(true);
  });
});

/**
 * Gate 1.2 — checks pre-review. Terzo cancello strutturale dopo
 * `review_needs_commit` e `review_needs_summary`: i comandi dichiarati dall'umano
 * sulla board girano NEL WORKTREE del task, e un rosso rimanda la consegna
 * all'agente con l'output vero invece di un "rifiutato" senza motivo.
 */
describe("checks pre-review (gate review_needs_green_checks)", () => {
  let db: Database; let broadcasts: any[]; let cwd: string;

  beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "tasks-router-checks-")); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });
  beforeEach(() => { db = freshDb(); broadcasts = []; });

  const mk = (over?: Partial<Parameters<typeof createTasksRouter>[2]>) =>
    createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      ...over,
    } as any);

  /** Consegna agente pronta al gate: task + commento di sintesi (gate #2 passato). */
  async function delivered(router: any) {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "fatto, guarda demo/" });
    return t;
  }

  const declare = (router: any, projectId: string, cmds: string[]) =>
    call(router, "PATCH", `/api/boards/${projectId}/settings`, { reviewChecks: cmds.map((cmd) => ({ name: cmd, cmd })) });

  test("board senza comandi: il gate non esiste e non scrive un falso verde", async () => {
    let asked = 0;
    const r = mk({ taskCheckoutRef: async () => { asked += 1; return { cwd, commit: "abc1234" }; } });
    const t = await delivered(r);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
    // null, NON 'pass': nessuno ha verificato niente.
    expect((await resp.json()).checksState).toBeNull();
    expect(asked).toBe(0); // nemmeno il git viene disturbato
  });

  test("verdi: la consegna passa e resta l'evidenza (stato, commit, comandi)", async () => {
    const r = mk();
    const t = await delivered(r);
    await declare(r, t.projectId, ["true", "exit 0"]);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).toBe("review");
    expect(got.task.checksState).toBe("pass");
    expect(got.task.checksCommit).toBe("abc1234");
    expect(got.task.checks.map((c: any) => c.ok)).toEqual([true, true]);
    // …e il reviewer trova il verdetto nel thread, non solo in un campo.
    expect(got.comments.some((c: any) => c.author === "system" && c.content.includes("Checks pre-review"))).toBe(true);
  });

  test("rosso: 409 con L'OUTPUT del comando, e il task NON entra in review", async () => {
    const r = mk();
    const t = await delivered(r);
    await declare(r, t.projectId, ["echo bella-riga-rossa >&2; exit 3"]);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(409);
    const err = await resp.json();
    expect(err.code).toBe("review_needs_green_checks");
    // Il motivo vero, non "consegna rifiutata": la riparazione parte da qui.
    expect(err.error).toContain("bella-riga-rossa");
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).not.toBe("review");
    expect(got.task.checksState).toBe("fail");
  });

  test("la board sa che stanno girando: broadcast 'running' PRIMA dell'esito", async () => {
    const r = mk();
    const t = await delivered(r);
    await declare(r, t.projectId, ["true"]);
    await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" });
    const states = broadcasts.filter((b) => b.type === "task:updated" && b.task?.id === t.id).map((b) => b.task.checksState);
    expect(states).toContain("running");
    expect(states.indexOf("running")).toBeLessThan(states.lastIndexOf("pass"));
  });

  test("task in-place (nessun worktree di branch): gate saltato, non 'verde'", async () => {
    const r = mk({ taskCheckoutRef: async () => null });
    const t = await delivered(r);
    await declare(r, t.projectId, ["exit 1"]);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).checksState).toBeNull();
  });

  test("una domanda a metà lavoro non fa girare niente", async () => {
    const r = mk();
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await declare(r, t.projectId, ["exit 1"]);
    await call(r, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "Come procedo?", options: ["A", "B"] });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).checksState).toBeNull();
  });

  test("un git rotto non può rifiutare una consegna", async () => {
    const r = mk({ taskCheckoutRef: async () => { throw new Error("git esploso"); } });
    const t = await delivered(r);
    await declare(r, t.projectId, ["exit 1"]);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
  });

  test("approve con i checks rossi: 409 checks_failed, ma `force` è la scelta dell'umano", async () => {
    const r = mk();
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" });
    // Rosso registrato (come lo scriverebbe il gate su una consegna agente).
    db.prepare("UPDATE tasks SET checks_state = 'fail', checks_json = ? WHERE id = ?")
      .run(JSON.stringify([{ name: "bun test", cmd: "bun test", ok: false, code: 1, ms: 10, timedOut: false, tail: "1 fail" }]), t.id);

    const blocked = (await call(r, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve" }))!;
    expect(blocked.status).toBe(409);
    const err = await blocked.json();
    expect(err.code).toBe("checks_failed");
    expect(err.error).toContain("bun test"); // dice QUALE comando

    // Rifiutare resta sempre possibile: il gate non intrappola il task.
    const ok = (await call(r, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve", force: true }))!;
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("done");
  });

  test("approve con i checks VERDI non chiede nessun force", async () => {
    const r = mk();
    const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    await call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "review" });
    db.prepare("UPDATE tasks SET checks_state = 'pass' WHERE id = ?").run(t.id);
    const ok = (await call(r, "POST", `/api/boards/pX/tasks/${t.id}/review`, { decision: "approve" }))!;
    expect(ok.status).toBe(200);
  });
});

/**
 * Intake che collega — la barra del task.
 *
 * Due invarianti, e sono l'uno il complemento dell'altro:
 *  1. testo nuovo su un tema già aperto → esce una PROPOSTA, e la board resta
 *     esattamente com'era (nessun task toccato: proporre non è attribuire);
 *  2. il collegamento esiste solo se qualcuno lo ha scelto — e quando è una
 *     catena, il task NON parte e lo dice (nei due thread, e come chip).
 */
describe("intake: propone e mostra, non attribuisce", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  const PID = "pIntake";
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  const FEEDBACK = "Feedback grafici sulla landing: spaziature e contrasto dei chip";
  const NUOVI = "Altri feedback grafici sulla landing: contrasto dei chip e spaziature";

  async function openCard(status = "in_progress") {
    const t = await (await call(router, "POST", `/api/boards/${PID}/tasks`, { text: FEEDBACK, status: "todo" }))!.json();
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, t.id);
    return t;
  }
  const suggest = async (text: string) =>
    (await (await call(router, "POST", `/api/boards/${PID}/intake/suggest`, { text }))!.json()).proposal;

  test("testo sullo stesso tema di una card aperta → PROPOSTA, non attribuzione", async () => {
    const card = await openCard();
    const before = db.prepare("SELECT COUNT(*) c FROM tasks").get() as any;
    broadcasts.length = 0; // da qui in poi ogni evento è colpa della proposta

    const proposal = await suggest(NUOVI);
    expect(proposal).not.toBeNull();
    expect(proposal.targetTaskId).toBe(card.id);
    expect(proposal.recommended).toBe("chain"); // sta girando → è un seguito
    expect(proposal.reason).toContain("landing");

    // La board è INTATTA: nessun task creato, nessun link scritto, nessun
    // broadcast. È il cuore del task: proporre non tocca niente.
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as any).c).toBe(before.c);
    expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE blocked_by_task_id IS NOT NULL OR parent_task_id IS NOT NULL").get() as any)
      .toMatchObject({ c: 0 });
    expect(broadcasts.length).toBe(0);
  });

  test("tema estraneo → nessuna proposta (task nuovo è il default silenzioso)", async () => {
    await openCard();
    expect(await suggest("Aggiornare le dipendenze Rust del sidecar PTY")).toBeNull();
  });

  test("la card CHIUSA non si propone: il lavoro lì non è in corso", async () => {
    await openCard("done");
    expect(await suggest(NUOVI)).toBeNull();
  });

  test("proposta IGNORATA: il task nasce libero, parte, e non c'è nessun link", async () => {
    const card = await openCard();
    await suggest(NUOVI); // vista e non accettata
    const t = await (await call(router, "POST", `/api/boards/${PID}/tasks`, { text: NUOVI, status: "todo" }))!.json();
    expect(t.blockedByTaskId).toBeNull();
    expect(t.parentTaskId).toBeNull();
    const svc = createTaskService(db);
    expect(svc.isDispatchBlocked(t.id)).toBe(false); // niente proposta pendente che lo trattiene
    expect((await (await call(router, "GET", `/api/boards/${PID}/tasks/${card.id}`))!.json()).comments.length).toBe(0);
  });

  test("catena ACCETTATA: il task resta fermo, e lo dice nei due thread", async () => {
    const card = await openCard();
    const proposal = await suggest(NUOVI);

    const t = await (await call(router, "POST", `/api/boards/${PID}/tasks`, {
      text: NUOVI, status: "todo",
      blockedByTaskId: proposal.targetTaskId, reuseBlockerContext: true,
      intakeLink: true, intakeReason: proposal.reason,
    }))!.json();

    // RESTA FERMO: il gate del dispatcher è lo stesso predicato della claim CAS.
    const svc = createTaskService(db);
    expect(t.blockedByTaskId).toBe(card.id);
    expect(t.reuseBlockerContext).toBe(true);
    expect(svc.isDispatchBlocked(t.id)).toBe(true);

    // E LO DICE, da entrambi i lati — niente attribuzione muta.
    const mine = await (await call(router, "GET", `/api/boards/${PID}/tasks/${t.id}`))!.json();
    expect(mine.comments.some((c: any) => c.author === "system" && c.content.includes("non parte finché"))).toBe(true);
    expect(mine.comments.some((c: any) => c.content.includes(proposal.reason))).toBe(true);
    const target = await (await call(router, "GET", `/api/boards/${PID}/tasks/${card.id}`))!.json();
    expect(target.comments.some((c: any) => c.author === "system" && c.content.includes("in attesa di questa card"))).toBe(true);
    expect(target.comments.some((c: any) => c.content.includes(NUOVI))).toBe(true);

    // Il bloccante si aggiorna anche per gli altri client (la card deve poter
    // mostrare "qualcuno ti aspetta" senza un reload).
    expect(broadcasts.some((b) => b.type === "task:updated" && b.task?.id === card.id)).toBe(true);
  });

  test("sottotask ACCETTATO: il link è sulle due card e scritto nei due thread", async () => {
    const card = await openCard("todo");
    const proposal = await suggest(NUOVI);
    expect(proposal.recommended).toBe("subtask"); // ferma in coda → è un pezzo

    const t = await (await call(router, "POST", `/api/boards/${PID}/tasks`, {
      text: NUOVI, status: "todo", parentTaskId: proposal.targetTaskId,
      intakeLink: true, intakeReason: proposal.reason,
    }))!.json();
    expect(t.parentTaskId).toBe(card.id);

    const parent = await (await call(router, "GET", `/api/boards/${PID}/tasks/${card.id}`))!.json();
    expect(parent.task.subtaskCount).toBe(1);          // visibile sulla card padre
    expect(parent.comments.some((c: any) => c.content.includes("sottotask"))).toBe(true);
    const mine = await (await call(router, "GET", `/api/boards/${PID}/tasks/${t.id}`))!.json();
    expect(mine.comments.some((c: any) => c.content.includes(FEEDBACK))).toBe(true);
  });

  test("una create senza intakeLink non scrive niente (nessun rumore sui thread)", async () => {
    const card = await openCard("todo");
    await (await call(router, "POST", `/api/boards/${PID}/tasks`, { text: "step a mano", parentTaskId: card.id }))!.json();
    const parent = await (await call(router, "GET", `/api/boards/${PID}/tasks/${card.id}`))!.json();
    expect(parent.comments.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L'anteprima dalla rotta di SESSIONE — quella che usa ogni agente.
//
// Il tool MCP `update_task` manda `previewImage`, e la rotta la scartava senza
// dirlo: 200 OK, card vuota. Stesso guasto che la riparazione del tool
// raccontava di aver chiuso, un piano più sotto — misurato sul server vivo:
// `update_task(preview_image=…)` rispondeva ok e il campo restava null.
// ─────────────────────────────────────────────────────────────────────────────
describe("tasks routes — anteprima dalla sessione dell'agente", () => {
  let db: Database;
  let broadcasts: any[];
  beforeEach(() => { db = freshDb(); broadcasts = []; });

  test("PATCH /api/sessions/:sk/tasks/:id con previewImage la SCRIVE (prima spariva in silenzio)", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "un piano" }))!.json();
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, {
      previewImage: "/allowed/diagramma.svg",
    }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).previewImage).toBe("/allowed/diagramma.svg");
  });

  test("un path fuori allowlist è scartato QUI, come sulla rotta umana", async () => {
    const ctx = makeCtx(db, broadcasts) as any;
    ctx.isPathAllowed = (p: string) => p.startsWith("/allowed/");
    const r = createTasksRouter(ctx);
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, {
      previewImage: "/Users/x/.ssh/id_rsa",
    }))!;
    expect((await resp.json()).previewImage).toBeNull();
  });

  test("stringa vuota azzera l'anteprima", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: "/allowed/a.png" });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: "" }))!;
    expect((await resp.json()).previewImage).toBeNull();
  });
});

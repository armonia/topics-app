import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { ARCHIVE_PARKED_LABEL, createTaskService, LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL, REQUEUE_PARKED_LABEL } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
// The skipped-merge note quotes two controls by the words printed on them. It
// reads those words from the dictionary the interface reads, so renaming a
// label cannot leave the note pointing at something the user cannot find.
// Aliased: `t` is already a local name for a task in half this file.
import { t as label } from "../../client/src/lib/i18n";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_auto_merge INTEGER NOT NULL DEFAULT 0,
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
  // migration 065 — i tentativi del fan-out, ridotta a cio' che la rotta chiede.
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT, UNIQUE (task_id, idx)
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
    // La potatura di un tentativo perdente archivia la sua chat. Qui non ci sono
    // chat vere: lo stub dice «non c'è» invece di lasciare che il `catch` di
    // `reapAttemptWorkspace` stampi un TypeError per ogni perdente.
    getTopicById: () => null,
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
    // Signed server-side from the session, and the signature is an IDENTITY.
    // It used to be the topic NAME, which for a dispatched agent is the task
    // title cut at 60 chars: every card in review showed half a word where the
    // speaker's name belongs. Now it is the same shape the status row already
    // writes, so one reader resolves both.
    expect(got.comments[0].author).toBe("agent:top-s1");
    expect(got.comments[0].author).not.toBe("topic-one");
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

  test("PATCH re-parents, refuses a cycle, and detaches with null", async () => {
    const parent = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "epic" }))!.json();
    const solo = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "orfano" }))!.json();
    // Il buco: la PATCH rispondeva 200 senza spostare niente.
    const moved = await (await call(router, "PATCH", `/api/boards/pX/tasks/${solo.id}`, { parentTaskId: parent.id }))!.json();
    expect(moved.parentTaskId).toBe(parent.id);
    const tree = await (await call(router, "GET", `/api/boards/pX/tasks/${parent.id}`))!.json();
    expect(tree.children.map((c: any) => c.id)).toEqual([solo.id]);

    // Anche col nome MCP (`parent_task_id`), che è quello che scrivono gli agenti.
    const two = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "secondo" }))!.json();
    const viaSnake = await (await call(router, "PATCH", `/api/boards/pX/tasks/${two.id}`, { parent_task_id: parent.id }))!.json();
    expect(viaSnake.parentTaskId).toBe(parent.id);

    // Ciclo: il padre sotto il proprio figlio farebbe sparire entrambi dalla board.
    const cyc = (await call(router, "PATCH", `/api/boards/pX/tasks/${parent.id}`, { parentTaskId: solo.id }))!;
    expect(cyc.status).toBe(400);
    expect((await cyc.json()).code).toBe("invalid_input");
    const self = (await call(router, "PATCH", `/api/boards/pX/tasks/${parent.id}`, { parentTaskId: parent.id }))!;
    expect(self.status).toBe(400);

    // Padre su un ALTRO progetto: 404, stessa forma dell'IDOR alla creazione.
    const foreign = await (await call(router, "POST", "/api/sessions/s2/tasks", { text: "far" }))!.json();
    const cross = (await call(router, "PATCH", `/api/boards/pX/tasks/${solo.id}`, { parentTaskId: foreign.id }))!;
    expect(cross.status).toBe(404);

    // Lavoro in volo: declassare lascerebbe l'agente a girare senza nessuno che guarda.
    const live = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "in volo", status: "in_progress" }))!.json();
    const busy = (await call(router, "PATCH", `/api/boards/pX/tasks/${live.id}`, { parentTaskId: parent.id }))!;
    expect(busy.status).toBe(400);

    // Una card in CODA invece si nidifica: nessuna sessione ancora accesa, e
    // accorpare è proprio il modo di toglierla dalla coda. Il chip 'queued' si
    // spegne, o resterebbe acceso su una card che nessuno dispaccerà più.
    const queued = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "in coda", status: "todo" }))!.json();
    db.run("UPDATE tasks SET dispatch_state = 'queued' WHERE id = ?", [queued.id]);
    const nested = await (await call(router, "PATCH", `/api/boards/pX/tasks/${queued.id}`, { parentTaskId: parent.id }))!.json();
    expect(nested.parentTaskId).toBe(parent.id);
    expect(nested.dispatchState ?? null).toBe(null);

    // null stacca e la card torna a vivere da sola.
    const back = await (await call(router, "PATCH", `/api/boards/pX/tasks/${solo.id}`, { parentTaskId: null }))!.json();
    expect(back.parentTaskId).toBe(null);
  });

  test("PATCH sullo SCATTO della consegna: 400, non un 200 che non applica niente", async () => {
    // Lo stesso difetto di `parentTaskId` qui sopra, seconda occorrenza: chi
    // chiamava `PATCH {deliveryCommit}` per dire alla card «il ramo è andato
    // avanti» riceveva 200 e non cambiava niente. Misurato la notte del 12/08
    // landando `ddf66270`, quando era l'unica via d'uscita rimasta.
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "consegnata" }))!.json();
    for (const patch of [
      { deliveryCommit: "cafe1234" },
      { delivery_commit: "cafe1234" },
      { deliveryBranch: "topics/altro" },
    ]) {
      const res = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, patch))!;
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("invalid_input");
      // Il rifiuto dice cosa fare invece: il land riallinea e pubblica la punta.
      expect(body.error).toContain("Landa su main");
    }
    // Anche dalla porta degli AGENTI: rifiutato da una e ingoiato dall'altra
    // sarebbe di nuovo il 200 muto, da un'altra parte.
    const viaAgente = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { deliveryCommit: "cafe1234" }))!;
    expect(viaAgente.status).toBe(400);
    // E una PATCH normale continua a passare: il cancello guarda solo quei campi.
    const ok = await (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { text: "rititolata" }))!.json();
    expect(ok.text).toBe("rititolata");
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

  // La porta di ritorno, dal lato in cui la usa la board: `?archived=1` per
  // rivedere, `POST .../restore` per riportare indietro. Il broadcast è
  // `task:created` perché per chi guarda la board quella card non c'era.
  test("?archived=1 elenca l'archivio, POST /restore riporta la card in colonna", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "da recuperare" }))!.json();
    await call(router, "DELETE", `/api/boards/pX/tasks/${t.id}`);

    const viva = await (await call(router, "GET", "/api/boards/pX/tasks"))!.json();
    expect(viva.tasks.length).toBe(0);
    const archivio = await (await call(router, "GET", "/api/boards/pX/tasks?archived=1"))!.json();
    expect(archivio.tasks.map((x: any) => x.id)).toEqual([t.id]);

    broadcasts.length = 0;
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${t.id}/restore`))!;
    expect(resp.status).toBe(200);
    expect(broadcasts.some(b => b.type === "task:created" && b.task?.id === t.id)).toBe(true);
    const tornata = await (await call(router, "GET", "/api/boards/pX/tasks"))!.json();
    expect(tornata.tasks.map((x: any) => x.id)).toEqual([t.id]);
    expect((await (await call(router, "GET", "/api/boards/pX/tasks?archived=1"))!.json()).tasks.length).toBe(0);
  });

  test("POST /restore su un id di un'altra board risponde 404", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "non tua" }))!.json();
    await call(router, "DELETE", `/api/boards/pX/tasks/${t.id}`);
    expect((await call(router, "POST", `/api/boards/pY/tasks/${t.id}/restore`))!.status).toBe(404);
    expect((await (await call(router, "GET", "/api/boards/pX/tasks?archived=1"))!.json()).tasks.length).toBe(1);
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

  test("quiet comment on a root in review ANNOTATES it: no reject, no resume, the card does not move", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-q')");
    const resumed: Array<[string, string]> = [];
    const fake = {
      onEnterTodo() {}, onLeaveTodo() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake);

    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "deliverable", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-q' WHERE id = ?").run(root.id);
    await call(r, "PATCH", `/api/boards/pX/tasks/${root.id}`, { status: "review" });

    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${root.id}/comments`, {
      content: "verificata, il video mostra il caso B", quiet: true,
    }))!;
    expect(resp.status).toBe(201);
    // La nota c'è, e si legge sul thread come qualunque altro commento.
    const got = await (await call(r, "GET", `/api/boards/pX/tasks/${root.id}`))!.json();
    expect(got.comments.at(-1).content).toBe("verificata, il video mostra il caso B");
    // Ma la card NON si è mossa e l'agent NON è ripartito: è tutto il punto del
    // gesto quieto. Senza, scrivere qui rigettava la consegna senza dirlo.
    expect(got.task.status).toBe("review");
    expect(resumed).toEqual([]);
    // Nessuna uscita review→in_progress nello storico: il rigetto non c'è stato,
    // non è stato fatto e disfatto. La timeline vive nei commenti `kind='status'`.
    const back = db.prepare(
      "SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND kind = 'status' AND content LIKE 'review→in_progress%'",
    ).get(root.id) as { n: number };
    expect(back.n).toBe(0);

    // E lo stesso campo, SENZA il flag, rimanda ancora indietro: il default non
    // cambia, il silenzio va chiesto.
    await call(r, "POST", `/api/boards/pX/tasks/${root.id}/comments`, { content: "rifallo" });
    expect(resumed.length).toBe(1);
    const after = await (await call(r, "GET", `/api/boards/pX/tasks/${root.id}`))!.json();
    expect(after.task.status).toBe("in_progress");
  });

  test("quiet comment with media stays quiet too (attachments do not wake the agent)", async () => {
    db.run("INSERT INTO topics (id) VALUES ('top-qm')");
    const resumed: string[] = [];
    const fake = {
      onEnterTodo() {}, onLeaveTodo() {},
      resume: async (id: string) => { resumed.push(id); },
    } as any;
    const r = createTasksRouter(makeCtx(db, broadcasts), fake);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "deliverable", status: "in_progress" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-qm' WHERE id = ?").run(root.id);
    await call(r, "PATCH", `/api/boards/pX/tasks/${root.id}`, { status: "review" });

    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${root.id}/comments`, {
      content: "screenshot della verifica", media: ["/tmp/prova.png"], quiet: true,
    }))!;
    expect((await resp.json()).media).toEqual(["/tmp/prova.png"]);
    expect(resumed).toEqual([]);
    const got = await (await call(r, "GET", `/api/boards/pX/tasks/${root.id}`))!.json();
    expect(got.task.status).toBe("review");
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
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-z', dispatch_state = 'working', dispatch_attempts = 1 WHERE id = ?").run(t.id);

    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${t.id}/stop`, {}))!;
    expect(resp.status).toBe(200);
    const parked = await resp.json();
    expect(parked.status).toBe("backlog");
    expect(parked.assignedTopicId).toBeNull();
    // FERMARE NON È FALLIRE, e si vede in due posti.
    // La chip: 'stopped' — non `null` (una card muta, indistinguibile da una mai
    // dispacciata) e non 'failed' (l'agent non ha fallito niente).
    expect(parked.dispatchState).toBe("stopped");
    // Il contatore: intatto. Un'attesa legittima non deve consumare il budget di
    // tentativi — chi ferma per guardare non deve pagarlo al rilancio.
    expect(parked.dispatchAttempts).toBe(1);
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

  test("i due feed della board rimettono dentro lo step ORFANO, e solo quello", async () => {
    // Padre vivo: la sua checklist NON è arretrato, e la colonna conta uno.
    const vivo = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "padre vivo", status: "todo" }))!.json();
    await (await call(router, "POST", "/api/boards/pX/tasks", { text: "step suo", parentTaskId: vivo.id, status: "todo" }))!.json();
    // Padre chiuso con uno step rimasto aperto: il cancello `open_subtasks`
    // impedisce di arrivarci dalla porta, ma lo stato esiste già sulle righe.
    const chiuso = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "padre chiuso" }))!.json();
    const orfano = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "step orfano", parentTaskId: chiuso.id, status: "todo" }))!.json();
    db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [chiuso.id]);

    const board = await (await call(router, "GET", "/api/boards/pX/tasks?status=todo"))!.json();
    expect(board.tasks.map((t: any) => t.id).sort()).toEqual([vivo.id, orfano.id].sort());

    const globale = await (await call(router, "GET", "/api/all-boards/tasks?status=todo"))!.json();
    expect(globale.tasks.map((t: any) => t.id).sort()).toEqual([vivo.id, orfano.id].sort());
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

  test("GET returns defaults (auto off) and NO per-board cap", async () => {
    const s = await (await call(router, "GET", "/api/boards/pX/settings"))!.json();
    expect(s.autoDispatch).toBe(false);
    // A per-board cap no longer exists: showing one here is what made this
    // endpoint report 9 on 2026-08-13 while the enforced cap (row '*') was 8.
    expect(s.maxAgents).toBeUndefined();
  });

  // La rotta ACCETTAVA `maxAgents`, lo salvava e lo rimostrava: un numero che
  // si scriveva e non limitava niente. Ora lo ignora, e soprattutto non lo
  // restituisce — e il tetto vero (riga '*') non si muove di un'unità.
  test("PATCH ignora un maxAgents per board e non tocca il tetto globale", async () => {
    const prima = await (await call(router, "GET", "/api/all-boards/settings"))!.json();
    expect(prima.maxAgents).toBe(3); // default della riga '*': mai impostata
    const resp = (await call(router, "PATCH", "/api/boards/pX/settings", { maxAgents: 9 }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).maxAgents).toBeUndefined();
    const dopo = await (await call(router, "GET", "/api/all-boards/settings"))!.json();
    expect(dopo.maxAgents).toBe(3);
    expect(dopo.maxAgentsAuto).toBe(true);
  });

  // The half above ("and does not touch the global cap") could not have failed
  // on its own: the old code wrote `max_agents` on row pX, never on '*'. THIS is
  // the address that could: the per-board route takes its projectId from the
  // path with a plain decodeURIComponent and no guard, so `/api/boards/*/…` aims
  // straight at the reserved row. If a per-board cap ever came back, that would
  // be a second writer of the machine cap — and one that skips the
  // board:global-cap broadcast, so other windows would never hear about it.
  test("nemmeno indirizzata alla riga riservata la rotta per board muove il tetto", async () => {
    expect((await (await call(router, "PATCH", "/api/all-boards/settings", { maxAgentsAuto: false, maxAgents: 8 }))!.json()).maxAgents).toBe(8);
    const resp = (await call(router, "PATCH", "/api/boards/*/settings", { maxAgents: 15 }))!;
    expect(resp.status).toBe(200);
    const dopo = await (await call(router, "GET", "/api/all-boards/settings"))!.json();
    expect(dopo).toMatchObject({ maxAgents: 8, maxAgentsAuto: false });
  });

  test("PATCH upserts + broadcasts board:settings", async () => {
    const resp = (await call(router, "PATCH", "/api/boards/pX/settings", { autoDispatch: true, dispatchTimeoutMin: 30 }))!;
    expect(resp.status).toBe(200);
    const s = await resp.json();
    expect(s.autoDispatch).toBe(true);
    expect(s.dispatchTimeoutMin).toBe(30);
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

  test("i sei cancelli si salvano TUTTI, e il settimo e' un 400 invece di sparire", async () => {
    // Il 12/08 il tetto era cinque, questo repo aveva sei gate, e il sesto
    // (`test:unit`) veniva troncato in silenzio: la board mostrava "verde" su
    // consegne che la suite bocciava, e il rosso lo trovava un umano al land.
    // Un tetto puo' esistere; sparire no.
    const sei = [
      { name: "typecheck", cmd: "bun run typecheck" },
      { name: "lint", cmd: "bun run lint" },
      { name: "check:deadcode", cmd: "bun run check:deadcode" },
      { name: "check:emdash", cmd: "bun run check:emdash" },
      { name: "check:migrations", cmd: "bun run check:migrations" },
      { name: "test:unit", cmd: "bun run test:unit" },
    ];
    const ok = (await call(router, "PATCH", "/api/boards/pX/settings", { reviewChecks: sei }))!;
    expect(ok.status).toBe(200);
    const salvati = (await (await call(router, "GET", "/api/boards/pX/settings"))!.json()).reviewChecks;
    expect(salvati).toHaveLength(6);
    expect(salvati.map((c: { name: string }) => c.name)).toContain("test:unit");

    const troppi = (await call(router, "PATCH", "/api/boards/pX/settings", {
      reviewChecks: [...sei, { name: "settimo", cmd: "echo no" }],
    }))!;
    expect(troppi.status).toBe(400);
    const body = await troppi.json();
    expect(body.error).toContain("7");
    // E non ha toccato quelli buoni: un rifiuto non deve lasciare la board a meta'.
    const dopo = (await (await call(router, "GET", "/api/boards/pX/settings"))!.json()).reviewChecks;
    expect(dopo).toHaveLength(6);
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
  let stamped: Array<[string, string]>;
  /** Same router over the same db, with a different landing stamp. */
  let withStamp: (fn: (taskId: string, verdict: string) => Promise<void>) => any;

  beforeEach(() => {
    db = freshDb(); broadcasts = []; merges = []; resumed = []; stamped = [];
    const autoMerge = {
      tryMerge: async (taskId: string) => { merges.push(taskId); return { status: "nothing" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    withStamp = (stampLanding) => createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge, stampLanding });
    router = withStamp(async (taskId, verdict) => { stamped.push([taskId, verdict]); });
  });

  async function reviewTask(): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  /** The land (and the landing verdict behind it) is fire-and-forget: let the
   *  microtasks drain before reading what it left behind. */
  const flushLand = () => new Promise((r) => setTimeout(r, 0));
  const systemNote = (id: string) => createTaskService(db).get(id)!.comments
    .filter((c) => c.author === "system").map((c) => c.content).join("\n");

  /** Turns the board switch on: without it, reaching Done does not merge. */
  const autoMergeOn = () => call(router, "PATCH", "/api/boards/pX/settings", { dispatchAutoMerge: true });

  test("trascinare una card in Done LANDA: `done` deve voler dire atterrato", async () => {
    // Il land era un'azione a parte, e il gesto piu' naturale — trascinare la
    // card in Done — chiudeva il lavoro lasciandolo sul suo ramo, in silenzio.
    // Misurato il 10/08: 17 card chiuse in otto ore col contenuto NON su main.
    const id = await reviewTask();
    await autoMergeOn();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await new Promise((r) => setTimeout(r, 0)); // il land e' fire-and-forget
    expect(merges).toContain(id);
  });

  test("una card SENZA ramo di consegna non tenta nessun land", async () => {
    // Il controllo del test qui sopra: una nota chiusa a mano non deve svegliare
    // git, o ogni gesto sulla board diventerebbe un'operazione sul repo.
    const id = await reviewTask();
    await autoMergeOn();
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await new Promise((r) => setTimeout(r, 0));
    expect(merges).not.toContain(id);
  });

  // ── THE BOARD SWITCH, which nobody read on this path ──────────────────────
  //
  // Every entry into Done of a card carrying a branch queued a merge: not just
  // approval, the drag and the "Sposta in" menu too. The comment next to it
  // claimed the board had already decided via `dispatchAutoMerge`, but the
  // field was never read. Measured on 13/08 against the live board db: of the
  // 137 "Mergiato su main" notes, 8 sit on boards whose switch is off today.

  test("auto-merge OFF: Done does not merge, and the card says why", async () => {
    const id = await reviewTask();   // board pX has no settings row: off by default
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();

    expect(merges).toEqual([]);
    // A MUTE closure with the code still on the branch is the 10/08 fault in
    // its silent form: the note has to name the branch and the way out.
    const note = systemNote(id);
    expect(note).toContain("SENZA fondere");
    expect(note).toContain("topics/x");
    // Both quoted controls are pinned against the words actually printed next
    // to them: a note naming a control the reader cannot find gets ignored, and
    // that is the whole reason this note exists. Rename either label in i18n.ts
    // and this test falls.
    expect(note).toContain(label("board.settings.autoMerge", "it"));
    // `board.action.land` and NOT the retired `board.task.landOnMain`: the
    // branch that gave every action one word moved the button's text into the
    // single action table. Reading the dead key made this assertion pass on
    // nothing, which is how a note could start quoting a control that no longer
    // says that.
    expect(note).toContain(label("board.action.land", "it"));
  });

  test("the skipped-merge note reaches the LIVE card without waiting for git", async () => {
    // The PATCH broadcasts `task:updated` with the task as it was BEFORE the
    // note, and `addComment` bumps `updated_at` precisely so a live client
    // refetches the thread (Card.tsx keys its comment effect on
    // `task.updatedAt`). Without a broadcast of its own the note exists only in
    // the db: a closure as mute on screen as the one this code exists to stop.
    //
    // The stamp here NEVER RESOLVES, which is what makes this test able to
    // fail. The landing verdict shells out to git, so the broadcast that
    // carries the note cannot be the one sitting behind it: a slow repo would
    // hold the note back for as long as git takes. Wire the note's broadcast
    // after the await and this goes red.
    const r = withStamp(() => new Promise<void>(() => { /* git, still thinking */ }));
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    const before = broadcasts.length;
    await call(r, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();

    // Exactly two: the PATCH's own (the task as it was BEFORE the note) and
    // this one. Drop the note's broadcast and it is one — the hung stamp means
    // the deferred broadcast behind it never fires, so nothing else can cover.
    const updates = broadcasts.slice(before).filter((b) => b.type === "task:updated" && b.task?.id === id);
    expect(updates.length).toBe(2);
    // And the second is a FRESH read, not a stale copy of the first: its
    // updatedAt is the one `addComment` just wrote, which is the change signal
    // the card refetches its thread on.
    const got = createTaskService(db).get(id)!;
    expect(updates[1].task.updatedAt).toBe(got.task.updatedAt);
    expect(got.comments.filter((c) => c.author === "system").at(-1)!.createdAt).toBe(got.task.updatedAt);
  });

  test("the way out the note names is REACHABLE: the landing verdict is asked for", async () => {
    // "Landa su main" on a `done` card is drawn by exactly one surface, the
    // "chiuso ma non su main" banner, behind `landingState === 'unlanded'` —
    // and `recordDelivery` blanks that column, so it sits at NULL until the
    // periodic audit runs (LANDING_AUDIT_INTERVAL_MS, 30 min). "ask" is the
    // house verb for "compute the verdict from the repo now": asserting
    // `unlanded` outright would be a guess, since the branch may already be in
    // main by somebody else's hand.
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();
    expect(stamped).toEqual([[id, "ask"]]);
  });

  test("with the switch ON nothing is skipped: no note, no verdict to ask for", async () => {
    // The control for the three above: the note and the stamp belong to the
    // SKIPPED path only. On the merging path `landTask` writes its own outcome.
    const id = await reviewTask();
    await autoMergeOn();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();
    expect(merges).toContain(id);
    expect(systemNote(id)).not.toContain("SENZA fondere");
  });

  test("the «Landa su main» button merges with the switch off: it is a human's choice", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {});
    await flushLand();
    expect(merges).toEqual([id]);
  });

  test("…and so does the «Landa su main» quick reply, switch on or off", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: LAND_ACTION_LABEL });
    await flushLand();
    expect(merges).toEqual([id]);
  });

  test("approve accepts the task WITHOUT merging (no azioni da sotto)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "approve" }))!.json();
    expect(t.status).toBe("done");
    expect(merges).toEqual([]); // approve no longer merges
  });

  test("picking the 'Landa su main' option lands, non è un reject, e NON chiude la card in anticipo", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: LAND_ACTION_LABEL }))!.json();
    // `review`, non `done`: la scelta è «landa», e la card la chiude il land
    // quando main lo conferma. Non è nemmeno un rifiuto (nessun resume).
    expect(t.status).toBe("review");
    expect(merges).toEqual([id]);  // e il land parte
    expect(resumed).toEqual([]);   // NOT resumed as a rejection
  });

  test("POST /land merges on demand e lascia la card in review finché non è atterrata", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!.json();
    expect(t.status).toBe("review");
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
    expect(t.task.status).toBe("in_progress");     // mai chiusa: mandata a riconciliare
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");              // non «user»: non l'ha mossa l'umano
    // `from: "review"` e non più `from: "done"`: il land non approva prima di
    // atterrare, quindi la card il `done` non lo tocca proprio.
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "review", to: "in_progress", reason: "il land ha fatto conflitto con main",
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
      from: "review", to: "in_progress", reason: "il land non ha saputo isolare i commit della card",
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

  /**
   * Il terzo verso dello stesso difetto, misurato il 12/08 su `ee5ebbb4`: la
   * card DICHIARAVA un ramo (`delivery_branch`, esistente) ma il land non
   * riusciva a risolvere dove atterrarlo. Finché quel caso rispondeva
   * `no-branch` la card restava chiusa col codice fuori da main; adesso ha un
   * codice suo, e il codice suo la ritira.
   */
  test("ramo dichiarato ma checkout introvabile: la card NON resta in done", async () => {
    const { id, db: d, resumed: r } = await landSkipping("repo-unresolved");
    expect(createTaskService(d).get(id)!.task.status).toBe("review");
    expect(r).toEqual([]);
  });

  test("«non c'era niente da atterrare» NON chiude la card: lo dice e la lascia in review", async () => {
    // Il controllo dei due test qui sopra: nessun rimbalzo all'agente, perché
    // non c'è niente da riparare. Ma nemmeno una chiusura: un land che non ha
    // portato niente da nessuna parte non è una prova che il lavoro sia su
    // main, e solo un merge confermato toglie una card da review. Se il lavoro è
    // già di là per mano di qualcun altro, a dirlo è l'umano che approva.
    const { id, db: d } = await landSkipping("no-branch");
    const t = createTaskService(d).get(id)!;
    expect(t.task.status).toBe("review");
    expect(t.comments.some((c) => c.content.includes("Niente da atterrare"))).toBe(true);
  });

  /** Un merge andato a buon fine, nella forma che `tryMerge` restituisce. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };

  /**
   * L'ALTRO verso, misurato l'11/08 su `4ec47331`: il land è RIUSCITO — il
   * thread scrive «Mergiato su main (commit a5f83e0e)» e il contenuto è dentro
   * — e la card è rimasta `in_progress` con il chip `working` e un agente
   * sopra, che ha speso un turno intero a rifare lavoro già atterrato. Il land
   * promuoveva a `done` solo passando da `review`; da ogni altro stato
   * mergiava e lasciava la card dov'era.
   */
  test("un land RIUSCITO da in_progress chiude la card: done, nessun agente dispacciato", async () => {
    const d = freshDb(); const b: any[] = []; const r: Array<[string, string]> = [];
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { r.push([id, msg]); },
    } as any;
    const rt = createTasksRouter(makeCtx(d, b), dispatcher, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    });
    d.run("INSERT INTO topics (id) VALUES ('top-l')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    // Lo stato in cui è finita la card vera: in corso, agente al lavoro.
    d.prepare("UPDATE tasks SET assigned_topic_id='top-l', status='in_progress', dispatch_state='working' WHERE id = ?").run(t.id);

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const svc = createTaskService(d);
    const after = svc.get(t.id)!;
    expect(after.task.status).toBe("done");
    // «Nessun agente dispacciato»: il chip spento è ciò che toglie la card dalla
    // presa del dispatcher — è il gesto che l'umano ha dovuto fare a mano.
    expect(after.task.dispatchState).toBe(null);
    expect(r).toEqual([]);
    // E la riga di storico dice PERCHÉ si è chiusa, non solo che si è chiusa.
    const ev = after.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(parseStatusEvent(ev.content)?.to).toBe("done");
    expect(parseStatusEvent(ev.content)?.reason).toContain("il codice è su main");
  });

  /**
   * Dove vanno i soldi. Chiudere la card la toglie dalla coda, ma NON taglia il
   * turno già partito: l'11/08 due land di fila hanno pagato $5,64 (`4ec47331`)
   * e $8,24 (`56677242`, fermata entro un minuto) a un agente che rifaceva
   * lavoro già su main. Il turno si taglia, e si taglia DOPO aver chiuso la
   * card — `onTurnEnd` su una card ancora `in_progress` riprenderebbe l'agente.
   */
  test("un land riuscito FERMA l'agente che sta ancora lavorando su quella card", async () => {
    const aborted: string[] = [];
    let statusAlloStop: string | undefined;
    let taskId = "";
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      // Si registra ANCHE lo stato della card nell'istante dello stop: l'ordine
      // non è un dettaglio di stile. `onTurnEnd` su una card ancora
      // `in_progress` riprende l'agente, quindi tagliare prima di chiuderla lo
      // farebbe ripartire — cioè ripagherebbe il turno che si stava evitando.
      abortTurn: async (key: string) => {
        aborted.push(key);
        statusAlloStop = (d.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as any)?.status;
      },
    });
    d.run("INSERT INTO topics (id) VALUES ('485cb19a-993f-4e36-9823-687ee4235aae')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    taskId = t.id;
    d.prepare(
      "UPDATE tasks SET assigned_topic_id='485cb19a-993f-4e36-9823-687ee4235aae', status='in_progress', dispatch_state='working' WHERE id = ?",
    ).run(t.id);

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    // La chiave della sessione è `topic:<primi 8>` — la stessa che usa «Ferma».
    expect(aborted).toEqual(["topic:485cb19a"]);
    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("done");
    // E il thread dice che qualcuno è stato fermato, altrimenti l'agente
    // sparisce a metà frase senza spiegazione.
    expect(after.comments.some((c) => c.content.includes("Fermato l'agente"))).toBe(true);
    // L'ordine: quando lo stop parte, la card è GIÀ chiusa.
    expect(statusAlloStop).toBe("done");
  });

  test("il ramo riallineato dal land finisce nel thread, PRIMA del «Mergiato»", async () => {
    // Sul ramo compare un commit di fusione che nessun umano ha fatto: se il
    // thread non lo dice, chi rilegge la storia del ramo non sa da dove venga.
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: {
        tryMerge: async () => ({ ...MERGED, realigned: "il ramo era indietro di 2 commit su 'main': ci ho riportato main dentro" }),
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const comments = createTaskService(d).get(t.id)!.comments.map((c) => c.content);
    const riallineato = comments.findIndex((c) => c.includes("Riallineato prima del land"));
    const mergiato = comments.findIndex((c) => c.includes("Mergiato su main"));
    expect(riallineato).toBeGreaterThanOrEqual(0);
    expect(riallineato).toBeLessThan(mergiato);
    expect(comments[riallineato]).toContain("indietro di 2 commit");
  });

  test("conflitto nel RIALLINEAMENTO: nomina i file e chiede una fusione, non una rebase", async () => {
    // Due conflitti diversi, due lavori diversi. Dire «rifai la base sul main
    // aggiornato» a chi ha appena visto fallire quel merge lo manda a rifare a
    // mano il tentativo che la macchina ha già fatto — senza dirgli su cosa.
    const d = freshDb(); const b: any[] = []; const r: Array<[string, string]> = [];
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { r.push([id, msg]); },
    } as any;
    const rt = createTasksRouter(makeCtx(d, b), dispatcher, {
      autoMerge: {
        tryMerge: async () => ({
          status: "conflict", branch: "topics/ramo-vecchio",
          realignConflict: { behind: 3, files: ["server/db.ts", "client/src/App.tsx"] },
        }),
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("in_progress");
    // Il thread dice quali file, e che NON è stato landato niente.
    const thread = after.comments.map((c) => c.content).join("\n");
    expect(thread).toContain("server/db.ts");
    expect(thread).toContain("client/src/App.tsx");
    expect(thread).toContain("Non ho landato niente");
    // La riga di storico distingue le due cause.
    const ev = after.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(parseStatusEvent(ev.content)?.reason).toContain("riportare main nel ramo");
    // E l'istruzione all'agente parla di `git merge main`, non di rebase.
    expect(r).toHaveLength(1);
    expect(r[0][1]).toContain("git merge main");
    expect(r[0][1]).toContain("server/db.ts");
    expect(r[0][1]).not.toContain("git rebase main");
  });

  test("nessun agente vivo → il land non chiama nessuno stop", async () => {
    // Il controllo del test qui sopra: il percorso normale (card già consegnata
    // e ferma) non deve mandare un abort a una sessione che non lavora.
    const aborted: string[] = [];
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      abortTurn: async (key: string) => { aborted.push(key); },
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='done' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));
    expect(aborted).toEqual([]);
  });

  test("un land riuscito su una card GIÀ chiusa non aggiunge righe di storico", async () => {
    // Il controllo del test qui sopra: il percorso normale (review → «Landa su
    // main» → done → merge) non deve guadagnare una transizione done→done.
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    });
    d.run("INSERT INTO topics (id) VALUES ('top-d')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-d', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('cd', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));
    const svc = createTaskService(d);
    const events = svc.get(t.id)!.comments.filter((c) => c.kind === "status");
    expect(events.map((e) => parseStatusEvent(e.content)?.to)).toEqual(["done"]);
  });

  /**
   * Il verdetto di atterraggio si REGISTRA quando il land succede, mentre il
   * ramo esiste ancora: dedurlo dopo, dal solo commit di consegna, sbaglia
   * (provato a mano su 108 card: 20 falsi allarmi con la patch inversa, 5 con
   * la riga distintiva). Il land che ha visto il merge non chiede a nessuno.
   */
  async function landStamping(
    merge: any,
    confirm?: (repoPath: string, commit: string) => Promise<boolean | null>,
  ): Promise<Array<[string, string]>> {
    const stamped: Array<[string, string]> = [];
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => merge, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      stampLanding: async (taskId: string, verdict: string) => { stamped.push([taskId, verdict]); },
      ...(confirm ? { confirmLandedOnMain: confirm } : {}),
    });
    d.run("INSERT INTO topics (id) VALUES ('top-a')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-a', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('ca', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 20));
    return stamped.map(([, v]) => [t.id, v] as [string, string]);
  }

  test("merge riuscito E CONFERMATO su main → l'esito si REGISTRA come 'landed'", async () => {
    const [[, v]] = await landStamping(MERGED, async () => true) as any;
    expect(v).toBe("landed");
  });

  /**
   * LA BARRA DEL 13/08, secondo sintomo: `landing_state` diceva `landed` su
   * card che su main non c'erano (viste quel giorno: `2d3d6051`, `8f1f1b95`).
   * Il campo non era una misura — copiava il resoconto di `git merge`, che dice
   * che una fusione è riuscita e NON su quale ramo.
   *
   * Qui il merge dice di sì e main dice di no: `landed` non si può scrivere.
   * Rimettendo l'ordine vecchio (verdetto dedotto dallo stato di `tryMerge`)
   * questo test è rosso.
   */
  test("il merge dice sì ma main dice di no: non si scrive MAI 'landed'", async () => {
    const [[, v]] = await landStamping(MERGED, async () => false) as any;
    expect(v).toBe("unlanded");
  });

  /**
   * LA BARRA DEL 13/08, primo sintomo, nella sua forma peggiore: il land CREDE
   * di essere riuscito. `git merge` è uscito zero, il thread scrive «Mergiato su
   * main», la card si chiude — e su main non c'è niente (checkout parcheggiato
   * su un altro ramo, worktree usa-e-getta mai ricucito). Il 13/08 sono andate
   * così `92d61427`, `274d5425` e `95a6794f`: `done` coi rami mai atterrati, e
   * la potatura delle worktree pronta a portarli via.
   *
   * Tre cose insieme, e servono tutte e tre: la card non si chiude, il worktree
   * (unica copia del lavoro) non si pota, e il thread dice perché.
   */
  test("merge non confermato da main: la card NON si chiude e il worktree resta", async () => {
    const d = freshDb(); const b: any[] = []; const reaped: string[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      confirmLandedOnMain: async () => false,
      deleteTaskWorktree: async (taskId: string) => { reaped.push(taskId); return true; },
      taskBranchStatus: async () => "unmerged" as const,
      taskWorktreeDirt: async () => [],
    });
    d.run("INSERT INTO topics (id) VALUES ('top-nc')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-nc', status='review' WHERE id = ?").run(t.id);

    const res = await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    expect(res!.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));

    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("review");     // NON done: il land non è avvenuto
    expect(reaped).toEqual([]);                   // e il ramo resta: è l'unica copia
    expect(after.comments.some((c) => c.content.includes("Land NON confermato"))).toBe(true);
  });

  test("main non risponde: il verdetto è «non verificabile», mai 'landed'", async () => {
    // Il no e il non-lo-so restano due cose diverse: `null` non accusa nessuno,
    // ma nemmeno assolve — e `landed` è un'assoluzione.
    const [[, v]] = await landStamping(MERGED, async () => null) as any;
    expect(v).toBe("unverifiable");
    // Stesso esito quando la verifica non esiste proprio su questo host: una
    // capacità non cablata è assenza di prova, non prova d'assenza di problemi
    // (il cablaggio mancante è precisamente come nascono questi guasti).
    const [[, v2]] = await landStamping(MERGED) as any;
    expect(v2).toBe("unverifiable");
  });

  test("land fallito → si registra 'unlanded': anche il no è un fatto osservato", async () => {
    const [[, v]] = await landStamping({ status: "skipped", reason: "x", code: "unisolable" }) as any;
    expect(v).toBe("unlanded");
    const [[, v2]] = await landStamping({ status: "conflict" }) as any;
    expect(v2).toBe("unlanded");
  });

  test("dove il land NON sa (niente ramo, niente da portare) si CHIEDE al repo", async () => {
    // Il controllo dei due test qui sopra: se registrasse sempre un fatto,
    // scriverebbe una testimonianza su una cosa che non ha visto.
    const [[, v]] = await landStamping({ status: "nothing" }) as any;
    expect(v).toBe("ask");
    const [[, v2]] = await landStamping({ status: "skipped", reason: "x", code: "no-branch" }) as any;
    expect(v2).toBe("ask");
  });

  test("picking 'Landa e pubblica' lands (routes to land+publish, not a reject)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: PUBLISH_ACTION_LABEL }))!.json();
    // Deterministic routing: the publish label lands, and does NOT resume the
    // agent (the publish PUSH itself runs in the fire-and-forget chain — no git
    // in this harness — but the interception routes correctly).
    // `review`: pubblicare è landare + spingere, e chiudere la card resta
    // compito del land, quando main lo conferma.
    expect(t.status).toBe("review");
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
          deliveryDrift: "il ramo porta 1 commit aggiunto DOPO la consegna", realigned: null };
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

  /**
   * IL TETTO DI BUN. La richiesta non può durare quanto i comandi: `idleTimeout`
   * si ferma a 255s e sotto quel muro morivano le consegne con `test:unit` da
   * dieci minuti, lasciando `checks_state` a «running» per sempre. La corsa vive
   * ora fuori dalla richiesta, che aspetta al massimo una gamba.
   */
  test("gamba scaduta: 202 'sta girando', e il task NON si muove", async () => {
    const r = mk();
    const t = await delivered(r);
    await declare(r, t.projectId, ["sleep 1"]);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", legMs: 100 }))!;
    expect(resp.status).toBe(202);
    const body = await resp.json();
    expect(body.pending).toBe(true);
    expect(body.code).toBe("review_checks_running");
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).not.toBe("review");
    expect(got.task.checksState).toBe("running");

    // La gamba dopo raccoglie l'esito della STESSA corsa e la consegna passa.
    const dopo = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", legMs: 5_000 }))!;
    expect(dopo.status).toBe(200);
    expect((await dopo.json()).status).toBe("review");
  });

  test("una corsa sola: dieci gambe non fanno dieci giri di comandi", async () => {
    const r = mk();
    const t = await delivered(r);
    const traccia = join(cwd, "giri.txt");
    await declare(r, t.projectId, [`sleep 1; echo giro >> ${traccia}`]);
    const gambe = await Promise.all(
      Array.from({ length: 10 }, () => call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", legMs: 100 })),
    );
    expect(gambe.every((g) => g!.status === 202)).toBe(true);
    const esito = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", legMs: 5_000 }))!;
    expect(esito.status).toBe(200);
    expect(readFileSync(traccia, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("`legMs` è trasporto: non finisce fra i campi del task e non fa 400", async () => {
    const r = mk();
    const t = await delivered(r);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { text: "titolo nuovo", legMs: 200 }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).text).toBe("titolo nuovo");
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

  // The hole the "it is a question" exemption opened onto itself: the envelope
  // ORDERS a landable delivery to attach `options=["Landa su main"]`, and the
  // server wraps every `options` in the very fence that counted as the
  // exemption here. Measured on 13/08 against the live board db: of the 437
  // agent comments carrying that fence, 331 are deliveries, so three
  // exemptions out of four went to the shape this gate exists to check.
  test("a delivery offering only «Landa su main»: the checks run anyway", async () => {
    const r = mk();
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await declare(r, t.projectId, ["echo rosso-della-consegna >&2; exit 3"]);
    await call(r, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, {
      content: "Fatto: rifatto il gate, commit sul branch.", options: [LAND_ACTION_LABEL],
    });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(409);
    const err = await resp.json();
    expect(err.code).toBe("review_needs_green_checks");
    expect(err.error).toContain("rosso-della-consegna");
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).not.toBe("review");
  });

  test("MIXED question: one option the system cannot run and the checks stay put", async () => {
    const r = mk();
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await declare(r, t.projectId, ["exit 1"]);
    await call(r, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, {
      content: "Ho finito, ma il nome del flag non mi convince.",
      options: [LAND_ACTION_LABEL, "Aspetta, ho un dubbio"],
    });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).checksState).toBeNull();
  });

  // The OTHER gate reading the same fence: `review_needs_commit`. A delivery
  // with the work still in the worktree is not reviewable (approving would find
  // nothing to merge), but "it is a question" exempted it, and the single
  // option "Landa su main" was enough to make it look like one.
  test("a dirty delivery offering «Landa su main»: 409 review_needs_commit", async () => {
    const r = mk({ taskWorktreeDirt: async () => ["server/routes/tasks.ts", "server/services/tasks.ts"] });
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(r, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, {
      content: "Fatto: rifatto il gate.", options: [LAND_ACTION_LABEL],
    });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(409);
    const err = await resp.json();
    expect(err.code).toBe("review_needs_commit");
    expect(err.error).toContain("2 uncommitted changes");
  });

  test("MIXED question with a dirty worktree: legitimate, no 409", async () => {
    const r = mk({ taskWorktreeDirt: async () => ["server/routes/tasks.ts"] });
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(r, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, {
      content: "Ho finito, ma il nome del flag non mi convince.",
      options: [LAND_ACTION_LABEL, "Aspetta, ho un dubbio"],
    });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" }))!;
    expect(resp.status).toBe(200);
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
    expect(mine.comments.some((c: any) => c.author === "system" && c.content.includes("Non parte finché"))).toBe(true);
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

  // Il path fuori allowlist non passa, e ora lo DICE: prima il 200 con la card
  // vuota era indistinguibile dall'aver consegnato l'anteprima.
  test("un path fuori allowlist è rifiutato QUI con 400, come sulla rotta umana", async () => {
    const ctx = makeCtx(db, broadcasts) as any;
    ctx.isPathAllowed = (p: string) => p.startsWith("/allowed/");
    const r = createTasksRouter(ctx);
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, {
      previewImage: "/Users/x/.ssh/id_rsa",
    }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).fields).toEqual(["previewImage"]);
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.previewImage).toBeNull();
  });

  // Un `.pdf` passava l'allowlist (è un allegato legittimo) e diventava
  // l'anteprima: il client lo mandava al ramo `<img>` e sulla card restava
  // un'icona rotta. Nessun errore da nessuna parte, quindi la consegna sembrava
  // fatta e non mostrava niente. Il tipo va guardato QUI, non solo il path.
  test("un file che nessuno sa MOSTRARE non diventa anteprima (il .pdf che l'ha insegnato)", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, {
      previewImage: "/allowed/relazione.pdf",
    }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toContain("mostrabile");
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.previewImage).toBeNull();
  });

  test("e non travolge i tre rami del protocollo: png, svg e webm entrano", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts));
    for (const p of ["/allowed/schermata.png", "/allowed/schema.svg", "/allowed/clip.webm"]) {
      const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: p }))!.json();
      const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: p }))!;
      expect((await resp.json()).previewImage).toBe(p);
    }
  });

  test("stringa vuota azzera l'anteprima", async () => {
    const r = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: "/allowed/a.png" });
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: "" }))!;
    expect((await resp.json()).previewImage).toBeNull();
  });
});

// L'incidente dell'11/08 dalla porta vera: una card sparita da Done senza che la
// board lo dicesse. Le due domande separate — il SEGNO (leggibile dall'API, non
// solo dai commenti) e il PERMESSO (chi ha chiuso decide chi riapre).
describe("uscita da Done: il segno sulla card e chi può riaprirla", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  /** Consegna dell'agent + approvazione umana: il done di Attilio. */
  async function approvedByHuman(): Promise<{ id: string; pid: string }> {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "lavoro" }))!.json();
    await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "consegnato" });
    await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review" });
    const ok = (await call(router, "POST", `/api/boards/${t.projectId}/tasks/${t.id}/review`, { decision: "approve" }))!;
    expect((await ok.json()).status).toBe("done");
    return { id: t.id, pid: t.projectId };
  }

  test("l'agent che riapre una card approvata da un umano prende 409 e la card non si muove", async () => {
    const { id, pid } = await approvedByHuman();
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${id}`, { status: "in_progress" }))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("reopen_needs_human");
    const { tasks } = await (await call(router, "GET", `/api/boards/${pid}/tasks`))!.json();
    const card = tasks.find((x: any) => x.id === id);
    expect(card.status).toBe("done");
    expect(card.doneActor).toBe("human");
    expect(card.reopenedAt).toBeNull();
  });

  test("quando la card ESCE da done, l'API della board lo dice: reopenedAt/By/Actor sulla card", async () => {
    const { id, pid } = await approvedByHuman();
    // L'umano la riapre: legittimo — ma la board deve dirlo lo stesso.
    const back = (await call(router, "PATCH", `/api/boards/${pid}/tasks/${id}`, { status: "in_progress" }))!;
    expect(back.status).toBe(200);

    const { tasks } = await (await call(router, "GET", `/api/boards/${pid}/tasks`))!.json();
    const card = tasks.find((x: any) => x.id === id);
    expect(card.status).toBe("in_progress");
    expect(typeof card.reopenedAt).toBe("string");
    expect(card.reopenedActor).toBe("human");
    expect(card.reopenedBy).toBeTruthy();
    expect(card.doneActor).toBeNull();
    // Il segno vive sulla CARD, non nei commenti: chi disegna la colonna lo vede.
    const detail = await (await call(router, "GET", `/api/boards/${pid}/tasks/${id}`))!.json();
    expect(detail.task.reopenedAt).toBe(card.reopenedAt);
  });
});

/**
 * La raffica di land — il guasto misurato l'11/08 a mezzanotte.
 *
 * Landando in blocco le card in review con un ciclo (~20 `POST …/land` in
 * raffica) sono atterrate 4 fusioni. Le altre 16: `status='done'` col codice
 * ancora sul loro branch, zero commenti, zero ragione, zero traccia. Le STESSE
 * card, poi, una alla volta e aspettando ognuna: tutte riuscite. Quindi non era
 * la fusione a essere rotta — erano le chiamate concorrenti a sparire, e a
 * sparire in silenzio, perché la rotta faceva `void landTask(...)` e rispondeva
 * `200` con la card: chi chiamava riceveva la card, non l'esito.
 *
 * Serializzare ha senso (le fusioni toccano tutte main nello stesso checkout).
 * Il difetto non è la fila: è che chi arrivava mentre una era in corso spariva
 * invece di mettersi in coda.
 */
describe("land in raffica: N chiamate ⇒ N esiti", () => {
  /** Banco di prova: N card in review, ognuna col suo ramo di consegna. */
  function bench(opts?: { fail?: (taskId: string) => boolean }) {
    const db = freshDb();
    const broadcasts: any[] = [];
    const merges: string[] = [];
    const pending: string[] = [];
    let live = 0; let maxLive = 0;
    const autoMerge = {
      tryMerge: async (taskId: string) => {
        live += 1; maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 1));
        live -= 1;
        if (opts?.fail?.(taskId)) throw new Error("git è esploso");
        merges.push(taskId);
        return { status: "nothing" };
      },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = { onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {}, resume: async () => {} } as any;
    const stamped: Array<[string, string]> = [];
    const router = createTasksRouter(makeCtx(db, broadcasts), dispatcher, {
      autoMerge,
      markLandPending: (taskId: string) => { pending.push(taskId); },
      stampLanding: async (taskId: string, verdict: string) => { stamped.push([taskId, verdict]); },
    } as any);
    return {
      db, router, merges, pending, stamped,
      get maxLive() { return maxLive; },
      async seed(n: number): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: `card ${i}` }))!.json();
          db.prepare("UPDATE tasks SET status='review', delivery_branch='topics/b' || ? WHERE id = ?").run(String(i), t.id);
          db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, 'claude', 'consegna', 'comment', ?)")
            .run(`c${i}`, t.id, new Date().toISOString());
          ids.push(t.id);
        }
        return ids;
      },
      /** Aspetta che ogni ticket si chiuda, interrogando la rotta come farebbe la UI. */
      async settle(ids: string[]): Promise<any[]> {
        for (let round = 0; round < 500; round++) {
          const seen = await Promise.all(ids.map(async (id) => (await (await call(router, "GET", `/api/boards/pX/tasks/${id}/land`))!.json()).landing));
          if (seen.every((s) => s.phase === "settled" || s.phase === "failed")) return seen;
          await new Promise((r) => setTimeout(r, 2));
        }
        throw new Error("i ticket non si sono chiusi");
      },
    };
  }

  test("20 land in raffica ⇒ 20 esiti, nessuno perso, nessuna fusione sovrapposta", async () => {
    const b = bench();
    const ids = await b.seed(20);
    const resps = await Promise.all(ids.map((id) => call(b.router, "POST", `/api/boards/pX/tasks/${id}/land`, {})));
    // `202`, non `200`: il land è ACCETTATO, non ancora avvenuto. Il `200` con la
    // card dentro è precisamente ciò che faceva sembrare riuscita una raffica
    // che non lo era.
    expect(resps.map((r) => r!.status)).toEqual(ids.map(() => 202));
    const bodies = await Promise.all(resps.map((r) => r!.json()));
    expect(bodies.every((x) => x.landing && x.landing.taskId)).toBe(true);
    // Ognuno sa in quanti ha davanti: chi arriva mentre una fusione è in corso
    // si ACCODA, e lo dice.
    expect(bodies.map((x) => x.landing.ahead)).toEqual(ids.map((_, i) => i));

    const settled = await b.settle(ids);
    expect(settled.filter((s) => s.phase === "settled")).toHaveLength(20);
    expect(new Set(b.merges).size).toBe(20);   // venti fusioni, una per card
    expect(b.maxLive).toBe(1);                 // e mai due insieme sullo stesso checkout
  });

  test("fra la richiesta e la fusione la card NON è chiusa, ed è già timbrata", async () => {
    // La finestra che ci è costata le 16 card dell'11/08 e le tre del 13/08: la
    // card diventava `done` subito e la fusione arrivava dopo — o non arrivava.
    // Adesso in quella finestra la card sta ancora in review (la chiude il land,
    // a merge confermato) e il timbro parte già all'ACCODAMENTO, quindi c'è
    // anche se il processo muore prima che il suo turno arrivi.
    const b = bench();
    const ids = await b.seed(20);
    await Promise.all(ids.map((id) => call(b.router, "POST", `/api/boards/pX/tasks/${id}/land`, {})));
    // Subito, prima che la coda abbia finito: nessuna chiusa, tutte timbrate.
    const svc = createTaskService(b.db);
    for (const id of ids) expect(svc.get(id)!.task.status).toBe("review");
    expect(new Set(b.pending)).toEqual(new Set(ids));
    await b.settle(ids);
  });

  test("un land che esplode non ingoia l'errore, non ferma la fila, e NON chiude la card", async () => {
    // Il vecchio `catch { console.error }` produceva esattamente «zero commenti,
    // zero ragione»: una card in Done col codice sul suo ramo e un thread muto.
    const boom = new Set<string>();
    const b = bench({ fail: (id) => boom.has(id) });
    const ids = await b.seed(3);
    boom.add(ids[1]!);

    await Promise.all(ids.map((id) => call(b.router, "POST", `/api/boards/pX/tasks/${id}/land`, {})));
    const settled = await b.settle(ids);

    // L'esito del land fallito è LEGGIBILE, col motivo — è ciò che il `void` non
    // poteva dare: la richiesta era già chiusa quando git è esploso.
    expect(settled[1]!.phase).toBe("failed");
    expect(settled[1]!.error).toBe("git è esploso");
    // …e non contagia i vicini: la fila prosegue.
    expect(settled[0]!.phase).toBe("settled");
    expect(settled[2]!.phase).toBe("settled");

    const svc = createTaskService(b.db);
    const t = svc.get(ids[1]!)!;
    // LA BARRA DEL 13/08, primo sintomo: un land che fallisce non deve poter
    // lasciare la card in `done`. Adesso non ce la porta proprio — resta dove
    // stava, in review, col motivo nel thread. Rimettendo l'ordine vecchio
    // (approva e POI accoda) questo test è rosso: la card è `done`.
    expect(t.task.status).toBe("review");
    expect(t.comments.some((c) => c.content.includes("Land NON riuscito (errore interno)"))).toBe(true);
    expect(b.stamped).toContainEqual([ids[1]!, "unlanded"]);
    // E le vicine hanno girato davvero (qui il banco risponde «niente da
    // portare»): il loro esito è nel thread e nemmeno loro si chiudono, perché
    // nessuna ha visto un merge.
    const vicina = svc.get(ids[0]!)!;
    expect(vicina.task.status).toBe("review");
    expect(vicina.comments.some((c) => c.content.includes("Niente da atterrare"))).toBe(true);
  });

  test("due click su «Landa» sulla stessa card = UN land", async () => {
    const b = bench();
    const [id] = await b.seed(1);
    const first = await (await call(b.router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!.json();
    const second = await (await call(b.router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!.json();
    expect(second.landing.queuedAt).toBe(first.landing.queuedAt);
    await b.settle([id!]);
    expect(b.merges).toEqual([id!]);
    // LA SECONDA STRADA PER CHIUDERE UNA CARD SENZA ATTERRARE NIENTE. Il dedup è
    // giusto — la coda restituisce lo snapshot del ticket già aperto e NON fa
    // partire un secondo run — ma finché la rotta approvava prima di accodare,
    // quel click chiudeva la card comunque, senza che niente girasse. Adesso non
    // c'è approvazione da nessuna delle due parti: la card sta dov'è.
    expect(second.status).toBe("review");
    expect(createTaskService(b.db).get(id!)!.task.status).toBe("review");
  });

  test("GET …/land su una card mai landata è 404, non un falso «tutto a posto»", async () => {
    const b = bench();
    const [id] = await b.seed(1);
    expect((await call(b.router, "GET", `/api/boards/pX/tasks/${id}/land`))!.status).toBe(404);  });
});

// Un campo che la PATCH non sa applicare non si ignora. Misurato: `archived`
// passava, la riga restava a 0 e il chiamante aveva un 200 in mano. Un 200 che
// non fa niente è indistinguibile dal successo, quindi non si scopre mai.
describe("PATCH task: campo non applicabile = 400, non un 200 muto", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  const archivedFlag = (id: string): number =>
    (db.query("SELECT archived FROM tasks WHERE id = ?").get(id) as { archived: number }).archived;

  test("`archived` sulla board: 400 che nomina il campo e indica DELETE, riga intatta", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { archived: true }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe("unapplicable_field");
    expect(body.fields).toEqual(["archived"]);
    expect(body.error).toContain("DELETE");
    expect(archivedFlag(t.id)).toBe(0);
  });

  test("DELETE archivia ancora: si chiude il buco, non si sposta il gesto", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    expect((await call(router, "DELETE", `/api/boards/pX/tasks/${t.id}`))!.status).toBe(200);
    expect(archivedFlag(t.id)).toBe(1);
  });

  test("chiave sconosciuta → 400, e la elenca", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { pippo: 1, priority: 4 }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).fields).toEqual(["pippo"]);
    // Rifiuto TOTALE: il campo buono della stessa richiesta non passa da solo,
    // o metà patch applicata sarebbe di nuovo un esito che nessuno ha chiesto.
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.task.priority).toBe(2);
  });

  test("tipo sbagliato → 400 (una stringa al posto di un numero non è «campo assente»)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x", priority: 1 }))!.json();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { priority: "4" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).fields).toEqual(["priority"]);
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.task.priority).toBe(1);
  });

  test("anteprima non mostrabile → 400, non un 200 con la card vuota", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { previewImage: "/tmp/report.pdf" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).fields).toEqual(["previewImage"]);
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.task.previewImage).toBe(null);
  });

  test("`assignee: null` stacca l'assegnatario invece di essere scartato", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x", assignee: "claude" }))!.json();
    expect(t.assignedTo).toBe("claude");
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { assignee: null }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).assignedTo).toBe(null);
  });

  test("`dueDate` si applica (il service lo scrive: era solo la rotta a perderlo)", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { dueDate: "2026-09-01" }))!;
    expect(resp.status).toBe(200);
    expect((await resp.json()).dueDate).toBe("2026-09-01");
  });

  test("rotta agente: un campo che solo la board sa applicare è 400 lì, non silenzio", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { kanbanOrder: 7 }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).fields).toEqual(["kanbanOrder"]);
  });

  test("la patch buona resta un 200 su entrambe le rotte", async () => {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x" }))!.json();
    const human = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, {
      text: "y", description: null, priority: 3, status: "todo", kanbanOrder: 2,
      outputUrl: "", model: null, blockedByTaskId: null, reuseBlockerContext: true,
      planFirst: true, parentTaskId: null, previewImage: "",
    }))!;
    expect(human.status).toBe(200);
    const a = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const agent = (await call(router, "PATCH", `/api/sessions/s1/tasks/${a.id}`, {
      status: "in_progress", priority: 1, assignee: "claude", output_url: "", text: "z",
      description: "d", previewImage: "",
    }))!;
    expect(agent.status).toBe(200);
  });
});

// Misurato il 13/08/2026, con una priorità sbagliata a mano:
//   PATCH {"priority": 9} → 500 {"error":"CHECK constraint failed: priority BETWEEN 0 AND 4"}
// Il codice mandava a cercare un guasto nel server, che era intero, e il
// messaggio era la riga di schema di SQLite: si legge solo sapendo che esiste
// un CHECK, e chi chiama lo schema non ce l'ha.
describe("valore fuori dominio: 400 con la regola, non 500 con l'SQL", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  /** Nessun pezzo di SQL deve affiorare fino al client. */
  const senzaSql = (body: any) => {
    const testo = JSON.stringify(body);
    expect(testo).not.toContain("CHECK");
    expect(testo).not.toContain("constraint");
    expect(testo).not.toContain("BETWEEN");
  };

  const nuovo = async (patch: Record<string, unknown> = {}) =>
    await (await call(router, "POST", "/api/boards/pX/tasks", { text: "x", ...patch }))!.json();

  test("priority fuori range sulla board: 400, il range a parole, riga intatta", async () => {
    const t = await nuovo({ priority: 1 });
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { priority: 9 }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.fields).toEqual(["priority"]);
    expect(body.error).toContain("da 0 a 4");
    senzaSql(body);
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.task.priority).toBe(1);
  });

  test("priority fuori range sulla rotta agente: stesso 400", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { priority: -1 }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.fields).toEqual(["priority"]);
    expect(body.error).toContain("da 0 a 4");
    senzaSql(body);
  });

  test("priority con la virgola: 400 (il DB la troncherebbe in silenzio)", async () => {
    const t = await nuovo();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { priority: 2.5 }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toContain("intero");
  });

  test("gli estremi del dominio restano validi: 0 e 4 sono 200", async () => {
    const t = await nuovo();
    for (const p of [0, 4]) {
      const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { priority: p }))!;
      expect(resp.status).toBe(200);
      expect((await resp.json()).priority).toBe(p);
    }
  });

  test("status fuori dominio: 400 che elenca i cinque valori", async () => {
    const t = await nuovo();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${t.id}`, { status: "quasi_fatto" }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.fields).toEqual(["status"]);
    expect(body.error).toContain("in_progress");
    expect(body.error).toContain("backlog");
    senzaSql(body);
    const got = await (await call(router, "GET", `/api/boards/pX/tasks/${t.id}`))!.json();
    expect(got.task.status).toBe(t.status);
  });

  test("status fuori dominio sulla rotta agente: stesso 400", async () => {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    const resp = (await call(router, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "quasi_fatto" }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.fields).toEqual(["status"]);
    expect(body.error).toContain("review");
    senzaSql(body);
  });

  // La CREAZIONE non passa dalla tabella dei campi della PATCH: qui il valore
  // arriva davvero al DB, ed è la seconda rete a tradurre il CHECK.
  test("creazione con priority fuori range: il CHECK diventa 400, non 500", async () => {
    const resp = (await call(router, "POST", "/api/boards/pX/tasks", { text: "x", priority: 9 }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe("invalid_input");
    expect(body.error).toContain("da 0 a 4");
    senzaSql(body);
  });
});

describe("le due risposte allo stallo dei sottotask parcheggiati", () => {
  // La domanda la fa il sistema, e la risposta la ESEGUE il sistema. Prima
  // queste due etichette sarebbero cadute nel ramo `reject`: un turno d'agente
  // pagato per spostare due card di colonna, e su una card senza sessione
  // nemmeno quello — il rifiuto la mandava in `in_progress` e lì restava.
  let db: Database; let broadcasts: any[];
  let resumed: string[]; let todos: string[]; let router: any;

  beforeEach(() => {
    db = freshDb(); broadcasts = []; resumed = []; todos = [];
    const dispatcher = {
      onEnterTodo(_p: string, id: string) { todos.push(id); },
      onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string) => { resumed.push(id); },
    } as any;
    router = createTasksRouter(makeCtx(db, broadcasts), dispatcher);
  });

  /** Un padre che chiede, con un figlio parcheggiato sotto. */
  async function padreCheChiede(): Promise<{ padre: string; figlio: string }> {
    const p = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "il padre" }))!.json();
    const f = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "il figlio", parentTaskId: p.id }))!.json();
    db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = ?").run(f.id);
    db.prepare(
      "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', delivered_by = 'system', delivered_reason = 'parked_children', dispatch_attempts = 2 WHERE id = ?",
    ).run(p.id);
    return { padre: p.id, figlio: f.id };
  }

  test("«rimetti in coda»: figlio in todo, padre in coda, nessun agente svegliato", async () => {
    const { padre, figlio } = await padreCheChiede();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${padre}/review`, {
      decision: "reject", comment: REQUEUE_PARKED_LABEL,
    }))!.json();

    expect(t.status).toBe("todo");
    expect(t.dispatchState).toBe("queued");
    expect(t.dispatchAttempts).toBe(0);
    expect((db.prepare("SELECT status FROM tasks WHERE id = ?").get(figlio) as any).status).toBe("todo");
    expect(resumed).toEqual([]);
    expect(todos).toEqual([padre]);
    // Il figlio non viaggia nel feed della board: senza il suo broadcast, un
    // drawer aperto lo mostrerebbe ancora parcheggiato.
    expect(broadcasts.filter((b) => b.type === "task:updated" && b.task?.id === figlio)).toHaveLength(1);
  });

  test("«archivia»: il figlio sparisce e il padre torna in coda", async () => {
    const { padre, figlio } = await padreCheChiede();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${padre}/review`, {
      decision: "reject", comment: ARCHIVE_PARKED_LABEL,
    }))!.json();

    expect(t.status).toBe("todo");
    expect((db.prepare("SELECT archived FROM tasks WHERE id = ?").get(figlio) as any).archived).toBe(1);
  });

  test("rispondere a una domanda già risolta è 409, non un esito inventato", async () => {
    const { padre } = await padreCheChiede();
    await call(router, "POST", `/api/boards/pX/tasks/${padre}/review`, { decision: "reject", comment: REQUEUE_PARKED_LABEL });
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${padre}/review`, {
      decision: "reject", comment: ARCHIVE_PARKED_LABEL,
    }))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("no_parked_children");
  });

  test("un rifiuto normale resta un rifiuto: l'agente riparte", async () => {
    const { padre } = await padreCheChiede();
    db.run("INSERT INTO topics (id) VALUES ('top-9')");
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-9' WHERE id = ?").run(padre);
    await call(router, "POST", `/api/boards/pX/tasks/${padre}/review`, { decision: "reject", comment: "rifallo" });
    expect(resumed).toEqual([padre]);
  });
});

/**
 * La board non deve crescere da sola. In 24h gli agenti hanno aperto 320 card
 * contro le 45 dell'umano: il difetto non e' che qualcuno chiuda male, e' che
 * nessuno CERCA prima di aprire. Qui si controlla il cancello sulla porta degli
 * agenti e la fusione, che e' l'unico modo di togliere una card senza buttarla.
 */
describe("doppioni: il cancello alla creazione e la fusione", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  const CARD = "store: UserMemoryStore.update() + test";

  test("l'agente che riapre la stessa card riceve 409 e l'id di quella che esiste", async () => {
    const first = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: CARD }))!.json();
    const resp = (await call(router, "POST", "/api/sessions/s1/tasks", {
      text: "store: UserMemoryStore.update() + unit test",
    }))!;
    expect(resp.status).toBe(409);
    const err = await resp.json();
    expect(err.code).toBe("duplicate");
    expect(err.duplicates[0].id).toBe(first.id);
    expect(err.duplicates[0].score).toBeGreaterThanOrEqual(0.72);
    // Le due mosse praticabili, scritte con i nomi esatti dei tool: senza
    // questi l'unica mossa che resta all'agente e' riscrivere il titolo storto
    // finche' passa, cioe' il guasto che il cancello doveva impedire.
    expect(err.error).toContain("add_comment");
    expect(err.error).toContain("allow_duplicate: true");
  });

  test("il cancello si scavalca, ma dicendolo", async () => {
    await call(router, "POST", "/api/sessions/s1/tasks", { text: CARD });
    const resp = (await call(router, "POST", "/api/sessions/s1/tasks", {
      text: "store: UserMemoryStore.update() + unit test",
      allow_duplicate: true,
    }))!;
    expect(resp.status).toBe(201);
  });

  test("una card nuova passa senza attriti", async () => {
    await call(router, "POST", "/api/sessions/s1/tasks", { text: CARD });
    const resp = (await call(router, "POST", "/api/sessions/s1/tasks", { text: "Sonda della CPU vera sotto carico" }))!;
    expect(resp.status).toBe(201);
  });

  test("il cancello guarda la PROPRIA board: due progetti non si intralciano", async () => {
    await call(router, "POST", "/api/sessions/s1/tasks", { text: CARD });
    const resp = (await call(router, "POST", "/api/sessions/s2/tasks", {
      text: "store: UserMemoryStore.update() + unit test",
    }))!;
    expect(resp.status).toBe(201);
  });

  /**
   * Il cancello guarda solo il primo livello. I passi di un lavoro si chiamano
   * uguali sotto padri diversi ("cancelli", "prova video") e non sono doppioni.
   * E c'e' un secondo motivo, trovato da un test che era gia' verde: un
   * `parent_task_id` di un'altra board deve rispondere 404, e un cancello che
   * parlava per primo lo trasformava in 409.
   */
  test("un sottotask non passa dal cancello: i passi si ripetono per mestiere", async () => {
    const parent = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "Il lavoro grosso" }))!.json();
    const uno = (await call(router, "POST", "/api/sessions/s1/tasks", { text: "cancelli e prova", parent_task_id: parent.id }))!;
    expect(uno.status).toBe(201);
    const due = (await call(router, "POST", "/api/sessions/s1/tasks", { text: "cancelli e prova", parent_task_id: parent.id }))!;
    expect(due.status).toBe(201);
  });

  test("la fusione toglie la card dalla board e ridisegna la superstite", async () => {
    const a = await (await call(router, "POST", "/api/boards/pX/tasks", { text: CARD }))!.json();
    const b = await (await call(router, "POST", "/api/boards/pX/tasks", {
      text: "store: UserMemoryStore.update() + unit test",
    }))!.json();
    broadcasts.length = 0;

    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${b.id}/merge`, { intoTaskId: a.id }))!;
    expect(resp.status).toBe(200);
    const esito = await resp.json();
    expect(esito.survivor.id).toBe(a.id);
    // Il client deve TOGLIERE la card fusa: senza questo evento resterebbe
    // disegnata fino al prossimo reload, e sembrerebbe che la fusione non abbia
    // fatto niente.
    expect(broadcasts.some((x) => x.type === "task:deleted" && x.taskId === b.id)).toBe(true);
    expect(broadcasts.some((x) => x.type === "task:updated" && x.task?.id === a.id)).toBe(true);
  });

  test("senza intoTaskId la fusione e' un 400, non una card archiviata per sbaglio", async () => {
    const a = await (await call(router, "POST", "/api/boards/pX/tasks", { text: CARD }))!.json();
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${a.id}/merge`, {}))!;
    expect(resp.status).toBe(400);
    const dopo = await (await call(router, "GET", "/api/boards/pX/tasks"))!.json();
    expect(dopo.tasks.length).toBe(1);
  });

  test("i gruppi si leggono senza fondere niente, e di default solo fra le card aperte", async () => {
    const a = await (await call(router, "POST", "/api/boards/pX/tasks", { text: CARD }))!.json();
    const b = await (await call(router, "POST", "/api/boards/pX/tasks", {
      text: "store: UserMemoryStore.update() + unit test",
    }))!.json();
    const resp = (await call(router, "GET", "/api/boards/pX/duplicates"))!;
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.groups.length).toBe(1);
    // Chi delle due sopravvive NON si asserisce qui: il router usa l'orologio
    // vero, le due card nascono nello stesso istante e a parità di `createdAt`
    // il pareggio lo rompe l'id, che è un uuid casuale. Questa riga asseriva
    // `survivor === a.id` e passava una volta su due: verde per fortuna, non
    // per costruzione. La scelta della superstite è coperta dove l'orologio è
    // iniettato (`task-merge.test.ts`).
    const nelGruppo = [body.groups[0].survivor.id, ...body.groups[0].duplicates.map((d: any) => d.id)].sort();
    expect(nelGruppo).toEqual([a.id, b.id].sort());
    // Lettura: le due card sono ancora tutte e due sulla board.
    const dopo = await (await call(router, "GET", "/api/boards/pX/tasks"))!.json();
    expect(dopo.tasks.length).toBe(2);
  });
});

/**
 * LA SCELTA DEL FAN-OUT SI FA UNA VOLTA SOLA.
 *
 * `attempts.select` è atomico dentro di sé (una transazione, mai due
 * `selected`), ma non aveva una PRECONDIZIONE. La potatura dei perdenti gira
 * fuori dalla transazione, quindi una seconda scelta su un tentativo diverso
 * ripuntava `assigned_topic_id` su un worktree che la prima aveva già buttato —
 * e su quell'indirezione viaggiano diff, checks, land, anteprima e reap. Due
 * schede aperte, o un doppio invio, e il lavoro scelto per primo diventava
 * irraggiungibile senza che nessuna riga lo dicesse.
 */
describe("fan-out: la scelta del vincitore", () => {
  let db: Database; let broadcasts: any[]; let router: any;
  beforeEach(() => {
    db = freshDb(); broadcasts = [];
    router = createTasksRouter(makeCtx(db, broadcasts));
  });

  /** Due tentativi finiti, ciascuno con la sua chat: la forma alla chiusura del fan-out. */
  async function conDueTentativi(): Promise<{ taskId: string; a1: string; a2: string }> {
    const task = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "due strade" }))!.json();
    for (const n of [1, 2]) {
      db.run("INSERT INTO topics (id) VALUES (?)", [`top-${n}`]);
      db.run(
        `INSERT INTO task_attempts (id, task_id, idx, topic_id, branch, state, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 'delivered', '2026-08-15T10:00:00.000Z', '2026-08-15T11:00:00.000Z')`,
        [`att-${n}`, task.id, n, `top-${n}`, `topics/strada-${n}`],
      );
    }
    return { taskId: task.id, a1: "att-1", a2: "att-2" };
  }

  const pick = (taskId: string, attemptId: string) =>
    call(router, "POST", `/api/boards/pX/tasks/${taskId}/attempts/${attemptId}/select`);

  test("una seconda scelta su un ALTRO tentativo è 409 fanout_already_decided, e nomina il vincitore", async () => {
    const { taskId, a1, a2 } = await conDueTentativi();

    expect((await pick(taskId, a1))!.status).toBe(200);
    // Il task punta al vincitore: è l'indirezione su cui viaggia tutto il resto.
    expect(db.query("SELECT assigned_topic_id AS t FROM tasks WHERE id = ?").get(taskId)).toEqual({ t: "top-1" });

    const secondo = (await pick(taskId, a2))!;
    expect(secondo.status).toBe(409);
    const body = await secondo.json();
    expect(body.code).toBe("fanout_already_decided");
    expect(body.attemptId).toBe(a1);
    // E il ri-puntamento NON è avvenuto: il worktree del primo è ancora quello del task.
    expect(db.query("SELECT assigned_topic_id AS t FROM tasks WHERE id = ?").get(taskId)).toEqual({ t: "top-1" });
    expect(db.query("SELECT state FROM task_attempts WHERE id = ?").get(a2)).toEqual({ state: "discarded" });
  });

  test("ripremere sullo STESSO tentativo resta idempotente", async () => {
    // La controprova: un cancello che rifiutasse anche questo trasformerebbe un
    // doppio click innocuo in un errore da leggere.
    const { taskId, a1 } = await conDueTentativi();
    expect((await pick(taskId, a1))!.status).toBe(200);
    expect((await pick(taskId, a1))!.status).toBe(200);
    expect(db.query("SELECT assigned_topic_id AS t FROM tasks WHERE id = ?").get(taskId)).toEqual({ t: "top-1" });
  });

  test("un tentativo ANCORA VIVO blocca la scelta prima di tutto il resto", async () => {
    // Il 409 che c'era già: si pinza qui perché il cancello nuovo gli sta
    // accanto, e l'ordine dei due conta (un fan-out non chiuso non è «deciso»).
    const { taskId, a1 } = await conDueTentativi();
    db.run("UPDATE task_attempts SET state = 'running' WHERE id = 'att-2'");
    const resp = (await pick(taskId, a1))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("fanout_running");
  });
});

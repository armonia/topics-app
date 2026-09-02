/**
 * Le route del fan-out: elenco dei tentativi, scelta del vincitore, diff per
 * tentativo, e il cancello che tiene gli N agenti fuori dal task condiviso.
 *
 * Il punto che questi test proteggono è UNO: scegliere un vincitore è
 * ri-puntare `assigned_topic_id`. Tutto il resto della board (diff, checks,
 * consegna, land, reap) viaggia già su quella indirezione, quindi se la scelta
 * la sposta bene non serve altra idraulica — e se un giorno qualcuno la
 * "ottimizza" via, qui diventa rosso.
 *
 * @covers KANBAN-13
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext } from "../types";
import { createTasksRouter } from "./tasks";
import { createTaskAttemptStore } from "../services/task-attempts";
import { createTaskService } from "../services/tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

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
    max_agents_auto INTEGER, review_checks TEXT, dispatch_fanout INTEGER
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
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running',
    commit_sha TEXT, files_changed INTEGER, insertions INTEGER, deletions INTEGER,
    summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

// Copia fedele di server/utils.ts:matchRoute.
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

const PID = "alpha-abc123";

type Topic = { id: string; name: string; projectPath: string; worktreeId?: string; archived?: boolean; updatedAt?: string };

function makeCtx(db: Database, topics: Map<string, Topic>, broadcasts: any[], deleted: string[]) {
  return {
    db,
    json: (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
    matchRoute,
    broadcastToAll: (m: any) => { broadcasts.push(m); },
    getTopicById: (id: string) => topics.get(id) ?? null,
    saveSingleTopic: (t: Topic) => { topics.set(t.id, t); },
    // La sessione del tentativo 1 è l'unica che può risolvere la board del task:
    // i tentativi 2..N non sono legati a niente, ed è il punto del cancello.
    getTopicBySessionKey: (sk: string) => (sk === "sk1" ? topics.get("topic-1") ?? null : null),
    worktreeStore: { get: () => null },
    worktreeManager: { delete: async (id: string) => { deleted.push(id); return true; } },
  } as unknown as AppContext;
}

function call(router: any, method: string, path: string, body?: any) {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://x${path}`, init);
  return router(req, new URL(req.url), new URL(req.url).pathname, method) as Promise<Response | null>;
}

describe("route del fan-out", () => {
  let db: Database, topics: Map<string, Topic>, broadcasts: any[], deleted: string[];
  let router: any, svc: ReturnType<typeof createTaskService>, attempts: ReturnType<typeof createTaskAttemptStore>;
  let previewed: string[];

  beforeEach(() => {
    db = freshDb();
    broadcasts = []; deleted = []; previewed = [];
    topics = new Map([
      ["topic-1", { id: "topic-1", name: "t1", projectPath: "/Users/x/Projects/alpha" }],
      ["topic-2", { id: "topic-2", name: "t2", projectPath: "/Users/x/Projects/alpha" }],
    ]);
    for (const id of topics.keys()) db.run("INSERT INTO topics (id) VALUES (?)", [id]);
    svc = createTaskService(db);
    attempts = createTaskAttemptStore(db);
    router = createTasksRouter(makeCtx(db, topics, broadcasts, deleted), undefined, {
      taskDeliveryRef: async () => ({ branch: "task/wt-2", commit: "deadbeef" }),
      preparePreview: async (taskId: string) => { previewed.push(taskId); },
    });
  });

  /** Un task in review con due tentativi chiusi: il caso da cui parte la scelta. */
  function seedFanOut(o: { closed?: boolean } = {}) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id)
       VALUES ('T', ?, 'fare la cosa', 'review', ?, ?, 'topic-1')`,
      [PID, now, now],
    );
    const a1 = attempts.create({ taskId: "T", idx: 1 });
    attempts.bind(a1.id, { topicId: "topic-1", worktreeId: "wt-1", branch: "task/wt-1" });
    const a2 = attempts.create({ taskId: "T", idx: 2 });
    attempts.bind(a2.id, { topicId: "topic-2", worktreeId: "wt-2", branch: "task/wt-2" });
    if (o.closed !== false) {
      attempts.finish(a1.id, { state: "delivered", commit: "aaa", filesChanged: 1, insertions: 5, deletions: 0 });
      attempts.finish(a2.id, { state: "delivered", commit: "bbb", filesChanged: 3, insertions: 40, deletions: 4 });
    }
    return { a1: a1.id, a2: a2.id };
  }

  test("GET /attempts elenca i tentativi; su un task normale è una lista vuota", async () => {
    seedFanOut();
    const r = (await call(router, "GET", `/api/boards/${PID}/tasks/T/attempts`))!;
    expect(r.status).toBe(200);
    const { attempts: list } = await r.json();
    expect(list.map((a: any) => a.idx)).toEqual([1, 2]);
    expect(list[1].filesChanged).toBe(3);

    const now = new Date().toISOString();
    db.run(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES ('N', ?, 'normale', 'todo', ?, ?)`, [PID, now, now]);
    const r2 = (await call(router, "GET", `/api/boards/${PID}/tasks/N/attempts`))!;
    expect((await r2.json()).attempts).toEqual([]);
  });

  test("GET /attempts di un task che non è di questa board → 404", async () => {
    seedFanOut();
    const r = (await call(router, "GET", "/api/boards/altra-board/tasks/T/attempts"))!;
    expect(r.status).toBe(404);
  });

  test("scegliere un vincitore RI-PUNTA il task sulla sua chat e pota gli altri", async () => {
    const { a2 } = seedFanOut();
    const r = (await call(router, "POST", `/api/boards/${PID}/tasks/T/attempts/${a2}/select`))!;
    expect(r.status).toBe(200);
    const { task, attempts: list } = await r.json();

    // Il fatto strutturale: il task ora È il tentativo 2.
    expect(task.assignedTopicId).toBe("topic-2");
    expect(list.find((a: any) => a.id === a2).state).toBe("selected");
    expect(list.find((a: any) => a.idx === 1).state).toBe("discarded");

    // I perdenti spariscono: worktree potato e chat archiviata.
    expect(deleted).toEqual(["wt-1"]);
    expect(topics.get("topic-1")!.archived).toBe(true);
    expect(topics.get("topic-2")!.archived).toBeUndefined();
    expect(broadcasts.some((b) => b.type === "topic:archived" && b.topic.id === "topic-1")).toBe(true);

    // La fotografia di consegna si ri-scatta sul vincitore: `captureDelivery`
    // scatta solo sul bordo verso `review`, e lì il task era il tentativo 1.
    expect(task.deliveryBranch).toBe("task/wt-2");
    expect(task.deliveryCommit).toBe("deadbeef");
    expect(previewed).toEqual(["T"]);

    const thread = (svc.get("T")!.comments).map((c) => c.content).join("\n");
    expect(thread).toContain("Scelto il **tentativo 2**");
    expect(thread).toContain("3 file · +40 −4");
    expect(broadcasts.some((b) => b.type === "task:updated")).toBe(true);
  });

  test("scegliere mentre un tentativo lavora ancora → 409, niente potature", async () => {
    const { a1 } = seedFanOut({ closed: false });
    const r = (await call(router, "POST", `/api/boards/${PID}/tasks/T/attempts/${a1}/select`))!;
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("fanout_running");
    expect(deleted).toEqual([]);
    expect(svc.get("T")!.task.assignedTopicId).toBe("topic-1");
  });

  test("un tentativo di un ALTRO task non si sceglie da questa board", async () => {
    seedFanOut();
    const now = new Date().toISOString();
    db.run(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES ('U', ?, 'altro', 'review', ?, ?)`, [PID, now, now]);
    const alien = attempts.create({ taskId: "U", idx: 1 });
    attempts.bind(alien.id, { topicId: "topic-2", worktreeId: "wt-9" });
    attempts.finish(alien.id, { state: "delivered", commit: "zzz" });

    const r = (await call(router, "POST", `/api/boards/${PID}/tasks/T/attempts/${alien.id}/select`))!;
    expect(r.status).toBe(404);
    expect(svc.get("T")!.task.assignedTopicId).toBe("topic-1");
    expect(deleted).toEqual([]);
  });

  test("il diff di un tentativo NON è leggibile passando l'id di un altro task", async () => {
    seedFanOut();
    const now = new Date().toISOString();
    db.run(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES ('U', ?, 'altro', 'review', ?, ?)`, [PID, now, now]);
    const alien = attempts.create({ taskId: "U", idx: 1 });
    attempts.bind(alien.id, { topicId: "topic-2", worktreeId: "wt-9" });

    const r = (await call(router, "GET", `/api/boards/${PID}/tasks/T/diff?attempt=${alien.id}`))!;
    const body = await r.json();
    // Il tentativo non si risolve, quindi non c'è niente da leggere — e con un
    // `?attempt` in mano NON si ripiega sui riferimenti durevoli del task, che
    // parlerebbero del vincitore: sarebbe il diff di un altro.
    expect(body.code).toBe("not_dispatched");
    expect(body.stat).toEqual([]);
    expect(body.patch).toBe("");
  });

  test("un tentativo senza sessione non si può scegliere (non c'è niente da tenere)", async () => {
    const now = new Date().toISOString();
    db.run(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id) VALUES ('T', ?, 'x', 'review', ?, ?, 'topic-1')`, [PID, now, now]);
    const dead = attempts.create({ taskId: "T", idx: 1 });   // mai bindato: setup fallito
    attempts.finish(dead.id, { state: "failed", error: "worktree non creato" });

    const r = (await call(router, "POST", `/api/boards/${PID}/tasks/T/attempts/${dead.id}/select`))!;
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("invalid_input");
  });

  test("con un fan-out vivo l'agent NON scrive nel thread né muove il task", async () => {
    seedFanOut({ closed: false });

    const c = (await call(router, "POST", "/api/sessions/sk1/tasks/T/comments", { content: "ci sto lavorando" }))!;
    expect(c.status).toBe(409);
    const body = await c.json();
    expect(body.code).toBe("fanout_running");
    // L'errore è anche il coaching: dice cosa fare INVECE di quello che ha provato.
    expect(body.error).toContain("2 parallel attempts");
    expect(body.error).toContain("commit everything on your branch");

    const p = (await call(router, "PATCH", "/api/sessions/sk1/tasks/T", { status: "review", summary: "riassunto della consegna" }))!;
    expect(p.status).toBe(409);
    expect((await p.json()).code).toBe("fanout_running");

    const d = (await call(router, "POST", "/api/sessions/sk1/tasks/T/defer", { reason: "aspetto" }))!;
    expect(d.status).toBe(409);

    expect(svc.get("T")!.comments.length).toBe(0);
  });

  test("a fan-out chiuso l'agent torna libero di scrivere", async () => {
    seedFanOut();   // tutti i tentativi finiti
    const c = (await call(router, "POST", "/api/sessions/sk1/tasks/T/comments", { content: "fatto" }))!;
    expect(c.status).toBe(201);
    expect(svc.get("T")!.comments.map((x) => x.content)).toContain("fatto");
  });

  /**
   * Fermare (o archiviare) un fan-out taglia TUTTI i turni, non solo quello del
   * tentativo legato al task. `assigned_topic_id` ne punta uno; gli altri N-1
   * restavano a girare dopo che l'umano aveva già detto basta.
   */
  describe("fermare un fan-out", () => {
    let aborted: string[];
    let r: any;
    beforeEach(() => {
      aborted = [];
      r = createTasksRouter(makeCtx(db, topics, broadcasts, deleted), undefined, {
        abortTurn: async (sk: string) => { aborted.push(sk); },
      });
    });

    test("stop aborta la sessione di OGNI tentativo vivo e ne chiude le righe", async () => {
      seedFanOut({ closed: false }); // due tentativi ancora `running`
      db.run("UPDATE tasks SET status = 'in_progress', dispatch_state = 'working' WHERE id = 'T'");

      const resp = (await call(r, "POST", `/api/boards/${PID}/tasks/T/stop`, {}))!;
      expect(resp.status).toBe(200);
      expect(aborted.sort()).toEqual(["topic:topic-1", "topic:topic-2"]);
      // Nessun tentativo resta `running`: altrimenti il gate del fan-out
      // sbarrerebbe il task per sempre e `reconcile` crederebbe di dover
      // recuperare un giro che non c'è più.
      expect(attempts.runningCount("T")).toBe(0);
      expect(attempts.list("T").map((a) => a.state)).toEqual(["failed", "failed"]);
    });

    test("archiviare un fan-out fa la stessa cosa, e archivia", async () => {
      seedFanOut({ closed: false });
      db.run("UPDATE tasks SET status = 'in_progress', dispatch_state = 'working' WHERE id = 'T'");

      expect((await call(r, "DELETE", `/api/boards/${PID}/tasks/T`))!.status).toBe(200);
      expect(aborted.sort()).toEqual(["topic:topic-1", "topic:topic-2"]);
      expect(attempts.runningCount("T")).toBe(0);
      expect((db.prepare("SELECT archived FROM tasks WHERE id = 'T'").get() as any).archived).toBe(1);
    });

    test("il topic legato al task non viene abortito due volte", async () => {
      // Un fan-out da UNO: `assigned_topic_id` e il topic del tentativo 1 sono
      // lo stesso, e la chiave di sessione va emessa una volta sola.
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, dispatch_state)
         VALUES ('S', ?, 'da solo', 'in_progress', ?, ?, 'topic-1', 'working')`,
        [PID, now, now],
      );
      const only = attempts.create({ taskId: "S", idx: 1 });
      attempts.bind(only.id, { topicId: "topic-1", worktreeId: "wt-1" });

      expect((await call(r, "POST", `/api/boards/${PID}/tasks/S/stop`, {}))!.status).toBe(200);
      expect(aborted).toEqual(["topic:topic-1"]);
    });

    test("senza agent e senza tentativi vivi resta un 409", async () => {
      seedFanOut(); // tutti i tentativi già chiusi
      db.run("UPDATE tasks SET assigned_topic_id = NULL, dispatch_state = NULL WHERE id = 'T'");
      expect((await call(r, "POST", `/api/boards/${PID}/tasks/T/stop`, {}))!.status).toBe(409);
      expect(aborted).toEqual([]);
    });
  });
});

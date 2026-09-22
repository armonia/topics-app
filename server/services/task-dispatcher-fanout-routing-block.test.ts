/**
 * AICTRL-01 nel fan-out: un cancello duro non si trasforma in "tentativo fallito". allow-italian: la regola che il file difende
 * `runAttempt` catturava tutto e chiudeva il tentativo come fallito, che per il fan-out significa «e' partito davvero»: il ramo che parcheggia col motivo non veniva mai raggiunto e la card tornava in giro muta. allow-italian: nomina il difetto trovato in review
 * Il mismatch e' PERMANENTE: rimetterlo in coda ripete lo stesso errore per sempre. Il catalogo ancora freddo e' l'altro caso, e aspetta (task-dispatcher-topics-catalog-pending.test.ts). allow-italian: distingue i due esiti possibili
 *
 * @covers AICTRL-01
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { TopicsRoutingUnavailableError } from "../../shared/task-coding-models";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium', dispatch_model TEXT,
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_paused INTEGER NOT NULL DEFAULT 0,
    dispatch_topics_routing INTEGER CHECK (dispatch_topics_routing IN (0, 1))
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment', message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

const PID = "alpha-abc123";

function seedTask(db: Database, id: string, model?: string | null): void {
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, ?, 1)`,
    [id, PID, "task " + id, ts, ts, model ?? null],
  );
}

function harness(createTopic: DispatcherDeps["createTopic"]) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: string[] = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic,
    createWorktree: async () => "wt-1",
    deleteWorktree: async () => {},
    runTurn: async (sessionKey: string) => { turns.push(sessionKey); return undefined as TurnEndInfo | undefined; },
    broadcast: () => {},
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
  };
  return { db, svc, dispatcher: createTaskDispatcher(deps), turns };
}

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

async function runFanOut(createTopic: DispatcherDeps["createTopic"], model?: string | null) {
  const h = harness(createTopic);
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 2 });
  h.svc.setGlobalCap({ auto: false, max: 5 });
  seedTask(h.db, "t1", model);
  await h.dispatcher.tick(PID);
  await flush();
  return h;
}

describe("fan-out: il cancello di instradamento non si perde in un tentativo fallito", () => {
  it("parcheggia la card come bloccata, col motivo, invece di chiudere il fan-out come se fosse partito", async () => {
    const h = await runFanOut(() => { throw new TopicsRoutingUnavailableError("codex", "gpt-5.4"); });

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("blocked");
    // Il motivo arriva fino alla card: senza, resta un blocco muto. allow-italian: dice cosa prova l'asserzione dopo
    expect(task.dispatchError ?? "").toContain("codex");
    // Nessun turno e' mai partito, quindi niente da chiudere come consegna. allow-italian: dice cosa prova l'asserzione dopo
    expect(h.turns).toHaveLength(0);
  });

  it("stesso trattamento per task_model_unavailable, che e' altrettanto permanente", async () => {
    const h = await runFanOut(() => {
      throw Object.assign(new Error("Open Codex to refresh its available models, then retry the task."), { code: "task_model_unavailable" });
    });

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("blocked");
    expect(task.dispatchError ?? "").toContain("Codex");
  });

  it("i tentativi non restano `running` per sempre: la riga si chiude comunque", async () => {
    // Un tentativo eternamente in corso e' peggio di nessun tentativo: `runningCount` lo conta e il cancello del fan-out ci crede. allow-italian: perche' una riga aperta fa danno
    const h = await runFanOut(() => { throw new TopicsRoutingUnavailableError("codex", "gpt-5.4"); });

    const rows = h.db.query("SELECT state FROM task_attempts WHERE task_id = 't1'").all() as { state: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state !== "running")).toBe(true);
  });

  it("un guasto ORDINARIO resta un tentativo fallito, non un blocco: il cancello duro e` un`altra cosa", async () => {
    // La recinzione: solo gli errori PERMANENTI parcheggiano, o il fan-out smetterebbe di tollerare i guasti passeggeri. allow-italian: dice perche' questo caso NON deve bloccare
    const h = await runFanOut(() => { throw new Error("worktree bind fallito"); });

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).not.toBe("blocked");
  });
});

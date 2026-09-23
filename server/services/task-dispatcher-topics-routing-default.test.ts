/**
 * AICTRL-05: il default BOARD dello switch di instradamento. allow-italian: l'asse che il file copre
 * L'ordine non e' "board vince sempre" ne' "task vince sempre": lo switch esplicito del task (true O false) vince quando c'e', altrimenti decide il default della board, e solo se anche quello e' null torna in gioco il vecchio prefisso `topics:<model>`. allow-italian: l'ordine di risoluzione, il cuore del file
 * Prima il dispatcher passava lo switch grezzo del task senza leggere il default della board: una board accesa non instradava niente se il task non l'aveva mai toccato. allow-italian: nomina il difetto trovato in review
 *
 * @covers AICTRL-05
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
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
let seq = 0;
function seedTask(db: Database, o: { id?: string; model?: string | null; topicsRouting?: boolean | null } = {}): string {
  const id = o.id ?? `t${++seq}`;
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, model, topics_routing)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, ?, ?)`,
    [id, PID, "task " + id, ts, ts, o.model ?? null, o.topicsRouting === undefined ? null : (o.topicsRouting === null ? null : (o.topicsRouting ? 1 : 0))],
  );
  return id;
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const topicsCreated: { topicsRouting?: boolean | null }[] = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: (opts) => {
      topicsCreated.push({ topicsRouting: opts.topicsRouting });
      const n = topicsCreated.length;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async () => `wt-1`,
    runTurn: () => new Promise<TurnEndInfo | void>(() => {}),
    broadcast: () => {},
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return { db, svc, dispatcher, topicsCreated };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("AICTRL-05: default board dello switch di instradamento", () => {
  it("il default board accende il routing quando il task non ha scelto niente", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchTopicsRouting: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated[0]?.topicsRouting).toBe(true);
  });

  it("il task esplicito vince sempre sul default board, anche a spegnerlo", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchTopicsRouting: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", topicsRouting: false });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated[0]?.topicsRouting).toBe(false);
  });

  it("senza default board ne' scelta task, il vecchio prefisso topics:<model> resta l'ultimo ripiego", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", model: "topics:claude-sonnet-5" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated[0]?.topicsRouting).toBe(true);
  });

  it("il legacy topics:<model> della BOARD non si perde quando il task non sceglie un modello suo", async () => {
    // Il fallback legacy guardava SOLO il modello del task: una board col vecchio `dispatchModel` "topics:<model>" e lo switch mai toccato deve restare ON per i task senza modello proprio. allow-italian: nomina il difetto che il test blocca
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchModel: "topics:claude-sonnet-5" });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated[0]?.topicsRouting).toBe(true);
  });

  it("senza nessuno dei tre, resta spento", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, { id: "t1", model: "claude-sonnet-5" });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated[0]?.topicsRouting).toBe(false);
  });
});

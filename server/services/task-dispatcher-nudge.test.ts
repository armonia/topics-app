/**
 * QUATTRO VOLTE LA STESSA FRASE NELLA CHAT DEL TASK.
 *
 * Il 19/08, su `topic:7d043b7e`, la chat portava «Your previous turn on this
 * task was interrupted» alle 00:37:07, 00:38:01, 00:38:18 e 00:38:28: quattro
 * paragrafi identici in novanta secondi, sopra la conversazione vera. Il
 * messaggio lo inietta il dispatcher a ogni ripresa, e quel canale non aveva la
 * dedupe che i COMMENTI hanno da agosto (`claimInterruption`).
 *
 * Qui si misura il dispatcher, non la regola (quella sta in nudge-gate.test.ts):
 * il turno riparte SEMPRE, ma dalla seconda ripresa dentro la finestra parte con
 * una riga corta. E si misura la parte che la RAM non poteva fare: il secondo
 * dispatcher e' un processo NUOVO (e' appena ripartito, e' il motivo per cui
 * sollecita), e trova la rivendicazione sul task.
 *
 * @covers THREAD-02
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";

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
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
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

/** Una card come la trova il BOOT: in volo, legata al suo topic, chip `working`. */
function seedOrfana(db: Database, id: string): string {
  const ts = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority,
       dispatch_state, assigned_topic_id, interrupted_at, interrupted_by)
     VALUES (?, ?, ?, 'in_progress', ?, ?, 1, 3, 'working', ?, ?, 'SIGTERM')`,
    [id, PID, "task " + id, ts, ts, `topic-${id}`, ts],
  );
  return id;
}

/** Un dispatcher nuovo sullo stesso database: e' cosi' che si vede un RIAVVIO. */
function processo(db: Database, turns: string[]) {
  const svc: TaskService = createTaskService(db);
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => ({ topicId: "t-1", sessionKey: "topic:sk1" }),
    createWorktree: async () => "wt-1",
    deleteWorktree: async () => {},
    worktreeBranch: (id) => `task/${id}`,
    attemptStats: async () => ({ commit: "c0ffee", filesChanged: 1, insertions: 1, deletions: 0 }),
    archiveTopic: () => {},
    getLastAgentText: () => ({ text: "riassunto", id: "m-riassunto" }),
    topicExists: () => true,
    // Il turno non finisce mai: la card resta in volo, esattamente come quando
    // il processo le muore sotto.
    runTurn: (_sessionKey, content) =>
      new Promise<TurnEndInfo | void>(() => { turns.push(content); }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  return createTaskDispatcher(deps);
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const INTERO = "Your previous turn on this task was interrupted";

describe("il sollecito del dispatcher non si ripete in chat", () => {
  it("quattro riprese ravvicinate: un paragrafo e tre righe corte", async () => {
    const db = freshDb();
    const turns: string[] = [];
    seedOrfana(db, "t1");

    // Quattro riavvii di fila, come le quattro righe del 19/08. Ogni giro e' un
    // processo nuovo: la memoria in RAM qui non esiste per costruzione.
    for (let i = 0; i < 4; i++) {
      await processo(db, turns).reconcile();
      await flush();
    }

    expect(turns).toHaveLength(4);                                  // le riprese non si perdono
    expect(turns.filter((c) => c.includes(INTERO))).toHaveLength(1); // il paragrafo, una volta
    expect(turns[1]).toContain("resume #2");
    expect(turns[2]).toContain("resume #3");
    expect(turns[3]).toContain("resume #4");
    for (const c of turns.slice(1)) expect(c.length).toBeLessThan(turns[0]!.length);
  });

  it("la rivendicazione resta scritta sul task, non nel processo che l'ha fatta", async () => {
    const db = freshDb();
    const turns: string[] = [];
    seedOrfana(db, "t1");

    await processo(db, turns).reconcile();
    await flush();

    const riga = db.prepare("SELECT nudge_claimed_at, nudge_fingerprint, nudge_repeats FROM tasks WHERE id = 't1'")
      .get() as { nudge_claimed_at: string | null; nudge_fingerprint: string | null; nudge_repeats: number };
    expect(riga.nudge_claimed_at).toBeTruthy();
    expect(riga.nudge_fingerprint).toBeTruthy();
    expect(riga.nudge_repeats).toBe(1);
  });

  it("due card diverse non si zittiscono a vicenda", async () => {
    const db = freshDb();
    const turns: string[] = [];
    seedOrfana(db, "t1");
    seedOrfana(db, "t2");

    await processo(db, turns).reconcile();
    await flush();

    // Il cancello e' per card: due interruzioni, due solleciti interi.
    expect(turns.filter((c) => c.includes(INTERO))).toHaveLength(2);
  });
});

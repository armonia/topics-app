/**
 * LO SPEGNIMENTO SCRIVE UN BIT, E IL RECUPERO ARRIVA NEL LOG.
 *
 * Prima: `gracefulShutdown` fermava timer, provider e DB senza toccare una riga
 * di `tasks`. Per tutta la finestra morta la board diceva «sta lavorando» sopra
 * un processo che non esisteva, e lo stato «interrotto» non veniva deciso:
 * veniva INDOVINATO dal boot successivo guardando il chip rimasto li'. Il 18/08
 * il server ha ripreso 303 card e nel log non c'era una riga: per contarle
 * bisognava interrogare il database.
 *
 * E il terzo silenzio: una `in_progress` con un chip che il cancello del
 * recupero non accetta (`null`, `needs_input`, `delivered`) veniva saltata a
 * ogni giro per sempre, con un `continue` muto.
 *
 * Qui si misurano le tre righe: il conteggio dello spegnimento, il conteggio
 * del riavvio, e la nota che dice «qui non passera' nessuno» - una volta sola,
 * e solo alle card che il server ha davvero tagliato.
 * @covers KANBAN-10
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

let seq = 0;

/** Una card da mettere in coda: parte `todo`, la prende il `tick`. */
function seedTodo(db: Database, id: string): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, 3)`,
    [id, PID, "task " + id, ts, ts],
  );
  return id;
}

/** Una card come la trova il BOOT: `in_progress`, legata a un topic, col chip
 *  che il processo morto le aveva lasciato addosso. */
function seedOrfana(
  db: Database,
  id: string,
  opts: { chip: string | null; interruptedAt?: string | null },
): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority,
       dispatch_state, assigned_topic_id, interrupted_at, interrupted_by)
     VALUES (?, ?, ?, 'in_progress', ?, ?, 1, 3, ?, ?, ?, ?)`,
    [id, PID, "task " + id, ts, ts, opts.chip, `topic-${id}`, opts.interruptedAt ?? null, opts.interruptedAt ? "SIGTERM" : null],
  );
  return id;
}

function harness(overrides: Partial<DispatcherDeps> = {}, db = freshDb()) {
  const svc: TaskService = createTaskService(db);
  const attempts = createTaskAttemptStore(db);
  const turns: { sessionKey: string; content: string }[] = [];
  const righe: string[] = [];

  const deps: DispatcherDeps = {
    svc,
    attempts,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = turns.length + 1;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`t-${n}`]);
      return { topicId: `t-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async () => `wt-${turns.length + 1}`,
    deleteWorktree: async () => {},
    worktreeBranch: (id) => `task/${id}`,
    attemptStats: async () => ({ commit: "c0ffee", filesChanged: 1, insertions: 1, deletions: 0 }),
    archiveTopic: () => {},
    getLastAgentText: () => ({ text: "riassunto", id: "m-riassunto" }),
    topicExists: () => true,
    // Il turno non finisce mai: la card resta in volo, che e' esattamente lo
    // stato in cui la trova uno spegnimento.
    runTurn: (sessionKey, content) =>
      new Promise<TurnEndInfo | void>(() => { turns.push({ sessionKey, content }); }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: (m: string) => { righe.push(m); },
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  return {
    db, svc, dispatcher, turns, righe,
    riga: (frammento: string) => righe.filter((r) => r.includes(frammento)),
    riga1: (id: string) => db.prepare("SELECT interrupted_at, interrupted_by FROM tasks WHERE id = ?")
      .get(id) as { interrupted_at: string | null; interrupted_by: string | null },
    note: (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("il turno tagliato da un riavvio e' un fatto scritto", () => {
  it("lo spegnimento stampa interrupted_at sulle card in volo, e lo dice in una riga", async () => {
    const h = harness();
    seedTodo(h.db, "q1");
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.dispatcher.isInFlight("q1")).toBe(true); // il turno sta girando

    const marcate = h.dispatcher.markInterrupted("SIGTERM");

    expect(marcate).toBe(1);
    const r = h.riga1("q1");
    expect(r.interrupted_at).toBeTruthy();   // il bit che prima non veniva scritto
    expect(r.interrupted_by).toBe("SIGTERM");
    expect(h.riga("card tagliata").length).toBe(1);
    expect(h.riga("SIGTERM").length).toBe(1);
  });

  it("senza card in volo lo spegnimento non scrive niente e non stampa una riga di zero", () => {
    const h = harness();
    expect(h.dispatcher.markInterrupted("SIGTERM")).toBe(0);
    expect(h.riga("spegnimento").length).toBe(0);
  });

  it("il boot dopo riprende la card, e il log dice quante ne ha riprese", async () => {
    const h = harness();
    seedOrfana(h.db, "t1", { chip: "working", interruptedAt: "2026-08-18T23:00:00.000Z" });

    await h.dispatcher.reconcile();
    await flush();

    expect(h.turns.length).toBe(1);                       // ripresa sulla stessa sessione
    expect(h.svc.get("t1")!.task.dispatchAttempts).toBe(1); // un riavvio non consuma un tentativo
    // La riga che il 18/08 non esisteva: 303 riprese, zero righe nel log.
    expect(h.riga("riavvio: 1 riprese").length).toBe(1);
    expect(h.riga("0 in diretta, 1 da capo").length).toBe(1);
  });

  it("una card che il recupero non riprendera' mai lo DICE, una volta sola", async () => {
    const h = harness();
    // Chip `needs_input`: fuori dal cancello del recupero. Con `interrupted_at`
    // pero' e' stato il server a tagliarla, quindi il salto va raccontato.
    seedOrfana(h.db, "t1", { chip: "needs_input", interruptedAt: "2026-08-18T23:00:00.000Z" });

    await h.dispatcher.reconcile();
    await flush();

    expect(h.turns.length).toBe(0);                    // nessun turno: il cancello resta com'era
    expect(h.svc.get("t1")!.task.status).toBe("in_progress");
    const dette = h.note("t1").filter((c) => c.includes("nessun turno ripartira' da solo"));
    expect(dette.length).toBe(1);
    expect(dette[0]).toContain("needs_input");         // quale stato l'ha lasciata fuori
    expect(h.riga("1 non recuperabili").length).toBe(1);

    // Il reconcile ripassa ogni 10 secondi: la seconda volta tace.
    await h.dispatcher.reconcile();
    await flush();
    expect(h.note("t1").filter((c) => c.includes("nessun turno ripartira' da solo")).length).toBe(1);
  });

  it("una card mossa a mano in In Progress non riceve niente: non e' un'orfana", async () => {
    const h = harness();
    // Nessun `interrupted_at`: nessuno spegnimento l'ha tagliata, ce l'ha
    // trascinata una persona. Il silenzio, qui, e' la risposta giusta.
    seedOrfana(h.db, "t1", { chip: "needs_input", interruptedAt: null });

    await h.dispatcher.reconcile();
    await flush();

    expect(h.note("t1").filter((c) => c.includes("nessun turno ripartira' da solo")).length).toBe(0);
    expect(h.riga("non recuperabili").length).toBe(0);
    expect(h.svc.get("t1")!.task.status).toBe("in_progress");
  });
});

/**
 * IL TETTO PIENO SI DICE, NON SI DEDUCE.
 *
 * Una card trattenuta dal tetto di concorrenza restava `todo` con il chip
 * `queued` e NIENTE nel thread: il `break` su `claimCap < 1` e il `null` muto di
 * `claim` erano due silenzi diversi con lo stesso effetto sulla board. Chi
 * guardava vedeva righe idonee e ferme, e l'unico modo di sapere da cosa era
 * rifare a mente il sort del dispatcher.
 *
 * Qui si misura la riga: c'è, porta i tre numeri (tetto, agenti in volo, card
 * ferme), e arriva UNA volta per episodio — la stessa disciplina del freno del
 * pesante, perché un reconcile ogni 10s riempirebbe il thread della stessa
 * frase.
 * @covers KANBAN-07
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
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER
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

const PID = "alpha-abc123";

let seq = 0;
function seedTask(db: Database, id: string, priority = 2): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, ?)`,
    [id, PID, "task " + id, ts, ts, priority],
  );
  return id;
}

/** Un agente GIA' in volo: è lui che riempie il tetto e tiene fuori gli altri. */
function seedInFlight(db: Database, id: string): void {
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, dispatch_state, assigned_topic_id)
     VALUES (?, ?, 'gia in volo', 'in_progress', '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z', 0, 4, 'working', ?)`,
    [id, PID, `topic-${id}`],
  );
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const attempts = createTaskAttemptStore(db);
  const turns: { sessionKey: string; content: string }[] = [];
  const pending = new Map<string, (info?: TurnEndInfo) => void>();

  const deps: DispatcherDeps = {
    svc,
    attempts,
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
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
    getLastAgentText: () => "riassunto",
    runTurn: (sessionKey, content) =>
      new Promise<TurnEndInfo | void>((res) => { turns.push({ sessionKey, content }); pending.set(sessionKey, res); }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, turns,
    task: (id: string) => svc.get(id)?.task,
    comments: (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content),
    /** Quante volte la riga del tetto è stata scritta su questa card. */
    /** La frase e' quella che il dispatcher scrive davvero: questo ramo ne
     *  proponeva una sua («Tetto N agenti»), ma la riga era gia' su main con un
     *  testo piu' chiaro, che dice anche che non c'e' niente da fare. I casi qui
     *  sotto restano validi e diventano copertura in piu'. */
    righeTetto: (id: string) =>
      (svc.get(id)?.comments ?? []).filter((c) => c.content.includes("Parte da sé appena si libera un posto")).length,
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function board(h: ReturnType<typeof harness>, cap: number, fanOut = 1) {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: fanOut });
  h.svc.setGlobalCap({ auto: false, max: cap });
}

describe("tetto pieno: la riga sulla card", () => {
  it("il claim rifiutato dal tetto lascia una riga con tetto, agenti in volo e card ferme", async () => {
    const h = harness();
    board(h, 1);
    seedInFlight(h.db, "busy");
    seedTask(h.db, "q1");
    seedTask(h.db, "q2");

    await h.dispatcher.tick(PID);
    await flush();

    // Niente parte: il posto è uno ed è occupato. Prima del fix finiva qui, con
    // due card `queued` e zero righe.
    expect(h.task("q1")!.status).toBe("todo");
    const nota = h.comments("q1").join("\n");
    // I due numeri che rendono la riga una spiegazione invece di un'attesa muta.
    expect(nota).toContain("1 agent al lavoro su un tetto di 1");
    expect(nota).toContain("2 card sono ferme");  // il terzo numero: quanto è lunga la fila
    // E la riceve anche chi sta dietro: la fila non è muta solo in testa.
    expect(h.righeTetto("q2")).toBe(1);
    expect(h.task("q2")!.dispatchState).toBe("queued");
  });

  it("una riga per EPISODIO, non una per poll", async () => {
    const h = harness();
    board(h, 1);
    seedInFlight(h.db, "busy");
    seedTask(h.db, "q1");

    for (let i = 0; i < 4; i++) { await h.dispatcher.tick(PID); await flush(); }

    // Il reconcile ripassa ogni 10s: quattro giri devono lasciare UNA riga,
    // altrimenti la nota che spiega diventa la nota che seppellisce.
    expect(h.righeTetto("q1")).toBe(1);
  });

  it("chi PARTE non riceve la riga (e chi resta fuori sì)", async () => {
    const h = harness();
    board(h, 1);
    seedTask(h.db, "q1", 4); // priorità alta: è lui a prendere l'unico posto
    seedTask(h.db, "q2", 2);

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("q1")!.status).toBe("in_progress");
    expect(h.righeTetto("q1")).toBe(0);
    expect(h.righeTetto("q2")).toBe(1);
  });

  it("il break su un fan-out che non ci sta lo dice, e dice quanti posti gli servono", async () => {
    // L'altro silenzio: qui il `break` scatta PRIMA di provare il claim, perché
    // i posti prenotati dal fan-out precedente non lasciano margine per gli N
    // agenti che questo task vuole insieme.
    const h = harness();
    board(h, 2, 2);
    seedTask(h.db, "q1", 4);
    seedTask(h.db, "q2", 2);

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("q2")!.status).toBe("todo");
    const nota = h.comments("q2").join("\n");
    // La card non aspetta UN posto: ne vuole N insieme, e i posti liberi sono
    // meno. I due numeri esatti dipendono da quanti slot ha gia' prenotato chi
    // e' partito prima, quindi si prova il MECCANISMO, non l'aritmetica di una
    // particolare implementazione: la riga deve dire tutte e due le meta'.
    expect(nota).toMatch(/ne vuole \d+ insieme/);
    expect(nota).toMatch(/(c'è 1 posto libero|ci sono \d+ posti liberi)/);
  });

  it("una barra di check in volo riduce i posti disponibili come un agente", async () => {
    // IL DIFETTO CHE QUESTO TEST PRESIDIA.
    // Con tetto=1 e checksRunning()=1, non deve partire nessun nuovo dispatch:
    // la barra di check satura la stessa CPU che l'agente userebbe, e il freno
    // deve contarla. Prima del fix il tetto contava solo gli agenti, e sei card
    // che consegnavano insieme lanciavano sei barre in parallelo (loadavg 78/12).
    const h = harness({ checksRunning: () => 1 });
    board(h, 1);
    seedTask(h.db, "q1");

    await h.dispatcher.tick(PID);
    await flush();

    // Niente parte: il posto è occupato dalla barra di check in volo.
    expect(h.task("q1")!.status).toBe("todo");
    // La card riceve la riga del tetto (non un silenzio muto).
    expect(h.righeTetto("q1")).toBe(1);
  });

  it("con tetto=2 e una barra in volo, un agente puo' ancora partire", async () => {
    // Un gate che occupa 1 slot su 2 non deve bloccare tutto.
    const h = harness({ checksRunning: () => 1 });
    board(h, 2);
    seedTask(h.db, "q1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.task("q1")!.status).toBe("in_progress");
  });
});

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";

/**
 * La fusione di due card, e la promessa che la regge: non si perde niente.
 *
 * Il rischio di questa funzione non e' sbagliare il verdetto (quello lo decide
 * chi preme il tasto): e' far sparire lavoro. Un sottotask che finisce sotto una
 * card archiviata e' irraggiungibile, un thread che resta attaccato alla card
 * sbagliata e' un thread perso. Ogni test qui sotto controlla una di queste due
 * cose, e nessuno controlla l'estetica del risultato.
 */

const DDL = {
  tasks: `CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, fingerprint TEXT, due_date TEXT,
    chat_id TEXT, created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, assigned_topic_id TEXT REFERENCES topics(id), archived INTEGER NOT NULL DEFAULT 0,
    assigned_agent_id TEXT, in_progress_at TEXT,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, dispatch_state TEXT, dispatch_error TEXT,
    dispatch_deferred_until TEXT,
    parent_task_id TEXT REFERENCES tasks(id), output_url TEXT, plan_first INTEGER NOT NULL DEFAULT 0,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT, blocked_by_task_id TEXT REFERENCES tasks(id), reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1, preview_image TEXT,
    checks_state TEXT, checks_at TEXT, checks_commit TEXT, checks_json TEXT,
    delivered_by TEXT, delivered_reason TEXT
  )`,
  comments: `CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`,
  settings: `CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT, dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    dispatch_fanout INTEGER
  )`,
};

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(DDL.tasks);
  db.run(DDL.comments);
  db.run(DDL.settings);
  return db;
}

const PID = "topics-app-abc123";
let db: Database;
let svc: TaskService;
let clock: { t: number };

beforeEach(() => {
  db = freshDb();
  clock = { t: Date.parse("2026-08-12T10:00:00.000Z") };
  let n = 0;
  svc = createTaskService(db, {
    now: () => new Date((clock.t += 1000)).toISOString(),
    uuid: () => `id-${++n}`,
  });
});

/** Due card vere della board, riscritte due volte con parole diverse. */
function twoCards() {
  const survivor = svc.create({ projectId: PID, text: "store: UserMemoryStore.update() + test" });
  const dupe = svc.create({ projectId: PID, text: "store: UserMemoryStore.update() + unit test" });
  return { survivor, dupe };
}

describe("fusione: niente si perde", () => {
  test("il thread della card assorbita finisce sulla superstite", () => {
    const { survivor, dupe } = twoCards();
    svc.addComment({ taskId: dupe.id, author: "user", content: "questa la faccio io" });
    svc.addComment({ taskId: dupe.id, author: "agent", content: "fatto, ramo consegnato" });

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const after = svc.get(survivor.id)!;
    const testi = after.comments.map((c) => c.content);
    expect(testi).toContain("questa la faccio io");
    expect(testi).toContain("fatto, ramo consegnato");
  });

  test("l'autore di ogni commento resta quello di prima", () => {
    const { survivor, dupe } = twoCards();
    svc.addComment({ taskId: dupe.id, author: "agent", content: "fatto, ramo consegnato" });
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const spostato = svc.get(survivor.id)!.comments.find((c) => c.content === "fatto, ramo consegnato");
    expect(spostato!.author).toBe("agent");
  });

  test("i sottotask passano sotto la superstite, VIVI", () => {
    const { survivor, dupe } = twoCards();
    const figlio = svc.create({ projectId: PID, text: "test unit dello store", parentTaskId: dupe.id });

    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const after = svc.get(survivor.id)!;
    expect(after.children.map((c) => c.id)).toContain(figlio.id);
    // Il difetto da evitare: archive() cascata sul sottoalbero. Se il figlio
    // non fosse stato staccato PRIMA, sarebbe archiviato e irraggiungibile.
    const row = db.prepare("SELECT archived, parent_task_id FROM tasks WHERE id = ?").get(figlio.id) as any;
    expect(row.archived).toBe(0);
    expect(row.parent_task_id).toBe(survivor.id);
  });

  test("la card assorbita e' archiviata, non cancellata", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const row = db.prepare("SELECT archived FROM tasks WHERE id = ?").get(dupe.id) as any;
    expect(row).toBeTruthy(); // la riga c'e' ancora
    expect(row.archived).toBe(1);
  });

  test("le due card dicono dove e' finito il lavoro", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });

    const suSuperstite = svc.get(survivor.id)!.comments.map((c) => c.content).join("\n");
    expect(suSuperstite).toContain(dupe.id.slice(0, 8));
    const suAssorbita = db
      .prepare("SELECT content FROM task_comments WHERE task_id = ?")
      .all(dupe.id)
      .map((r: any) => r.content)
      .join("\n");
    expect(suAssorbita).toContain(survivor.id.slice(0, 8));
  });

  test("il conto tornato dice quanto ha spostato", () => {
    const { survivor, dupe } = twoCards();
    svc.addComment({ taskId: dupe.id, author: "user", content: "uno" });
    svc.addComment({ taskId: dupe.id, author: "user", content: "due" });
    svc.create({ projectId: PID, text: "sottotask", parentTaskId: dupe.id });

    const esito = svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    expect(esito.movedComments).toBe(2);
    expect(esito.movedChildren).toBe(1);
    expect(esito.survivor.id).toBe(survivor.id);
    expect(esito.merged.id).toBe(dupe.id);
    // `Task` non espone `archived` (l'API non restituisce mai card archiviate):
    // che la card sia uscita dalla board lo dice la riga, ed e' il test sopra.
    expect(esito.survivor.subtaskCount).toBe(1);
  });
});

describe("fusione: quando si rifiuta", () => {
  test("una card non si fonde con se stessa", () => {
    const { survivor } = twoCards();
    expect(() => svc.merge({ taskId: survivor.id, intoTaskId: survivor.id, by: "attilio" })).toThrow(TaskServiceError);
  });

  test("non si fondono card di board diverse", () => {
    const { dupe } = twoCards();
    const altrove = svc.create({ projectId: "altro-progetto", text: "store: UserMemoryStore.update() + unit test" });
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: altrove.id, by: "attilio" })).toThrow(/board/);
  });

  test("una card con un agente vivo non si fonde: il worktree resterebbe orfano", () => {
    const { survivor, dupe } = twoCards();
    db.prepare("UPDATE tasks SET dispatch_state = 'working' WHERE id = ?").run(dupe.id);
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" })).toThrow(/agente/);
  });

  test("una card gia' archiviata non si fonde una seconda volta", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" })).toThrow(TaskServiceError);
  });

  test("la superstite non puo' essere un sottotask della card che sparisce", () => {
    const { dupe } = twoCards();
    const figlio = svc.create({ projectId: PID, text: "il figlio", parentTaskId: dupe.id });
    // Fondere il padre DENTRO il figlio lascerebbe il figlio genitore di se stesso.
    expect(() => svc.merge({ taskId: dupe.id, intoTaskId: figlio.id, by: "attilio" })).toThrow(/sottotask/);
  });
});

describe("doppioni al momento della creazione", () => {
  test("la board dice quali card gia' dicono questa cosa", () => {
    const { survivor } = twoCards();
    const vicini = svc.findDuplicates({ projectId: PID, text: "store: UserMemoryStore.update() + unit test" });
    expect(vicini.some((v) => v.task.id === survivor.id && v.duplicate)).toBe(true);
  });

  test("un titolo nuovo non produce vicini", () => {
    twoCards();
    expect(svc.findDuplicates({ projectId: PID, text: "Sonda della CPU vera sotto carico" })).toEqual([]);
  });

  test("una card archiviata non conta come doppione: e' gia' fuori dalla board", () => {
    const { survivor, dupe } = twoCards();
    svc.merge({ taskId: dupe.id, intoTaskId: survivor.id, by: "attilio" });
    const vicini = svc.findDuplicates({ projectId: PID, text: "store: UserMemoryStore.update() + unit test" });
    expect(vicini.map((v) => v.task.id)).not.toContain(dupe.id);
  });

  test("il doppione si cerca sulla PROPRIA board, non su tutte", () => {
    twoCards();
    const vicini = svc.findDuplicates({ projectId: "altro-progetto", text: "store: UserMemoryStore.update() + unit test" });
    expect(vicini).toEqual([]);
  });
});

// La BARRA numero 1: una card che lancia due sessioni figlie non fa mai salire
// il numero di agenti vivi sopra il tetto della board.
//
// Il test conta ADESSO, come conta la porta vera: `liveAgentCount` è la stessa
// funzione che legge il claim e la stessa che legge la rotta di spawn. Se ne
// esistessero due (una per la board, una per lo spawn) questo test resterebbe
// verde mentre il tetto si sfonda, perché ne verificherebbe una sola.
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  boardChildCount,
  boardSpawnRefusal,
  boardTaskForSession,
  dispatchedTaskCount,
  liveAgentCount,
  orphanBoardChildSessions,
  topicSessionKey,
} from "./agent-census";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { createTaskService } from "./tasks";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  // `terminal_sessions` arriva da TASKS_FK_STUBS_DDL: il claim la legge.
  return db;
}

/** `freshDb` piu' il contorno che `createTaskService` esige per vivere. */
function fullDb(): Database {
  const db = freshDb(); // `topics` e `agent_profiles` arrivano gia' dagli stub FK
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5,
    -- See tasks.queue-reason.test.ts: readGlobalCap SELECTs max_agents_auto
    -- (migration 053), so a DDL without it throws instead of reading the cap.
    max_agents_auto INTEGER, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT, dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    dispatch_fanout INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

let n = 0;
/** Un task con un agente vivo, legato al suo topic. */
function dispatchedTask(db: Database, opts?: { projectId?: string; state?: string; status?: string }): { id: string; topicId: string; sessionKey: string } {
  const id = `task-${++n}`;
  const topicId = `topic-${n}`;
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, dispatch_state, assigned_topic_id, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, opts?.projectId ?? "proj-a", `t${n}`, opts?.status ?? "in_progress", opts?.state ?? "working", topicId, "2026-08-12", "2026-08-12"],
  );
  return { id, topicId, sessionKey: topicSessionKey(topicId) };
}

function child(db: Database, parentSessionKey: string, opts?: { status?: string; claudeId?: string }): string {
  const id = `child-${++n}`;
  db.run(
    `INSERT INTO terminal_sessions (id, name, cwd, type, created_at, claude_session_id, status, parent_session_key)
     VALUES (?, ?, ?, 'claude-code', ?, ?, ?, ?)`,
    [id, id, "/w", "2026-08-12", opts?.claudeId ?? null, opts?.status ?? "active", parentSessionKey],
  );
  return id;
}

describe("il tetto conta le figlie", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("una card con due figlie vale TRE agenti, non uno", () => {
    const t = dispatchedTask(db);
    child(db, t.sessionKey);
    child(db, t.sessionKey);
    expect(dispatchedTaskCount(db)).toBe(1);
    expect(boardChildCount(db)).toBe(2);
    expect(liveAgentCount(db)).toBe(3);
  });

  test("col tetto pieno la terza figlia viene rifiutata, e il conto non sale", () => {
    const t = dispatchedTask(db);
    const cap = 3;
    // Due spawn accettati, uno per volta, contando come conta la porta vera.
    for (let i = 0; i < 2; i++) {
      expect(boardSpawnRefusal(db, { parentSessionKey: t.sessionKey, cap })).toEqual({ ok: true });
      child(db, t.sessionKey);
    }
    expect(liveAgentCount(db)).toBe(cap);
    const refusal = boardSpawnRefusal(db, { parentSessionKey: t.sessionKey, cap });
    expect(refusal).toEqual({ ok: false, code: "cap", live: 3, cap: 3 });
    // E il numero di agenti vivi non ha MAI superato il tetto.
    expect(liveAgentCount(db)).toBeLessThanOrEqual(cap);
  });

  test("il tetto e' della MACCHINA: le figlie di una card mangiano il posto di un'altra board", () => {
    const a = dispatchedTask(db, { projectId: "proj-a" });
    const b = dispatchedTask(db, { projectId: "proj-b" });
    child(db, a.sessionKey);
    expect(liveAgentCount(db)).toBe(3);
    // Con tetto 3 la board B non puo' aprire figlie: il posto se l'e' preso A.
    expect(boardTaskForSession(db, b.sessionKey)?.projectId).toBe("proj-b");
    expect(boardSpawnRefusal(db, { parentSessionKey: b.sessionKey, cap: 3 }).ok).toBe(false);
  });

  test("una figlia non apre nipoti: profondita' 1", () => {
    const t = dispatchedTask(db);
    const c = child(db, t.sessionKey);
    expect(boardSpawnRefusal(db, { parentSessionKey: c, cap: 99 })).toEqual({ ok: false, code: "depth" });
  });

  test("una chat dell'umano non e' affare di questo modulo: passa e non conta", () => {
    dispatchedTask(db);
    // Un topic che non ha nessun task addosso.
    expect(boardTaskForSession(db, topicSessionKey("topic-libero"))).toBeNull();
    expect(boardSpawnRefusal(db, { parentSessionKey: topicSessionKey("topic-libero"), cap: 1 })).toEqual({ ok: true });
    child(db, topicSessionKey("topic-libero"));
    expect(liveAgentCount(db)).toBe(1); // solo il task, la figlia della chat non entra
  });

  test("una figlia dormiente non tiene un posto", () => {
    const t = dispatchedTask(db);
    child(db, t.sessionKey, { status: "dormant" });
    expect(liveAgentCount(db)).toBe(1);
  });
});

// Lo stesso fatto, ma sulla porta che conta davvero: il CLAIM. Il test sopra
// prova la funzione; questo prova che la board la usa. Senza, il censimento
// potrebbe essere giusto e il tetto restare quello di prima.
describe("il claim non ammette un task quando le figlie hanno riempito il tetto", () => {
  let db: Database;
  beforeEach(() => { db = fullDb(); });

  test("tre agenti vivi (un task + due figlie) e un tetto di 3: il quarto non entra", () => {
    const s = createTaskService(db);
    const lavora = s.create({ projectId: "proj-a", text: "coordinatore", status: "todo" });
    db.run("UPDATE tasks SET status='in_progress', dispatch_state='working', assigned_topic_id=? WHERE id=?", ["topic-c", lavora.id]);
    db.run("INSERT INTO topics (id) VALUES ('topic-c')");
    const inCoda = s.create({ projectId: "proj-a", text: "in coda", status: "todo" });

    // Con una card sola al lavoro c'e' posto: il claim passa.
    expect(s.claim({ taskId: inCoda.id, cap: 3, maxAttempts: 3, scope: "global" })).not.toBeNull();
    // Si rimette in coda e si aprono due figlie sulla prima card.
    db.run("UPDATE tasks SET status='todo', dispatch_state=NULL, assigned_topic_id=NULL, dispatch_attempts=0 WHERE id=?", [inCoda.id]);
    child(db, topicSessionKey("topic-c"));
    child(db, topicSessionKey("topic-c"));
    expect(liveAgentCount(db)).toBe(3);

    // Adesso la macchina e' piena, e il claim lo vede.
    expect(s.claim({ taskId: inCoda.id, cap: 3, maxAttempts: 3, scope: "global" })).toBeNull();
    expect(liveAgentCount(db)).toBe(3);
  });
});

describe("le figlie muoiono col padre", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("finche' il task lavora, nessuna figlia e' orfana", () => {
    const t = dispatchedTask(db);
    child(db, t.sessionKey);
    expect(orphanBoardChildSessions(db)).toEqual([]);
  });

  test("il task consegnato in review lascia le sue figlie da raccogliere", () => {
    const t = dispatchedTask(db);
    const c = child(db, t.sessionKey);
    db.run("UPDATE tasks SET status = 'review', dispatch_state = NULL WHERE id = ?", [t.id]);
    expect(orphanBoardChildSessions(db)).toEqual([c]);
  });

  test("vale su OGNI strada di uscita, archiviazione compresa", () => {
    const t = dispatchedTask(db);
    const c = child(db, t.sessionKey);
    db.run("UPDATE tasks SET archived = 1 WHERE id = ?", [t.id]);
    expect(orphanBoardChildSessions(db)).toEqual([c]);
  });

  test("un coordinatore FERMO su una domanda tiene le sue figlie", () => {
    // Il caso che rende comoda tutta la campagna: il coordinatore chiede, il
    // chip si spegne, la sessione e' viva e riprendera'. Raccogliere qui
    // vorrebbe dire ammazzare il lavoro a ogni domanda.
    const t = dispatchedTask(db, { state: "needs_input" });
    child(db, t.sessionKey);
    expect(orphanBoardChildSessions(db)).toEqual([]);
    // E finche' il padre e' vivo la figlia tiene il suo posto sotto il tetto.
    expect(boardChildCount(db)).toBe(1);
  });

  test("le figlie di una chat dell'umano non vengono mai raccolte", () => {
    child(db, topicSessionKey("topic-libero"));
    expect(orphanBoardChildSessions(db)).toEqual([]);
  });
});

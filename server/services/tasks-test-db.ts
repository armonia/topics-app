/**
 * IL BANCO DI PROVA DEL SERVIZIO DEI TASK, in un posto solo.
 *
 * Lo schema qui dentro non e' una comodita': e' fedele alla produzione APPOSTA.
 * `PRAGMA foreign_keys = ON` e le tabelle-genitore esistono perche' il guasto
 * del segnaposto `pending:<taskId>` si riproduceva SOLO con le FK accese — con
 * uno schema piu' comodo il test sarebbe stato verde su un bug vivo.
 *
 * Estratto il 18/08 quando `tasks.test.ts` ha sfondato il cancello di
 * dimensione a 3.378 righe. La risposta non e' stata alzare la soglia: il file
 * teneva insieme due mestieri diversi — le regole del servizio e la catena di
 * consegna/review/atterraggio — e ne e' uscito `tasks-review.test.ts`. Due file
 * a fuoco, un banco solo: se lo schema diverge fra i due, i test smettono di
 * parlare della stessa produzione.
 */
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

// La DDL di `tasks` non si ricopia più qui: è TASKS_DDL, cioè la catena delle
// migration, verificata colonna per colonna da test-schema.test.ts. PRAGMA
// foreign_keys e la FK su assigned_topic_id sono fedeli alla produzione
// apposta: il guasto del segnaposto "pending:<taskId>" si riproduceva solo con
// le FK accese, e con le FK accese le tabelle-genitore devono esistere.
export function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    dispatch_fanout INTEGER,
    -- migration 053: mancava qui, e senza di lei ogni lettura del tetto VERO
    -- (riga '*', readGlobalCap) esplode invece di misurare.
    max_agents_auto INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  // migration 100 — le etichette. `rowToTask` la legge per OGNI riga, quindi
  // senza questa tabella non fallisce il test delle etichette: falliscono tutti.
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

// Controllable clock + counter uuid → deterministic rows.
export function svc(db: Database, clock = { t: Date.parse("2026-07-09T10:00:00.000Z") }): TaskService {
  let n = 0;
  return createTaskService(db, {
    now: () => new Date(clock.t).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

export const PID = "topics-app-abc123";

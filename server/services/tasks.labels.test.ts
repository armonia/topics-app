/**
 * Il cancello che rende le etichette qualcosa di più di una decorazione.
 *
 * `invisibile` decide che la card la può chiudere il conduttore senza che un
 * umano la guardi. Se un agente potesse scriversela da sé, l'etichetta non
 * sarebbe una misura di ciò che si vede: sarebbe il modulo con cui si autorizza
 * a chiudersi le proprie card. Da qui l'asimmetria: alzare la mano sempre,
 * abbassarla mai — e nemmeno di sponda, togliendo un `visibile` già scritto.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, due_date TEXT, chat_id TEXT,
    created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, archived INTEGER NOT NULL DEFAULT 0, in_progress_at TEXT,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, parent_task_id TEXT REFERENCES tasks(id),
    plan_first INTEGER NOT NULL DEFAULT 0, agent_ms INTEGER NOT NULL DEFAULT 0,
    agent_tokens INTEGER NOT NULL DEFAULT 0, agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1, reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    blocked_by_task_id TEXT REFERENCES tasks(id), checks_state TEXT,
    model TEXT, created_by_topic_id TEXT
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE task_labels (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('derived', 'human', 'agent')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, label)
  )`);
  return db;
}

const PID = "topics-app-abc123";

function svc(db: Database): TaskService {
  let n = 0;
  return createTaskService(db, { now: () => "2026-08-11T18:00:00.000Z", uuid: () => `id-${++n}` });
}

describe("l'agente non si marca invisibile da solo", () => {
  let db: Database; let s: TaskService; let taskId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    taskId = s.create({ projectId: PID, text: "Riscrittura del dispatcher" }).id;
  });

  test("RIFIUTATO: un agente che si scrive `invisibile` prende label_forbidden", () => {
    let err: unknown;
    try {
      s.setLabels({ taskId, labels: ["invisibile", "chore"], actor: "agent", source: "agent" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TaskServiceError);
    expect((err as TaskServiceError).code).toBe("label_forbidden");
    // E non è passato NIENTE: nemmeno il `chore` che viaggiava insieme.
    expect(s.get(taskId)!.task.labels).toEqual([]);
  });

  test("l'agente può alzare la mano: `visibile` passa, con la sua provenienza", () => {
    const t = s.setLabels({ taskId, labels: ["visibile", "bugfix"], actor: "agent", source: "agent" });
    expect(t.labels).toEqual([
      { label: "bugfix", source: "agent" },
      { label: "visibile", source: "agent" },
    ]);
  });

  test("anche `decisione` passa: è l'altro modo di passare la card a una persona", () => {
    const t = s.setLabels({ taskId, labels: ["decisione"], actor: "agent", source: "agent" });
    expect(t.labels).toEqual([{ label: "decisione", source: "agent" }]);
  });

  test("nemmeno di sponda: l'agente non può TOGLIERE un `visibile` già scritto", () => {
    s.setLabels({ taskId, labels: ["visibile"], actor: "human", source: "human" });
    expect(() => s.setLabels({ taskId, labels: ["chore"], actor: "agent", source: "agent" }))
      .toThrow(/non può togliere/);
    expect(s.get(taskId)!.task.labels.map((l) => l.label)).toEqual(["visibile"]);
  });

  test("l'umano invece scrive quello che vuole, `invisibile` compreso", () => {
    const t = s.setLabels({ taskId, labels: ["invisibile"], actor: "human", source: "human" });
    expect(t.labels).toEqual([{ label: "invisibile", source: "human" }]);
  });
});

describe("deriveLabelsFromDiff", () => {
  let db: Database; let s: TaskService; let taskId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    taskId = s.create({ projectId: PID, text: "x" }).id;
  });

  test("dal diff a chi chiude, timbrato `derived`", () => {
    const t = s.deriveLabelsFromDiff({ taskId, files: ["server/routes/tasks.ts", "docs/x.md"] });
    expect(t!.labels).toEqual([{ label: "invisibile", source: "derived" }]);
  });

  test("solo documenti ⇒ `decisione`, e la card resta di chi decide", () => {
    const t = s.deriveLabelsFromDiff({ taskId, files: ["docs/PIANO.md"] });
    expect(t!.labels).toEqual([{ label: "decisione", source: "derived" }]);
  });

  test("il ricalcolo porta via anche la classe VECCHIA, non solo la sua gemella", () => {
    // La DELETE guardava due etichette su tre: una `decisione` rimasta accanto a
    // una `visibile` nuova sarebbe una card con due risposte alla stessa domanda.
    s.deriveLabelsFromDiff({ taskId, files: ["docs/PIANO.md"] });
    s.deriveLabelsFromDiff({ taskId, files: ["client/src/App.tsx"] });
    expect(s.get(taskId)!.task.labels).toEqual([{ label: "visibile", source: "derived" }]);
  });

  test("una consegna successiva RICALCOLA ciò che aveva calcolato lei", () => {
    s.deriveLabelsFromDiff({ taskId, files: ["server/a.ts"] });
    s.deriveLabelsFromDiff({ taskId, files: ["client/src/App.tsx"] });
    expect(s.get(taskId)!.task.labels).toEqual([{ label: "visibile", source: "derived" }]);
  });

  test("la correzione a mano di un umano NON si sovrascrive alla consegna dopo", () => {
    // Una correzione che scade al turno successivo non è una correzione.
    s.setLabels({ taskId, labels: ["visibile"], actor: "human", source: "human" });
    expect(s.deriveLabelsFromDiff({ taskId, files: ["server/a.ts"] })).toBeNull();
    expect(s.get(taskId)!.task.labels).toEqual([{ label: "visibile", source: "human" }]);
  });

  test("la derivazione non tocca le etichette di genere", () => {
    s.setLabels({ taskId, labels: ["bugfix"], actor: "human", source: "human" });
    s.deriveLabelsFromDiff({ taskId, files: ["server/a.ts"] });
    expect(s.get(taskId)!.task.labels.map((l) => l.label)).toEqual(["bugfix", "invisibile"]);
  });
});

describe("filtro per etichetta sulla lista", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("«solo le visibili in review» è etichetta + colonna insieme", () => {
    const a = s.create({ projectId: PID, text: "vis in review", status: "review" });
    const b = s.create({ projectId: PID, text: "inv in review", status: "review" });
    const c = s.create({ projectId: PID, text: "vis in todo", status: "todo" });
    s.setLabels({ taskId: a.id, labels: ["visibile"], actor: "human", source: "human" });
    s.setLabels({ taskId: b.id, labels: ["invisibile"], actor: "human", source: "human" });
    s.setLabels({ taskId: c.id, labels: ["visibile"], actor: "human", source: "human" });
    const got = s.list({ scope: "project", projectId: PID, status: "review", labels: ["visibile"] });
    expect(got.map((t) => t.id)).toEqual([a.id]);
  });

  test("più etichette = AND, non OR", () => {
    const a = s.create({ projectId: PID, text: "bugfix visibile" });
    const b = s.create({ projectId: PID, text: "solo bugfix" });
    s.setLabels({ taskId: a.id, labels: ["bugfix", "visibile"], actor: "human", source: "human" });
    s.setLabels({ taskId: b.id, labels: ["bugfix"], actor: "human", source: "human" });
    expect(s.list({ scope: "project", projectId: PID, labels: ["bugfix", "visibile"] }).map((t) => t.id))
      .toEqual([a.id]);
    expect(s.list({ scope: "project", projectId: PID, labels: ["bugfix"] })).toHaveLength(2);
  });

  test("un'etichetta ignota non filtra niente invece di filtrare tutto", () => {
    s.create({ projectId: PID, text: "una" });
    expect(s.list({ scope: "project", projectId: PID, labels: ["bugfix-ui"] })).toHaveLength(1);
  });
});

/**
 * FROM A DEAD PANE BACK TO ITS CARD.
 *
 * A pane knows the topic it lives in and nothing else. To say why it went quiet
 * it has to find the card that was working there, and the card moves: a restart
 * can release it and a later claim binds it to a NEW topic, leaving the old one
 * pointed at by nobody. That is why the lookup reads the attempt history too.
 * @covers TERM-11
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
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

function seedCard(db: Database, id: string, topicId: string | null, interruptedAt?: string) {
  const ts = new Date().toISOString();
  if (topicId) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [topicId]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority,
       assigned_topic_id, interrupted_at, interrupted_by)
     VALUES (?, ?, ?, 'in_progress', ?, ?, 1, 3, ?, ?, ?)`,
    [id, PID, "card " + id, ts, ts, topicId, interruptedAt ?? null, interruptedAt ? "SIGTERM" : null],
  );
}

function seedAttempt(db: Database, taskId: string, idx: number, topicId: string, at: string) {
  db.run(
    `INSERT INTO task_attempts (id, task_id, idx, topic_id, state, created_at)
     VALUES (?, ?, ?, ?, 'failed', ?)`,
    [`att-${taskId}-${idx}`, taskId, idx, topicId, at],
  );
}

describe("taskIdOfTopic", () => {
  it("finds the card currently bound to the topic", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedCard(db, "t1", "topic-live");
    expect(svc.taskIdOfTopic("topic-live")).toBe("t1");
  });

  it("still finds it after the card moved to a new topic, through the attempt history", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedCard(db, "t1", "topic-second");
    seedAttempt(db, "t1", 1, "topic-first", "2026-09-14T23:03:00.000Z");
    expect(svc.taskIdOfTopic("topic-first")).toBe("t1");
    expect(svc.taskIdOfTopic("topic-second")).toBe("t1");
  });

  it("takes the most recent attempt when a topic was reused", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedCard(db, "t1", null);
    seedCard(db, "t2", null);
    seedAttempt(db, "t1", 1, "topic-shared", "2026-09-14T10:00:00.000Z");
    seedAttempt(db, "t2", 1, "topic-shared", "2026-09-14T23:03:00.000Z");
    expect(svc.taskIdOfTopic("topic-shared")).toBe("t2");
  });

  it("answers null for a topic no card ever worked, and for the empty string", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedCard(db, "t1", "topic-live");
    expect(svc.taskIdOfTopic("topic-orphan")).toBeNull();
    expect(svc.taskIdOfTopic("")).toBeNull();
  });

  it("carries interruptedAt on the fetched card, and omits it when there was no shutdown", () => {
    const db = freshDb();
    const svc = createTaskService(db);
    seedCard(db, "t1", "topic-cut", "2026-09-14T23:03:00.000Z");
    seedCard(db, "t2", "topic-clean");
    expect(svc.get("t1")?.task.interruptedAt).toBe("2026-09-14T23:03:00.000Z");
    expect(svc.get("t2")?.task.interruptedAt).toBeUndefined();
  });
});

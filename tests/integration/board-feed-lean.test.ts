/**
 * `GET /api/all-boards/tasks` carries every field of `svc.list` with the same
 * value, minus the fields no client reads (`shared/board-feed.ts`): even when
 * those fields have a value.
 * @covers FEEDCOST-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "../../server/routes/tasks";
import { createTaskService } from "../../server/services/tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../../server/db/test-schema";
import { FEED_OMITTED_TASK_FIELDS } from "../../shared/board-feed";
import type { RouteHandler } from "../../server/types";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASKS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment', message_id TEXT
  )`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, auto_dispatch INTEGER NOT NULL DEFAULT 0,
    dispatch_retry_cap INTEGER, review_checks TEXT,
    max_agents INTEGER DEFAULT 5, max_agents_auto INTEGER
  )`);
  return db;
}

/** Every omitted field WITH a value, so a field that leaks is a field that shows. */
function seed(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, created_at, updated_at,
       due_date, chat_id, wait_streak, wait_reason, wait_since, dispatch_attempts, dispatch_deferred_until,
       dispatch_weight, done_actor, checks_commit, preview_rejected, url_probe_checked_at, landing_checked_at,
       model_effort, claude_task_id, deploy_command_at_propose, delegated_start_capability_id,
       run_initiator_person_id, run_initiator_device_id, completed_at)
     VALUES (?, 'board-1', ?, ?, ?, 1, ?, '2026-10-01T10:00:00.000Z', ?,
       '2026-12-01', 'chat-1', 2, 'busy', '2026-10-01T09:00:00.000Z', 1, '2026-10-09T00:00:00.000Z',
       'heavy', 'human', 'abc123', '["/tmp/x.png"]', '2026-10-01T08:00:00.000Z', '2026-10-01T08:30:00.000Z',
       'high', 'ct-1', 'bun run deploy', 'cap-1', 'person-1', 'device-1', ?)`,
  );
  const statuses = ["backlog", "todo", "in_progress", "review", "done"];
  for (let i = 0; i < 25; i++) {
    const status = statuses[i % statuses.length]!;
    insert.run(`t-${i}`, `task ${i}`, `descrizione ${i}`, status, i, `2026-10-0${(i % 9) + 1}T10:00:00.000Z`,
      status === "done" ? "2026-10-05T10:00:00.000Z" : null);
  }
}

function router(db: Database): RouteHandler {
  return createTasksRouter({
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async () => null,
    matchRoute: () => null,
    broadcast: () => {},
    broadcastToAll: () => {},
    getTopicBySessionKey: () => null,
    requestIdentity: () => null,
  } as never);
}

async function feed(db: Database): Promise<Array<Record<string, unknown>>> {
  const url = new URL("http://127.0.0.1:3333/api/all-boards/tasks");
  const resp = await router(db)(new Request(url), url, url.pathname, "GET");
  expect(resp?.status).toBe(200);
  return (JSON.parse(await resp!.text()) as { tasks: Array<Record<string, unknown>> }).tasks;
}

describe("the board feed without the fields nobody reads", () => {
  test("drops each omitted field and keeps every other field of svc.list unchanged", async () => {
    const db = freshDb();
    seed(db);
    const wire = await feed(db);
    const listed = JSON.parse(JSON.stringify(createTaskService(db).list({
      scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120,
    }))) as Array<Record<string, unknown>>;
    expect(wire.length).toBe(25);
    expect(wire.map((t) => t.id)).toEqual(listed.map((t) => t.id));
    // The service still carries them, with a value: the feed is what drops them.
    for (const field of ["dispatchAttempts", "waitStreak", "checksCommit", "doneActor", "previewRejected"]) {
      expect(listed[0]![field]).toBeDefined();
    }
    for (let i = 0; i < wire.length; i++) {
      const expected = { ...listed[i]! };
      for (const field of FEED_OMITTED_TASK_FIELDS) delete expected[field];
      expect(Object.keys(wire[i]!)).toEqual(Object.keys(expected));
      expect(wire[i]).toEqual(expected);
    }
  });
});

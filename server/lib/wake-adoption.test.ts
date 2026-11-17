/**
 * Who adopts a turn the CLI opened by itself (a Monitor delivering, a
 * background shell finishing). The measured defect: task agent topics are born
 * archived, the server refused every archived topic, so a Monitor armed inside
 * a running task never woke its agent (8 wakes dropped since 16/09, every one on
 * a topic whose task was in progress).
 * @covers MONITOR-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { wakeVerdict, runningTaskOwnsTopic, stoppedSubagentChat, launchedSinceRetired, launchingChatCanWake, markSystemChat, type WakeLaunch } from "./wake-adoption";

const noStoppedChild = () => false;

function taskDb(rows: Array<{ id: string; status: string; topic: string | null }>): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, assigned_topic_id TEXT)");
  for (const r of rows) db.run("INSERT INTO tasks (id, status, assigned_topic_id) VALUES (?, ?, ?)", [r.id, r.status, r.topic]);
  return db;
}

describe("wake adoption: which topic takes a spontaneous turn", () => {
  test("an open topic adopts", () => {
    expect(wakeVerdict({ id: "t-open", archived: false }, () => false, noStoppedChild)).toBe("adopt");
  });

  test("an archived topic owned by an in-progress task adopts: the agent is still working", () => {
    const db = taskDb([{ id: "k1", status: "in_progress", topic: "t-agent" }]);
    const topic = { id: "t-agent", archived: true };
    expect(wakeVerdict(topic, (id) => runningTaskOwnsTopic(db, id), noStoppedChild)).toBe("adopt");
  });

  test("an archived topic with no task in progress is still refused", () => {
    const db = taskDb([
      { id: "k1", status: "done", topic: "t-old" },
      { id: "k2", status: "in_progress", topic: "t-other" },
    ]);
    const topic = { id: "t-old", archived: true };
    expect(wakeVerdict(topic, (id) => runningTaskOwnsTopic(db, id), noStoppedChild)).toBe("archived");
  });

  test("no topic at all is refused", () => {
    expect(wakeVerdict(null, () => true, noStoppedChild)).toBe("no-topic");
  });

  test("a failing ownership lookup refuses instead of guessing", () => {
    const db = new Database(":memory:"); // no `tasks` table: the query throws
    expect(runningTaskOwnsTopic(db, "t-agent")).toBe(false);
  });

  // Found by the adversarial check on bd0525bcb: in a fan-out only attempt 1
  // is in tasks.assigned_topic_id; attempts 2..N live in task_attempts, with
  // topics born archived like any agent's. A Monitor on attempt 2 was dropped.
  function fanOutDb(): Database {
    const db = taskDb([{ id: "k1", status: "in_progress", topic: "t-att1" }]);
    db.run("CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT, idx INTEGER, topic_id TEXT, state TEXT)");
    db.run("INSERT INTO task_attempts VALUES ('a1','k1',1,'t-att1','running'),('a2','k1',2,'t-att2','running'),('a3','k1',3,'t-att3','failed')");
    return db;
  }

  test("a running fan-out attempt of an in-progress task adopts, not only attempt 1", () => {
    const db = fanOutDb();
    expect(wakeVerdict({ id: "t-att2", archived: true }, (id) => runningTaskOwnsTopic(db, id), noStoppedChild)).toBe("adopt");
  });

  test("an attempt that already ended is refused like any archived topic", () => {
    const db = fanOutDb();
    expect(wakeVerdict({ id: "t-att3", archived: true }, (id) => runningTaskOwnsTopic(db, id), noStoppedChild)).toBe("archived");
  });

  test("a running attempt of a task no longer in progress is refused", () => {
    const db = fanOutDb();
    db.run("UPDATE tasks SET status = 'done' WHERE id = 'k1'");
    expect(wakeVerdict({ id: "t-att2", archived: true }, (id) => runningTaskOwnsTopic(db, id), noStoppedChild)).toBe("archived");
  });

  // Review 3 of PR 238: a native sub-agent stopped by its parent or a person
  // was woken by a result queued before the Stop, its chat being open.
  function subagentDb(state: string, runtime = "topics"): Database {
    const db = taskDb([]);
    db.run("CREATE TABLE subagents (id TEXT PRIMARY KEY, runtime TEXT, state TEXT)");
    db.run("INSERT INTO subagents VALUES ('t-child', ?, ?)", [runtime, state]);
    return db;
  }

  test("a stopped native child is never woken, open or archived", () => {
    const db = subagentDb("stopped");
    const stopped = (id: string) => stoppedSubagentChat(db, id);
    expect(wakeVerdict({ id: "t-child", archived: false }, () => true, stopped)).toBe("stopped");
    expect(wakeVerdict({ id: "t-child", archived: true }, () => true, stopped)).toBe("stopped");
  });

  test("a running or retired native child is woken as before", () => {
    for (const state of ["running", "retired"]) {
      const db = subagentDb(state);
      expect(wakeVerdict({ id: "t-child", archived: false }, () => false, (id) => stoppedSubagentChat(db, id))).toBe("adopt");
    }
  });
});

// 17/11: a channel chat (archived by a person on 11/11, still driven by its
// bridge) spawned a child; the child's result was written as a plain row and the
// parent never read it, because every archived topic got the verdict "archived".
describe("wake adoption: an archived chat that launched work after a person archived it is alive", () => {
  const PARENT = { id: "t-parent", archived: true };
  const SK = "topic:parent";
  const RETIRED = "2026-11-11T15:35:28.893Z";
  const AFTER = "2026-11-16T23:41:09.861Z";
  const BEFORE = "2026-11-05T10:00:00.000Z";

  interface Rows {
    retired?: { at: string; reason: string };
    children?: Array<{ id: string; at: string; parent?: string }>;
    cards?: Array<{ id: string; at: string; createdBy?: string | null; origin?: string | null }>;
  }
  function launchDb(o: Rows): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, assigned_topic_id TEXT, created_by_topic_id TEXT, origin_topic_id TEXT, created_at TEXT)");
    db.run("CREATE TABLE subagents (id TEXT PRIMARY KEY, parent_session_key TEXT, created_at TEXT, runtime TEXT DEFAULT 'topics')");
    db.run("CREATE TABLE task_attempts (task_id TEXT, topic_id TEXT, state TEXT)");
    db.run("CREATE TABLE system_chats (topic_id TEXT PRIMARY KEY, kind TEXT, created_at TEXT)");
    db.run("CREATE TABLE retirements (kind TEXT, ref_id TEXT, retired_at TEXT, reason TEXT, PRIMARY KEY (kind, ref_id))");
    if (o.retired) db.run("INSERT INTO retirements VALUES ('topic', 't-parent', ?, ?)", [o.retired.at, o.retired.reason]);
    for (const c of o.children ?? []) db.run("INSERT INTO subagents (id, parent_session_key, created_at) VALUES (?, ?, ?)", [c.id, c.parent ?? SK, c.at]);
    for (const k of o.cards ?? []) db.run("INSERT INTO tasks (id, status, created_by_topic_id, origin_topic_id, created_at) VALUES (?, 'done', ?, ?, ?)", [k.id, k.createdBy === undefined ? "t-parent" : k.createdBy, k.origin ?? null, k.at]);
    return db;
  }
  const person = { at: RETIRED, reason: "archive" };
  const verdictOf = (db: Database, launch?: WakeLaunch) =>
    wakeVerdict(PARENT, (id) => runningTaskOwnsTopic(db, id), noStoppedChild, (id) => launchedSinceRetired(db, id, SK, launch));

  test("a child spawned after the person archived the chat wakes it", () => {
    const db = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] });
    expect(verdictOf(db, { subagentId: "c1" })).toBe("adopt");
  });

  test("a card the chat opened after the archive wakes it; a command started after it too", () => {
    const db = launchDb({ retired: person, cards: [{ id: "k1", at: AFTER }] });
    expect(verdictOf(db, { taskId: "k1" })).toBe("adopt");
    expect(verdictOf(db, { startedAt: AFTER })).toBe("adopt");
  });

  test("each wake is judged on ITS launch: child A before the archive stays a row, child B after it wakes", () => {
    const db = launchDb({ retired: person, children: [{ id: "A", at: BEFORE }, { id: "B", at: AFTER }] });
    expect(verdictOf(db, { subagentId: "A" })).toBe("archived");
    expect(verdictOf(db, { subagentId: "B" })).toBe("adopt");
  });

  test("a person archiving the chat after the launch is still obeyed", () => {
    const db = launchDb({ retired: { at: "2026-11-16T23:50:00.000Z", reason: "archive" }, children: [{ id: "c1", at: AFTER }] });
    expect(verdictOf(db, { subagentId: "c1" })).toBe("archived");
  });

  test("the same millisecond is not later: a tie keeps the old verdict", () => {
    const db = launchDb({ retired: person, children: [{ id: "c1", at: RETIRED }] });
    expect(verdictOf(db, { subagentId: "c1" })).toBe("archived");
  });

  test("the archive reasons a person writes count: archive, bulk-archive, tab-close", () => {
    for (const reason of ["archive", "bulk-archive", "tab-close"]) {
      const db = launchDb({ retired: { at: RETIRED, reason }, children: [{ id: "c1", at: AFTER }] });
      expect(verdictOf(db, { subagentId: "c1" })).toBe("adopt");
    }
  });

  // The measured defect of the first version: 1482 of 3249 retirement rows are
  // `reconcile:registry`, the chats of board agents that are BORN archived,
  // dated by the first restart. Counting them woke 102 chats that never were a
  // person's (66 with their card done).
  test("a chat born archived (reconcile:registry, attempt-reap, backfill) stays a row", () => {
    for (const reason of ["reconcile:registry", "attempt-reap", "backfill:archived"]) {
      const db = launchDb({ retired: { at: RETIRED, reason }, children: [{ id: "c1", at: AFTER }], cards: [{ id: "k1", at: AFTER }] });
      expect(verdictOf(db, { subagentId: "c1" })).toBe("archived");
      expect(verdictOf(db, { taskId: "k1" })).toBe("archived");
      expect(verdictOf(db, { startedAt: AFTER })).toBe("archived");
    }
  });

  test("a card is proof of launch only through created_by_topic_id: origin_topic_id is a caller's word", () => {
    const db = launchDb({ retired: person, cards: [{ id: "k1", at: AFTER, createdBy: null, origin: "t-parent" }, { id: "k2", at: AFTER, createdBy: "t-other" }] });
    expect(verdictOf(db, { taskId: "k1" })).toBe("archived");
    expect(verdictOf(db, { taskId: "k2" })).toBe("archived");
  });

  test("a child of another chat proves nothing", () => {
    const db = launchDb({ retired: person, children: [{ id: "c1", at: AFTER, parent: "topic:other" }] });
    expect(verdictOf(db, { subagentId: "c1" })).toBe("archived");
  });

  // The measured defect of the second version: until the dispatcher and the native
  // children got their own reasons they archived as "archive" too, 93 card agents
  // on the live database. `3003e355` (agent of a card in done, with a launched card
  // `805eb761`) and `731e8870` (card `4f4954e1`, with `d9cc483c`) went from row to wake.
  test("the chat of a card's agent (archived as 'archive') stays a row even if it launched work afterwards", () => {
    const done = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }], cards: [{ id: "k-launched", at: AFTER }] });
    done.run("INSERT INTO tasks (id, status, assigned_topic_id, created_at) VALUES ('agent-card', 'done', 't-parent', ?)", [BEFORE]);
    markSystemChat(done, "t-parent", "task");
    expect(verdictOf(done, { subagentId: "c1" })).toBe("archived");
    expect(verdictOf(done, { taskId: "k-launched" })).toBe("archived");
  });

  test("the topic of an attempt of a fan-out, and the chat of a native child, stay a row too", () => {
    const attempt = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] });
    attempt.run("INSERT INTO task_attempts VALUES ('k', 't-parent', 'done')");
    markSystemChat(attempt, "t-parent", "attempt");
    expect(verdictOf(attempt, { subagentId: "c1" })).toBe("archived");

    const native = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] });
    native.run("INSERT INTO subagents (id, parent_session_key, created_at, runtime) VALUES ('t-parent', 'topic:boss', ?, 'topics')", [BEFORE]);
    markSystemChat(native, "t-parent", "subagent");
    expect(verdictOf(native, { subagentId: "c1" })).toBe("archived");
  });

  test("a person's chat that merely appears in another table's other column is not a system chat", () => {
    const db = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] });
    db.run("INSERT INTO tasks (id, status, assigned_topic_id, created_by_topic_id, created_at) VALUES ('k', 'done', 't-agent', 't-parent', ?)", [BEFORE]);
    expect(verdictOf(db, { subagentId: "c1" })).toBe("adopt");
  });

  // 96b737de: the requeue cleared assigned_topic_id, the marker did not.
  test("an agent chat stays a system chat after its card is requeued (link cleared)", () => {
    const db = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] });
    db.run("INSERT INTO tasks (id, status, assigned_topic_id, created_at) VALUES ('k', 'todo', NULL, ?)", [BEFORE]);
    markSystemChat(db, "t-parent", "task");
    expect(verdictOf(db, { subagentId: "c1" })).toBe("archived");
  });

  test("no launch named, no archive row, or an unknown child: the old verdict", () => {
    expect(verdictOf(launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] }))).toBe("archived");
    expect(verdictOf(launchDb({ children: [{ id: "c1", at: AFTER }] }), { subagentId: "c1" })).toBe("archived");
    expect(verdictOf(launchDb({ retired: person }), { subagentId: "ghost" })).toBe("archived");
  });

  test("a stopped child still wins over a recent launch", () => {
    const db = launchDb({ retired: person, children: [{ id: "c1", at: AFTER }] });
    expect(wakeVerdict(PARENT, () => false, () => true, (id) => launchedSinceRetired(db, id, SK, { subagentId: "c1" }))).toBe("stopped");
  });

  test("without the fourth argument the verdict is the old one (spontaneous CLI turns)", () => {
    expect(wakeVerdict(PARENT, () => false, noStoppedChild)).toBe("archived");
  });
});

// The function the three wakes in `boot/reattach.ts` are wired to: the whole road
// from topic row to verdict, with a real database.
describe("launchingChatCanWake: the shared canWake of the wakes that answer a launch", () => {
  const RETIRED = "2026-11-11T15:35:28.893Z";
  const AFTER = "2026-11-16T23:41:09.861Z";
  function setup(topic: { archived: boolean; provider?: string }, held = false) {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, assigned_topic_id TEXT, created_by_topic_id TEXT, origin_topic_id TEXT, created_at TEXT)");
    db.run("CREATE TABLE subagents (id TEXT PRIMARY KEY, runtime TEXT, state TEXT, parent_session_key TEXT, created_at TEXT)");
    db.run("CREATE TABLE retirements (kind TEXT, ref_id TEXT, retired_at TEXT, reason TEXT, PRIMARY KEY (kind, ref_id))");
    db.run("INSERT INTO retirements VALUES ('topic', 't-parent', ?, 'archive')", [RETIRED]);
    db.run("INSERT INTO subagents VALUES ('c1', 'topics', 'retired', 'topic:parent', ?)", [AFTER]);
    const canWake = launchingChatCanWake({
      db,
      getTopicBySessionKey: (sk) => (sk === "topic:parent" ? { id: "t-parent", ...topic } : null),
      isProviderHeld: () => held,
      defaultProvider: () => undefined,
    });
    return { db, canWake };
  }

  test("an archived parent is woken for the child it launched after the archive, and only for it", () => {
    const { canWake } = setup({ archived: true });
    expect(canWake("topic:parent", { subagentId: "c1" })).toBe("wake");
    expect(canWake("topic:parent", { subagentId: "ghost" })).toBe("row");
    expect(canWake("topic:parent")).toBe("row");
    expect(canWake("topic:gone", { subagentId: "c1" })).toBe("row");
  });

  test("an open parent is woken, `wait` while its provider is held", () => {
    expect(setup({ archived: false }).canWake("topic:parent")).toBe("wake");
    expect(setup({ archived: false }, true).canWake("topic:parent")).toBe("wait");
    expect(setup({ archived: true }, true).canWake("topic:parent", { subagentId: "c1" })).toBe("wait");
  });
});

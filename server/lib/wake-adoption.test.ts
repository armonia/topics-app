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
import { wakeVerdict, runningTaskOwnsTopic, stoppedSubagentChat } from "./wake-adoption";

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

/**
 * @covers CMD-10
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Topic } from "../types";
import { cleanupStaleSideQuestions, deleteSideQuestion } from "./side-question";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT UNIQUE, created_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, content TEXT);
    CREATE TABLE chat_forks (session_key TEXT PRIMARY KEY, runtime TEXT);
    CREATE TABLE session_context (session_key TEXT PRIMARY KEY, used_tokens INTEGER);
    CREATE TABLE notification_log (id TEXT PRIMARY KEY, target_kind TEXT, target_id TEXT, group_key TEXT);
    CREATE TABLE activity_log (id TEXT PRIMARY KEY, session_key TEXT, entity_type TEXT, entity_id TEXT);
    CREATE TABLE side_refs (id TEXT PRIMARY KEY, topic_id TEXT);
    CREATE TABLE subject_attention (subject TEXT PRIMARY KEY, state TEXT);
  `);
  const main: Topic = { id: "main", sessionKey: "topic:main", name: "Main", createdAt: new Date().toISOString() } as Topic;
  const side: Topic = { id: "side-question-one", sessionKey: "topic:side", name: "Side", createdAt: new Date().toISOString() } as Topic;
  const topics: Record<string, Topic> = { main, [side.id]: side };
  const deleted: string[] = [];
  db.prepare("INSERT INTO topics VALUES (?, ?, ?)").run(main.id, main.sessionKey, main.createdAt);
  db.prepare("INSERT INTO topics VALUES (?, ?, ?)").run(side.id, side.sessionKey, side.createdAt);
  db.prepare("INSERT INTO messages VALUES ('m-side', ?, 'copied')").run(side.sessionKey);
  db.prepare("INSERT INTO chat_forks VALUES (?, 'claude-cli')").run(side.sessionKey);
  db.prepare("INSERT INTO session_context VALUES (?, 1)").run(side.sessionKey);
  db.prepare("INSERT INTO notification_log VALUES ('n-side', 'topic', ?, ?)").run(side.id, `topic:${side.id}`);
  db.prepare("INSERT INTO activity_log VALUES ('a-side', ?, 'topic', ?)").run(side.sessionKey, side.id);
  db.prepare("INSERT INTO side_refs VALUES ('r-side', ?)").run(side.id);
  db.prepare("INSERT INTO subject_attention VALUES (?, 'finished')").run(`topic:${side.id}`);
  const deps = {
    db,
    getTopic: (id: string) => topics[id] ?? null,
    isStreaming: (key: string) => key === "topic:streaming",
    resolveProvider: () => ({ discardEphemeralSession: async (key: string) => { deleted.push(key); } }) as never,
    now: () => Date.now(),
  };
  return { db, deps, side, topics, deleted };
}

describe("side-question cleanup", () => {
  test("deletes rows keyed by the topic and session and discards its transcript", async () => {
    const h = fixture();
    const stopped: string[] = [];
    await deleteSideQuestion({ ...h.deps, stopAgentProcesses: (key) => stopped.push(key) }, h.side);
    expect(h.deleted).toEqual([h.side.sessionKey]);
    expect(stopped).toEqual([h.side.sessionKey]);
    for (const table of ["topics", "messages", "chat_forks", "session_context", "notification_log", "activity_log", "side_refs", "subject_attention"]) {
      expect(h.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: table === "topics" ? 1 : 0 });
    }
    expect(h.db.query("SELECT id FROM topics").all()).toEqual([{ id: "main" }]);
    h.db.close();
  });

  test("the main chat's rows stay: only what names the side topic or its session goes", async () => {
    const h = fixture();
    h.db.prepare("INSERT INTO messages VALUES ('m-main', 'topic:main', 'kept')").run();
    h.db.prepare("INSERT INTO activity_log VALUES ('a-main', 'topic:main', 'topic', 'main')").run();
    h.db.prepare("INSERT INTO notification_log VALUES ('n-main', 'topic', 'main', 'topic:main')").run();
    await deleteSideQuestion(h.deps, h.side);
    expect(h.db.query("SELECT id FROM messages").all()).toEqual([{ id: "m-main" }]);
    expect(h.db.query("SELECT id FROM activity_log").all()).toEqual([{ id: "a-main" }]);
    expect(h.db.query("SELECT id FROM notification_log").all()).toEqual([{ id: "n-main" }]);
    h.db.close();
  });

  test("a stale question that cannot be removed does not keep the others", async () => {
    const h = fixture();
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const broken = { ...h.side, id: "side-question-broken", sessionKey: "topic:broken", createdAt: old } as Topic;
    const stale = { ...h.side, id: "side-question-stale", sessionKey: "topic:stale", createdAt: old } as Topic;
    for (const [topic, runtime] of [[broken, "db-history"], [stale, "claude-cli"]] as const) {
      h.topics[topic.id] = topic;
      h.db.prepare("INSERT INTO topics VALUES (?, ?, ?)").run(topic.id, topic.sessionKey, topic.createdAt);
      h.db.prepare("INSERT INTO chat_forks VALUES (?, ?)").run(topic.sessionKey, runtime);
    }
    expect(await cleanupStaleSideQuestions(h.deps)).toBe(1);
    expect(h.db.query("SELECT id FROM topics WHERE id IN (?, ?)").all(broken.id, stale.id)).toEqual([{ id: broken.id }]);
    h.db.close();
  });

  test("removes an 11-minute orphan but keeps a 2-minute topic and an active turn", async () => {
    const h = fixture();
    const now = Date.now();
    const old = { ...h.side, id: "side-question-old", sessionKey: "topic:old", createdAt: new Date(now - 11 * 60_000).toISOString() } as Topic;
    const recent = { ...h.side, id: "side-question-recent", sessionKey: "topic:recent", createdAt: new Date(now - 2 * 60_000).toISOString() } as Topic;
    const active = { ...h.side, id: "side-question-active", sessionKey: "topic:streaming", createdAt: new Date(now - 11 * 60_000).toISOString() } as Topic;
    for (const topic of [old, recent, active]) {
      h.topics[topic.id] = topic;
      h.db.prepare("INSERT INTO topics VALUES (?, ?, ?)").run(topic.id, topic.sessionKey, topic.createdAt);
      h.db.prepare("INSERT INTO chat_forks VALUES (?, 'claude-cli')").run(topic.sessionKey);
    }
    const removed = await cleanupStaleSideQuestions(h.deps);
    expect(removed).toBe(1);
    expect(h.db.query("SELECT id FROM topics WHERE id IN (?, ?, ?) ORDER BY id").all(old.id, recent.id, active.id)).toEqual([
      { id: active.id }, { id: recent.id },
    ]);
    h.db.close();
  });

  test("reads only the side questions' rows, never the other topics", async () => {
    const h = fixture();
    // Ids that sort right around the prefix: the range must leave them out.
    for (const id of ["side-question", "side-questions", "side-question.x", "a-main", "zeta"]) {
      h.db.prepare("INSERT INTO topics VALUES (?, ?, ?)").run(id, `topic:${id}`, new Date(0).toISOString());
    }
    const asked: string[] = [];
    const getTopic = h.deps.getTopic;
    await cleanupStaleSideQuestions({ ...h.deps, getTopic: (id: string) => { asked.push(id); return getTopic(id); } });
    expect(asked).toEqual([h.side.id]);
    h.db.close();
  });
});

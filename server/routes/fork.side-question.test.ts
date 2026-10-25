/**
 * @covers CMD-10
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Topic } from "../types";
import { createForkRouter } from "./fork";

describe("POST /side-question", () => {
  test("starts from the CLI transcript without copying the parent messages", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT UNIQUE); CREATE TABLE messages (id TEXT, session_key TEXT, role TEXT, content TEXT); CREATE TABLE chat_forks (session_key TEXT PRIMARY KEY, parent_topic_id TEXT, parent_name TEXT NOT NULL, fork_point_message_id TEXT NOT NULL, runtime TEXT NOT NULL, parent_ref TEXT, parent_at TEXT, branch_ref TEXT, created_at TEXT NOT NULL); CREATE TABLE claude_code_sessions (session_key TEXT, claude_session_id TEXT, created_at TEXT, updated_at TEXT);");
    const parent: Topic = { id: "parent", name: "Parent", sessionKey: "topic:parent", createdAt: new Date().toISOString(), provider: "claude-code" } as Topic;
    const topics: Record<string, Topic> = { parent };
    db.prepare("INSERT INTO topics VALUES (?, ?)").run(parent.id, parent.sessionKey);
    const messages = [{ id: "m-user", role: "user", content: "question" }, { id: "m-answer", role: "assistant", content: "finished answer" }];
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("m-user", parent.sessionKey, "user", "question");
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("m-answer", parent.sessionKey, "assistant", "finished answer");
    let saved = 0;
    const discarded: string[] = [];
    const stopped: string[] = [];
    const provider = { name: "claude-code", forkPoint: (_key: string, text: string) => ({ ref: "cli-session", at: "answer-uuid", text }), discardEphemeralSession: async (key: string) => { discarded.push(key); } };
    const ctx = {
      db,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
      readJSON: async (request: Request) => request.json(),
      matchRoute: (path: string, pattern: string) => {
        const [prefix, suffix] = pattern.split(":id");
        if (!suffix) return null;
        if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
        const id = path.slice(prefix.length, path.length - suffix.length);
        return id ? { id } : null;
      },
      getTopicById: (id: string) => topics[id] ?? null,
      isStreaming: () => undefined,
      loadTopics: () => ({ topics }),
      loadActiveThread: () => messages,
      saveSingleTopic: (topic: Topic) => { topics[topic.id] = topic; db.prepare("INSERT INTO topics VALUES (?, ?)").run(topic.id, topic.sessionKey); },
      saveLocalMessages: (sessionKey: string, rows: typeof messages) => {
        saved++;
        const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
        for (const row of rows) insert.run(row.id, sessionKey, row.role, row.content);
      },
      slugify: (value: string) => value.toLowerCase(),
      broadcastToAll: () => {},
    } as never;
    const router = createForkRouter(ctx, {
      resolveProvider: () => provider as never,
      stopAgentProcesses: (sessionKey) => stopped.push(sessionKey),
    });
    const url = new URL("http://topics.test/api/topics/parent/side-question");
    const response = await router(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), url, url.pathname, "POST");
    expect(response?.status).toBe(201);
    const branch = await response!.json() as Topic;
    expect(branch.id.startsWith("side-question-")).toBe(true);
    expect(saved).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE session_key = ?").get(branch.sessionKey)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM chat_forks").get()).toEqual({ count: 1 });
    expect(db.query("SELECT fork_point_message_id, parent_at FROM chat_forks").get()).toEqual({ fork_point_message_id: "m-answer", parent_at: "answer-uuid" });
    const deleted = await router(new Request(`http://topics.test/api/topics/${branch.id}/side-question`, { method: "DELETE" }), new URL(`http://topics.test/api/topics/${branch.id}/side-question`), `/api/topics/${branch.id}/side-question`, "DELETE");
    expect(deleted?.status).toBe(200);
    expect(discarded).toEqual([branch.sessionKey]);
    expect(stopped).toEqual([branch.sessionKey]);
    expect(db.query("SELECT id FROM topics WHERE id = ?").get(branch.id)).toBeNull();
    expect(db.query("SELECT session_key FROM chat_forks WHERE session_key = ?").get(branch.sessionKey)).toBeNull();
    expect(db.query("SELECT session_key FROM claude_code_sessions WHERE session_key = ?").get(branch.sessionKey)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE session_key = ?").get(branch.sessionKey)).toEqual({ count: 0 });
    db.close();
  });

  test("returns 409 when the transcript cannot locate the finished answer", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT UNIQUE); CREATE TABLE chat_forks (session_key TEXT PRIMARY KEY, parent_topic_id TEXT, parent_name TEXT NOT NULL, fork_point_message_id TEXT NOT NULL, runtime TEXT NOT NULL, parent_ref TEXT, parent_at TEXT, branch_ref TEXT, created_at TEXT NOT NULL);");
    const parent = { id: "parent", name: "Parent", sessionKey: "topic:parent", createdAt: new Date().toISOString(), provider: "claude-code" } as Topic;
    const ctx = {
      db, json: (body: unknown, status = 200) => Response.json(body, { status }), readJSON: async (request: Request) => request.json(),
      matchRoute: (path: string, pattern: string) => path === "/api/topics/parent/side-question" && pattern.includes(":id") ? { id: "parent" } : null,
      getTopicById: (id: string) => id === "parent" ? parent : null, isStreaming: () => undefined,
      loadTopics: () => ({ topics: { parent } }), loadActiveThread: () => [{ id: "m", role: "assistant", content: "answer" }],
      saveSingleTopic: () => { throw new Error("must not create a branch"); }, saveLocalMessages: () => {}, slugify: (s: string) => s,
      broadcastToAll: () => {},
    } as never;
    const router = createForkRouter(ctx, { resolveProvider: () => ({ name: "claude-code", forkPoint: () => null }) as never });
    const url = new URL("http://topics.test/api/topics/parent/side-question");
    const response = await router(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), url, url.pathname, "POST");
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: "side_question_fork_unavailable", reason: "no-parent-session" });
    db.close();
  });
});

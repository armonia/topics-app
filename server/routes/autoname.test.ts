/**
 * Auto-naming never binds a detected project to the registry-backed coordinator.
 * @covers GLOBAL-ORCHESTRATOR-ISOLATION-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext, StoredMessage, Topic } from "../types";
import { createAutoNameRouter } from "./autoname";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pathParts = pathname.split("/");
  const patternParts = pattern.split("/");
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!;
    const actual = pathParts[index]!;
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

function makeTopic(id: string): Topic {
  return {
    id,
    name: "Global coordinator",
    slug: "global-coordinator",
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:00:00.000Z",
    archived: false,
  };
}

describe("auto-name global coordinator invariant", () => {
  test("never infers or binds a project for the registry-mapped ordinary Topic", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    db.run("PRAGMA foreign_keys = ON");
    db.run(`CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL UNIQUE
    )`);
    db.run(`CREATE TABLE global_orchestrator_sessions (
      scope TEXT PRIMARY KEY CHECK (scope = 'global'),
      topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    const topic = makeTopic("global-topic");
    const topics = new Map([[topic.id, topic]]);
    db.run("INSERT INTO topics (id, session_key) VALUES (?, ?)", [topic.id, topic.sessionKey]);
    db.run(
      `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
       VALUES ('global', ?, '2026-09-04T11:00:00.000Z', '2026-09-04T11:00:00.000Z')`,
      [topic.id],
    );

    const messages: StoredMessage[] = [
      { id: "u1", role: "user", content: "Please inspect /work/selected", timestamp: "2026-09-04T11:01:00.000Z" },
      { id: "a1", role: "assistant", content: "I can coordinate that board.", timestamp: "2026-09-04T11:01:01.000Z" },
    ];
    const broadcasts: unknown[] = [];
    let providerResolutions = 0;
    const ctx = {
      db,
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      matchRoute,
      getTopicById: (id: string) => topics.get(id) ?? null,
      loadLocalMessages: () => messages,
      saveSingleTopic: (next: Topic) => { topics.set(next.id, next); },
      broadcastToAll: (message: unknown) => { broadcasts.push(message); },
      slugify: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    } as unknown as AppContext;
    const router = createAutoNameRouter(ctx, {
      detectProjectPathFromMessages: () => "/work/selected",
      resolveProvider: () => {
        providerResolutions += 1;
        throw new Error("the coordinator must not reach generic autoname provider resolution");
      },
    });

    const url = new URL(`http://topics.test/api/topics/${topic.id}/auto-name`);
    const response = await router(new Request(url, { method: "POST" }), url, url.pathname, "POST");

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ suggestedProject: null });
    expect(topics.get(topic.id)?.projectPath).toBeUndefined();
    expect(broadcasts).toEqual([]);
    expect(providerResolutions).toBe(0);
  });
});

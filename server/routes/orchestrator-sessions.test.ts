/**
 * HTTP coverage for the durable global-orchestrator entry point.
 *
 * The endpoint must mint/reuse an ordinary Topic and hand its id to the
 * standard Topic panel lifecycle.  This fixture intentionally has no real
 * provider/session implementation: those are normal Topic concerns, while the
 * route's security boundary is the registry row plus the normal topic writer.
 * @covers GLOBAL-ORCHESTRATOR-ROUTE-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext, Topic } from "../types";
import { createOrchestratorSessionsRouter } from "./orchestrator-sessions";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeTopic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    name: id,
    slug: id,
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

function makeHarness(role: "owner" | "guest" = "owner") {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("PRAGMA foreign_keys = ON");
  // The registry resolves a session key through this normal Topic row.  The
  // full production topics schema is intentionally not needed for this route.
  db.run(`CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    project_path TEXT,
    worktree_id TEXT,
    parent_id TEXT,
    provider TEXT
  )`);
  db.run(`CREATE TABLE global_orchestrator_sessions (
    scope TEXT PRIMARY KEY CHECK (scope = 'global'),
    topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  const topics = new Map<string, Topic>();
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];
  const saveTopic = (topic: Topic) => {
    topics.set(topic.id, topic);
    db.run(
      `INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_key = excluded.session_key,
         project_path = excluded.project_path,
         worktree_id = excluded.worktree_id,
         parent_id = excluded.parent_id,
         provider = excluded.provider`,
      [
        topic.id,
        topic.sessionKey,
        topic.projectPath ?? null,
        topic.worktreeId ?? null,
        topic.parentId ?? null,
        topic.provider ?? null,
      ],
    );
  };

  const ctx = {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
    // Kept in the test context because RouteHandler construction shares the
    // normal AppContext shape, although this focused endpoint does not match
    // dynamic parameters itself.
    matchRoute: () => null,
    getTopicById: (id: string) => topics.get(id) ?? null,
    saveSingleTopic: saveTopic,
    loadTopics: () => ({ topics: Object.fromEntries(topics) }),
    broadcastToAll: (message: { type: string } & Record<string, unknown>) => { broadcasts.push(message); },
    requestIdentity: () => role === "guest" ? { role: "guest" as const, deviceId: "guest-device" } : null,
  } as unknown as AppContext;

  const router = createOrchestratorSessionsRouter(ctx);
  const call = async (method = "POST") => {
    const url = new URL("http://topics.test/api/orchestrator-sessions/global/ensure");
    const response = await router(new Request(url, { method }), url, url.pathname, method);
    if (!response) throw new Error("orchestrator sessions route did not respond");
    return response;
  };

  return { db, topics, broadcasts, saveTopic, call };
}

describe("POST /api/orchestrator-sessions/global/ensure", () => {
  test("creates one unbound ordinary Topic, broadcasts it once, then reuses its normal id", async () => {
    const h = makeHarness();

    // A title/MCP-policy lookalike must remain an ordinary, unrelated Topic.
    // This makes the endpoint's source of truth observable at the HTTP seam.
    const lookalike = makeTopic("lookalike", {
      name: "Kanban coordinator",
      mcpPolicy: "bridge-only",
      systemPrompt: "looks special but is not registered",
    });
    h.saveTopic(lookalike);

    const first = await h.call();
    const firstBody = await first.json() as { topicId: string; topic: Topic };
    const second = await h.call();
    const secondBody = await second.json() as { topicId: string; topic: Topic };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.topicId).toBe(firstBody.topicId);
    expect(firstBody.topicId).not.toBe(lookalike.id);
    // The client-facing role marker is a server projection of the registry,
    // not a claim inferred from the coordinator's name, prompt, or provider.
    expect(firstBody.topic).toEqual(expect.objectContaining({
      id: firstBody.topicId,
      isGlobalOrchestrator: true,
    }));
    expect(secondBody.topic).toEqual(expect.objectContaining({
      id: firstBody.topicId,
      isGlobalOrchestrator: true,
    }));

    const topic = h.topics.get(firstBody.topicId);
    expect(topic).toBeDefined();
    expect(topic?.sessionKey).toMatch(/^topic:/);
    expect(topic?.projectPath).toBeUndefined();
    expect(topic?.worktreeId).toBeUndefined();
    expect(topic?.parentId).toBeNull();
    expect(topic?.systemPrompt).toContain("focused global task tools");
    expect(topic?.systemPrompt).toContain("Codex Voice remains external");
    // The registry remains role identity, while this durable role is expressly
    // pinned to the user's Codex subscription rather than a fallback provider.
    expect(topic?.provider).toBe("codex");
    expect(topic).not.toHaveProperty("mcpPolicy");

    expect(
      h.db.query("SELECT scope, topic_id FROM global_orchestrator_sessions").all(),
    ).toEqual([{ scope: "global", topic_id: firstBody.topicId }]);
    expect(h.broadcasts.filter((message) => message.type === "topic:created")).toEqual([
      expect.objectContaining({
        type: "topic:created",
        topic: expect.objectContaining({
          id: firstBody.topicId,
          isGlobalOrchestrator: true,
        }),
      }),
    ]);
  });

  test("repairs an archived pre-feature coordinator in place without minting another transcript", async () => {
    const h = makeHarness();
    const first = await h.call();
    const { topicId } = await first.json() as { topicId: string; topic: Topic };
    const topic = h.topics.get(topicId)!;
    topic.archived = true;
    topic.provider = "openclaw";
    topic.systemPrompt = "stale prompt";
    h.saveTopic(topic);

    const restored = await h.call();
    const restoredBody = await restored.json() as { topicId: string; topic: Topic };
    expect(restoredBody.topicId).toBe(topicId);
    expect(restoredBody.topic).toEqual(expect.objectContaining({
      id: topicId,
      isGlobalOrchestrator: true,
    }));
    expect(h.topics.get(topicId)).toMatchObject({
      archived: false,
      provider: "codex",
      systemPrompt: expect.stringContaining("focused global task tools"),
    });
    expect(h.broadcasts.filter((message) => message.type === "topic:created")).toHaveLength(1);
    expect(h.broadcasts.filter((message) => message.type === "topic:updated")).toEqual([
      expect.objectContaining({
        topic: expect.objectContaining({ id: topicId, isGlobalOrchestrator: true }),
      }),
    ]);
  });

  test("forbids a guest before it can create or learn a global coordinator Topic", async () => {
    const h = makeHarness("guest");

    const response = await h.call();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "guest_forbidden" });
    expect(h.topics.size).toBe(0);
    expect(h.db.query("SELECT COUNT(*) AS count FROM global_orchestrator_sessions").get()).toEqual({ count: 0 });
    expect(h.broadcasts).toEqual([]);
  });

  test("does not accidentally accept a read request as an ensure operation", async () => {
    const h = makeHarness();

    const response = await h.call("GET");

    expect(response.status).toBe(405);
    expect(h.topics.size).toBe(0);
    expect(h.db.query("SELECT COUNT(*) AS count FROM global_orchestrator_sessions").get()).toEqual({ count: 0 });
  });
});

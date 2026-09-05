/**
 * Provider boundary for the durable global Kanban coordinator.
 *
 * This is intentionally at the real chat-router seam: the rejection must
 * happen before a user message is persisted and before a normal provider can
 * be resolved as a fallback.
 * @covers GLOBAL-ORCHESTRATOR-PROVIDER-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getProvider, registerProvider, removeProvider } from "../providers";
import { createChatRouter } from "./chat";
import type { AppContext, Topic } from "../types";

// `chat.ts` resolves the coordinator's provider straight from the registry
// (`getProvider("codex")`), never through the dependency-injected resolver.
// A REAL Codex provider is registered for the file rather than a `mock.module`
// on the barrel: the module mock is process-global in bun and outlives this
// file, and the namespace import it needed made every provider export look
// used to the dead-code gate. The Codex constructor only stores its config and
// `start()` only flips a flag: no process is spawned and no CLI is required.
// The harness stops the route right after persistence, before any spawn.
beforeAll(() => { registerProvider({ type: "codex" }); });
afterAll(() => { removeProvider("codex"); });

const SESSION_KEY = "topic:global-provider-test";
const TOPIC_ID = "global-provider-test";

function makeTopic(provider: string): Topic {
  const now = "2026-09-04T12:00:00.000Z";
  return {
    id: TOPIC_ID,
    name: "Kanban coordinator",
    slug: "kanban-coordinator",
    parentId: null,
    links: [],
    sessionKey: SESSION_KEY,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: now,
    updatedAt: now,
    archived: false,
    provider,
  };
}

function harness(topicProvider = "codex") {
  const db = new Database(":memory:");
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
  const topic = makeTopic(topicProvider);
  db.run(
    `INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider)
     VALUES (?, ?, NULL, NULL, NULL, ?)`,
    [topic.id, topic.sessionKey, topicProvider],
  );
  db.run(
    `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
     VALUES ('global', ?, ?, ?)`,
    [topic.id, topic.createdAt, topic.updatedAt],
  );

  const appended: string[] = [];
  let fallbackCalls = 0;
  const ctx = {
    db,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
    readJSON: async (req: Request) => req.json(),
    getTopicBySessionKey: (sessionKey: string) => sessionKey === topic.sessionKey ? topic : null,
    isStreaming: () => undefined,
    appendLocalMessage: (_sessionKey: string, _role: string, content: string) => {
      appended.push(content);
      // Stop exactly after persistence. A valid coordinator request therefore
      // demonstrates the forced provider decision without launching a CLI.
      throw new Error("STOP_AFTER_APPEND");
    },
  } as unknown as AppContext;
  const router = createChatRouter(ctx, {
    resolveProvider: () => {
      fallbackCalls += 1;
      throw new Error("ordinary provider fallback must not run");
    },
    detectLocalhostAutoNav: () => "",
    bindTopicToProject: () => false,
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: "/tmp",
  });
  const send = (provider?: string) => {
    const url = new URL("http://topics.test/api/chat");
    return router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: SESSION_KEY,
          messages: [{ role: "user", content: "coordinate this board" }],
          ...(provider === undefined ? {} : { provider }),
        }),
      }),
      url,
      url.pathname,
      "POST",
    );
  };
  return {
    db,
    appended,
    fallbackCalls: () => fallbackCalls,
    send,
  };
}

describe("POST /api/chat — global coordinator Codex-only boundary", () => {
  test("rejects every non-Codex override before message persistence", async () => {
    const h = harness();
    try {
      for (const provider of ["openclaw", "claude", "openai"]) {
        const response = await h.send(provider);
        expect(response?.status).toBe(400);
        expect(await response!.json()).toMatchObject({ code: "orchestrator_provider_required" });
      }
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual([]);
    } finally { h.db.close(); }
  });

  test("forces the Codex registry provider and never resolves the ordinary fallback", async () => {
    const h = harness();
    try {
      // The registry holds Codex, so the route passes the boundary and reaches
      // persistence: the message is recorded without the injected resolver
      // ever running. That is the forced decision, observed from outside.
      expect(getProvider("codex").name).toBe("codex");
      await expect(h.send("codex")).rejects.toThrow("STOP_AFTER_APPEND");
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual(["coordinate this board"]);
    } finally { h.db.close(); }
  });

  test("with Codex missing from the registry the turn fails closed instead of falling back", async () => {
    // Same request as above, minus the only provider the coordinator accepts.
    // A route that fell through to the ordinary resolver would count a
    // fallback call or persist the message; a route that asks the registry for
    // Codex specifically can only answer 503.
    removeProvider("codex");
    const h = harness();
    try {
      const response = await h.send("codex");
      expect(response?.status).toBe(503);
      expect(await response!.json()).toMatchObject({ code: "codex_unavailable" });
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual([]);
    } finally {
      h.db.close();
      registerProvider({ type: "codex" });
    }
  });

  test("a raw registered row with a non-Codex provider fails closed before fallback", async () => {
    const h = harness("openclaw");
    try {
      const response = await h.send("codex");
      expect(response?.status).toBe(409);
      expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual([]);
    } finally { h.db.close(); }
  });
});

/**
 * Provider boundary for the durable global Kanban coordinator.
 *
 * This is intentionally at the real chat-router seam: the rejection must
 * happen before a user message is persisted and before a normal provider can
 * be resolved as a fallback.
 * @covers GLOBAL-ORCHESTRATOR-PROVIDER-01
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext, Topic } from "../types";

const providerCalls: string[] = [];
const codexProvider = {
  name: "codex",
  capabilities: new Set<string>(),
  connected: true,
};

// `chat.ts` imports this one runtime symbol from the provider barrel. Mocking
// it proves the route asks specifically for Codex rather than falling through
// to the ordinary dependency-injected provider resolver.
//
// `mock.module` is process-global in bun and outlives this file when the suite
// runs in one process: everything but the Codex lookup is delegated to the real
// barrel (captured BEFORE the mock, since the live bindings get rewritten), so
// a later file that registers a real provider still finds the registry it
// expects. Measured 2026-09-04: a throwing stub turned topics-abort-turnend red.
import * as realProviders from "../providers";
const realBarrel = { ...realProviders };
const realGetProvider = realProviders.getProvider;
mock.module("../providers", () => ({
  ...realBarrel,
  getProvider: (name?: string) => {
    providerCalls.push(name ?? "");
    if (name === "codex") return codexProvider;
    return realGetProvider(name);
  },
}));

import { createChatRouter } from "./chat";

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

beforeEach(() => { providerCalls.splice(0); });

describe("POST /api/chat — global coordinator Codex-only boundary", () => {
  test("rejects every non-Codex override before message persistence", async () => {
    const h = harness();
    try {
      for (const provider of ["openclaw", "claude", "openai"]) {
        const response = await h.send(provider);
        expect(response?.status).toBe(400);
        expect(await response!.json()).toMatchObject({ code: "orchestrator_provider_required" });
      }
      expect(providerCalls).toEqual([]);
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual([]);
    } finally { h.db.close(); }
  });

  test("forces the Codex registry provider and never resolves the ordinary fallback", async () => {
    const h = harness();
    try {
      await expect(h.send("codex")).rejects.toThrow("STOP_AFTER_APPEND");
      expect(providerCalls).toEqual(["codex"]);
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual(["coordinate this board"]);
    } finally { h.db.close(); }
  });

  test("a raw registered row with a non-Codex provider fails closed before fallback", async () => {
    const h = harness("openclaw");
    try {
      const response = await h.send("codex");
      expect(response?.status).toBe(409);
      expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
      expect(providerCalls).toEqual([]);
      expect(h.fallbackCalls()).toBe(0);
      expect(h.appended).toEqual([]);
    } finally { h.db.close(); }
  });
});

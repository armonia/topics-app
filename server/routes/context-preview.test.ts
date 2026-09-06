/**
 * Unit tests for the Context Preview & Snapshots router.
 *
 * Mocks the AppContext just like `assemble.test.ts`. Tests focus on the
 * router contract (route matching, response shapes, error paths). The
 * deep semantics of the envelope and adapter are exercised in their own
 * suites — here we just verify the wiring.
  * @covers CTX-PREVIEW-01
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AppContext, StoredMessage, Topic, TopicsData } from "../types";
import type { ContextEnvelope } from "../context";
import { clearSnapshots, getSnapshots, pushSnapshot } from "../context";
import { createContextPreviewRouter } from "./context-preview";

// ────────────────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────────────────

const ROOT = join(tmpdir(), `context-preview-test-${process.pid}-${Date.now()}`);
const baseDir = join(ROOT, "base");
const openclawDir = join(ROOT, "openclaw");

beforeAll(() => {
  mkdirSync(join(baseDir, "memory"), { recursive: true });
  mkdirSync(join(openclawDir, "workspace"), { recursive: true });
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  clearSnapshots();
});

const topic: Topic = {
  id: "topic-1",
  name: "Topic 1",
  slug: "topic-1",
  parentId: null,
  links: [],
  sessionKey: "topic:t1",
  color: "#5865f2",
  icon: "MessageSquare",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  archived: false,
  systemPrompt: "You are concise.",
};

const messages: StoredMessage[] = [
  { id: "u1", role: "user", content: "hello", timestamp: "2026-01-01T00:00:00Z" },
  { id: "a1", role: "assistant", content: "hi", timestamp: "2026-01-01T00:00:01Z" },
];

const topicsData: TopicsData = { topics: { [topic.id]: topic } };

const ctx = {
  BASE_DIR: baseDir,
  OPENCLAW_DIR: openclawDir,
  getTopicById: (id: string) => (id === topic.id ? topic : null),
  getTopicBySessionKey: (sk: string) => (sk === topic.sessionKey ? topic : null),
  loadLocalMessages: (_sk: string) => messages,
  loadTopics: () => topicsData,
  resolveTopicCwd: () => null,
  json: (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  matchRoute: (pathname: string, pattern: string) => {
    const patternParts = pattern.split("/");
    const pathnameParts = pathname.split("/");
    if (patternParts.length !== pathnameParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = pathnameParts[i];
      } else if (patternParts[i] !== pathnameParts[i]) {
        return null;
      }
    }
    return params;
  },
} as unknown as AppContext;

const router = createContextPreviewRouter(ctx);

function url(path: string, query: Record<string, string> = {}): URL {
  const u = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("contextPreviewRouter", () => {
  it("GET /api/topics/:id/context-preview returns envelope + payload", async () => {
    const req = new Request(url("/api/topics/topic-1/context-preview"));
    const resp = await router(req, url("/api/topics/topic-1/context-preview"), "/api/topics/topic-1/context-preview", "GET");
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.envelope).toBeDefined();
    expect(body.envelope.topicId).toBe("topic-1");
    expect(body.payload).toBeDefined();
    // System prompt block should be present
    expect(body.envelope.systemBlocks.some((b: any) => b.id === "prompt:system")).toBe(true);
  });

  it("GET /api/topics/:id/context-preview returns 404 for unknown topic", async () => {
    const path = "/api/topics/missing/context-preview";
    const resp = await router(new Request(url(path)), url(path), path, "GET");
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(404);
  });

  it("refuses a raw registered coordinator instead of honoring a caller-selected provider", async () => {
    const guarded = createContextPreviewRouter({
      ...ctx,
      db: {
        query: (sql: string) => ({
          get: (_scope: string, topicId: string) =>
            sql.includes("global_orchestrator_sessions") && topicId === topic.id
              ? {
                  scope: "global",
                  topic_id: topic.id,
                  created_at: "2026-09-04T00:00:00.000Z",
                  updated_at: "2026-09-04T00:00:00.000Z",
                }
              : null,
        }),
      },
    } as AppContext);
    const path = "/api/topics/topic-1/context-preview";
    const response = await guarded(new Request(url(path, { provider: "openclaw" })), url(path, { provider: "openclaw" }), path, "GET");
    expect(response!.status).toBe(403);
    expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
  });

  it("keeps retained snapshots behind the same raw coordinator fence", async () => {
    const guarded = createContextPreviewRouter({
      ...ctx,
      db: {
        query: (sql: string) => ({
          get: (_scope: string, topicId: string) =>
            sql.includes("global_orchestrator_sessions") && topicId === topic.id
              ? {
                  scope: "global",
                  topic_id: topic.id,
                  created_at: "2026-09-04T00:00:00.000Z",
                  updated_at: "2026-09-04T00:00:00.000Z",
                }
              : null,
        }),
      },
    } as AppContext);
    pushSnapshot({
      topicId: topic.id,
      sessionKey: topic.sessionKey,
      providerName: "codex",
      providerStrategy: "history-aware",
      systemBlocks: [],
      history: [],
      userMessage: { content: "retained board data" },
      diagnostics: {
        totalTokens: 0, budgetLimit: 200_000, budgetPercent: 0,
        droppedHistoryTurns: 0, historyEntries: [], warnings: [], assembledAt: 0,
      },
    });
    const path = `/api/topics/${topic.id}/context-snapshots`;

    for (const method of ["GET", "DELETE"] as const) {
      const response = await guarded(new Request(url(path), { method }), url(path), path, method);
      expect(response!.status).toBe(403);
      expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
    }
    expect(getSnapshots(topic.id)).toHaveLength(1);
  });

  it("GET /api/topics/:id/context-snapshots starts empty", async () => {
    const path = "/api/topics/topic-1/context-snapshots";
    const resp = await router(new Request(url(path)), url(path), path, "GET");
    expect(resp).not.toBeNull();
    const body = await resp!.json();
    expect(body.snapshots).toEqual([]);
  });

  it("GET /api/topics/:id/context-snapshots returns pushed envelopes", async () => {
    const env: ContextEnvelope = {
      topicId: "topic-1",
      sessionKey: "topic:t1",
      providerName: "claude",
      providerStrategy: "history-aware",
      systemBlocks: [],
      history: [],
      userMessage: { content: "hi" },
      diagnostics: {
        totalTokens: 0, budgetLimit: 200_000, budgetPercent: 0,
        droppedHistoryTurns: 0, historyEntries: [],
        warnings: [], assembledAt: 0,
      },
    };
    pushSnapshot(env);
    pushSnapshot({ ...env, userMessage: { content: "hi 2" } });
    const path = "/api/topics/topic-1/context-snapshots";
    const resp = await router(new Request(url(path)), url(path), path, "GET");
    const body = await resp!.json();
    expect(body.snapshots.length).toBe(2);
    expect(body.snapshots[1].userMessage.content).toBe("hi 2");
  });

  it("DELETE /api/topics/:id/context-snapshots wipes the topic's ring", async () => {
    pushSnapshot({
      topicId: "topic-1", sessionKey: "topic:t1", providerName: "claude",
      providerStrategy: "history-aware", systemBlocks: [], history: [],
      userMessage: { content: "x" },
      diagnostics: { totalTokens: 0, budgetLimit: 200_000, budgetPercent: 0, droppedHistoryTurns: 0, historyEntries: [], warnings: [], assembledAt: 0 },
    });
    const path = "/api/topics/topic-1/context-snapshots";
    const resp = await router(new Request(url(path)), url(path), path, "DELETE");
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(1);
    // Subsequent GET returns empty.
    const resp2 = await router(new Request(url(path)), url(path), path, "GET");
    const body2 = await resp2!.json();
    expect(body2.snapshots).toEqual([]);
  });

  it("returns null for unhandled paths so other routers can match", async () => {
    const path = "/api/something-else";
    const resp = await router(new Request(url(path)), url(path), path, "GET");
    expect(resp).toBeNull();
  });
});

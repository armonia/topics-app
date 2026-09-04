/**
 * Context, history and session-environment routes keep the coordinator local-only.
 * @covers GLOBAL-ORCHESTRATOR-ISOLATION-01
 */
import { describe, expect, test } from "bun:test";
import type { AppContext, Topic } from "../types";
import { createContextRouter } from "./context";
import { createHistoryRouter } from "./history";
import { createSessionEnvironmentRouter } from "./session-environment";

const TOPIC_ID = "global-coordinator";
const SESSION_KEY = "topic:global-coordinator";

function rawCoordinatorDb() {
  return {
    query: () => ({
      get: (_scope: string, key: string) =>
        key === TOPIC_ID || key === SESSION_KEY
          ? {
              scope: "global",
              topic_id: TOPIC_ID,
              created_at: "2026-09-04T00:00:00.000Z",
              updated_at: "2026-09-04T00:00:00.000Z",
            }
          : null,
    }),
  };
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const actual = pathname.split("/");
  const expected = pattern.split("/");
  if (actual.length !== expected.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i]!.startsWith(":")) params[expected[i]!.slice(1)] = decodeURIComponent(actual[i]!);
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}

function coordinatorTopic(): Topic {
  return {
    id: TOPIC_ID,
    name: "Kanban coordinator",
    slug: "kanban-coordinator",
    parentId: null,
    links: [],
    sessionKey: SESSION_KEY,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    archived: false,
    // This simulates a damaged row. Raw registry identity must still deny
    // ordinary project/config/provider paths rather than treating it as a
    // normal bound Topic.
    projectPath: "/must-not-be-read",
    provider: "openclaw",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("global coordinator route isolation", () => {
  test("does not inspect a damaged coordinator's inherited project environment", async () => {
    const topic = coordinatorTopic();
    const router = createSessionEnvironmentRouter({
      db: rawCoordinatorDb(),
      json,
      matchRoute,
      getTopicById: (id: string) => id === TOPIC_ID ? topic : null,
    } as unknown as AppContext);
    const url = new URL(`http://topics.test/api/topics/${TOPIC_ID}/environment`);

    const response = await router(new Request(url), url, url.pathname, "GET");

    expect(response?.status).toBe(403);
    expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
  });

  test("uses a local context estimate instead of the OpenClaw gateway", async () => {
    const topic = coordinatorTopic();
    const router = createContextRouter({
      db: rawCoordinatorDb(),
      GATEWAY_URL: "not-a-valid-url",
      GATEWAY_TOKEN: "must-not-be-used",
      json,
      loadTopics: () => ({ topics: { [TOPIC_ID]: topic } }),
      loadLocalMessages: () => [{ role: "user", content: "1234" }],
      getTopicBySessionKey: (key: string) => key === SESSION_KEY ? topic : null,
    } as unknown as AppContext);
    const url = new URL(`http://topics.test/api/context?sessionKey=${encodeURIComponent(SESSION_KEY)}`);

    const response = await router(new Request(url), url, url.pathname, "GET");

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      total: 1,
      limit: expect.any(Number),
      breakdown: [{ label: "Messages", tokens: 1, color: "#22c55e" }],
    });
  });

  test("returns only local history and never asks a provider to migrate it", async () => {
    let providerLookups = 0;
    const router = createHistoryRouter({
      // The capped read on main asks SQLite which partial rows carry a body
      // before deciding what to hydrate; the coordinator has none.
      db: { ...rawCoordinatorDb(), prepare: () => ({ all: () => [] }) },
      json,
      readJSON: async () => ({}),
      loadLocalMessages: () => [],
      hydrateMessageBodies: (rows: unknown[]) => rows,
      appendLocalMessage: () => { throw new Error("provider migration must not append"); },
      isStreaming: () => undefined,
      getStreamContent: () => null,
      SESSIONS_DIR: "/must-not-be-read",
    } as unknown as AppContext, {
      matchHistoryRoute: (pathname) => pathname === `/api/history/${encodeURIComponent(SESSION_KEY)}` ? SESSION_KEY : null,
      providerForSessionKey: () => {
        providerLookups += 1;
        throw new Error("provider fallback must not run");
      },
    });
    const url = new URL(`http://topics.test/api/history/${encodeURIComponent(SESSION_KEY)}`);

    const response = await router(new Request(url), url, url.pathname, "GET");

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ messages: [], total: 0 });
    expect(providerLookups).toBe(0);
  });
});

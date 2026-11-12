/**
 * TWO MESSAGES IN THE SAME TICK ON ONE SESSION: ONE TURN, ONE 409.
 *
 * The one-turn-per-session gate holds only if nothing yields between it and
 * `startStream`: a second POST that runs while the first one waits on a
 * microtask finds no stream registered and opens a turn of its own. The
 * opt-in checkpoint is the only await allowed in that stretch.
 *
 * Real route, real database (`createTestAppContext`), a provider that never
 * answers: the first POST keeps its turn open, the second must be refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-same-tick-gate");
let ctx: AppContext;
const handlers: StreamHandler[] = [];
let chat: ReturnType<typeof createChatRouter>;

beforeAll(async () => {
  setupTestDataDir(`${ROOT}/data`);
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  const provider = {
    name: "topics",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  chat = createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null,
    getProjectIdForTopic: () => null, getWorkspaceProjects: () => [], autoBindProject: () => {},
    watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: `${ROOT}/ws`,
  } as never);
});
afterAll(async () => {
  for (const h of handlers.splice(0)) h.onDone({ result: "", turnEnd: { end: "end_turn" } });
  await Bun.sleep(80);
  cleanupTestDataDir(ROOT);
});

function topic(name: string): string {
  const now = new Date().toISOString();
  const sessionKey = `topic:${name}`;
  ctx.saveSingleTopic({
    id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: now, updatedAt: now, archived: false, provider: "topics",
  } as Topic);
  return sessionKey;
}

async function post(sessionKey: string, content: string): Promise<Response> {
  const url = new URL("http://topics.test/api/chat");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
  });
  const resp = (await chat(req, url, url.pathname, "POST"))!;
  if (resp.status === 200) resp.body?.cancel().catch(() => {});
  return resp;
}

describe("the one-turn-per-session gate", () => {
  test("two POSTs fired together on one session: [200, 409], one turn, one user row", async () => {
    const sk = topic("same-tick");
    const [a, b] = await Promise.all([post(sk, "first message"), post(sk, "second message")]);
    expect([a.status, b.status]).toEqual([200, 409]);
    expect((await b.json()).code).toBe("stream_in_flight");
    expect(handlers).toHaveLength(1);
    expect(ctx.loadLocalMessages(sk).filter((m) => m.role === "user")).toHaveLength(1);
  });
});

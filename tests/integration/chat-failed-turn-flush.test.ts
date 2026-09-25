/**
 * A TURN THAT FAILED TO START KEEPS ITS NOTICE WHEN SOMEBODY READS THE CHAT.
 *
 * A reader of a live turn's row (the history route, a catch-up, the outbound
 * gate) calls `flushTurnBody`, and the turn's writer registers that flush when
 * it is built. The two paths that close a turn which could not be driven
 * (`sendChat` rejected, or the setup threw) wrote the failure notice and left
 * the flush registered. Once the flush wrote the whole body, the next reader of
 * the session wrote the turn's empty body over the notice: the chat showed a
 * blank answer instead of "could not start the turn".
 *
 * Driven through the real chat route with a provider whose send rejects.
 *
 * @covers CHAT-FAIL-01
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { flushTurnBody } from "../../server/lib/turn-body-flush";
import type { AIProvider } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-failed-turn-flush-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

async function failedTurn(sessionKey: string): Promise<AppContext> {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  ctx.saveSingleTopic({
    id: `t-${sessionKey}`, name: "failed", slug: "failed", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "claude-code",
  } as Topic);

  const provider = {
    name: "claude-code",
    capabilities: new Set(["streaming"]),
    contextStrategy: "inline-system",
    get connected() { return true; },
    registerStreamHandler: () => {},
    unregisterStreamHandler: () => {},
    // Rejected after the route has built the turn, as a CLI that dies at spawn.
    sendChat: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("spawn failed")), 10)),
    defaultModel: () => "claude-opus-5",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;

  const chatRouter = createChatRouter(ctx, {
    resolveProvider: () => provider,
    resolveProviderByName: () => provider,
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: () => {},
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: testTmpDir("chat-failed-turn-flush-ws"),
  } as never);

  const url = new URL("http://topics.test/api/chat");
  const resp = (await chatRouter(new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "hello" }], provider: "claude-code" }),
  }), url, "/api/chat", "POST")) as Response | null;
  expect(resp?.status).toBe(200);
  // The failure path writes its message, [DONE], and closes the stream.
  await resp!.text();
  return ctx;
}

describe("a turn that could not start", () => {
  test("its notice survives the next reader of the chat", async () => {
    const sessionKey = "topic:failflush";
    const ctx = await failedTurn(sessionKey);
    const lastAssistant = () => ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant").pop();
    const before = lastAssistant();
    expect(before?.content).toContain("spawn failed");

    // What GET /api/history does before it reads the rows.
    expect(flushTurnBody(sessionKey), "the failed turn left no writer behind").toBe(false);
    expect(lastAssistant()?.content).toBe(before?.content);
    expect(lastAssistant()?.blocks).toEqual(before?.blocks);
  });
});

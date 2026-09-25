/**
 * A TURN THAT FAILS KEEPS BOTH ITS WORK AND ITS NOTICE, WHOEVER READS THE CHAT
 * AFTERWARDS.
 *
 * A reader of a live turn's row (the history route, a catch-up, the outbound
 * gate) calls `flushTurnBody`, and the turn's writer registers that flush when
 * it is built. The paths that close a turn on a failure wrote the notice and
 * left the flush registered. Once the flush wrote the whole body, the next
 * reader of the session wrote the turn's body over the notice: the chat
 * showed a blank answer instead of "could not start the turn".
 *
 * Taking the writer down is not enough on its own: a `sendChat` that rejects
 * LATE has work the throttle still owes (a tool result, the text since the
 * last periodic save). That work is written first, then the verdict is added.
 *
 * Driven through the real chat route with a provider whose send rejects.
 *
 * @covers CHAT-FAIL-01
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { flushTurnBody } from "../../server/lib/turn-body-flush";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, StoredMessage, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-failed-turn-flush-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

/**
 * One turn through the chat route, with a provider whose send rejects after
 * `drive` has played what the CLI did before dying.
 */
async function failedTurn(sessionKey: string, drive: (handler: StreamHandler | undefined) => void): Promise<AppContext> {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  ctx.saveSingleTopic({
    id: `t-${sessionKey}`, name: "failed", slug: "failed", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "claude-code",
  } as Topic);

  let handler: StreamHandler | undefined;
  const provider = {
    name: "claude-code",
    capabilities: new Set(["streaming"]),
    contextStrategy: "inline-system",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _runId: unknown, h: StreamHandler) => { handler = h; },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise((_resolve, reject) => setTimeout(() => {
      drive(handler);
      setTimeout(() => reject(new Error("CLI died")), 20);
    }, 10)),
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

const lastAssistant = (ctx: AppContext, sessionKey: string): StoredMessage | undefined =>
  ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant").pop();

const kinds = (row: StoredMessage | undefined): string[] =>
  (row?.blocks ?? []).map((b) => (b.kind === "tool" ? `tool:${b.toolCall.status}` : b.kind));

describe("a turn that fails", () => {
  test("before doing anything: its notice survives the next reader of the chat", async () => {
    const sessionKey = "topic:failflush";
    const ctx = await failedTurn(sessionKey, () => {});
    const before = lastAssistant(ctx, sessionKey);
    expect(before?.content).toContain("CLI died");

    // What GET /api/history does before it reads the rows.
    expect(flushTurnBody(sessionKey), "the failed turn left no writer behind").toBe(false);
    expect(lastAssistant(ctx, sessionKey)?.content).toBe(before?.content);
    expect(lastAssistant(ctx, sessionKey)?.blocks).toEqual(before?.blocks);
  });

  test("after real work: the row keeps the tool and the text, and adds the verdict", async () => {
    const sessionKey = "topic:failwork";
    const ctx = await failedTurn(sessionKey, (h) => {
      h!.onToolStart("tool-aaaaaaaa", "Bash", { command: "ls" });
      // A small patch after the first write: the throttle defers it.
      h!.onToolResult("tool-aaaaaaaa", "ok", false);
      // Below the periodic text save: nothing asks for a write.
      for (let i = 1; i <= 5; i++) h!.onTextDelta(`c-${i} `, "");
    });
    // Past the throttle's shortest delay: a write left pending by the failure
    // would land now, over the verdict.
    await new Promise((r) => setTimeout(r, 1_200));
    const row = lastAssistant(ctx, sessionKey);
    expect(kinds(row)).toEqual(["tool:success", "text", "error"]);
    expect(row?.blocks?.find((b) => b.kind === "text")).toMatchObject({ text: "c-1 c-2 c-3 c-4 c-5 " });
    expect(flushTurnBody(sessionKey)).toBe(false);
  });
});

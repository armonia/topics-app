/**
 * TWO ENDS OF A TURN THE PROVIDER CUT SHORT, AS THE CHAT ROUTE SEES THEM.
 * @covers CCLI-01 CCLI-03
 *
 * Found by adversarial review of the claude-code kill and queue fixes (chat
 * 3019832f, 2026-09-24), on the harness of `chat.turn-end-hook.test.ts`:
 *
 *  - `/clear` in the middle of a turn deletes the rows, then kills the child,
 *    and the killed turn now ends at once (it used to hang until the watchdog).
 *    Its `finalizeStream` runs after the `clear` frame, and a `message:new` for
 *    a row the database no longer has put the deleted text back in the sidebar
 *    preview and in every other open window.
 *  - A send stopped while it waited in the provider's queue never reached the
 *    model, but the route had already marked its inline context as sent: the
 *    next message left out blocks the session never received.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";
import { getInlineSentState, inlineScope } from "../context/inline-sent-state";
import { cancelled } from "../providers/stop-reason";

const ROOT = testTmpDir("chat-killed-turn");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const WS = testTmpDir("chat-killed-turn-ws");

async function harness(sendResult: () => Promise<{ runId?: string; notSent?: boolean }>) {
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: "claude-code",
    capabilities: new Set(["streaming"]),
    // The CLI keeps the conversation itself, so the route sends the context
    // inline and remembers what it sent: the marks under test.
    contextStrategy: "inline-system",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    sendChat: () => sendResult(),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;

  const chatRouter = createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: () => {},
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: WS,
  } as never);

  const startTurn = async (sessionKey: string): Promise<StreamHandler> => {
    const topic: Topic = {
      id: `t-${sessionKey}`, name: "killed", slug: "killed", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "claude-code",
      systemPrompt: "You are the killed-turn test topic.",
    } as Topic;
    ctx.saveSingleTopic(topic);
    captured = undefined;
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "hello" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  return { ctx: ctx as AppContext, frames, startTurn };
}

const settle = () => Bun.sleep(80);
const never = () => new Promise<{ runId?: string }>(() => {});

describe("a turn the provider cut short, in the chat route", () => {
  test("a turn whose row /clear deleted ends without announcing that row", async () => {
    const h = await harness(never);
    const sk = "topic:killed-by-clear";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("half an answer", "half an answer");

    // `/clear`: the rows go first, then the provider ends the killed turn.
    h.ctx.saveLocalMessages(sk, []);
    handler.onAborted?.({ turnEnd: cancelled("user") });
    await settle();

    expect(h.frames.filter((f) => f.type === "message:new" && f.role === "assistant" && f.sessionKey === sk)).toEqual([]);
    // The stream itself still ends, or the chat would show it running.
    expect(h.frames.some((f) => f.type === "stream:end" && f.sessionKey === sk)).toBe(true);
    expect(h.ctx.loadLocalMessages(sk)).toEqual([]);
  });

  test("a send stopped in the provider's queue takes back its inline context marks", async () => {
    const scope = inlineScope(null, 0);

    // Control: a send that reached the model keeps its marks, so the next
    // message does not repeat the context. Without this the test below would
    // pass on a route that never marks anything.
    const sent = await harness(never);
    await sent.startTurn("topic:queued-sent");
    await settle();
    expect(getInlineSentState("topic:queued-sent", scope).size).toBeGreaterThan(0);

    const stopped = await harness(async () => ({ runId: undefined, notSent: true }));
    await stopped.startTurn("topic:queued-not-sent");
    await settle();
    expect(getInlineSentState("topic:queued-not-sent", scope).size).toBe(0);
  });
});

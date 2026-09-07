/**
 * THE ROUTE EXECUTES ONLY THE CONTROL TOOLS THE ROUTE REGISTERED.  @covers CTRLTOOL-02
 *
 * `sendOptions.tools` hands `open_project` and its four siblings to the
 * passthrough providers alone; every other runtime owns the same five names
 * through the MCP table and runs them itself. When the route dispatched them
 * for everybody, the native runtime executed the call and the route executed
 * it a second time, with the empty argument object its announcement carries
 * (`onToolStart(id, name, {})`) - so a call that had succeeded was painted
 * over with "'topic_id' (string) is required".
 *
 * Three things are proven on the chat harness: a passthrough provider still
 * gets its side effect and its success result; the native runtime gets
 * neither; and the empty-argument announcement of the native runtime produces
 * no error result at all.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { Topic } from "../types";

const ROOT = testTmpDir("chat-control-tool-dispatch");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const WS = testTmpDir("chat-control-tool-dispatch-ws");
const PROJECT_DIR = `${WS}/known-project`;

interface Harness {
  frames: Array<Record<string, unknown>>;
  resolved: string[];
  bound: Array<{ topicId: string; dir: string }>;
  startTurn: (sessionKey: string) => Promise<StreamHandler>;
}

async function harness(providerName: string): Promise<Harness> {
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: providerName,
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;

  const resolved: string[] = [];
  const bound: Array<{ topicId: string; dir: string }> = [];
  const chatRouter = createChatRouter(ctx, {
    resolveProvider: () => provider,
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: (topicId: string, dir: string) => { bound.push({ topicId, dir }); return true; },
    resolveProjectRef: (ref: string) => { resolved.push(ref); return ref === "known-project" ? PROJECT_DIR : null; },
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
      id: `t-${sessionKey}`, name: "control", slug: "control", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: providerName,
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

  return { frames, resolved, bound, startTurn };
}

const settle = () => Bun.sleep(80);

/**
 * Close the turn before the test ends, tool included. A stream left open keeps
 * its timers and its deferred row writer alive for the whole process, and bun
 * runs several test files in one process: the next file then measures this
 * one's leftovers, against a database this file has already closed.
 */
async function endTurn(handler: StreamHandler, toolCallId: string): Promise<void> {
  handler.onToolResult(toolCallId, "done");
  handler.onDone({ result: "", turnEnd: { end: "end_turn" } });
  await settle();
}
const toolResults = (h: Harness) => h.frames.filter((f) => f.type === "stream:tool_result");

describe("control tools in the chat route", () => {
  test("a passthrough provider: the route runs the tool and reports the success", async () => {
    const h = await harness("claude");
    const handler = await h.startTurn("topic:control-passthrough");
    handler.onToolStart("call-1", "open_project", { ref: "known-project" });
    await settle();

    const results = toolResults(h);
    await endTurn(handler, "call-1");

    expect(h.resolved).toEqual(["known-project"]);
    expect(h.bound).toEqual([{ topicId: "t-topic:control-passthrough", dir: PROJECT_DIR }]);
    expect(results).toMatchObject([{ toolCallId: "call-1", status: "success" }]);
  });

  test("the native runtime already ran it: the route stays out", async () => {
    const h = await harness("topics");
    const handler = await h.startTurn("topic:control-native");
    handler.onToolStart("call-2", "open_project", { ref: "known-project" });
    await settle();

    const results = toolResults(h);
    await endTurn(handler, "call-2");

    expect(h.resolved).toEqual([]);
    expect(h.bound).toEqual([]);
    expect(results).toEqual([]);
  });

  test("the empty-argument announcement of the native runtime raises no error result", async () => {
    const h = await harness("topics");
    const handler = await h.startTurn("topic:control-native-empty");
    handler.onToolStart("call-3", "switch_topic", {});
    await settle();

    const results = toolResults(h);
    await endTurn(handler, "call-3");

    expect(results).toEqual([]);
  });
});

/**
 * THE ROUTE DOES NOT RE-RUN THE BROWSER TOOLS THE RUNTIME ALREADY RAN.
 * @covers BROWSER-CHAT-04
 *
 * The chat route dispatches `browser_*` server-side for the providers whose
 * tool surface IT registered (the passthrough ones: `claude`, `openai`). The
 * native runtime carries the same tools in-process and executes them itself,
 * and it announces a call at `content_block_start` -- when the arguments have
 * not been streamed yet, so the copy the route sees has EMPTY args.
 *
 * Measured here on the real route, driving the same `onToolStart(id, name, {})`
 * the native agent loop emits: without the guard four browser calls in a turn
 * become four extra touches on the BrowserService with `{}`; with it, zero,
 * while `claude` keeps dispatching all four.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { BrowserService } from "../browser-service";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { Topic } from "../types";
import { nativeDelegateRegistry } from "../browser-native-delegate";
import { resolveContextIdForTopic } from "../browser-tool-dispatcher";

const ROOT = testTmpDir("chat-browser-dispatch");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const WS = testTmpDir("chat-browser-dispatch-ws");

/**
 * A BrowserService that only remembers being touched. Every dispatch labels the
 * in-flight action on the service first (`setAgentAction`), so ONE touch = one
 * call the route decided to execute. What a handler reaches for afterwards is
 * the same call going deeper -- counting that too would measure the handlers
 * instead of the route -- so those reaches only fail, which is what a call with
 * no arguments deserves.
 */
function recordingBrowserService(touches: string[]): BrowserService {
  const known = {
    setAgentAction: (_contextId: string, _label: string) => { touches.push("dispatch"); },
  };
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return (..._args: unknown[]) => {
        throw new Error(`browser service not wired in this test: ${prop}`);
      };
    },
  }) as unknown as BrowserService;
}

interface Harness {
  touches: string[];
  topic: Topic;
  /** Every frame the route sent to the topic's subscribers. */
  frames: Array<Record<string, unknown>>;
  /** Opens a turn and hands back the route's StreamHandler. */
  startTurn: () => Promise<StreamHandler>;
  announceBrowserTools: () => Promise<void>;
  toolRows: () => Array<{ name: string; status: string }>;
}

async function harness(providerName: string, label = providerName): Promise<Harness> {
  // One session key per harness: they share the test database, and
  // `session_key` is unique on `topics`.
  const sessionKey = `topic:browser-dispatch-${label}`;
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
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

  const touches: string[] = [];
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
  } as never, recordingBrowserService(touches));

  const topic: Topic = {
    id: `t-${label}`, name: "browser", slug: "browser", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: providerName,
  } as Topic;
  ctx.saveSingleTopic(topic);

  const startTurn = async () => {
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "open a page" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  const announceBrowserTools = async () => {
    const captured = await startTurn();
    // Exactly what `native/agent-loop.ts` emits at `content_block_start`: the
    // name, and no arguments yet.
    captured.onToolStart("call-1", "browser_open", {});
    captured.onToolStart("call-2", "browser_observe", {});
    captured.onToolStart("call-3", "browser_act", {});
    captured.onToolStart("call-4", "browser_get_text", {});
    await Bun.sleep(80);
    // CLOSE THE TURN. The route persists a turn's blocks through a throttle
    // that defers writes by at least a second; a turn left open keeps that
    // timer pending, it fires after this file has closed its database, and the
    // SQLite error lands on whatever test file happened to run next (measured
    // 2026-09-07: two different real-git files went red in two pre-review
    // rounds, neither of them touched by this card). `onDone` is what a real
    // turn ends with, and it flushes and disposes.
    captured.onDone();
    await Bun.sleep(50);
  };

  const toolRows = () =>
    (ctx.loadLocalMessages(sessionKey) ?? [])
      .flatMap((m) => m.toolCalls ?? [])
      .map((t) => ({ name: t.name, status: String(t.status) }));

  return { touches, topic, frames, startTurn, announceBrowserTools, toolRows };
}

describe("server-side dispatch of browser_* in the chat route", () => {
  test("the native runtime runs them itself: the route touches the BrowserService zero times", async () => {
    const h = await harness("topics");
    await h.announceBrowserTools();

    expect(h.touches).toEqual([]);
    // The calls are still ANNOUNCED: what the guard removes is the second
    // execution, not the four rows the user sees.
    expect(h.toolRows().map((t) => t.name)).toEqual([
      "browser_open", "browser_observe", "browser_act", "browser_get_text",
    ]);
  });

  test("a passthrough provider keeps dispatching: the route registered those tools, so it runs them", async () => {
    const h = await harness("claude");
    await h.announceBrowserTools();

    expect(h.touches).toHaveLength(4);
  });
});

/**
 * The detail of a routed `browser_open` is read back from its RESULT
 * (CHAT-BROWSER-01, BROWSER-CHAT-05). The start-time detail only knows the
 * requested URL: the marker needs the final one, the title and the context, and
 * a failed opening must not draw one at all. On a Tauri pane the failure comes
 * back RESOLVED as `{error}` (the native delegate never throws), so the result
 * is the only place that says it.
 */
describe("the routed browser_open re-derives its detail from the result", () => {
  async function openThroughNativePane(label: string, reply: { result?: unknown; error?: string }) {
    const h = await harness("claude", label);
    const contextId = resolveContextIdForTopic(h.topic);
    nativeDelegateRegistry.register(contextId, (m) => {
      queueMicrotask(() => nativeDelegateRegistry.resolveOp({ opId: m.opId, ...reply }));
    });
    try {
      const handler = await h.startTurn();
      handler.onToolStart("call-open", "browser_open", { url: "https://example.com" });
      await Bun.sleep(80);
      handler.onDone();
      await Bun.sleep(50);
    } finally {
      nativeDelegateRegistry.unregister(contextId);
    }
    const result = h.frames.find((f) => f.type === "stream:tool_result" && f.toolCallId === "call-open");
    if (!result) throw new Error("the route sent no stream:tool_result for browser_open");
    return { contextId, result };
  }

  test("a success carries the final URL, the title and the context", async () => {
    const { contextId, result } = await openThroughNativePane("open-ok", {
      result: { url: "https://example.com/final", title: "Example" },
    });
    expect(result.status).toBe("success");
    expect(result.detail).toMatchObject({ type: "browser", url: "https://example.com/final", title: "Example", contextId });
  });

  test("an {error} that resolved instead of throwing is not an opening", async () => {
    const { result } = await openThroughNativePane("open-fail", { error: "goto: net::ERR_CONNECTION_REFUSED" });
    expect((result.detail as { type?: string } | undefined)?.type).toBe("mcp");
  });
});

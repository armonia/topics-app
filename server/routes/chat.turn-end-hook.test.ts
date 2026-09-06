/**
 * THE TURN-END HOOK IS READ IN CHAT AND NEVER HOLDS THE TURN.  @covers HOOKS-02
 *
 * The route fires the user's `turn-end` hook in the same deferred slot as the
 * goal loop, after the stream is finalised. Three things are proven on the
 * `chat.cut-turn-notice` harness: a refusing hook becomes one more assistant
 * row plus the two broadcasts the system-message verb sends; a provider that
 * is not the native runtime never triggers it; and a hook that has not
 * answered yet does not keep the assistant row partial, which is the
 * "SHALL NEVER block" of the spec measured on the row.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";
import type { LifecycleHookPayload, HookOutcome } from "../services/lifecycle-hooks";

const ROOT = testTmpDir("chat-turn-end-hook");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const WS = testTmpDir("chat-turn-end-hook-ws");

interface Harness {
  frames: Array<Record<string, unknown>>;
  seen: Array<[string, LifecycleHookPayload]>;
  startTurn: (sessionKey: string) => Promise<StreamHandler>;
  assistantRows: (sessionKey: string) => Array<{ content: string; partial: boolean }>;
}

async function harness(opts: { providerName: string; answer: () => Promise<HookOutcome> }): Promise<Harness> {
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: opts.providerName,
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

  const seen: Array<[string, LifecycleHookPayload]> = [];
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
    hooks: { run: (event: string, payload: LifecycleHookPayload) => { seen.push([event, payload]); return opts.answer(); } },
  } as never);

  const startTurn = async (sessionKey: string): Promise<StreamHandler> => {
    const topic: Topic = {
      id: `t-${sessionKey}`, name: "hook", slug: "hook", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: opts.providerName,
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

  const assistantRows = (sessionKey: string) =>
    (ctx as AppContext).loadLocalMessages(sessionKey)
      .filter((m) => m.role === "assistant")
      .map((m) => ({ content: m.content, partial: m.partial === true }));

  return { frames, seen, startTurn, assistantRows };
}

const settle = () => Bun.sleep(80);

describe("the turn-end hook in the chat route", () => {
  test("a refusing hook: its stderr is one more assistant row, broadcast like a system message", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: false, reason: "tests are red, fix them first" }) });
    const sk = "topic:turn-end-refused";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]![0]).toBe("turn-end");
    expect(h.seen[0]![1]).toEqual({ hook_event_name: "turn-end", session_id: sk, cwd: WS });

    const rows = h.assistantRows(sk);
    expect(rows.map((r) => r.content)).toEqual(["done", "tests are red, fix them first"]);
    expect(rows.every((r) => !r.partial)).toBe(true);
    const wire = h.frames.find((f) => f.type === "message:new" && f.content === "tests are red, fix them first");
    expect(wire).toMatchObject({ sessionKey: sk, role: "assistant", topicId: `t-${sk}` });
    expect(h.frames.some((f) => f.type === "message" && (f.message as { content?: string })?.content === "tests are red, fix them first")).toBe(true);
  });

  test("a hook that exits zero changes nothing", async () => {
    const h = await harness({ providerName: "topics", answer: async () => ({ ok: true }) });
    const sk = "topic:turn-end-silent";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();
    expect(h.seen).toHaveLength(1);
    expect(h.assistantRows(sk).map((r) => r.content)).toEqual(["done"]);
  });

  test("a provider that is not the native runtime never fires it", async () => {
    const h = await harness({ providerName: "fake-stream", answer: async () => ({ ok: false, reason: "never read" }) });
    const sk = "topic:turn-end-other-provider";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();
    expect(h.seen).toEqual([]);
    expect(h.assistantRows(sk).map((r) => r.content)).toEqual(["done"]);
  });

  test("a hook that has not answered does not hold the turn: the row is final before the verdict", async () => {
    let release: (v: HookOutcome) => void = () => {};
    const pending = new Promise<HookOutcome>((r) => { release = r; });
    const h = await harness({ providerName: "topics", answer: () => pending });
    const sk = "topic:turn-end-slow";
    const handler = await h.startTurn(sk);
    handler.onTextDelta("done", "done");
    handler.onDone({ result: "done", turnEnd: { end: "end_turn" } });
    await settle();

    // The hook was asked and is still running: the turn is already over.
    expect(h.seen).toHaveLength(1);
    const rows = h.assistantRows(sk);
    expect(rows).toEqual([{ content: "done", partial: false }]);
    expect(h.frames.some((f) => f.type === "stream:end")).toBe(true);

    release({ ok: false, reason: "late verdict" });
    await settle();
    expect(h.assistantRows(sk).map((r) => r.content)).toEqual(["done", "late verdict"]);
  });
});

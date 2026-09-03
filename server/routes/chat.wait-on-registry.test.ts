/**
 * THE WAIT A TURN IS IN MUST SURVIVE FOR WHOEVER ATTACHES LATER.
 *
 * `stream:retry` and `stream:slow` are broadcast ONCE, when the wait starts.
 * A client that attaches after that instant (topic reopened, tab switched
 * back, WS reconnect after a server hot-reload) is served from
 * `activeStreams`, whose entry knew nothing about the wait: reopen the topic
 * during a 30 s backoff and the app said "elaborando" with a moving ring,
 * which is exactly the hung-chat reading those two frames exist to prevent.
 *
 * The wait now lives on the registry entry the `stream:catchup` frame is
 * built from (`ActiveStream.retry` / `.slow`), and clears where
 * `stream:resumed` goes out. Proven on the real `POST /api/chat` with a fake
 * provider driven from the handler, reading the real registry; the frame's
 * shape is pinned in `tests/unit/ws-outbound-*.test.ts`.
 * @covers CHAT-REL-03
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-wait-on-registry");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

/** The route's soft inactivity timeout, as armed in `routes/chat.ts`. */
const STREAM_TIMEOUT_MS = 60_000;

interface Harness {
  ctx: AppContext;
  /** Every frame the route broadcast, in order. */
  frames: Array<Record<string, unknown>>;
  /** Send a first message on a fresh topic and return the route's StreamHandler. */
  startTurn: (sessionKey: string) => Promise<StreamHandler>;
  /** The assistant rows of a session, as the DB holds them. */
  assistantRows: (sessionKey: string) => Array<{ content: string; partial: boolean; blocks: Array<{ kind: string; text?: string }> }>;
}

async function harness(): Promise<Harness> {
  const ctx = await createTestAppContext();
  const frames: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    // Stays pending: the turn is driven from the handler, the way a real
    // provider drives it from inside its own loop.
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
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
    WORKSPACE_DIR: testTmpDir("chat-wait-on-registry-ws"),
  } as never);

  const startTurn = async (sessionKey: string): Promise<StreamHandler> => {
    const topic: Topic = {
      id: `t-${sessionKey}`, name: "cut", slug: "cut", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "openai",
    } as Topic;
    ctx.saveSingleTopic(topic);

    captured = undefined;
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "write the whole document" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    // Do NOT read the SSE body: draining it would block until `[DONE]`.
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  const assistantRows = (sessionKey: string) =>
    ctx.loadLocalMessages(sessionKey)
      .filter((m) => m.role === "assistant")
      .map((m) => ({ content: m.content, partial: m.partial === true, blocks: (m.blocks ?? []) as Array<{ kind: string; text?: string }> }));

  return { ctx, frames, startTurn, assistantRows };
}

/** The finalization is asynchronous (writes, then closes the SSE). */
const settle = () => Bun.sleep(80);

describe("the wait a turn is in survives on the registry entry", () => {
  test("onRetry writes it, the next provider event clears it", async () => {
    const h = await harness();
    const sk = "topic:wait-retry";
    const handler = await h.startTurn(sk);
    expect(h.ctx.activeStreams.get(sk)?.retry).toBeUndefined();

    const before = Date.now();
    handler.onRetry!({ attempt: 1, maxAttempts: 10, delayMs: 30_000, reason: "API 529" });

    const waiting = h.ctx.activeStreams.get(sk)?.retry;
    expect(waiting).toMatchObject({ attempt: 1, maxAttempts: 10, delayMs: 30_000, reason: "API 529" });
    expect(waiting!.at).toBeGreaterThanOrEqual(before);
    expect(waiting!.at).toBeLessThanOrEqual(Date.now());

    // The API came back: the catchup must stop saying "waiting".
    handler.onTextDelta("ok", "ok");
    expect(h.ctx.activeStreams.get(sk)?.retry).toBeUndefined();
    expect(h.frames.some((f) => f.type === "stream:resumed")).toBe(true);

    handler.onDone({ result: "ok", turnEnd: { end: "end_turn" } });
    await settle();
  });

  test("the soft timeout writes `slow`, recovery clears it", async () => {
    // Capture the route's own soft timer instead of waiting a minute for it:
    // the callback is the real `handleSoftTimeout`, fired by hand.
    const realSetTimeout = globalThis.setTimeout;
    const softTimers: Array<() => void> = [];
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === STREAM_TIMEOUT_MS && (new Error().stack ?? "").includes("routes/chat.ts")) {
        softTimers.push(() => fn(...args));
      }
      return realSetTimeout(fn, ms as number, ...args);
    }) as unknown as typeof globalThis.setTimeout;
    try {
      const h = await harness();
      const sk = "topic:wait-slow";
      const handler = await h.startTurn(sk);
      expect(h.ctx.activeStreams.get(sk)?.slow).toBeUndefined();
      // Armed at START, so a turn that never emits anything is watched too.
      expect(softTimers.length).toBeGreaterThan(0);

      softTimers[softTimers.length - 1]!();
      expect(h.ctx.activeStreams.get(sk)?.slow).toBe(true);
      expect(h.frames.some((f) => f.type === "stream:slow")).toBe(true);

      handler.onTextDelta("eccomi", "eccomi");
      expect(h.ctx.activeStreams.get(sk)?.slow).toBeUndefined();
      expect(h.frames.some((f) => f.type === "stream:resumed")).toBe(true);

      handler.onDone({ result: "eccomi", turnEnd: { end: "end_turn" } });
      await settle();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

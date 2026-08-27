/**
 * SUSPECT (B): the soft / grace / hard timers of `POST /api/chat`.
 *
 * The route arms three layered `setTimeout` handles per turn (server/routes/
 * chat.ts): SOFT re-armed on every provider event, GRACE armed when SOFT
 * fires, HARD armed once at stream start and never reset. A turn that ends
 * without cancelling them leaves up to three live handles per turn, each one
 * holding the whole stream closure alive - `fullContent`, `blocks`,
 * `partialMsg`, the SSE writer. Thirty minutes of a busy server is a lot of
 * turns.
 *
 * WHAT IS MEASURED, and it is a counter and not a reading of the code: every
 * `setTimeout` created while the probe is installed is recorded with the stack
 * that created it, and dropped again when it is cleared OR when it fires. The
 * counter is "pending handles whose creation stack points at
 * `server/routes/chat.ts`". Baseline before the turns, same number after.
 *
 * THIS DRIVES THE REAL ROUTE. `createChatRouter(ctx, ...)` is the production
 * factory, `POST /api/chat` is the production path, and the turns end through
 * the four exits a real turn has:
 *
 *   - normal end     -> `handler.onDone(...)`     -> finalizeStream("done")
 *   - provider abort -> `handler.onAborted(...)`  -> finalizeStream("aborted")
 *   - provider error -> `handler.onError(...)`    -> finalizeStream("error")
 *   - Stop button    -> `stream.abortController.abort()`, which is the exact
 *                       call `/api/chat/abort` makes (server/routes/topics.ts,
 *                       "Abort the gateway request") and which fires the
 *                       `externalAbort` listener inside chat.ts. The route
 *                       itself is not called only because it resolves its
 *                       provider from the global registry, and mutating that
 *                       registry from here would reach every other test file
 *                       in the same bun process.
 *
 * The fake provider is the one `chat-stream-abort.test.ts` already uses: it
 * hands back the `StreamHandler` the route registers, which is how a real
 * provider drives a turn from inside its own `for await`.
 *
 * @covers LEAK-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

/** The one line an aggregator parses. Same shape in all three leak measurements. */
function leakCounterLine(suspect: string, counter: string, before: number, after: number, cycles: number): void {
  const verdict = after === before ? "ok" : "LEAK";
  console.log(`LEAK-COUNTER ${suspect} | ${counter} | before=${before} after=${after} cycles=${cycles} | ${verdict}`);
}

const ROOT = testTmpDir("leak-stream-timers");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

/** One full turn per cycle, over the four end paths above. */
const CYCLES = 24;

/** The file whose timers we are counting. */
const OWNER = "server/routes/chat.ts";

interface TimerProbe {
  /** Pending handles created from OWNER right now. */
  count: () => number;
  /**
   * Wait until every FIRE-AND-FORGET timer has fired. `finalizeStream` arms
   * two on purpose (a 1 s media rescan, a 500 ms project auto-bind): they are
   * not leaks, they are deferred work, and nobody clears them because they
   * clear themselves by running. Polling for them beats sleeping for a fixed
   * duration, which would either be flaky or slow.
   */
  settle: (target: number) => Promise<void>;
  restore: () => void;
}

function installTimerProbe(): TimerProbe {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  /** handle -> creation stack. Deleted on clear AND on fire. */
  const pending = new Map<unknown, string>();

  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const stack = new Error().stack ?? "";
    let handle: unknown;
    handle = realSetTimeout(
      () => {
        pending.delete(handle);
        (fn as (...a: unknown[]) => void)(...args);
      },
      ms as number,
    );
    pending.set(handle, stack);
    return handle;
  }) as unknown as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle: unknown) => {
    if (handle !== undefined && handle !== null) pending.delete(handle);
    return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
  }) as unknown as typeof globalThis.clearTimeout;

  const count = () => {
    let n = 0;
    for (const stack of pending.values()) if (stack.includes(OWNER)) n++;
    return n;
  };

  return {
    count,
    settle: async (target: number) => {
      // 6 s ceiling: the longest deferred timer the route arms is 1 s, so this
      // is 6x headroom and still nowhere near the 30 s suite timeout. Poll on
      // the REAL setTimeout, or the probe would be measuring itself.
      for (let i = 0; i < 120 && count() > target; i++) {
        await new Promise((r) => realSetTimeout(r, 50));
      }
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

interface Harness {
  ctx: AppContext;
  /** Send a first message on a fresh topic and return the route's StreamHandler. */
  startTurn: (sessionKey: string) => Promise<StreamHandler>;
  /** The Stop button's own line, fired on the stream the route registered. */
  externalAbort: (sessionKey: string) => void;
}

async function harness(): Promise<Harness> {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = () => {};

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
    WORKSPACE_DIR: testTmpDir("leak-stream-timers-ws"),
  } as never);

  const startTurn = async (sessionKey: string): Promise<StreamHandler> => {
    const topic: Topic = {
      id: `t-${sessionKey}`, name: "leak", slug: "leak", parentId: null, links: [],
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
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "write something" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    // Do NOT read the SSE body: draining it would block until `[DONE]`, which
    // only arrives once the turn is over.
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  const externalAbort = (sessionKey: string) => {
    const stream = ctx.activeStreams.get(sessionKey);
    if (!stream?.abortController) throw new Error(`no abortable stream for ${sessionKey}`);
    stream.abortController.abort();
  };

  return { ctx, startTurn, externalAbort };
}

describe("suspect (B): the stream timers of POST /api/chat", () => {
  test(`${CYCLES} turns over all four end paths leave no pending timer`, async () => {
    const probe = installTimerProbe();
    try {
      const h = await harness();
      const before = probe.count();

      for (let i = 0; i < CYCLES; i++) {
        const sessionKey = `topic:leak-timers-${i}`;
        const handler = await h.startTurn(sessionKey);

        // THE PROBE MUST BE ABLE TO SEE. A stack filter that matched nothing
        // would report before=0 after=0 forever and call a leaking route
        // clean, so the live turn has to show up in the count first: chat.ts
        // arms SOFT and HARD at stream start, so mid-turn is never zero.
        expect(probe.count()).toBeGreaterThanOrEqual(2);

        // Traffic that exercises the SOFT timer's arm / suspend / re-arm path:
        // a tool start suspends it (a turn waiting on a tool is not silent),
        // the result re-arms it. That is the only place a chat.ts timer is
        // replaced mid-turn, so it is the one that can strand a handle.
        let cumulative = "";
        for (const delta of ["thinking ", "about ", "it "]) {
          cumulative += delta;
          handler.onTextDelta(delta, cumulative);
        }
        handler.onToolStart(`tc-${i}`, "Bash", { command: "true" } as never);
        handler.onToolResult(`tc-${i}`, "ok");
        cumulative += "done";
        handler.onTextDelta("done", cumulative);

        switch (i % 4) {
          case 0:
            handler.onDone?.({ turnEnd: { end: "end_turn" } } as never);
            break;
          case 1:
            handler.onAborted?.({ result: cumulative, turnEnd: { end: "cancelled", cause: "user" } } as never);
            break;
          case 2:
            handler.onError?.("provider exploded");
            break;
          default:
            h.externalAbort(sessionKey);
            break;
        }
      }

      // Let the deferred (self-clearing) timers run out before counting.
      await probe.settle(before);
      const after = probe.count();

      leakCounterLine("stream-timers", "chat.ts pending setTimeout handles", before, after, CYCLES);
      expect(after).toBe(before);
    } finally {
      probe.restore();
    }
  }, 25_000);
});

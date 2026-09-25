/**
 * THE CHAT'S SSE STREAM OUTLIVES A SILENT TOOL, AND SAYS WHICH TURN IT IS.
 * @covers CHAT-STREAM-01, CHAT-INT-01
 *
 * Measured on 2026-09-24 (chat 3019832f): a Bash with a 300 s timeout started
 * at 23:35:30Z, and the SSE response of POST /api/chat closed at 23:39:45Z,
 * 255 s later to the second, with HTTP 200 and no `data: [DONE]`. The turn went
 * on (re-attached at 23:40:23Z). 255 is Bun's `idleTimeout` (server.ts), and
 * `send_chat_message` read that close as the end of the turn.
 *
 * Bun resets the idle timeout on every write, so a ping holds the stream open.
 * Its socket timers tick every 4 s, and any timeout up to 4 s is one tick that
 * no write can stretch: the proof below runs at 8 s, where a write counts.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { createTopicsRouter } from "./topics";
import { callSendChatMessage } from "../mcp/topics-mcp-server";
import { armStallDetector } from "../lib/stall-detector";
import { isSseCommentOnly } from "../lib/sse-ping";
import { cancelled } from "../providers/stop-reason";
import { recordTurnEnd } from "../providers/turn-end-registry";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("chat-sse-ping");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Reads a response to the end, keeping what arrived before a reset. */
async function readAll(resp: Response): Promise<{ body: string; cut: boolean }> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { body, cut: false };
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return { body, cut: true };
  }
}

function saveTopic(ctx: AppContext, id: string): string {
  const sessionKey = `topic:${id}`;
  ctx.saveSingleTopic({
    id, name: id, slug: id, parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archived: false, provider: "claude-code",
  } as unknown as Topic);
  return sessionKey;
}

/**
 * A provider whose turn starts a tool that prints nothing. With `silentMs` the
 * tool ends and the answer follows; without it the turn stays silent until the
 * test drives the handler.
 */
function silentToolProvider(silentMs?: number) {
  const handlers = new Map<string, StreamHandler>();
  const provider = {
    name: "claude-code",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: () => {},
    unregisterStreamHandler: () => {},
    sendChat: async (sk: string, _msg: string, h: StreamHandler) => {
      handlers.set(sk, h);
      h.onToolStart("toolu_silent", "Bash", { command: "sleep 300" });
      if (silentMs !== undefined) {
        void Bun.sleep(silentMs).then(() => {
          h.onToolResult("toolu_silent", "done", false);
          h.onTextDelta("finished", "finished");
          h.onDone(undefined as never);
        });
      }
      return { runId: "run-1" };
    },
    defaultModel: () => "fake-model",
    abort: async () => {},
    isTurnProcessAlive: () => true,
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  return { provider, handlers };
}

function chatRouterFor(ctx: AppContext, provider: AIProvider, ssePingMs: number) {
  return createChatRouter(ctx, {
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
    WORKSPACE_DIR: ROOT,
    ssePingMs,
  } as never);
}

function chatRequest(sessionKey: string, base = "http://localhost"): Request {
  return new Request(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "run the long command" }] }),
  });
}

/** POST /api/chat in the same process, the way the board's headless turns call it. */
async function postInProcess(router: ReturnType<typeof createChatRouter>, sessionKey: string): Promise<Response> {
  const req = chatRequest(sessionKey);
  const url = new URL(req.url);
  const resp = await router(req, url, url.pathname, "POST");
  expect(resp?.status).toBe(200);
  return resp!;
}

describe("the chat's SSE response during a silent tool, behind Bun's idle timeout", () => {
  test("silent, it is cut without [DONE]; with the ping, it reaches [DONE]", async () => {
    const ctx = await createTestAppContext();
    const silentKey = saveTopic(ctx, "sse-silent");
    const pingKey = saveTopic(ctx, "sse-ping");
    // 14 s of silence against an 8 s idle timeout: the cut lands at 8 to 12 s.
    const silent = chatRouterFor(ctx, silentToolProvider(14_000).provider, 60_000);
    const pinged = chatRouterFor(ctx, silentToolProvider(14_000).provider, 2_000);
    const serve = (router: ReturnType<typeof createChatRouter>) => Bun.serve({
      port: 0,
      idleTimeout: 8,
      fetch: async (req) => {
        const url = new URL(req.url);
        return (await router(req, url, url.pathname, req.method)) ?? new Response("not found", { status: 404 });
      },
    });
    const silentServer = serve(silent);
    const pingServer = serve(pinged);
    try {
      const [cutRun, pingRun] = await Promise.all([
        fetch(chatRequest(silentKey, `http://127.0.0.1:${silentServer.port}`)).then(readAll),
        fetch(chatRequest(pingKey, `http://127.0.0.1:${pingServer.port}`)).then(readAll),
      ]);

      expect(cutRun.body).not.toContain("[DONE]");
      expect(cutRun.body).not.toContain("finished");

      expect(pingRun.cut).toBe(false);
      expect((pingRun.body.match(/^: ping$/gm) ?? []).length).toBeGreaterThanOrEqual(3);
      expect(pingRun.body).toContain("finished");
      expect(pingRun.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    } finally {
      silentServer.stop(true);
      pingServer.stop(true);
    }
  }, 40_000);
});

describe("send_chat_message across a stream Bun cut, on the real routes", () => {
  test("the idle close lands mid-tool, before any text: the tool still returns the final answer", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-cut-send");
    // No ping inside the 14 s: the response is cut at 8 to 12 s, the turn goes on.
    const chat = chatRouterFor(ctx, silentToolProvider(14_000).provider, 60_000);
    const topics = createTopicsRouter(ctx);
    const server = Bun.serve({
      port: 0,
      idleTimeout: 8,
      fetch: async (req) => {
        const url = new URL(req.url);
        return (await chat(req, url, url.pathname, req.method))
          ?? (await topics(req, url, url.pathname, req.method))
          ?? new Response("not found", { status: 404 });
      },
    });
    const asked: string[] = [];
    const recording = ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      return fetch(input, init);
    }) as typeof fetch;
    try {
      const reply = await callSendChatMessage(
        { baseUrl: `http://127.0.0.1:${server.port}`, sessionKey: "topic:the-caller" },
        { topic_id: "sse-cut-send", message: "run the long command" },
        recording,
        { pollMs: 200, maxWaitMs: 30_000 },
      );
      expect(reply).toBe("finished");
      // It came from the row, after the cut: not from a stream that reached [DONE].
      expect(asked.some((u) => /\/api\/topics\/sse-cut-send\/messages\/[^/?]+$/.test(u))).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 40_000);
});

describe("the board's stall watch with pings on the stream", () => {
  test("a stuck turn is still judged within the idle window while pings flow", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-stall");
    const { provider } = silentToolProvider();
    const resp = await postInProcess(chatRouterFor(ctx, provider, 100), sessionKey);
    const reader = resp.body!.getReader();

    // The reader of `watchHeadlessBody` (server.ts), with a 1 s idle window
    // standing in for `dispatchIdleMin`.
    const t0 = Date.now();
    let stuckAfterMs: number | null = null;
    let pings = 0;
    const detector = armStallDetector({
      idleMs: 1_000,
      isWaitingForHuman: () => false,
      getTail: () => "the tail",
      judge: async () => "stuck",
      onStuck: () => { stuckAfterMs = Date.now() - t0; reader.cancel().catch(() => {}); },
    });
    const giveUp = setTimeout(() => reader.cancel().catch(() => {}), 4_000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isSseCommentOnly(value)) pings++;
        else detector.noteActivity();
      }
    } catch { /* cancelled */ }
    finally {
      clearTimeout(giveUp);
      detector.clear();
    }

    expect(pings).toBeGreaterThanOrEqual(5);
    expect(stuckAfterMs).not.toBeNull();
    expect(stuckAfterMs!).toBeLessThan(2_500);
    ctx.activeStreams.get(sessionKey)?.abortController?.abort();
  }, 10_000);

  test("the headless reader in server.ts counts no ping as activity, nor as the body speaking after the end", () => {
    // The loop lives inside server.ts, which starts a server on import: its
    // wiring is checked on the source. Two rules: a ping does not feed the
    // stall watch, and a ping does not keep the end grace (20 s, like the
    // ping) from ever running out once the end is deposited.
    const source = readFileSync(join(REPO_ROOT, "server.ts"), "utf8");
    const reader = source.slice(source.indexOf("async function watchHeadlessBody("));
    const loop = reader.slice(0, reader.indexOf("finally {"));
    expect(loop).toMatch(/if \(!isSseCommentOnly\(value\)\) \{ detector\.noteActivity\(\); lastDataAt = Date\.now\(\); \}/);
    expect(loop).toMatch(/else if \(peekTurnEnd\(sessionKey\) && Date\.now\(\) - lastDataAt >= HEADLESS_END_GRACE_MS\) \{ reader\.cancel\(\)/);
  });

  test("a comment-only chunk is a ping; a chunk with data is activity", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(isSseCommentOnly(bytes(": ping\n\n"))).toBe(true);
    expect(isSseCommentOnly(bytes(": ping\n\n: ping\n\n"))).toBe(true);
    expect(isSseCommentOnly(bytes(": ping\n\ndata: {}\n\n"))).toBe(false);
    expect(isSseCommentOnly(bytes("data: [DONE]\n\n"))).toBe(false);
    expect(isSseCommentOnly(bytes(""))).toBe(false);
    expect(isSseCommentOnly(undefined)).toBe(false);
  });
});

describe("the turn frames the chat's SSE carries for its readers", () => {
  const firstData = (body: string) => JSON.parse(body.split("\n").find((l) => l.startsWith("data: "))!.slice(6));

  test("the first frame names the turn's row, and a finished turn sends no end frame", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-row");
    const { provider } = silentToolProvider(50);
    const { body } = await readAll(await postInProcess(chatRouterFor(ctx, provider, 60_000), sessionKey));

    const rows = ctx.loadLocalMessages(sessionKey);
    const answer = rows[rows.length - 1];
    expect(answer.role).toBe("assistant");
    expect(firstData(body)).toEqual({ turn: { messageId: answer.id } });
    expect(body).not.toContain('"end"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("a turn that ends with nothing at all is an error, and says so before [DONE]", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-empty");
    const { provider } = silentToolProvider();
    // Ends at once: no text, no tool. The route writes its empty-reply verdict.
    (provider as unknown as { sendChat: unknown }).sendChat = async (_sk: string, _msg: string, h: StreamHandler) => {
      h.onDone(undefined as never);
      return { runId: "run-empty" };
    };
    const { body } = await readAll(await postInProcess(chatRouterFor(ctx, provider, 60_000), sessionKey));
    expect(body).toContain(`data: ${JSON.stringify({ turn: { end: "error" } })}\n\ndata: [DONE]`);
  });

  test("a provider that throws while the turn is set up gets an answer at once, with the error and its end", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-sync-throw");
    const { provider } = silentToolProvider();
    // Throws synchronously, before any promise: the route's setup catch.
    (provider as unknown as { sendChat: unknown }).sendChat = () => { throw new Error("spawn failed"); };
    const router = chatRouterFor(ctx, provider, 60_000);
    const req = chatRequest(sessionKey);
    const url = new URL(req.url);
    const answered = await Promise.race([
      router(req, url, url.pathname, "POST"),
      Bun.sleep(3_000).then(() => "no answer in 3 s" as const),
    ]);
    expect(answered).not.toBe("no answer in 3 s");
    const { body } = await readAll(answered as Response);
    expect(body).toContain(`data: ${JSON.stringify({ turn: { end: "error" } })}\n\ndata: [DONE]`);
  }, 10_000);

  test("a turn a person stops says so before [DONE]", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-stop");
    const { provider } = silentToolProvider();
    const resp = await postInProcess(chatRouterFor(ctx, provider, 60_000), sessionKey);
    // What POST /api/chat/abort does: deposit the cause, then abort the stream.
    setTimeout(() => {
      recordTurnEnd(sessionKey, cancelled("user", "POST /api/chat/abort"));
      ctx.activeStreams.get(sessionKey)!.abortController!.abort();
    }, 100);
    const { body } = await readAll(resp);
    expect(body).toContain(`data: ${JSON.stringify({ turn: { end: "cancelled", cause: "user" } })}\n\ndata: [DONE]`);
  });

  test("a turn that ends in a provider error says so before [DONE]", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "sse-error");
    const { provider, handlers } = silentToolProvider();
    const resp = await postInProcess(chatRouterFor(ctx, provider, 60_000), sessionKey);
    setTimeout(() => handlers.get(sessionKey)!.onError("upstream connection reset"), 100);
    const { body } = await readAll(resp);
    expect(body).toMatch(/data: \{"turn":\{"end":"error","cause":"[a-z-]+"\}\}\n\ndata: \[DONE\]/);
  });
});

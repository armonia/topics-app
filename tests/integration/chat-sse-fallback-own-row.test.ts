/**
 * A TURN STREAMED OVER HTTP-SSE WRITES ON ITS OWN ROW, NOT ON THE LAST ONE
 * (card c714a62c).
 *
 * PR #135 made the WS path of a turn write its body and its tools on its row
 * by id. The HTTP-SSE paths kept `updateLastMessage` and friends without a
 * `rowId`, so they wrote the LAST row of the session: the chat route's
 * fallback (a provider that is not connected), and edit/regenerate with a
 * provider that streams over HTTP (openclaw, claude, openai). A row born after
 * the turn's own (a notice, a sub-agent's report, a system message) took the
 * turn's text and tools, and the turn's row stayed empty and partial.
 *
 * Driven through the real routes with a provider whose HTTP stream the test
 * writes frame by frame. Ten chunks before the other row is born: the text is
 * saved every ten, so the turn's row has been written once by then.
 *
 * @covers CHAT-01
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { createEditRouter } from "../../server/routes/edit";
import { insertRestartNotification } from "../../server/lib/boot-partial-sweep";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, StoredMessage, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-sse-fallback-own-row-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

/** An SSE body the test writes into, frame by frame. */
function sseBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const encoder = new TextEncoder();
  const frame = (data: string) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  return {
    body,
    push: (delta: Record<string, unknown>) => frame(JSON.stringify({ choices: [{ index: 0, delta }] })),
    text: (from: number, to: number, tag: string) => {
      for (let i = from; i <= to; i++) frame(JSON.stringify({ choices: [{ index: 0, delta: { content: `${tag}${i} ` } }] }));
    },
    done: () => { frame("[DONE]"); controller.close(); },
    /** The stream ends without `[DONE]`: the consumer's `finally` closes the turn. */
    cut: () => controller.close(),
  };
}

/** A provider that streams over HTTP; `wired.handler` is the WS handler the route registers. */
function httpProvider(name: string, connected: boolean, body: ReadableStream<Uint8Array>) {
  const wired: { handler?: StreamHandler } = {};
  const provider = {
    name,
    capabilities: new Set(["streaming"]),
    contextStrategy: "inline-system",
    get connected() { return connected; },
    streamHTTP: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    registerStreamHandler: (_sk: string, _runId: unknown, h: StreamHandler) => { wired.handler = h; },
    unregisterStreamHandler: () => {},
    defaultModel: () => "gw-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  return { provider, wired };
}

async function contextFor(sessionKey: string, provider?: string): Promise<AppContext> {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  ctx.saveSingleTopic({
    id: `t-${sessionKey}`, name: "sse", slug: "sse", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, ...(provider ? { provider } : {}),
  } as Topic);
  return ctx;
}

function chatTurn(ctx: AppContext, provider: AIProvider, sessionKey: string) {
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
    WORKSPACE_DIR: testTmpDir("chat-sse-fallback-own-row-ws"),
  } as never);
  const url = new URL("http://topics.test/api/chat");
  // No provider in the body and none on the topic: the topic follows the
  // default, and a default that is not connected takes the HTTP-SSE fallback.
  return chatRouter(new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "hello" }] }),
  }), url, "/api/chat", "POST") as Promise<Response | null>;
}

const rows = (ctx: AppContext, sessionKey: string): StoredMessage[] => ctx.loadLocalMessages(sessionKey);
const lastRow = (ctx: AppContext, sessionKey: string): StoredMessage => rows(ctx, sessionKey).at(-1)!;
const rowById = (ctx: AppContext, sessionKey: string, id: string) => rows(ctx, sessionKey).find((m) => m.id === id);

/** The turn has saved its first ten chunks on its row. */
async function savedOnce(ctx: AppContext, sessionKey: string, rowId: string, tag: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (!rowById(ctx, sessionKey, rowId)?.content.includes(`${tag}10`)) {
    if (Date.now() > until) throw new Error(`the turn never saved its tenth chunk: ${JSON.stringify(rowById(ctx, sessionKey, rowId))}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The whole row as the database gives it back, for a byte-for-byte comparison. */
const shape = (m: StoredMessage | undefined) => m && structuredClone(m);
const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i + 1} `).join("");

describe("a turn streamed over HTTP-SSE, with a row born after its own", () => {
  test("the chat route's fallback: text and tools stay on the turn's row, the other row is untouched", async () => {
    const sk = "topic:ssefallback";
    const ctx = await contextFor(sk);
    const sse = sseBody();
    const { provider, wired } = httpProvider("openclaw", false, sse.body);
    const resp = await chatTurn(ctx, provider, sk);
    expect(resp?.status).toBe(200);
    // Read while the gateway writes: the route forwards every chunk to this
    // response, and without a reader it waits.
    const drained = resp!.text();
    const turnRow = lastRow(ctx, sk);
    expect(turnRow).toMatchObject({ role: "assistant", partial: true });

    sse.text(1, 10, "A");
    await savedOnce(ctx, sk, turnRow.id, "A");
    insertRestartNotification(ctx.db, sk, { text: "NOTICE" });
    const notice = lastRow(ctx, sk);
    const noticeBefore = shape(notice);

    // Past twenty: the periodic save after the other row is born writes too.
    sse.text(11, 20, "A");
    sse.push({ tool_calls: [{ id: "tc-sse", function: { name: "Bash", arguments: "{}" } }] });
    sse.push({ tool_result: { id: "tc-sse", status: "success", result: "ok" } });
    // The WS handler the fallback registers, for tool events that arrive on a
    // gateway socket that came back during the request.
    wired.handler!.onToolStart("tc-ws", "Read", {});
    wired.handler!.onToolResult("tc-ws", "read");
    sse.done();
    await drained;

    expect(shape(rowById(ctx, sk, notice.id)), "the row born after the turn is untouched").toEqual(noticeBefore);
    const own = rowById(ctx, sk, turnRow.id)!;
    expect(own.content).toBe(words("A", 20));
    expect(own.partial).toBeFalsy();
    // Both tools, whichever came first: the socket's events are handled at
    // once, the stream's frames when the route reads them.
    expect(own.toolCalls?.map((t) => `${t.id}:${t.status}`).sort()).toEqual(["tc-sse:success", "tc-ws:success"]);
  });

  test("the chat route's fallback cut without [DONE]: the close lands on the turn's row", async () => {
    const sk = "topic:ssecut";
    const ctx = await contextFor(sk);
    const sse = sseBody();
    const { provider } = httpProvider("openclaw", false, sse.body);
    const resp = await chatTurn(ctx, provider, sk);
    const drained = resp!.text();
    const turnRow = lastRow(ctx, sk);

    sse.text(1, 10, "C");
    await savedOnce(ctx, sk, turnRow.id, "C");
    insertRestartNotification(ctx.db, sk, { text: "NOTICE" });
    const notice = lastRow(ctx, sk);
    const noticeBefore = shape(notice);
    sse.text(11, 12, "C");
    sse.cut();
    await drained;
    // The consumer's `finally` closes the response BEFORE it writes the row and
    // ends the stream: the end of the stream is what says the write happened.
    const until = Date.now() + 5_000;
    while (ctx.isStreaming(sk) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));

    expect(shape(rowById(ctx, sk, notice.id))).toEqual(noticeBefore);
    const own = rowById(ctx, sk, turnRow.id)!;
    expect(own.content).toBe(words("C", 12));
    expect(own.partial).toBeFalsy();
  });

  test("regenerate over HTTP-SSE: the new branch gets the answer, the other row is untouched", async () => {
    const sk = "topic:sseregen";
    const ctx = await contextFor(sk, "claude");
    ctx.appendLocalMessage(sk, "user", "q");
    const old = ctx.appendLocalMessage(sk, "assistant", "old");
    const sse = sseBody();
    const { provider } = httpProvider("claude", true, sse.body);
    const editRouter = createEditRouter(ctx, { resolveProvider: () => provider, updateUnreadCount: () => {} });
    const url = new URL(`http://topics.test/api/messages/${old.id}/regenerate`);
    const resp = (await editRouter(new Request(url.toString(), { method: "POST" }), url, url.pathname, "POST")) as Response | null;
    expect(resp?.status).toBe(200);
    const drained = resp!.text();
    const branch = lastRow(ctx, sk);
    expect(branch).toMatchObject({ role: "assistant", partial: true });
    expect(branch.id).not.toBe(old.id);

    sse.text(1, 10, "B");
    await savedOnce(ctx, sk, branch.id, "B");
    insertRestartNotification(ctx.db, sk, { text: "NOTICE" });
    const notice = lastRow(ctx, sk);
    const noticeBefore = shape(notice);
    sse.text(11, 12, "B");
    sse.push({ tool_calls: [{ id: "tc-regen", function: { name: "Bash", arguments: "{}" } }] });
    sse.push({ tool_result: { id: "tc-regen", status: "success", result: "ok" } });
    sse.done();
    await drained;

    expect(shape(rowById(ctx, sk, notice.id))).toEqual(noticeBefore);
    const own = rowById(ctx, sk, branch.id)!;
    expect(own.content).toBe(words("B", 12));
    expect(own.partial).toBeFalsy();
    expect(own.toolCalls?.map((t) => `${t.id}:${t.status}`)).toEqual(["tc-regen:success"]);
  });
});

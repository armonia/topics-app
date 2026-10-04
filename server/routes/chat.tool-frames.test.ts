/**
 * THE TOOL FRAMES OF THE ROUTE: the same tool call on both transports, the live
 * output kept for a catch-up, and the times a tool was first given.
 *
 *  - CHAT-TOOL-10: the window that sent the message reads only its SSE. The
 *    announcement went out there without `startedAt` and `detail`, the result
 *    without `endedAt`, and a turn's closing error was never read: no clock, no
 *    duration and a red X without a reason, only in that window.
 *  - CHAT-TOOL-11: `onToolUpdate` was broadcast and forgotten, so a socket
 *    opened mid-command got the running shell back with no output; and the
 *    history page a reopening window reads right after its catch-up carried
 *    the running shell without it too, wiping what the catch-up had restored.
 *  - CHAT-TOOL-12: a re-adoption's replay announced every tool again, stamped
 *    `Date.now()`: each tool that ran before the restart lost its duration.
 *
 * Proven on the real `POST /api/chat` with a fake provider driven from the
 * handler, the SSE read off the response and the rows off the real DB.
 * @covers CHAT-TOOL-10, CHAT-TOOL-11, CHAT-TOOL-12
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import { createHistoryRouter } from "./history";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { AppContext, ContentBlock, Topic, ToolCall } from "../types";

const ROOT = testTmpDir("chat-tool-frames");
let ctx: AppContext;
const frames: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { frames.push(m as Record<string, unknown>); };
});
afterAll(() => cleanupTestDataDir(ROOT));

function topic(tid: string, provider: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider } as Topic);
  return `topic:${tid}`;
}

/** What the provider does once the route hands it the handler. */
let drive: (h: StreamHandler) => void | Promise<void> = () => {};
const provider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  sendChat: async (_sk: string, _m: string, h: StreamHandler) => { setTimeout(() => drive(h), 5); return { runId: "run" }; },
  reattach: async (_sk: string, h: StreamHandler) => { setTimeout(() => drive(h), 5); return "reattach-run"; },
  defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {}, complete: async () => ({ content: "" }),
} as unknown as AIProvider;

/** One request through the real route, read to its end; returns the SSE `delta`s it wrote. */
async function turn(sk: string, body: Record<string, unknown>, emit: (h: StreamHandler) => void | Promise<void>): Promise<Array<Record<string, unknown>>> {
  drive = emit;
  const chat = createChatRouter(ctx, {
    resolveProvider: () => provider, resolveProviderByName: () => provider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null, getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
  } as never);
  const url = new URL("http://topics.test/api/chat");
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk, ...body }) }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  const text = await new Response(resp.body).text();
  const deltas: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const delta = (JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]?.delta;
      if (delta) deltas.push(delta);
    } catch { /* a non-JSON keepalive */ }
  }
  return deltas;
}

const sseToolCalls = (deltas: Array<Record<string, unknown>>, id: string) =>
  deltas.flatMap((d) => (d.tool_calls as Array<Record<string, unknown>> | undefined) ?? []).filter((tc) => tc.id === id);
const sseToolResult = (deltas: Array<Record<string, unknown>>, id: string) =>
  deltas.map((d) => d.tool_result as Record<string, unknown> | undefined).find((r) => r?.id === id);
const toolOf = (rowId: string, id: string): ToolCall | undefined =>
  (ctx.getMessageById(rowId)?.blocks ?? []).map((b) => (b as { toolCall?: ToolCall }).toolCall).find((tc) => tc?.id === id);

describe("the SSE carries the same tool call as the WS frame", () => {
  test("the announcement has startedAt and detail; the result endedAt, error and detail; a turn's closing error too", async () => {
    const sk = topic("sse-parity", "claude-code");
    const deltas = await turn(sk, { messages: [{ role: "user", content: "go" }] }, (h) => {
      h.onToolStart("t-fail", "Bash", { command: "false" });
      h.onToolResult("t-fail", "exit 1: boom", true);
      h.onToolStart("t-cut", "Bash", { command: "sleep 30" });
      h.onError("CLI exited with code 1");
    });

    const announced = sseToolCalls(deltas, "t-fail")[0]!;
    expect(typeof announced.startedAt).toBe("number");
    expect(announced.detail).toMatchObject({ type: "shell", command: "false" });
    expect(announced.status).toBe("running");

    const failed = sseToolResult(deltas, "t-fail")!;
    expect(failed).toMatchObject({ status: "error", error: "exit 1: boom", detail: { type: "shell" } });
    expect(failed.endedAt as number).toBeGreaterThanOrEqual(announced.startedAt as number);

    // Still running when the turn died: closed by the route, with the reason.
    const cut = sseToolResult(deltas, "t-cut")!;
    expect(cut.status).toBe("error");
    expect(String(cut.error)).toContain("CLI exited with code 1");
    expect(typeof cut.endedAt).toBe("number");
  });
});

describe("the live output of a running tool waits on the turn's registry entry", () => {
  test("kept while the tool runs, dropped at its result", async () => {
    const sk = topic("live-tail", "claude-code");
    const seen: Array<string | undefined> = [];
    await turn(sk, { messages: [{ role: "user", content: "go" }] }, (h) => {
      h.onToolStart("t-live", "Bash", { command: "bun test" });
      h.onToolUpdate!("t-live", "test 1 ok\ntest 2 ok\ntest 3 ok");
      seen.push(ctx.activeStreams.get(sk)?.liveToolTails?.get("t-live"));
      h.onToolResult("t-live", "3 pass");
      seen.push(ctx.activeStreams.get(sk)?.liveToolTails?.get("t-live"));
      h.onDone({ result: "done" } as never);
    });
    expect(seen).toEqual(["test 1 ok\ntest 2 ok\ntest 3 ok", undefined]);
  });
});

/** The last row of the session's history page, as `GET /api/history/:sessionKey` sends it. */
async function historyTail(sk: string): Promise<{ isStreaming: boolean; last: { partial?: boolean; blocks?: ContentBlock[]; toolCalls?: ToolCall[] } }> {
  const history = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => provider,
  });
  const path = `/api/history/${encodeURIComponent(sk)}`;
  const url = new URL(`http://topics.test${path}?limit=40`);
  const body = (await (await history(new Request(url, { method: "GET" }), url, path, "GET"))!.json()) as { isStreaming: boolean; messages: Array<{ partial?: boolean; blocks?: ContentBlock[]; toolCalls?: ToolCall[] }> };
  return { isStreaming: body.isStreaming, last: body.messages[body.messages.length - 1]! };
}

describe("the history page of a turn in flight carries the running tools' live output", () => {
  test("the running shell has its tail as result, the closed one its own output", async () => {
    const sk = topic("history-tail", "claude-code");
    let read: Awaited<ReturnType<typeof historyTail>> | undefined;
    await turn(sk, { messages: [{ role: "user", content: "go" }] }, async (h) => {
      h.onToolStart("t-done", "Bash", { command: "ls" });
      h.onToolResult("t-done", "a.txt");
      h.onToolStart("t-live", "Bash", { command: "bun test" });
      h.onToolUpdate!("t-live", "r1\nr2\nr3");
      // The row is written by the turn's throttle: let it land, as it has by the time a window reopens.
      await new Promise((r) => setTimeout(r, 50));
      read = await historyTail(sk);
      h.onToolResult("t-live", "3 pass");
      h.onDone({ result: "done" } as never);
    });
    expect(read!.isStreaming).toBe(true);
    expect(read!.last.partial).toBe(true);
    const tools = (read!.last.blocks ?? []).map((b) => (b as { toolCall?: ToolCall }).toolCall).filter(Boolean) as ToolCall[];
    expect(tools.find((tc) => tc.id === "t-live")).toMatchObject({ status: "running", result: "r1\nr2\nr3" });
    expect(tools.find((tc) => tc.id === "t-done")?.result).not.toBe("r1\nr2\nr3");
  });
});

describe("a re-adoption's replay keeps the times the tools were first given", () => {
  test("the closed tool keeps startedAt and endedAt, the running one its startedAt, in the row and on the wire", async () => {
    const sk = topic("reattach-times", "claude-code");
    ctx.appendLocalMessage(sk, "user", "build it");
    const row = ctx.createPartialMessage(sk, "assistant");
    const done: ToolCall = { id: "t-done", name: "Bash", args: { command: "make" }, status: "success", result: "ok", startedAt: 1_000, endedAt: 61_000 };
    const live: ToolCall = { id: "t-live", name: "Bash", args: { command: "sleep 200" }, status: "running", startedAt: 62_000 };
    ctx.updateLastMessage(sk, { content: "", blocks: [{ kind: "tool", toolCall: done }, { kind: "tool", toolCall: live }] as ContentBlock[], toolCalls: [done, live] }, { rowId: row.id });
    // The boot keeps the row open for the child still alive in the broker.
    runBootPartialSweep(ctx.db as unknown as PartialSweepDb, { listConfirmed: true, liveSessions: new Set([sk]) });
    frames.length = 0;

    const deltas = await turn(sk, { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" }, (h) => {
      h.onToolStart("t-done", "Bash", { command: "make" });
      h.onToolResult("t-done", "ok");
      h.onToolStart("t-live", "Bash", { command: "sleep 200" });
      h.onToolResult("t-live", "slept");
      h.onTextDelta("Fatto.", "Fatto.");
      h.onDone({ result: "Fatto." } as never);
    });

    expect(toolOf(row.id, "t-done")).toMatchObject({ startedAt: 1_000, endedAt: 61_000 });
    expect(toolOf(row.id, "t-live")?.startedAt).toBe(62_000);
    expect(toolOf(row.id, "t-live")!.endedAt!).toBeGreaterThan(62_000);

    const wired = frames.filter((f) => f.type === "stream:tool_call").map((f) => f.toolCall as ToolCall);
    expect(wired.find((tc) => tc.id === "t-done")?.startedAt).toBe(1_000);
    expect(wired.find((tc) => tc.id === "t-live")?.startedAt).toBe(62_000);
    expect(frames.find((f) => f.type === "stream:tool_result" && f.toolCallId === "t-done")?.endedAt).toBe(61_000);
    expect(sseToolCalls(deltas, "t-done")[0]?.startedAt).toBe(1_000);
  });
});

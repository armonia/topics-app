/**
 * HOW A ROW CLOSED IS WRITTEN ON THE ROW, AND THE TOOLS READ IT (card a57e6d4d).
 * @covers CHAT-INT-01
 *
 * After PR #138, `send_chat_message` and `read_chat_messages` told a row a
 * restart had cut from its missing `latency_ms`, and the post-restart reattach
 * adopted the session's last row on the same clue. An independent verifier
 * broke that five ways with the real functions, in boot order: a whole reply
 * written without latency (regenerate) was called cut, a woken turn with no
 * user row of its own went unmarked, the reattach adopted a sub-agent's report
 * instead of the turn's row, a row that kept a latency from an earlier leg was
 * handed back as the answer after a SIGKILL, and a Stop was reported as "a
 * restart or a watchdog". These are the verifier's probes with the assertions
 * the right way round, plus the reopen after a leg that ends on a turn still
 * open, which has to light the leg's row now that the reattach takes it.
 * `finished()` writes what the chat route's finalize writes when a turn
 * completes; the route writing it is asserted in tests/integration
 * (chat-woken-turn, chat-watchdog-finalize). The reattach legs go through the
 * real route (`mode: "reattach"`, the boot's request) and end through the
 * helpers server.ts calls (`lib/closed-outside.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "../routes/topics";
import { createEditRouter } from "../routes/edit";
import { createChatRouter } from "../routes/chat";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { endReattachLeg, finalizeStaleRow } from "../lib/closed-outside";
import { registerProvider, removeProvider } from "../providers";
import type { AIProvider, StreamHandler } from "../providers/types";
import { callReadChatMessages, callSendChatMessage } from "./topics-mcp-server";
import type { AppContext, ContentBlock, Topic, ToolCall } from "../types";

const ROOT = testTmpDir("cut-row-end-reason");
let ctx: AppContext;
beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(() => cleanupTestDataDir(ROOT));

// A real provider in the registry, disconnected: the Stop route calls no
// provider abort, so what is measured is the route's own write.
registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

const CUT_NOTE = "cut by a server restart before it finished";

function topic(tid: string): string {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey: `topic:${tid}`, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, provider: "openai" } as Topic);
  return `topic:${tid}`;
}

/** What `finalizeStream` (routes/chat.ts) writes when the turn completes. */
const finished = (sk: string, rowId: string, content: string) =>
  ctx.updateLastMessage(sk, { content, partial: undefined, streamedAt: undefined, latencyMs: 500, endReason: "done" }, { rowId });

/** A boot after a SIGKILL, with the chat's child gone (or alive, for the reattach). */
const boot = (live: string[] = []) =>
  runBootPartialSweep(ctx.db as unknown as PartialSweepDb, { listConfirmed: true, liveSessions: new Set(live) });

const routerFetch = (): typeof fetch => {
  const router = createTopicsRouter(ctx);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    return (await router(new Request(u.toString(), { method: init?.method ?? "GET" }), u, u.pathname, init?.method ?? "GET"))!;
  }) as typeof fetch;
};

/** The note read_chat_messages puts on each row, null where there is none. */
async function notes(tid: string): Promise<Array<string | null>> {
  const out = JSON.parse(await callReadChatMessages({ baseUrl: "http://x", sessionKey: "topic:caller" }, { topic_id: tid }, routerFetch())) as { messages: Array<{ note?: string }> };
  return out.messages.map((m) => m.note ?? null);
}

/** send_chat_message whose stream was cut after naming `rowId`; everything else is served by the real routes. */
function sendCut(tid: string, rowId: string): Promise<string> {
  const inner = routerFetch();
  const cut = `data: ${JSON.stringify({ turn: { messageId: rowId } })}\n\n`;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/api/chat") {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(cut)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return inner(input, init);
  }) as typeof fetch;
  return callSendChatMessage({ baseUrl: "http://x", sessionKey: "topic:caller" }, { topic_id: tid, message: "ping" }, f, { pollMs: 5, maxWaitMs: 2_000, unreachableMs: 1_000 });
}

describe("a whole reply written without latency_ms is not a cut", () => {
  test("A: a regenerated reply, then a woken turn a restart cut: the woken row is the one marked", async () => {
    const tid = "endr-regen";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "domanda");
    const first = ctx.createPartialMessage(sk, "assistant");
    finished(sk, first.id, "prima risposta");
    // The real regenerate route, on a provider with complete() only (edit.ts).
    const edit = createEditRouter(ctx, { resolveProvider: () => ({ name: "fake", connected: true, complete: async () => ({ content: "RISPOSTA RIGENERATA, COMPLETA." }) }) as never, updateUnreadCount: () => {} } as never);
    const path = `/api/messages/${first.id}/regenerate`;
    const req = new Request(`http://t.test${path}`, { method: "POST" });
    const resp = await edit(req, new URL(req.url), path, "POST");
    expect(resp!.status).toBe(200);
    await resp!.text();
    // A woken turn opens its own row (chat.ts, `reuseHeadstoneOrCreate`) and the process dies while it writes.
    const wakeRow = ctx.reuseHeadstoneOrCreate(sk);
    ctx.updateLastMessage(sk, { content: "Il Monitor ha chiuso, ora" }, { rowId: wakeRow.id });
    boot();
    // user, regenerated reply, woken row, restart notice
    expect(await notes(tid)).toEqual([null, null, CUT_NOTE, null]);
  });

  test("A2: a finished turn, then a woken turn a restart cut: the cut row is recognised without a user row of its own", async () => {
    const tid = "endr-woken";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "domanda");
    const first = ctx.createPartialMessage(sk, "assistant");
    finished(sk, first.id, "fatto");
    const wakeRow = ctx.reuseHeadstoneOrCreate(sk);
    ctx.updateLastMessage(sk, { content: "mezza frase del risveglio" }, { rowId: wakeRow.id });
    boot();
    expect(await notes(tid)).toEqual([null, null, CUT_NOTE, null]);
  });
});

/** What the broker hands the reattach leg: `ClaudeCodeProvider.reattach` re-emits all, only the final text, or nothing. */
let replay: (h: StreamHandler) => void = () => {};
const brokerProvider = {
  name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "inline-system",
  get connected() { return true; },
  registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
  reattach: async (_sk: string, h: StreamHandler) => { setTimeout(() => replay(h), 5); return "reattach-run"; },
  sendChat: () => { throw new Error("a reattach leg sends nothing"); },
  defaultModel: () => "claude-opus-5", abort: async () => {}, start: () => {}, stop: () => {}, complete: async () => ({ content: "" }),
} as unknown as AIProvider;

/** A reattach leg through the real route, the request `runHeadlessReattach` makes at boot, read to its end. */
async function reattachLeg(sk: string, emit: (h: StreamHandler) => void): Promise<void> {
  replay = emit;
  const chat = createChatRouter(ctx, {
    resolveProvider: () => brokerProvider, resolveProviderByName: () => brokerProvider,
    detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {}, resolveProjectRef: () => null, getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [], autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: join(ROOT, "ws"),
  } as never);
  const url = new URL("http://topics.test/api/chat");
  const body = JSON.stringify({ sessionKey: sk, messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
  const resp = (await chat(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }), url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  const reader = resp.body!.getReader();
  while (!(await reader.read()).done) { /* the leg's frames */ }
}
const mute = (h: StreamHandler) => h.onDone({} as never);

/** A turn that ran a sub-agent, cut mid-way; the sub-agent's report was written after its row (subagent-watch.ts). */
function turnWithReport(sk: string) {
  ctx.appendLocalMessage(sk, "user", "ping");
  const turn = ctx.createPartialMessage(sk, "assistant");
  const task: ToolCall = { id: "tool-task", name: "Task", args: {}, status: "success" };
  const blocks: ContentBlock[] = [{ kind: "text", text: "Lancio il sotto-agente, " }, { kind: "tool", toolCall: task } as ContentBlock];
  ctx.updateLastMessage(sk, { content: "Lancio il sotto-agente, ", blocks, toolCalls: [task] }, { rowId: turn.id });
  const report = ctx.appendLocalMessage(sk, "assistant", "Sotto-agente Lane A, esito: fatto.");
  return { turn, report };
}
const hasTool = (id: string) => (ctx.getMessageById(id)?.blocks ?? []).some((b) => b.kind === "tool");

describe("the reattach and the send wait on the turn's own row", () => {
  test("B: a mute replay after a restart with the child alive keeps the turn's row as it was, and the send gets it, not the sub-agent's report", async () => {
    const tid = "endr-reattach";
    const sk = topic(tid);
    const { turn, report } = turnWithReport(sk);
    boot([sk]);
    await reattachLeg(sk, mute);
    expect(endReattachLeg(ctx.db, sk, "idle")).toBe("closed");
    expect([ctx.getMessageById(turn.id)?.content, hasTool(turn.id)]).toEqual(["Lancio il sotto-agente, ", true]);
    expect(ctx.getMessageById(report.id)?.content).toBe("Sotto-agente Lane A, esito: fatto.");
    await expect(sendCut(tid, turn.id)).resolves.toBe("Lancio il sotto-agente,");
  });

  test("B: a replay that re-delivers only the final text keeps the turn's tools, and the send gets that text", async () => {
    const tid = "endr-reattach-final";
    const sk = topic(tid);
    const { turn, report } = turnWithReport(sk);
    const FINAL = "Risposta finale del turno.";
    boot([sk]);
    await reattachLeg(sk, (h) => { h.onTextDelta(FINAL, FINAL); h.onDone({ result: FINAL } as never); });
    endReattachLeg(ctx.db, sk, "idle");
    expect([ctx.getMessageById(turn.id)?.content, hasTool(turn.id)]).toEqual([FINAL, true]);
    expect(ctx.getMessageById(report.id)?.content).toBe("Sotto-agente Lane A, esito: fatto.");
    await expect(sendCut(tid, turn.id)).resolves.toBe(FINAL);
  });

  test("C: a reattach leg closed with its latency, lit again because the broker says open, then killed: the row is cut, not a reply", async () => {
    const tid = "endr-reopen";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "ping");
    const turn = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "Meta' del lavoro, poi" }, { rowId: turn.id });
    boot([sk]);
    // The leg ends on a turn still open (a mute replay): finalized, latency and all, then lit again.
    await reattachLeg(sk, mute);
    expect(ctx.getMessageById(turn.id)?.latencyMs).toBeNumber();
    expect(endReattachLeg(ctx.db, sk, "open")).toBe("relit");
    // Unclean restart, child gone.
    boot();
    expect(await notes(tid)).toEqual([null, CUT_NOTE, null]);
    await expect(sendCut(tid, turn.id)).rejects.toThrow(/closed from outside before it finished/);
  });

  test("a leg that ends on a turn still open lights the turn's row again, not the report written after it", async () => {
    const tid = "endr-relight";
    const sk = topic(tid);
    const { turn, report } = turnWithReport(sk);
    boot([sk]);
    await reattachLeg(sk, mute);
    endReattachLeg(ctx.db, sk, "open");
    expect([ctx.getMessageById(turn.id)?.partial, ctx.getMessageById(report.id)?.partial]).toEqual([true, undefined]);
    // Killed, child gone: the turn is the cut one, the report is whole.
    boot();
    expect(await notes(tid)).toEqual([null, CUT_NOTE, null, null]);
  });

  test("a row lit again after a leg, then closed by the next leg's end or by the stale sweeper, is closed from outside despite its old latency", async () => {
    for (const close of ["leg", "stale"] as const) {
      const tid = `endr-outside-${close}`;
      const sk = topic(tid);
      ctx.appendLocalMessage(sk, "user", "ping");
      const turn = ctx.createPartialMessage(sk, "assistant");
      ctx.updateLastMessage(sk, { content: "Meta' del lavoro, poi" }, { rowId: turn.id });
      boot([sk]);
      await reattachLeg(sk, mute);
      endReattachLeg(ctx.db, sk, "open");
      // The next leg fails before finalizing and the broker says the turn is over, or the stale sweeper gives up on it.
      if (close === "leg") endReattachLeg(ctx.db, sk, "idle");
      else finalizeStaleRow(ctx.db, { messageId: turn.id, marker: null, interruption: { text: "silent", cause: "watchdog", at: new Date().toISOString() } });
      await expect(sendCut(tid, turn.id)).rejects.toThrow(/closed from outside before it finished/);
      expect(ctx.reuseOrCreatePartialForReattach(sk).id).toBe(turn.id);
    }
  });

  test("a Stop the route finalizes is reported as a stop, not as a restart or a watchdog", async () => {
    const tid = "endr-stop";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "ping");
    const turn = ctx.createPartialMessage(sk, "assistant");
    ctx.startStream(sk, turn.id, new AbortController());
    ctx.updateStreamContent(sk, "Meta' della risposta", "");
    const router = createTopicsRouter(ctx);
    const url = new URL("http://topics.test/api/chat/abort");
    const req = new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk }) });
    expect((await router(req, url, url.pathname, "POST"))!.status).toBe(200);
    const said = await sendCut(tid, turn.id).then((reply) => `resolved: ${reply}`, (err: Error) => err.message);
    expect(said).toMatch(/the turn was stopped before finishing its reply\. What it had written: "Meta' della risposta"/);
    expect(said).not.toMatch(/restart|watchdog/);
  });
});

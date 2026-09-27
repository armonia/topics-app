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
 * helpers server.ts calls (`lib/closed-outside.ts`), broker probe included:
 * server.ts only hands them its context and the claude-code provider.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "../routes/topics";
import { createEditRouter } from "../routes/edit";
import { createChatRouter } from "../routes/chat";
import { createHistoryRouter } from "../routes/history";
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

/** What `finalizeStream` (routes/chat.ts) writes when the turn ends: completed, stopped (the provider's `onAborted`) or failed. */
const finished = (sk: string, rowId: string, content: string, endReason: "done" | "stopped" | "error" = "done") =>
  ctx.updateLastMessage(sk, { content, partial: undefined, streamedAt: undefined, latencyMs: 500, endReason }, { rowId });

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

const REGENERATED = "RISPOSTA RIGENERATA, COMPLETA.";

/** A finished answer regenerated through the real route, on a provider with complete() only (edit.ts). Returns the new row. */
async function regenerated(sk: string): Promise<string> {
  ctx.appendLocalMessage(sk, "user", "domanda");
  const first = ctx.createPartialMessage(sk, "assistant");
  finished(sk, first.id, "prima risposta");
  const edit = createEditRouter(ctx, { resolveProvider: () => ({ name: "fake", connected: true, complete: async () => ({ content: REGENERATED }) }) as never, updateUnreadCount: () => {} } as never);
  const path = `/api/messages/${first.id}/regenerate`;
  const req = new Request(`http://t.test${path}`, { method: "POST" });
  const resp = await edit(req, new URL(req.url), path, "POST");
  expect(resp!.status).toBe(200);
  await resp!.text();
  const last = ctx.loadLocalMessages(sk).at(-1)!;
  expect(last.content).toBe(REGENERATED);
  return last.id;
}

describe("a whole reply written without latency_ms is not a cut", () => {
  test("A: a regenerated reply, then a woken turn a restart cut: the woken row is the one marked", async () => {
    const tid = "endr-regen";
    const sk = topic(tid);
    await regenerated(sk);
    // A woken turn opens its own row (chat.ts, `reuseHeadstoneOrCreate`) and the process dies while it writes.
    const wakeRow = ctx.reuseHeadstoneOrCreate(sk);
    ctx.updateLastMessage(sk, { content: "Il Monitor ha chiuso, ora" }, { rowId: wakeRow.id });
    boot();
    // user, regenerated reply, woken row, restart notice
    expect(await notes(tid)).toEqual([null, null, CUT_NOTE, null]);
  });

  test("A: a regenerated reply left as the session's last row, with no row open, is not taken back by a reattach", async () => {
    const sk = topic("endr-regen-reattach");
    const row = await regenerated(sk);
    // Taken back, the replay of the next leg poured over the finished answer.
    expect(ctx.reuseOrCreatePartialForReattach(sk).id).not.toBe(row);
    expect(ctx.getMessageById(row)).toMatchObject({ content: REGENERATED, endReason: "done" });
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

/** The claude-code provider as the end of a leg finds it: the broker answers, or its socket fails. */
const broker = (says: "open" | "idle" | Error) => ({
  brokerTurnState: async () => { if (says instanceof Error) throw says; return says; },
});

/** A pane opening the chat (`/api/history`): with no turn streaming, its cleanup closes the rows still open. */
async function openHistory(sk: string): Promise<void> {
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => broker("idle") as never,
  });
  const path = `/api/history/${encodeURIComponent(sk)}`;
  const url = new URL(`http://h${path}`);
  const resp = (await router(new Request(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), url, path, "POST"))!;
  expect(resp.status).toBe(200);
}

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
    expect(await endReattachLeg(ctx, sk, broker("idle"))).toEqual({ relit: false, closed: 0 });
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
    await endReattachLeg(ctx, sk, broker("idle"));
    expect([ctx.getMessageById(turn.id)?.content, hasTool(turn.id)]).toEqual([FINAL, true]);
    expect(ctx.getMessageById(report.id)?.content).toBe("Sotto-agente Lane A, esito: fatto.");
    await expect(sendCut(tid, turn.id)).resolves.toBe(FINAL);
  });

  test("B: the turn's row closed from outside before the reattach takes it (a pane's history cleanup, the stale sweeper), with a report after it: the reattach still takes that row, and the send gets the final text", async () => {
    for (const closer of ["history", "stale"] as const) {
      const tid = `endr-closed-first-${closer}`;
      const sk = topic(tid);
      const FINAL = "Risposta finale del turno.";
      let turn, report;
      if (closer === "history") {
        ({ turn, report } = turnWithReport(sk));
        boot([sk]);
        // A window reloads right after the restart, before the boot's reattach request reaches the turn.
        await openHistory(sk);
      } else {
        // The sweeper gives up on a turn gone silent while its child works on; the sub-agent reports after that.
        ctx.appendLocalMessage(sk, "user", "ping");
        turn = ctx.createPartialMessage(sk, "assistant");
        ctx.updateLastMessage(sk, { content: "Lancio il sotto-agente, " }, { rowId: turn.id });
        finalizeStaleRow(ctx.db, { messageId: turn.id, marker: null, interruption: { text: "silent", cause: "watchdog", at: new Date().toISOString() } });
        report = ctx.appendLocalMessage(sk, "assistant", "Sotto-agente Lane A, esito: fatto.");
      }
      expect(ctx.getMessageById(turn.id)?.endReason).toBe("closed-outside");
      await reattachLeg(sk, (h) => { h.onTextDelta(FINAL, FINAL); h.onDone({ result: FINAL } as never); });
      await endReattachLeg(ctx, sk, broker("idle"));
      expect(ctx.loadLocalMessages(sk).map((m) => m.id)).toHaveLength(3);
      expect(ctx.getMessageById(turn.id)?.content).toBe(FINAL);
      expect(ctx.getMessageById(report.id)?.content).toBe("Sotto-agente Lane A, esito: fatto.");
      await expect(sendCut(tid, turn.id)).resolves.toBe(FINAL);
    }
  });

  test("a row closed from outside above a turn that ended after it, completed, stopped or failed, is not taken back: the next turn gets a row of its own", async () => {
    for (const ending of ["done", "stopped", "error"] as const) {
      const sk = topic(`endr-closed-then-${ending}`);
      ctx.appendLocalMessage(sk, "user", "ping");
      const cut = ctx.createPartialMessage(sk, "assistant");
      ctx.updateLastMessage(sk, { content: "meta'" }, { rowId: cut.id });
      finalizeStaleRow(ctx.db, { messageId: cut.id, marker: null, interruption: { text: "silent", cause: "watchdog", at: new Date().toISOString() } });
      // A woken turn after it, ended by its own route.
      const wakeRow = ctx.reuseHeadstoneOrCreate(sk);
      finished(sk, wakeRow.id, "risveglio", ending);
      // A later wake, replayed by a reattach that finds no row of its own.
      const NEXT = "Risposta del secondo risveglio.";
      await reattachLeg(sk, (h) => { h.onTextDelta(NEXT, NEXT); h.onDone({ result: NEXT } as never); });
      await endReattachLeg(ctx, sk, broker("idle"));
      expect([ending, ...ctx.loadLocalMessages(sk).map((m) => m.content)]).toEqual([ending, "ping", "meta'", "risveglio", NEXT]);
    }
  });

  test("a reattach that finds no row of its turn and gets nothing from the replay leaves no row, not a 'no answer' notice under a finished reply", async () => {
    const sk = topic("endr-fresh-mute");
    ctx.appendLocalMessage(sk, "user", "ping");
    const first = ctx.createPartialMessage(sk, "assistant");
    finished(sk, first.id, "risposta finita");
    await reattachLeg(sk, mute);
    expect(ctx.loadLocalMessages(sk).map((m) => m.content)).toEqual(["ping", "risposta finita"]);
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
    expect(await endReattachLeg(ctx, sk, broker("open"))).toEqual({ relit: true, closed: 0 });
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
    await endReattachLeg(ctx, sk, broker("open"));
    expect([ctx.getMessageById(turn.id)?.partial, ctx.getMessageById(report.id)?.partial]).toEqual([true, undefined]);
    // Killed, child gone: the turn is the cut one, the report is whole.
    boot();
    expect(await notes(tid)).toEqual([null, CUT_NOTE, null, null]);
  });

  test("a row lit again after a leg, then closed by the next leg's end, the stale sweeper or a pane's history cleanup, is closed from outside despite its old latency", async () => {
    for (const close of ["leg", "stale", "history"] as const) {
      const tid = `endr-outside-${close}`;
      const sk = topic(tid);
      ctx.appendLocalMessage(sk, "user", "ping");
      const turn = ctx.createPartialMessage(sk, "assistant");
      ctx.updateLastMessage(sk, { content: "Meta' del lavoro, poi" }, { rowId: turn.id });
      boot([sk]);
      await reattachLeg(sk, mute);
      await endReattachLeg(ctx, sk, broker("open"));
      // The next leg fails before finalizing and the broker does not answer, the stale sweeper gives up on the
      // turn, or a pane opens the chat once the child is gone.
      if (close === "leg") expect(await endReattachLeg(ctx, sk, broker(new Error("broker socket closed")))).toEqual({ relit: false, closed: 1 });
      else if (close === "stale") finalizeStaleRow(ctx.db, { messageId: turn.id, marker: null, interruption: { text: "silent", cause: "watchdog", at: new Date().toISOString() } });
      else await openHistory(sk);
      expect(ctx.getMessageById(turn.id)?.partial).toBeUndefined();
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

describe("a turn an outage ended is written as failed, whichever leg of the route closed it", () => {
  test("the CLI giving up on the API (done leg), the watchdog on an API retry and a dead daemon (aborted leg) write 'error'; a completion and a Stop keep theirs", async () => {
    const FINAL = "Risposta finale del turno.";
    const ends: Array<[string, (h: StreamHandler) => void, string]> = [
      ["api-unavailable, done", (h) => h.onDone({ result: "", turnEnd: { end: "error", cause: "api-unavailable" } } as never), "error"],
      ["api-unavailable, aborted", (h) => h.onAborted!({ turnEnd: { end: "error", cause: "api-unavailable" } } as never), "error"],
      ["broker-died, aborted", (h) => h.onAborted!({ turnEnd: { end: "error", cause: "broker-died" } } as never), "error"],
      ["completed", (h) => { h.onTextDelta(FINAL, FINAL); h.onDone({ result: FINAL } as never); }, "done"],
      ["stopped", (h) => h.onAborted!({ turnEnd: { end: "cancelled", cause: "user" } } as never), "stopped"],
    ];
    for (const [name, end, expected] of ends) {
      const sk = topic(`endr-outage-${name.replace(/\W+/g, "-")}`);
      ctx.appendLocalMessage(sk, "user", "ping");
      const turn = ctx.createPartialMessage(sk, "assistant");
      ctx.updateLastMessage(sk, { content: "Meta' del lavoro, poi" }, { rowId: turn.id });
      boot([sk]);
      await reattachLeg(sk, end);
      await endReattachLeg(ctx, sk, broker("idle"));
      expect([name, ctx.getMessageById(turn.id)?.endReason]).toEqual([name, expected]);
    }
  });
});

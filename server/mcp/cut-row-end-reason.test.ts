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
 * (chat-woken-turn, chat-watchdog-finalize).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "../routes/topics";
import { createEditRouter } from "../routes/edit";
import { runBootPartialSweep, type PartialSweepDb } from "../lib/boot-partial-sweep";
import { spiegaTurnoTroncato } from "../lib/turno-troncato";
import { registerProvider, removeProvider } from "../providers";
import { callReadChatMessages, callSendChatMessage } from "./topics-mcp-server";
import type { AppContext, Topic } from "../types";

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
    const woken = ctx.reuseHeadstoneOrCreate(sk);
    ctx.updateLastMessage(sk, { content: "Il Monitor ha chiuso, ora" }, { rowId: woken.id });
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
    const woken = ctx.reuseHeadstoneOrCreate(sk);
    ctx.updateLastMessage(sk, { content: "mezza frase del risveglio" }, { rowId: woken.id });
    boot();
    expect(await notes(tid)).toEqual([null, null, CUT_NOTE, null]);
  });
});

describe("the reattach and the send wait on the turn's own row", () => {
  test("B: a restart with the child alive adopts the turn's open row, not the sub-agent's report after it, and the send gets the whole reply", async () => {
    const tid = "endr-reattach";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "ping");
    const turn = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "Lancio il sotto-agente, " }, { rowId: turn.id });
    // subagent-watch.ts, while the turn runs.
    const report = ctx.appendLocalMessage(sk, "assistant", "Sotto-agente Lane A, esito: fatto.");
    boot([sk]);
    const adopted = ctx.reuseOrCreatePartialForReattach(sk);
    expect(adopted.id).toBe(turn.id);
    // The reattached leg ends: the whole answer on the adopted row.
    finished(sk, adopted.id, "Lancio il sotto-agente, e la risposta e' completa.");
    // server.ts after the leg, broker idle: whatever is still open is closed, and explained on the last row.
    ctx.db.run("UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1", [sk]);
    spiegaTurnoTroncato(ctx.db as never, sk);
    await expect(sendCut(tid, turn.id)).resolves.toBe("Lancio il sotto-agente, e la risposta e' completa.");
    expect(ctx.getMessageById(report.id)?.content).toBe("Sotto-agente Lane A, esito: fatto.");
  });

  test("C: a reattach leg closed with its latency, lit again because the broker says open, then killed: the row is cut, not a reply", async () => {
    const tid = "endr-reopen";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "ping");
    const turn = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "Meta' del lavoro, poi" }, { rowId: turn.id });
    // The leg ends on a turn still open (a mute replay): finalize, latency and all.
    finished(sk, turn.id, "Meta' del lavoro, poi");
    // server.ts: the broker says `open`, the row is lit again.
    ctx.db.run("UPDATE messages SET partial = 1 WHERE id = ?", [turn.id]);
    // Unclean restart, child gone.
    boot();
    expect(await notes(tid)).toEqual([null, CUT_NOTE, null]);
    await expect(sendCut(tid, turn.id)).rejects.toThrow(/closed from outside before it finished/);
  });

  test("a leg that ends on a turn still open lights the turn's row again, not the report written after it", async () => {
    const tid = "endr-relight";
    const sk = topic(tid);
    ctx.appendLocalMessage(sk, "user", "ping");
    const turn = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "Ti chiedo una cosa: " }, { rowId: turn.id });
    const report = ctx.appendLocalMessage(sk, "assistant", "Sotto-agente Lane B, esito: fatto.");
    boot([sk]);
    expect(ctx.reuseOrCreatePartialForReattach(sk).id).toBe(turn.id);
    // The mute leg ends; the broker says the turn is still open (a question on screen).
    finished(sk, turn.id, "Ti chiedo una cosa: ");
    ctx.relightReattachedRow(sk);
    expect([ctx.getMessageById(turn.id)?.partial, ctx.getMessageById(report.id)?.partial]).toEqual([true, undefined]);
    // Killed, child gone: the turn is the cut one, the report is whole.
    boot();
    expect(await notes(tid)).toEqual([null, CUT_NOTE, null, null]);
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

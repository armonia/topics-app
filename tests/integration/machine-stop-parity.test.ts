/**
 * A STOP THE MACHINE WANTED ENDS AS ON MAIN, AND IS NOT THE PERSON'S (card C9,
 * third review of PR #135).
 *
 * The rule (Attilio's): a land (`superseded`), a delegation's deadline
 * (`wall-clock`) and the stall judge (`stall`) stop a turn on purpose. That
 * turn ends as every route stop ended on main: no "Riprendo da solo" notice, an
 * empty row discarded, nothing resent. The one difference from main is that it
 * is not written down as the person's Stop: only `user` enters that memory.
 *
 * The second review measured the opposite: the route reduced every machine
 * cause to `watchdog`, claude-code answers an abort with a synchronous
 * `onAborted` carrying that reason, and the finalize wrote the watchdog's
 * resumable notice. After a land the sweep resent the card's last envelope;
 * after a stall recycle of an empty woken row it resent a message already
 * answered, the duplicate class of 3019832f.
 *
 * Ported from the reviewers' repros: the chat and topics routes and the sweep
 * are real, and the provider behaves like claude-code on abort.
 *
 * @covers RESUME-02
 * @covers CHAT-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { createTopicsRouter } from "../../server/routes/topics";
import { riprendiTurniInterrotti } from "../../server/lib/ripresa-boot";
import { internalAbortRequest } from "../../server/lib/abort-cause";
import { STOP_PRESSED_LOG_TITLE } from "../../server/lib/cancelled-notice";
import { readTurnEnd, resetTurnEndRegistry } from "../../server/providers/turn-end-registry";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, StoredMessage, Topic } from "../../server/types";
import { HEADSTONE_PREFIX } from "../../server/lib/empty-turn-headstone";
import { turnIsOnlyError, turnLooksUnanswered } from "../../client/src/components/Chat/turnError";

const TEST_DATA = testTmpDir("machine-stop-parity-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

let captured: StreamHandler | undefined;
const reasons: string[] = [];
/** What the provider still says between the stop and its abort echo (ACP, native). */
let beforeEcho: ((h: StreamHandler) => void) | null = null;
/** false = a provider whose abort ends the turn later (ACP, Codex): the route finalizes first. */
let echoesAbort = true;
const registered = registerProvider({ type: "openai", apiKey: "" } as never) as unknown as Record<string, unknown>;
Object.defineProperty(registered, "connected", { configurable: true, get: () => true });
// Like claude-code's abort(): a synchronous onAborted with the reason it got.
registered.abort = async (_sk: string, _runId: string | undefined, reason: string) => {
  reasons.push(reason);
  if (!echoesAbort) return;
  if (captured && beforeEcho) beforeEcho(captured);
  captured?.onAborted?.({ turnEnd: { end: "cancelled", cause: reason } } as never);
};
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function chatWith(sessionKey: string, rows: StoredMessage[] = []) {
  captured = undefined;
  beforeEcho = null;
  echoesAbort = true;
  reasons.length = 0;
  const ctx: AppContext = await createTestAppContext();
  const sent: Array<Record<string, unknown>> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { sent.push(m as Record<string, unknown>); };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = (_id, m) => { sent.push(m as Record<string, unknown>); };
  ctx.saveSingleTopic({
    id: `t-${sessionKey}`, name: "stop parity", slug: "stop-parity", parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archived: false, provider: "openai",
  } as Topic);
  if (rows.length) ctx.saveLocalMessages(sessionKey, rows);
  const provider = {
    name: "fake", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise(() => {}),
    reattach: (_sk: string, h: StreamHandler) => { captured = h; return new Promise(() => {}); },
    defaultModel: () => "fake-model", abort: async () => {}, start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  const chat = createChatRouter(ctx, {
    resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
    resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [],
    autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: testTmpDir("machine-stop-parity-ws"),
  } as never);
  const topics = createTopicsRouter(ctx);

  const post = async (body: Record<string, unknown>) => {
    const url = new URL("http://localhost/api/chat");
    const resp = await chat(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, ...body }),
    }), url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    expect(captured).toBeDefined();
  };
  const abort = async (req: Request) => {
    const resp = await topics(req, new URL(req.url), "/api/chat/abort", "POST") as Response;
    expect(resp.status).toBe(200);
  };
  /** What the person's client sends: a plain request, whatever its body claims. */
  const clientAbort = (extra: Record<string, unknown> = {}) => abort(new Request("http://topics.test/api/chat/abort", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, ...extra }),
  }));
  const assistantRows = () => ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant");
  const notices = () => assistantRows().flatMap((m) => (m.blocks ?? []).filter((b: ContentBlock) => b.kind === "error"));
  const stopsOnRecord = () => (ctx.db.query(
    "SELECT COUNT(*) AS n FROM activity_log WHERE session_key = ? AND title = ?",
  ).get(sessionKey, STOP_PRESSED_LOG_TITLE) as { n: number }).n;
  /** The first sweep after a boot: the registry empty, the database as the stop left it. */
  const resentAfterRestart = async (): Promise<string[]> => {
    ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ? AND role = 'user'", [minutesAgo(10), sessionKey]);
    resetTurnEndRegistry();
    const resent: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
      await riprendiTurniInterrotti(
        {
          db: ctx.db, getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k),
          isStreaming: () => false, providerBusy: () => false, bootedAtMs: Date.now(),
        },
        async (req) => {
          const body = await req.clone().json().catch(() => null) as { sessionKey?: string; messages?: Array<{ content?: string }> } | null;
          if (body?.sessionKey === sessionKey) resent.push(body.messages?.[0]?.content ?? "");
          return new Response(null, { status: 200 });
        },
        { responseMs: 300, streamMs: 300 },
      );
    } finally { console.log = log; console.warn = warn; }
    return resent;
  };
  return { ctx, sent, post, abort, clientAbort, assistantRows, notices, stopsOnRecord, resentAfterRestart };
}

describe("a stop the machine wanted ends as on main, and is not the person's", () => {
  for (const cause of ["superseded", "wall-clock", "stall"] as const) {
    test(`${cause}: no notice, nothing resent, the true cause recorded, no Stop of the person`, async () => {
      const sk = `topic:machine-${cause}`;
      const c = await chatWith(sk);
      await c.post({ messages: [{ role: "user", content: "Envelope della card: fai il merge" }] });
      captured!.onTextDelta("Sto facendo il merge del ramo...", "Sto facendo il merge del ramo...");

      await c.abort(internalAbortRequest(sk, cause));

      // The cause reaches the provider and the registry as it was said.
      expect(reasons).toEqual([cause]);
      expect(readTurnEnd(sk)?.info).toMatchObject({ end: "cancelled", cause });
      // As on main: the partial answer stays, with no notice on it.
      expect(c.assistantRows().at(-1)?.content).toContain("Sto facendo il merge");
      expect(c.notices()).toEqual([]);
      // Not the person's Stop, and still nothing for the sweep to resume.
      expect(c.stopsOnRecord()).toBe(0);
      expect(await c.resentAfterRestart()).toEqual([]);
    });
  }

  test("an event the provider still sends before its abort echo does not turn the echo into a notice (ACP, native)", async () => {
    // ACP may send a tool update after `session/cancel`, and the native loop
    // reports the tool it killed before `onAborted`: either opened the late
    // lane, and the echo that followed wrote the cause's notice.
    const sk = "topic:machine-echo";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "rallenta pure" }] });
    captured!.onToolStart("toolu_slow", "Bash", { command: "sleep 600" } as never);
    beforeEcho = (h) => h.onToolResult("toolu_slow", "killed", true);

    await c.abort(internalAbortRequest(sk, "wall-clock"));

    expect(c.notices()).toEqual([]);
    expect(await c.resentAfterRestart()).toEqual([]);
  });

  test("a tool in flight when the machine stops the turn is closed on screen too, not left spinning", async () => {
    // A machine stop no longer passes through the finalize that announced the
    // tools it closed; `endStream` closes them in the row, and the screens are
    // told as the watchdogs tell them (chat.ts `endStreamAndAnnounce`).
    const sk = "topic:machine-tool";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "lancia la suite" }] });
    captured!.onToolStart("toolu_suite", "Bash", { command: "bun test" } as never);
    const rowId = c.assistantRows().at(-1)!.id;

    await c.abort(internalAbortRequest(sk, "stall"));

    const result = c.sent.find((m) => m.type === "stream:tool_result" && m.toolCallId === "toolu_suite");
    expect(result).toMatchObject({ status: "error", messageId: rowId });
  });

  test("the stall judge recycling an empty woken row: the row is discarded and the answered message is not resent", async () => {
    // The shape of 3019832f on 25/09: an answered message, then a woken row the
    // restart left partial and empty, adopted by a headless reattach.
    const sk = "topic:c9-woken";
    const c = await chatWith(sk, [
      { id: `${sk}-u`, role: "user", content: "Due cose per il vortice, da girare SUBITO", timestamp: minutesAgo(40) },
      {
        id: `${sk}-a`, role: "assistant", content: "Fatto: barra verde.", timestamp: minutesAgo(20), parentId: `${sk}-u`,
        blocks: [{ kind: "text", text: "Fatto: barra verde." }], latencyMs: 1000,
      },
      { id: `${sk}-w`, role: "assistant", content: "", timestamp: minutesAgo(15), partial: true, parentId: `${sk}-a` },
    ] as StoredMessage[]);
    await c.post({ messages: [], mode: "reattach", dispatched: true, provider: "openai" });

    await c.abort(internalAbortRequest(sk, "stall"));

    expect(c.assistantRows().map((m) => m.id)).toEqual([`${sk}-a`]);
    expect(await c.resentAfterRestart()).toEqual([]);
  });

  test("a landed or archived card's chat is left alone; one still on the board is resumed as on main", async () => {
    // A cut the sweep WOULD resume (a watchdog verdict, nothing after it), on
    // the chat of a card. Landed, the card is `done` and keeps its topic: the
    // sweep resent its last envelope and an agent redid work already on main.
    const cut = (sk: string): StoredMessage[] => [
      { id: `${sk}-u`, role: "user", content: "Envelope della card", timestamp: minutesAgo(12) },
      {
        id: `${sk}-a`, role: "assistant", content: "", timestamp: minutesAgo(11), parentId: `${sk}-u`,
        blocks: [{ kind: "tool", toolCall: { id: "t1", name: "Bash", status: "error" } }, { kind: "error", text: "Turno interrotto.", cause: "watchdog" }],
      },
    ] as StoredMessage[];
    const bindCard = (c: Awaited<ReturnType<typeof chatWith>>, sk: string, status: string, archived: number) =>
      c.ctx.db.run(
        "INSERT INTO tasks (id, project_id, text, status, archived, assigned_topic_id, created_at, updated_at) VALUES (?, 'p-parity', 'card', ?, ?, ?, ?, ?)",
        [`card-${sk}`, status, archived, `t-${sk}`, minutesAgo(30), minutesAgo(1)],
      );

    const free = await chatWith("topic:card-none", cut("topic:card-none"));
    expect(await free.resentAfterRestart()).toEqual(["Envelope della card"]);

    for (const [status, archived] of [["done", 0], ["review", 1], ["done", 1]] as const) {
      const sk = `topic:card-${status}-${archived}`;
      const c = await chatWith(sk, cut(sk));
      bindCard(c, sk, status, archived);
      expect(await c.resentAfterRestart()).toEqual([]);
    }
    // A card still on the board keeps main's rule for a cut turn: the notice
    // says «Riprendo da solo», and somebody does.
    for (const status of ["todo", "in_progress", "review"] as const) {
      const sk = `topic:card-live-${status}`;
      const c = await chatWith(sk, cut(sk));
      bindCard(c, sk, status, 0);
      expect(await c.resentAfterRestart()).toEqual(["Envelope della card"]);
    }
  });

  test("the person's Stop: no notice, nothing resent, and the Stop is kept", async () => {
    const sk = "topic:machine-person";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "fermati pure" }] });
    captured!.onTextDelta("Comincio...", "Comincio...");

    await c.clientAbort();

    expect(reasons).toEqual(["user"]);
    expect(c.notices()).toEqual([]);
    expect(c.stopsOnRecord()).toBe(1);
    expect(await c.resentAfterRestart()).toEqual([]);
  });

  test("a request from outside the server cannot declare a machine cause: it is the person's Stop", async () => {
    const sk = "topic:machine-spoofed";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "ciao" }] });

    await c.clientAbort({ cause: "stall" });

    expect(reasons).toEqual(["user"]);
    expect(readTurnEnd(sk)?.info).toMatchObject({ cause: "user" });
    expect(c.stopsOnRecord()).toBe(1);
  });
});

/**
 * AN EMPTY TURN THE MACHINE STOPPED OFFERS NO RETRY, AFTER A RELOAD TOO (card
 * 46617a7f).
 *
 * A stop the machine wanted discards an empty turn's row (above), and the chat
 * then ends on the message that turn was answering: for a card, the
 * dispatcher's envelope. The client reads that shape as a reply that never
 * came (`turnLooksUnanswered`) and offers «Riprova», which resends the envelope:
 * a paid turn to redo work already on main. Measured on the production DB
 * before the fix: 11 card chats ending on an envelope, the card landed about a
 * second later, nothing under it.
 *
 * "Reload" here is what the history route serves (`loadLocalMessages`), read
 * by the client's own rules, so the verdict survives a reload by construction.
 */
describe("an empty turn the machine stopped offers no retry, after a reload too", () => {
  /** What the client decides on the rows the history route serves. */
  const retryOffered = (rows: StoredMessage[]) => {
    const last = rows.at(-1);
    const banner = turnLooksUnanswered({
      lastMessageIsUser: last?.role === "user",
      locallyStreaming: false,
      serverSaysOpen: false,
      serverAsked: true,
    });
    const bubble = last?.role === "assistant" && turnIsOnlyError(last);
    return banner || bubble;
  };

  for (const cause of ["superseded", "wall-clock", "stall"] as const) {
    for (const echoes of [true, false]) {
      const order = echoes ? "the provider finalizes first (claude-code)" : "the route finalizes first (ACP, Codex)";
      test(`${cause}, ${order}: a service row under the envelope, no retry, nothing resent`, async () => {
        const sk = `topic:empty-${cause}-${echoes ? "echo" : "late"}`;
        const c = await chatWith(sk);
        echoesAbort = echoes;
        await c.post({ messages: [{ role: "user", content: "Envelope della card: fai il merge" }] });
        const turnRowId = c.assistantRows().at(-1)!.id;

        await c.abort(internalAbortRequest(sk, cause));

        const rows = c.ctx.loadLocalMessages(sk);
        expect(rows.some((m) => m.id === turnRowId)).toBe(false);
        expect(retryOffered(rows)).toBe(false);
        // The row that says why. Its `content` is empty on purpose: the model's
        // history and the dispatcher's "last words of the agent" read only
        // `content`, and a sentence there would reach both.
        const notice = rows.at(-1)!;
        expect(notice.role).toBe("assistant");
        expect(notice.content).toBe("");
        expect(notice.blocks).toEqual([{ kind: "machine-stop", cause }]);
        expect(notice.parentId).toBe(rows.at(-2)!.id);
        // A window watching the chat gets it live, before the stop's end: its
        // handler drops a `message:new` without text, so the frame carries one.
        const live = c.sent.findIndex((m) => m.type === "message:new" && m.messageId === notice.id);
        expect(live).toBeGreaterThanOrEqual(0);
        expect(c.sent[live]).toMatchObject({ role: "assistant", blocks: [{ kind: "machine-stop", cause }] });
        expect(String(c.sent[live].content ?? "")).not.toBe("");
        const routeEnd = c.sent.findLastIndex((m) => m.type === "stream:end");
        expect(live).toBeLessThan(routeEnd);
        expect(await c.resentAfterRestart()).toEqual([]);
      });
    }
  }

  test("a turn that produced something keeps its own row, and gets no service row", async () => {
    const sk = "topic:kept-superseded";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "Envelope della card" }] });
    captured!.onTextDelta("Comincio il merge", "Comincio il merge");

    await c.abort(internalAbortRequest(sk, "superseded"));

    const rows = c.ctx.loadLocalMessages(sk);
    expect(rows.at(-1)?.content).toContain("Comincio il merge");
    expect(rows.flatMap((m) => m.blocks ?? []).some((b) => b.kind === "machine-stop")).toBe(false);
  });

  test("the stall judge on an empty woken row under an answer: nothing to explain, no service row", async () => {
    // The chat ends on an answer once the woken row is gone: no retry was on
    // offer, and a line saying a turn was stopped would sit under a reply.
    const sk = "topic:woken-no-notice";
    const c = await chatWith(sk, [
      { id: `${sk}-u`, role: "user", content: "Fai il giro", timestamp: minutesAgo(40) },
      { id: `${sk}-a`, role: "assistant", content: "Fatto.", timestamp: minutesAgo(20), parentId: `${sk}-u` },
      { id: `${sk}-w`, role: "assistant", content: "", timestamp: minutesAgo(15), partial: true, parentId: `${sk}-a` },
    ] as StoredMessage[]);
    await c.post({ messages: [], mode: "reattach", dispatched: true, provider: "openai" });

    await c.abort(internalAbortRequest(sk, "stall"));

    expect(c.ctx.loadLocalMessages(sk).map((m) => m.id)).toEqual([`${sk}-u`, `${sk}-a`]);
    expect(c.sent.some((m) => m.type === "message:new")).toBe(false);
  });

  test("the person's Stop on an empty turn is not the machine's: no service row", async () => {
    const sk = "topic:empty-person";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "fermati pure" }] });

    await c.clientAbort();

    const rows = c.ctx.loadLocalMessages(sk);
    expect(rows.at(-1)?.role).toBe("user");
    expect(rows.flatMap((m) => m.blocks ?? []).some((b) => b.kind === "machine-stop")).toBe(false);
  });

  test("the opposite: a turn that really came back empty keeps its notice and its retry", async () => {
    // No stop at all: the provider closed the turn with nothing. That is a
    // failure the person can act on, and «Riprova» is the right offer.
    const sk = "topic:empty-for-real";
    const c = await chatWith(sk);
    await c.post({ messages: [{ role: "user", content: "rispondi" }] });

    captured!.onDone({} as never);

    const rows = c.ctx.loadLocalMessages(sk);
    const last = rows.at(-1)!;
    expect(last.content.startsWith(HEADSTONE_PREFIX)).toBe(true);
    expect(retryOffered(rows)).toBe(true);
    expect(rows.flatMap((m) => m.blocks ?? []).some((b) => b.kind === "machine-stop")).toBe(false);
  });
});

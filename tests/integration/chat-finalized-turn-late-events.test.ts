/**
 * A CLOSED TURN WRITES ON NO ROW BUT ITS OWN (card 1046df0b, C3).
 *
 * The body of a turn used to reach the database through `updateLastMessage`
 * and friends, which write the LAST row of the session, whatever it is. Once
 * the grace watchdog had closed a turn, its handler stayed wired to the
 * provider: a send still waiting in the provider's queue installed that same
 * handler on a fresh child, and everything the CLI answered afterwards was
 * written on whatever row was last at that moment. On 24/09, chat 3019832f,
 * the resume sweep's notices were those rows: one got its content turned into
 * «⚠️ Response timed out... Please try again.Due problemi nuovi...», and the  allow-italian: the corrupted row, verbatim
 * blocks it inherited (`error{cause:"watchdog"}`) made the next sweep read the
 * notice as one more interruption of ours and write another notice. Six in
 * thirty minutes.
 *
 * The rules:
 *   - a finalized turn's late answer is kept on ITS row, under the cut, never
 *     on a row born after it; its frames name that row (review of PR #135);
 *   - so the sweep reads it as answered and does not resend the message;
 *   - a question or a permission of a late answer lands on that row too, and a
 *     permission no row announced is refused instead of held for two hours;
 *   - a LIVE turn writes on its row by id, so a row born after it (a notice,
 *     anything) is never the target of its body or its tools.
 *
 * Ten deltas and not one: the text is persisted every SAVE_INTERVAL (10)
 * deltas, so a single late delta never reaches the database and the content
 * half of the bug stays invisible (the verifier's objection on the card).
 *
 * @covers CHAT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { createChatRouter } from "../../server/routes/chat";
import { insertRestartNotification, type PartialSweepDb } from "../../server/lib/boot-partial-sweep";
import { RESUME_CAP_MARKER, resumeVerdict, riprendiTurniInterrotti } from "../../server/lib/ripresa-boot";
import { createPermissionRouter } from "../../server/routes/permission";
import { beginPermission, cancelPermissionsForSession } from "../../server/lib/permission-bridge";
import { decodeCol } from "../../shared/message-blob";
import { flushTurnBody } from "../../server/lib/turn-body-flush";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-finalized-late-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

const PREVIOUS_SOFT = process.env.TOPICS_STREAM_SOFT_MS;
const PREVIOUS_GRACE = process.env.TOPICS_STREAM_GRACE_MS;
// Shrunk so the watchdog closes the silent turn in milliseconds, widened with
// the load like the sibling watchdog test (card 0f4cbccb).
const SILENCE_MS = String(slackMs(60));
process.env.TOPICS_STREAM_SOFT_MS = SILENCE_MS;
process.env.TOPICS_STREAM_GRACE_MS = SILENCE_MS;
afterAll(() => {
  if (PREVIOUS_SOFT === undefined) delete process.env.TOPICS_STREAM_SOFT_MS;
  else process.env.TOPICS_STREAM_SOFT_MS = PREVIOUS_SOFT;
  if (PREVIOUS_GRACE === undefined) delete process.env.TOPICS_STREAM_GRACE_MS;
  else process.env.TOPICS_STREAM_GRACE_MS = PREVIOUS_GRACE;
});

interface WireMessage { type: string; [k: string]: unknown }

/** The raw columns, compared byte for byte: a rewrite with the same meaning is still a write. */
interface RawRow { content: unknown; blocks: unknown; tool_calls: unknown }

async function harness(sessionKey: string) {
  const ctx: AppContext = await createTestAppContext();
  const sent: WireMessage[] = [];

  const topic: Topic = {
    id: `t-${sessionKey}`, name: "late events", slug: "late-events", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);

  (ctx as { broadcastToAll: (m: unknown) => void })
    .broadcastToAll = (m) => { sent.push(m as WireMessage); };
  // Every write that carries the timeline, with the row it was aimed at: what
  // a late answer costs is counted here, not guessed.
  const blockWrites: string[] = [];
  const realUpdate = ctx.updateLastMessage;
  (ctx as { updateLastMessage: typeof realUpdate }).updateLastMessage = (sk, updates, opts) => {
    if (updates.blocks !== undefined) blockWrites.push(opts?.rowId ?? "last");
    return realUpdate(sk, updates, opts);
  };
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
    .broadcastToTopicSubscribers = (_id, m) => { sent.push(m as WireMessage); };

  let captured: StreamHandler | undefined;
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming", "tool-phases"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
    unregisterStreamHandler: () => {},
    // Never settles: the send the watchdog gives up on is still pending in the
    // provider, which is exactly the zombie of C2.
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
    WORKSPACE_DIR: testTmpDir("chat-finalized-late-ws"),
  } as never);

  const startTurn = async (): Promise<StreamHandler> => {
    const url = new URL("http://topics.test/api/chat");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "sistema la nuvola" }] }),
    });
    const resp = await chatRouter(req, url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  const lastRowId = (): string => (ctx.db.query(
    "SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1",
  ).get(sessionKey) as { id: string }).id;

  const raw = (id: string): RawRow => ctx.db.query(
    "SELECT content, blocks, tool_calls FROM messages WHERE id = ?",
  ).get(id) as RawRow;

  const blocksOf = (id: string): ContentBlock[] => {
    const r = raw(id);
    return JSON.parse(decodeCol(r.blocks as never) ?? "[]") as ContentBlock[];
  };

  /** A person's row after the turn, with no blocks: every writer really writes there if aimed at it. */
  const appendUserRow = (text: string): string => {
    ctx.appendLocalMessage(sessionKey, "user", text);
    return lastRowId();
  };

  /** Writes the resume sweep's cap notice: the row the incident rewrote. */
  const insertNotice = (): string => {
    insertRestartNotification(ctx.db as unknown as PartialSweepDb, sessionKey, { text: RESUME_CAP_MARKER });
    return lastRowId();
  };

  return { ctx, sent, blockWrites, startTurn, lastRowId, raw, blocksOf, insertNotice, appendUserRow };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for the condition, not for the clock (see the sibling watchdog test). */
const until = async (ready: () => boolean, budgetMs = slackMs(5_000)): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) await sleep(25);
};

/** Ten late deltas, one late tool and a late end: what the CLI answered to a turn already closed. */
function driveLateTurn(handler: StreamHandler): void {
  let total = "";
  for (let i = 1; i <= 10; i++) {
    const d = `Due problemi nuovi ${i}. `;
    total += d;
    handler.onTextDelta(d, total);
  }
  handler.onToolStart("toolu_late", "Bash", { command: "git merge feature/sito-nuovo" } as never);
  handler.onToolResult("toolu_late", "merged", false);
  handler.onDone({ content: [{ type: "text", text: total + "Ho sistemato tutti e tre i problemi." }] } as never);
}

describe("a closed turn writes on no row but its own", () => {
  test("a late answer lands on the closed turn's own row, under the cut, and the notice after it stays byte for byte", async () => {
    const h = await harness("topic:late-after-grace");
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();

    // The provider says nothing: soft + grace expire, the watchdog closes T1.
    await until(() => h.sent.some((m) => m.type === "stream:end"));
    expect(h.sent.some((m) => m.type === "stream:end" && m.stopCause === "watchdog")).toBe(true);
    const turnAtClose = h.raw(turnRowId);

    // The sweep writes its notice: from now on it is the last row.
    const noticeId = h.insertNotice();
    expect(noticeId).not.toBe(turnRowId);
    const noticeBefore = h.raw(noticeId);

    driveLateTurn(handler);
    await sleep(50);

    // The notice is untouched: content, blocks and tool calls.
    expect(h.raw(noticeId)).toEqual(noticeBefore);
    // Which is what keeps the next sweep from reading it as a cut of ours.
    const notice = h.ctx.db.query("SELECT role, timestamp FROM messages WHERE id = ?")
      .get(noticeId) as { role: string; timestamp: string };
    expect(resumeVerdict({
      sessionKey: "topic:late-after-grace", ruolo: notice.role, blocks: h.blocksOf(noticeId),
      timestampMs: Date.parse(notice.timestamp), attempts: 0,
    }, Date.now())).toBe("no");
    // The late answer is KEPT, on T1's own row and under the cut (Attilio's
    // call in the review of PR #135): the timeout block first, then the text,
    // the tool and the tail that only the end carried.
    const closedContent = decodeCol(turnAtClose.content as never) ?? "";
    const content = decodeCol(h.raw(turnRowId).content as never) ?? "";
    expect(content.startsWith(`${closedContent}\n\n`)).toBe(true);
    expect(content).toContain("Due problemi nuovi 10.");
    expect(content).toContain("Ho sistemato tutti e tre i problemi.");
    const kinds = h.blocksOf(turnRowId).map((b) => b.kind);
    const cut = kinds.lastIndexOf("error");
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(kinds.slice(cut + 1)).toEqual(["text", "tool", "text"]);
    // And every late frame named that row and said it was late.
    const lateFrames = h.sent.filter((m) => m.late === true);
    expect(lateFrames.length).toBeGreaterThan(0);
    expect(lateFrames.every((m) => m.messageId === turnRowId)).toBe(true);
    expect(h.sent.some((m) => m.type === "stream:tool_call" && m.late === true && m.messageId === turnRowId)).toBe(true);
  });

  test("the message a late answer answered is not resent: the sweep reads the answer under the cut", async () => {
    // The exact shape of 3019832f: the queue drains, the CLI really answers,
    // and nothing is written after the closed turn, so the sweep judges T1.
    const sk = "topic:late-answered";
    const h = await harness(sk);
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();
    await until(() => h.sent.some((m) => m.type === "stream:end"));

    driveLateTurn(handler);
    await sleep(20);
    expect(h.lastRowId()).toBe(turnRowId);

    const row = h.ctx.db.query("SELECT role, timestamp FROM messages WHERE id = ?").get(turnRowId) as { role: string; timestamp: string };
    expect(resumeVerdict({
      sessionKey: sk, ruolo: row.role, blocks: h.blocksOf(turnRowId), timestampMs: Date.parse(row.timestamp), attempts: 0,
    }, Date.now())).toBe("no");

    const resent: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
      await riprendiTurniInterrotti(
        {
          db: h.ctx.db,
          getTopicBySessionKey: (key) => h.ctx.getTopicBySessionKey(key),
          isStreaming: () => false,
          providerBusy: () => false,
          bootedAtMs: Date.now() - 3_600_000,
        },
        () => { resent.push(sk); return new Response(null, { status: 200 }); },
        { responseMs: 500, streamMs: 500 },
      );
    } finally { console.log = log; console.warn = warn; }
    expect(resent).toEqual([]);
  });

  test("a permission asked by a late answer is painted on the closed turn's row, where it can be answered", async () => {
    // Card C8 (de3b5a0b). The zombie announces a Bash call, then the CLI's
    // permission tool asks Topics over HTTP whether it may run it.
    const sk = "topic:late-perm";
    const h = await harness(sk);
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();
    await until(() => h.sent.some((m) => m.type === "stream:end"));
    const noticeId = h.insertNotice();
    const noticeBefore = h.raw(noticeId);

    handler.onToolStart("toolu_perm", "Bash", { command: "git push origin main" } as never);
    const perm = createPermissionRouter(h.ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(sk)}/permission`);
    try {
      const resp = await perm(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: "Bash", toolUseId: "toolu_perm", input: { command: "git push origin main" }, legMs: 150 }),
      }), url, url.pathname, "POST") as Response;
      expect(await resp.json()).toEqual({ pending: true });
      const tool = h.blocksOf(turnRowId).find((b) => b.kind === "tool" && b.toolCall.id === "toolu_perm");
      expect(tool && tool.kind === "tool" ? tool.toolCall.status : null).toBe("awaiting_permission");
      expect(h.raw(noticeId)).toEqual(noticeBefore);
      expect(h.sent.some((m) => m.type === "stream:tool_permission_required" && m.toolCallId === "toolu_perm")).toBe(true);
    } finally {
      cancelPermissionsForSession(sk, "test over");
    }
  });

  test("a permission for a tool no row announced is refused after a short grace, not held for two hours", async () => {
    const sk = "topic:perm-nobody";
    const h = await harness(sk);
    await h.startTurn();
    await until(() => h.sent.some((m) => m.type === "stream:end"));
    // The request has been open for a minute and still no row carries it.
    beginPermission(sk, "toolu_ghost", undefined, Date.now() - 60_000);
    const perm = createPermissionRouter(h.ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(sk)}/permission`);
    try {
      const resp = await perm(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: "Bash", toolUseId: "toolu_ghost", input: {}, legMs: 150 }),
      }), url, url.pathname, "POST") as Response;
      const out = await resp.json() as { cancelled?: boolean };
      expect(out.cancelled).toBe(true);
    } finally {
      cancelPermissionsForSession(sk, "test over");
    }
  });

  test("a question in a late answer lands on the closed turn's own row, where it can be answered", async () => {
    const h = await harness("topic:late-ask");
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();
    await until(() => h.sent.some((m) => m.type === "stream:end"));
    const noticeId = h.insertNotice();
    const noticeBefore = h.raw(noticeId);

    // The late answer asks the person: announcement, arguments, then the
    // verdict that it is a question, each on the closed turn's row by id.
    handler.onToolStart("toolu_ask", "mcp__topics__ask_user_question", {} as never);
    const questions = [{ question: "Quale ramo?", header: "Ramo", options: [{ label: "main" }, { label: "sito" }] }];
    handler.onToolArgsUpdate?.("toolu_ask", { questions } as never);
    handler.onTextDelta("testo tardivo ", "testo tardivo ");
    handler.onUserInputRequired?.("toolu_ask", "mcp__topics__ask_user_question", { kind: "questions", questions } as never);

    // On screen: the panel event went out for that tool.
    expect(h.sent.some((m) => m.type === "stream:tool_user_input_required" && m.toolCallId === "toolu_ask")).toBe(true);
    // In the database: on the turn's own row, waiting for the answer.
    const ask = h.blocksOf(turnRowId).find((b) => b.kind === "tool" && b.toolCall.id === "toolu_ask");
    expect(ask && ask.kind === "tool" ? ask.toolCall.status : null).toBe("waiting_for_input");
    // The answer closes it, on the same row. Through the turn's throttle, like
    // a live turn's tools: a reader that opens the row flushes it first, and
    // the late answer's flush is registered while it runs.
    handler.onToolResult("toolu_ask", "sito", false);
    expect(flushTurnBody("topic:late-ask")).toBe(true);
    const answered = h.blocksOf(turnRowId).find((b) => b.kind === "tool" && b.toolCall.id === "toolu_ask");
    expect(answered && answered.kind === "tool" ? answered.toolCall.status : null).toBe("success");
    // The late text is kept on the same row (every write is by id), the
    // question's frame named that row, and the notice is untouched.
    handler.onDone({} as never);
    expect(decodeCol(h.raw(turnRowId).content as never)).toContain("testo tardivo");
    expect(h.sent.some((m) => m.type === "stream:tool_call" && m.messageId === turnRowId && m.late === true)).toBe(true);
    expect(h.raw(noticeId)).toEqual(noticeBefore);
  });

  test("a compaction reaching a closed turn is still recorded: it is the session's fact, not the turn's row", async () => {
    const h = await harness("topic:late-compaction");
    const handler = await h.startTurn();
    await until(() => h.sent.some((m) => m.type === "stream:end"));

    // The late answer auto-compacts the CLI session. The marker is what resets
    // the inline-preamble dedup: lost, the next turns skip the topic context.
    handler.onCompaction?.({ trigger: "auto", preTokens: 180_000 } as never);

    const markers = h.ctx.db.query("SELECT trigger FROM compaction_markers WHERE session_key = ?")
      .all("topic:late-compaction") as Array<{ trigger: string }>;
    expect(markers.map((m) => m.trigger)).toEqual(["auto"]);
  });

  test("a live turn writes its body and its tools on its own row even when a newer row exists", async () => {
    const h = await harness("topic:live-by-id");
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();

    let total = "";
    const first = "prima parte ";
    total += first;
    handler.onTextDelta(first, total);

    // A row born after the turn while it is still streaming, and one WITHOUT
    // blocks on purpose: on a row that has blocks (a sweep notice does) the
    // tool column write is skipped, so a tool writer aimed at the last row
    // would leave that row identical and this test would prove nothing about
    // the tools. A resend's user row is the realistic shape.
    const laterRowId = h.appendUserRow("scrivo mentre risponde");
    const laterRowBefore = h.raw(laterRowId);

    for (let i = 1; i <= 10; i++) {
      const d = `pezzo ${i} `;
      total += d;
      handler.onTextDelta(d, total);
    }
    handler.onToolStart("toolu_live", "Read", {} as never);
    handler.onToolArgsUpdate?.("toolu_live", { file_path: "/tmp/x" } as never);
    handler.onToolUsage?.("toolu_live", { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 });
    handler.onToolResult("toolu_live", "contenuto", false);
    handler.onDone({ content: [{ type: "text", text: total }] } as never);
    await until(() => h.sent.some((m) => m.type === "stream:end"));

    expect(h.raw(laterRowId)).toEqual(laterRowBefore);
    // The whole answer, tail included, is on the turn's own row.
    const turn = h.raw(turnRowId);
    expect(decodeCol(turn.content as never)).toBe(total);
    const blocks = h.blocksOf(turnRowId);
    expect(blocks.some((b) => b.kind === "tool" && b.toolCall.id === "toolu_live")).toBe(true);
    expect(blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("")).toContain("pezzo 10");
  });
});

describe("a late answer is kept whole, cheaply, on the row as its closer left it", () => {
  /** Watchdog-closed T1, then `n` late deltas: the shape every case below starts from. */
  async function closedTurnWithLateText(sk: string, n: number) {
    const h = await harness(sk);
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();
    await until(() => h.sent.some((m) => m.type === "stream:end"));
    let total = "";
    for (let i = 1; i <= n; i++) {
      const d = `pezzo${i} `;
      total += d;
      handler.onTextDelta(d, total);
    }
    return { h, handler, turnRowId };
  }

  test("a late answer that dies of an error keeps every delta and its thinking, and says why it stopped", async () => {
    // Fifteen deltas: the periodic save wrote the first ten, and the end that
    // saves the rest is the error, not `onDone`.
    const sk = "topic:late-error-end";
    const { h, handler, turnRowId } = await closedTurnWithLateText(sk, 15);
    handler.onThinkingDelta?.("sto pensando");
    handler.onError("API Error: 429 rate_limit_error");
    await sleep(20);

    const row = h.ctx.getMessageById(turnRowId);
    expect(row?.content).toContain("pezzo15");
    expect(row?.thinking).toContain("sto pensando");
    const blocks = h.blocksOf(turnRowId);
    // The failure is on the row, after the late answer: a notice the sweep
    // recognises, so the message is resumed like a live turn cut the same way.
    expect(blocks[blocks.length - 1]?.kind).toBe("error");
    const at = h.ctx.db.query("SELECT timestamp FROM messages WHERE id = ?").get(turnRowId) as { timestamp: string };
    expect(resumeVerdict({
      sessionKey: sk, ruolo: "assistant", blocks, timestampMs: Date.parse(at.timestamp), attempts: 0,
    }, Date.now())).toBe("resend");
  });

  test("a late answer that is aborted keeps every delta it streamed", async () => {
    const { h, handler, turnRowId } = await closedTurnWithLateText("topic:late-aborted-end", 15);
    handler.onAborted?.();
    await sleep(20);
    expect(h.ctx.getMessageById(turnRowId)?.content).toContain("pezzo15");
  });

  test("a long late answer goes through the write throttle, not one full rewrite per tool event", async () => {
    // Forty tools with a 4 KB result each: forced, that was a rewrite of the
    // whole timeline per event (eighty, and growing with the square of the
    // answer). Through the throttle it is a handful, and nothing is lost.
    const { h, handler, turnRowId } = await closedTurnWithLateText("topic:late-throttled", 1);
    const before = h.blockWrites.length;
    const result = "x".repeat(4_096);
    for (let i = 1; i <= 40; i++) {
      handler.onToolStart(`toolu_${i}`, "Read", {} as never);
      handler.onToolResult(`toolu_${i}`, result, false);
    }
    handler.onDone({ content: [{ type: "text", text: "pezzo1 fine" }] } as never);
    await sleep(20);

    expect(h.blockWrites.length - before).toBeLessThan(20);
    const tools = h.blocksOf(turnRowId).filter((b) => b.kind === "tool");
    expect(tools).toHaveLength(40);
    expect(tools.every((b) => b.kind === "tool" && b.toolCall.status === "success")).toBe(true);
  });

  test("a late write does not put back a tool the close marked as interrupted", async () => {
    // The close fixes the ROW (endStream turns a running tool into an error)
    // and not the route's copy of the timeline. Written back whole, that copy
    // set the tool running again, on a turn nothing will ever close.
    const h = await harness("topic:late-no-resurrect");
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();
    handler.onToolStart("toolu_orig", "Bash", { command: "sleep 600" } as never);
    await until(() => h.sent.some((m) => m.type === "stream:end"));
    const statusOf = () => h.blocksOf(turnRowId)
      .flatMap((b) => (b.kind === "tool" && b.toolCall.id === "toolu_orig" ? [b.toolCall.status] : []));
    expect(statusOf()).toEqual(["error"]);

    let total = "";
    for (let i = 1; i <= 10; i++) {
      const d = `tardi${i} `;
      total += d;
      handler.onTextDelta(d, total);
    }
    handler.onDone({ content: [{ type: "text", text: total }] } as never);
    await sleep(20);
    expect(statusOf()).toEqual(["error"]);
  });

  test("every frame a closed turn still sends names its row and says it is late, the tool results too", async () => {
    // The window that sent the NEXT turn drops the session's stream frames it
    // thinks its own SSE carries; a late frame of the turn before is not among
    // them, and the client lets it through only if it says so.
    const { h, handler, turnRowId } = await closedTurnWithLateText("topic:late-frames", 1);
    handler.onToolStart("toolu_f", "Read", {} as never);
    handler.onToolResult("toolu_f", "ok", false);
    await sleep(20);
    const result = h.sent.find((m) => m.type === "stream:tool_result" && m.toolCallId === "toolu_f");
    expect(result?.late).toBe(true);
    expect(result?.messageId).toBe(turnRowId);
  });
});

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
 * Two rules, one test each:
 *   - a finalized turn ignores whatever the provider still sends it;
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
import { RESUME_CAP_MARKER, resumeVerdict } from "../../server/lib/ripresa-boot";
import { decodeCol } from "../../shared/message-blob";
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

  /** Writes the resume sweep's cap notice: the row the incident rewrote. */
  const insertNotice = (): string => {
    insertRestartNotification(ctx.db as unknown as PartialSweepDb, sessionKey, { text: RESUME_CAP_MARKER });
    return lastRowId();
  };

  return { ctx, sent, startTurn, lastRowId, raw, blocksOf, insertNotice };
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
  test("events reaching a turn the watchdog closed leave the notice after it byte for byte", async () => {
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
    // And the closed turn stays closed: no late prose glued to its verdict.
    expect(h.raw(turnRowId)).toEqual(turnAtClose);
  });

  test("a live turn writes its body and its tools on its own row even when a newer row exists", async () => {
    const h = await harness("topic:live-by-id");
    const handler = await h.startTurn();
    const turnRowId = h.lastRowId();

    let total = "";
    const first = "prima parte ";
    total += first;
    handler.onTextDelta(first, total);

    // A row born after the turn while it is still streaming.
    const noticeId = h.insertNotice();
    const noticeBefore = h.raw(noticeId);

    for (let i = 1; i <= 10; i++) {
      const d = `pezzo ${i} `;
      total += d;
      handler.onTextDelta(d, total);
    }
    handler.onToolStart("toolu_live", "Read", { file_path: "/tmp/x" } as never);
    handler.onToolResult("toolu_live", "contenuto", false);
    handler.onDone({ content: [{ type: "text", text: total }] } as never);
    await until(() => h.sent.some((m) => m.type === "stream:end"));

    expect(h.raw(noticeId)).toEqual(noticeBefore);
    // The whole answer, tail included, is on the turn's own row.
    const turn = h.raw(turnRowId);
    expect(decodeCol(turn.content as never)).toBe(total);
    const blocks = h.blocksOf(turnRowId);
    expect(blocks.some((b) => b.kind === "tool" && b.toolCall.id === "toolu_live")).toBe(true);
    expect(blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("")).toContain("pezzo 10");
  });
});

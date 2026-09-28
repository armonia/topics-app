/**
 * THE PERSON'S ANSWER STAYS ON THE ROW WHEN THE TURN THAT ASKED WRITES AGAIN.
 *
 * `/api/chat/tool-response` records the answer (`userResponse`) on the tool's
 * row, by id. The turn that asked the question owns the row's timeline in
 * memory (`routes/chat.ts`) and writes it whole at every later write: the
 * tool's result, the throttle, the end of the turn. That copy never received
 * the answer, so the first write after it took the answer off the row, and a
 * reload showed the question with nothing under it. Third review of PR #135,
 * point 3. A late answer's question is the same case: the late lane
 * (`lib/late-answer-lane.ts`) writes from that same timeline.
 *
 * Two more roads to the same row. A SECOND submission of a question already
 * answered (another window, a stale panel) must not reach the timeline: the
 * tool it names has returned, and putting it back to running or to error is
 * what the turn then wrote. And a turn REATTACHED after a restart rebuilds its
 * timeline from the replay, which carries no answer: the one on the row before
 * the restart has to survive it (`routes/reattachMerge.ts`).
 *
 * Driven through the real chat route and the real tool-response route, on one
 * test database.
 *
 * @covers ASK-09
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { createChatRouter } from "../../server/routes/chat";
import { createTopicsRouter } from "../../server/routes/topics";
import { beginAsk, cancelAsk } from "../../server/lib/ask-user-bridge";
import { decodeCol } from "../../shared/message-blob";
import { _resetTurnBodyFlushers, flushTurnBody } from "../../server/lib/turn-body-flush";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, ToolCall, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-tool-response-live-turn-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

// The route's PROVIDER road (a tool paused on the CLI's stdin) resolves the
// topic's provider from the registry. Like claude-code's, it takes one answer
// per paused tool and refuses the next one with "no pending input".
const resumed = new Set<string>();
const registered = registerProvider({ type: "openai", apiKey: "" } as never) as unknown as Record<string, unknown>;
Object.defineProperty(registered, "connected", { configurable: true, get: () => true });
registered.resumeWithToolResponse = async (_sk: string, toolCallId: string) => {
  if (resumed.has(toolCallId)) throw new Error(`claude-code: no pending input for tool ${toolCallId}`);
  resumed.add(toolCallId);
};
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

const ASK_TOOL = "mcp__topics__ask_user_question";
const QUESTION = "Quale ramo?";
const ANSWERS = { [QUESTION]: "sito" };
const SCHEMA = { kind: "questions" as const, questions: [{ question: QUESTION, header: "Ramo", options: [{ label: "sito" }, { label: "app" }] }] };

interface WireMessage { type: string; [k: string]: unknown }

async function harness(sessionKey: string) {
  const ctx: AppContext = await createTestAppContext();
  const sent: WireMessage[] = [];
  ctx.saveSingleTopic({
    id: `t-${sessionKey}`, name: "answer", slug: "answer", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic);
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { sent.push(m as WireMessage); };
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
    // The turn ends when the test says so, through the handler.
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    // A reattach hands the route's handler to the replay the test drives.
    reattach: (_sk: string, h: StreamHandler) => { captured = h; return new Promise<string>(() => {}); },
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
    WORKSPACE_DIR: testTmpDir("chat-tool-response-live-turn-ws"),
  } as never);
  const topicsRouter = createTopicsRouter(ctx);

  /** A turn sent by the person, or `reattach`: the server that restarted adopting it. */
  const startTurn = async (reattach = false): Promise<StreamHandler> => {
    captured = undefined;
    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reattach
        ? { sessionKey, mode: "reattach", messages: [] }
        : { sessionKey, messages: [{ role: "user", content: "sistema il sito" }] }),
    }), url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    if (!captured) throw new Error("the route registered no StreamHandler");
    return captured;
  };

  /** What the panel's submit button sends. */
  const answer = async (toolCallId: string): Promise<Response> => {
    const url = new URL("http://topics.test/api/chat/tool-response");
    return await topicsRouter(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, toolCallId, response: { kind: "questions", answers: ANSWERS } }),
    }), url, url.pathname, "POST") as Response;
  };

  const lastRowId = (): string => (ctx.db.query(
    "SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1",
  ).get(sessionKey) as { id: string }).id;

  /** The tool as the row's timeline has it: what a reload draws. */
  const toolOnRow = (rowId: string, toolCallId: string): ToolCall | undefined => {
    const row = ctx.db.query("SELECT blocks FROM messages WHERE id = ?").get(rowId) as { blocks: unknown };
    const blocks = JSON.parse(decodeCol(row.blocks as never) ?? "[]") as ContentBlock[];
    const block = blocks.find((b) => b.kind === "tool" && b.toolCall.id === toolCallId);
    return block?.kind === "tool" ? block.toolCall : undefined;
  };

  return { sent, startTurn, answer, lastRowId, toolOnRow };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for the condition, not for the clock. */
const until = async (ready: () => boolean, budgetMs = slackMs(5_000)): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) await sleep(25);
};

/** The question is asked, answered through the route, and its tool returns. */
async function askAnswerAndReturn(h: Awaited<ReturnType<typeof harness>>, handler: StreamHandler, rowId: string, toolCallId: string, toolName = ASK_TOOL) {
  handler.onToolStart(toolCallId, toolName, { questions: SCHEMA.questions } as never);
  handler.onUserInputRequired!(toolCallId, toolName, SCHEMA);
  expect(h.toolOnRow(rowId, toolCallId)?.status).toBe("waiting_for_input");

  expect((await h.answer(toolCallId)).status).toBe(200);
  // The route's own write carries it: the loss comes after.
  expect(h.toolOnRow(rowId, toolCallId)?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });

  handler.onToolResult(toolCallId, JSON.stringify({ answers: ANSWERS }), false);
}

describe("the answer to a question survives the next write of the turn that asked it", () => {
  test("a live turn: the answer is still on the row after the tool's result and the end of the turn", async () => {
    const sk = "topic:answer-live-turn";
    const h = await harness(sk);
    try {
      const handler = await h.startTurn();
      const rowId = h.lastRowId();
      await askAnswerAndReturn(h, handler, rowId, "toolu_live_ask");
      handler.onDone({ content: [{ type: "text", text: "Lavoro sul sito." }] } as never);
      await until(() => h.sent.some((m) => m.type === "stream:end"));

      const tool = h.toolOnRow(rowId, "toolu_live_ask");
      expect(tool?.status).toBe("success");
      expect(tool?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
    } finally {
      cancelAsk(sk);
    }
  });

  test("a late answer: a question asked after the watchdog closed the turn keeps its answer on that turn's row", async () => {
    const sk = "topic:answer-late-turn";
    const previous = { soft: process.env.TOPICS_STREAM_SOFT_MS, grace: process.env.TOPICS_STREAM_GRACE_MS };
    // Shrunk so the watchdog closes the silent turn in milliseconds; read once
    // per turn, when the route starts it.
    process.env.TOPICS_STREAM_SOFT_MS = String(slackMs(60));
    process.env.TOPICS_STREAM_GRACE_MS = String(slackMs(60));
    const h = await harness(sk);
    try {
      const handler = await h.startTurn();
      const rowId = h.lastRowId();
      await until(() => h.sent.some((m) => m.type === "stream:end"));
      expect(h.sent.some((m) => m.type === "stream:end" && m.stopCause === "watchdog")).toBe(true);

      await askAnswerAndReturn(h, handler, rowId, "toolu_late_ask");
      // The late answer's end writes its row from the timeline.
      handler.onDone({ content: [{ type: "text", text: "Lavoro sul sito." }] } as never);

      const tool = h.toolOnRow(rowId, "toolu_late_ask");
      expect(tool?.status).toBe("success");
      expect(tool?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
    } finally {
      for (const [key, value] of [["TOPICS_STREAM_SOFT_MS", previous.soft], ["TOPICS_STREAM_GRACE_MS", previous.grace]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      cancelAsk(sk);
    }
  });
});

describe("a second submission of a question already answered leaves the returned tool as it returned", () => {
  // The client expects it (useChat's tool-response: "404 = someone already
  // answered, the other window or the panel").
  for (const road of [
    { name: "the bridge's ask (200, the answer is buffered)", tool: ASK_TOOL, second: 200 },
    { name: "a tool paused on the provider (404, no pending input)", tool: "AskUserQuestion", second: 404 },
  ]) {
    test(road.name, async () => {
      const sk = `topic:answer-twice-${road.second}`;
      const h = await harness(sk);
      try {
        const handler = await h.startTurn();
        const rowId = h.lastRowId();
        await askAnswerAndReturn(h, handler, rowId, `toolu_twice_${road.second}`, road.tool);
        expect((await h.answer(`toolu_twice_${road.second}`)).status).toBe(road.second);
        handler.onDone({ content: [{ type: "text", text: "Lavoro sul sito." }] } as never);
        await until(() => h.sent.some((m) => m.type === "stream:end"));

        const tool = h.toolOnRow(rowId, `toolu_twice_${road.second}`);
        expect({ status: tool?.status, error: tool?.error }).toEqual({ status: "success", error: undefined });
        expect(tool?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
      } finally {
        cancelAsk(sk);
      }
    });
  }

  test("a second submission before the tool returns: the tool that then succeeds carries no error", async () => {
    // The 404 reaches a tool still open, so its error enters the timeline; the
    // result that follows is the tool's real end, and a success has no error
    // (the legacy column's `updateToolCallResult` already clears it).
    const sk = "topic:answer-twice-before-result";
    const h = await harness(sk);
    try {
      const handler = await h.startTurn();
      const rowId = h.lastRowId();
      handler.onToolStart("toolu_race_404", "AskUserQuestion", { questions: SCHEMA.questions } as never);
      handler.onUserInputRequired!("toolu_race_404", "AskUserQuestion", SCHEMA);
      expect((await h.answer("toolu_race_404")).status).toBe(200);
      expect((await h.answer("toolu_race_404")).status).toBe(404);
      handler.onToolResult("toolu_race_404", JSON.stringify({ answers: ANSWERS }), false);
      handler.onDone({ content: [{ type: "text", text: "Lavoro sul sito." }] } as never);
      await until(() => h.sent.some((m) => m.type === "stream:end"));

      const tool = h.toolOnRow(rowId, "toolu_race_404");
      expect({ status: tool?.status, error: tool?.error }).toEqual({ status: "success", error: undefined });
      expect(tool?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
    } finally {
      cancelAsk(sk);
    }
  });
});

describe("an answer reaches a tool that has not returned, whatever its timeline says", () => {
  test("the outbound gate's confirmation: painted on the row alone, the timeline still says running", async () => {
    const sk = "topic:answer-row-panel";
    const h = await harness(sk);
    try {
      const handler = await h.startTurn();
      const rowId = h.lastRowId();
      // What `routes/outbound.ts` does: write what the turn owes, open the
      // ask, paint the panel on the send's row. The timeline is not told.
      handler.onToolStart("toolu_send", "mcp__topics__send_mail", { to: "a@example.com" } as never);
      flushTurnBody(sk);
      beginAsk(sk);
      expect((await h.answer("toolu_send")).status).toBe(200);
      handler.onToolResult("toolu_send", "sent", false);
      handler.onDone({ content: [{ type: "text", text: "Inviata." }] } as never);
      await until(() => h.sent.some((m) => m.type === "stream:end"));

      const tool = h.toolOnRow(rowId, "toolu_send");
      expect(tool?.status).toBe("success");
      expect(tool?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
    } finally {
      cancelAsk(sk);
    }
  });
});

describe("the answer given before a restart survives the turn's reattach", () => {
  test("the replay rebuilds the tool without the answer, and the row keeps it", async () => {
    const sk = "topic:answer-reattach";
    const h = await harness(sk);
    try {
      const handler = await h.startTurn();
      const rowId = h.lastRowId();
      handler.onToolStart("toolu_reattach_ask", ASK_TOOL, { questions: SCHEMA.questions } as never);
      handler.onUserInputRequired!("toolu_reattach_ask", ASK_TOOL, SCHEMA);
      expect((await h.answer("toolu_reattach_ask")).status).toBe(200);
      // The graceful shutdown writes what the throttle owes; then the
      // process, and the registry of its writers, is gone.
      flushTurnBody(sk);
      expect(h.toolOnRow(rowId, "toolu_reattach_ask")?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
      _resetTurnBodyFlushers();

      const replay = await h.startTurn(true);
      expect(h.lastRowId()).toBe(rowId);
      // The broker's store holds the CLI's events: the tool and its result.
      replay.onToolStart("toolu_reattach_ask", ASK_TOOL, { questions: SCHEMA.questions } as never);
      replay.onToolResult("toolu_reattach_ask", JSON.stringify({ answers: ANSWERS }), false);
      replay.onDone({ content: [{ type: "text", text: "Lavoro sul sito." }] } as never);
      await until(() => h.sent.some((m) => m.type === "stream:end"));

      const tool = h.toolOnRow(rowId, "toolu_reattach_ask");
      expect(tool?.status).toBe("success");
      expect(tool?.userResponse).toMatchObject({ kind: "questions", answers: ANSWERS });
      expect(tool?.userInputSchema).toEqual(SCHEMA);
    } finally {
      cancelAsk(sk);
    }
  });
});

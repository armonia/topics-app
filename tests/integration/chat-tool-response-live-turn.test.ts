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
 * Driven through the real chat route and the real tool-response route, on one
 * test database.
 *
 * @covers ASK-09
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { createChatRouter } from "../../server/routes/chat";
import { createTopicsRouter } from "../../server/routes/topics";
import { cancelAsk } from "../../server/lib/ask-user-bridge";
import { decodeCol } from "../../shared/message-blob";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, ToolCall, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("chat-tool-response-live-turn-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

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

  const startTurn = async (): Promise<StreamHandler> => {
    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "sistema il sito" }] }),
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
async function askAnswerAndReturn(h: Awaited<ReturnType<typeof harness>>, handler: StreamHandler, rowId: string, toolCallId: string) {
  handler.onToolStart(toolCallId, ASK_TOOL, { questions: SCHEMA.questions } as never);
  handler.onUserInputRequired!(toolCallId, ASK_TOOL, SCHEMA);
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

/**
 * A TURN THAT ENDS ON A PLAN APPROVAL LEAVES THE QUESTION OPEN, AND SAYS SO.
 * @covers CHAT-QUEUE-07
 *
 * In a topic with autonomy `ask` the route turns the plan of the turn into a
 * question for the person (`lib/plan-approval.ts`) and keeps it open past the
 * turn's end (`endStream` with `keepAwaiting`). Two things went wrong with an
 * `ExitPlanMode` that got no result (a fire-and-forget tool):
 *
 *   - the end-of-turn pass that closes such tools marked the plan `success`
 *     right after it had been put to the person: the panel vanished, and the
 *     plan read as approved (e2e 30/09, tool `success` in the row);
 *   - the close of the turn said only "over", so every window drained its
 *     queue into the question (26 ms after it was written).
 *
 * The real chat route and the real `createAppContext`; the frames are read in
 * wire order.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { createChatRouter } from "../../server/routes/chat";
import { decodeCol } from "../../shared/message-blob";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { ContentBlock, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("plan-approval-holds-queue");
beforeAll(() => setupTestDataDir(TEST_DATA));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for the condition, not for the clock. */
const until = async (ready: () => boolean, budgetMs = slackMs(5_000)): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) await sleep(25);
};

describe("a plan approval at the end of a turn", () => {
  test("the plan stays open for the person, and the close of the turn says a person is awaited", async () => {
    const sk = "topic:plan-holds";
    const ctx = await createTestAppContext();
    const frames: Array<Record<string, unknown>> = [];
    // The ledger's frames go to the sockets, the route's through the stubbed `ctx.broadcastToAll`: one list, call order.
    ctx.wsClients.add({ readyState: 1, data: { id: "w", remote: false }, send: (p: string) => { frames.push(JSON.parse(p)); return 0; } } as never);
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(JSON.parse(JSON.stringify(m))); };
    ctx.saveSingleTopic({
      id: "t-plan-holds", name: "plan", slug: "plan", parentId: null, links: [], sessionKey: sk,
      color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "claude-code", autonomyLevel: "ask",
    } as Topic);

    let captured: StreamHandler | undefined;
    const provider = {
      name: "claude-code", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { captured = h; },
      unregisterStreamHandler: () => {},
      sendChat: () => new Promise(() => {}),
      defaultModel: () => "fake-model", abort: async () => {}, start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;
    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
      resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [],
      autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: testTmpDir("plan-approval-holds-queue-ws"),
    } as never);

    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(new Request(url.toString(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: sk, messages: [{ role: "user", content: "plan it" }] }),
    }), url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    const handler = captured!;
    expect(handler).toBeDefined();
    const rowId = ctx.isStreaming(sk)!.messageId;

    handler.onTextDelta("planning. ", "planning. ");
    handler.onToolStart("toolu_plan", "ExitPlanMode", { plan: "# Plan\n\n1. Read the files\n2. Write the code" } as never);
    // No result for the tool: the turn ends on it.
    handler.onDone({ content: [{ type: "text", text: "planning. " }] } as never);
    await until(() => frames.some((f) => f.type === "stream:end" && f.sessionKey === sk));

    const row = ctx.db.query("SELECT blocks FROM messages WHERE id = ?").get(rowId) as { blocks: unknown };
    const blocks = JSON.parse(decodeCol(row.blocks as never) ?? "[]") as ContentBlock[];
    const plan = blocks.flatMap((b) => (b.kind === "tool" ? [b.toolCall] : [])).find((tc) => tc.id === "toolu_plan");
    expect(plan?.status).toBe("waiting_for_input");
    expect(frames.some((f) => f.type === "stream:tool_result" && f.toolCallId === "toolu_plan")).toBe(false);

    const close = frames.filter((f) => f.type === "turn:state" && f.sessionKey === sk && f.open === false).at(-1);
    expect(close).toMatchObject({ open: false, awaitsHuman: true });
  });
});

import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";

hermetic(test);

/**
 * A FINISHED TURN SHOWS ITS ANSWER; ITS WORK FOLDS INTO ONE ROW.
 *
 * Measured on 23/09: a closed turn was 59-93 rows and the answer sat under
 * them. This drives the real shape (commentary and tools interleaved, then the
 * answer) and checks the three promises: the answer is in sight, the work is
 * one closed row, and opening it gives back every row. A turn waiting on the
 * person stays open.
 * @covers CHAT-TOOL-02
 */
test.describe("finished turn fold", () => {
  let topicId = "";
  let topicName = "";

  const tool = (id: string, command: string, status = "success") => ({
    kind: "tool",
    toolCall: { id, name: "Bash", args: { command }, status, detail: { type: "shell", command, output: "ok" } },
  });

  test.beforeAll(async ({ request }) => {
    topicName = `turn-fold-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
        data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true,
      });
    await row("user", "sistema il test");
    await row("assistant", "Il test passa ora.", [
      { kind: "text", text: "Guardo il file." }, tool("t1", "cat a.ts"),
      { kind: "text", text: "Ora lancio il test." }, tool("t2", "bun test a"), tool("t3", "bun test b"),
      { kind: "text", text: "Il test passa ora." },
    ]);
    await row("user", "continua");
    // A turn that ran out of context: the CLI writes its recap as text in the
    // middle, then keeps working. The recap must stay in sight (24/09: 55 turns
    // of 55 folded it behind «N actions»).
    await row("assistant", "Finito dopo la compattazione.", [
      tool("c1", "ls"),
      { kind: "text", text: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation." },
      tool("c2", "bun test"), tool("c3", "git status"),
      { kind: "text", text: "Finito dopo la compattazione." },
    ]);
    await row("user", "e questo?");
    await row("assistant", "Quale preferisci?", [
      tool("t4", "ls"), tool("t5", "git status"),
      { kind: "tool", toolCall: { id: "q1", name: "mcp__topics__ask_user_question", args: {}, status: "waiting_for_input" } },
      { kind: "text", text: "Quale preferisci?" },
    ]);
  });
  test.afterAll(async ({ request }) => { if (topicId) await deleteTopic(request, topicId).catch(() => {}); });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, [topicId]); });

  test("the answer is in sight, the work is one closed row, a waiting turn stays open", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    const fold = page.getByTestId("turn-work-fold").first();
    await expect(page.getByTestId("turn-work-fold")).toHaveCount(2, { timeout: 15_000 });
    await expect(fold).toHaveAttribute("data-open", "false");
    await expect(fold).toHaveAttribute("data-actions", "3");
    await expect(page.getByText("Il test passa ora.")).toBeVisible();
    // The commentary and the rows of the work are behind the closed row.
    await expect(page.getByText("Ora lancio il test.")).toHaveCount(0);
    await expect(page.locator('[data-testid="tool-call-row-t2"]')).toHaveCount(0);

    // Open: every row comes back, in order.
    await fold.getByTestId("task-work-summary").click();
    await expect(page.getByText("Ora lancio il test.")).toBeVisible();
    await expect(page.getByText("Guardo il file.")).toBeVisible();

    // The compacted turn: its recap is in sight (folded by its own «context
    // summary» row, never behind «N actions»), only the work after it folds.
    await expect(page.getByTestId("compaction-summary-fold")).toHaveCount(1);
    await expect(page.getByTestId("turn-work-fold").nth(1)).toHaveAttribute("data-actions", "2");
    await expect(page.getByText("Finito dopo la compattazione.")).toBeVisible();

    // The turn waiting on a question is shown whole: nothing of it folded.
    await expect(page.locator('[data-testid="tool-call-row-t5"]')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("turn-fold.png") });
  });

  // The turn you just WATCHED stays spread out when it ends: folding it at
  // `stream:end` shrank the bubble under the reader and the pinned list jumped
  // up (chat-scroll-at-rest caught it, 3793 -> 3312).
  test("a turn watched live does not fold when it ends", async ({ page, chatPage, request }) => {
    const topics = (await (await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true })).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)!.sessionKey;
    const wire = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => wire.getByType("subscribe").some(({ direction, data }) =>
      direction === "client" && JSON.parse(data).topicIds?.includes(topicId))).toBe(true);
    const id = `fold-live-${Date.now()}`;
    wire.send({ type: "stream:start", sessionKey, topicId, messageId: id });
    // A real turn spans many frames: the bubble is on screen while it streams,
    // which is what makes it a turn the reader WATCHED.
    await expect(page.getByTestId("chat-streaming-indicator")).toBeVisible({ timeout: 10_000 });
    for (const i of [1, 2, 3]) {
      wire.send({ type: "stream:tool_call", sessionKey, topicId, toolCall: { id: `live${i}`, name: "Bash", args: { command: `echo ${i}` }, status: "running" } });
      wire.send({ type: "stream:tool_result", sessionKey, topicId, toolCallId: `live${i}`, result: "ok" });
    }
    wire.send({ type: "stream:content_chunk", sessionKey, topicId, messageId: id, content: "Risposta finale dal vivo." });
    wire.send({ type: "stream:end", sessionKey, topicId, messageId: id });
    await expect(page.getByText("Risposta finale dal vivo.")).toBeVisible({ timeout: 10_000 });
    // Its three actions are still on screen as the run it streamed (one group
    // row), not behind a second fold; the only fold is the history turn's.
    await expect(page.locator('[data-testid="tool-group-row"][data-group-id="live1"]')).toHaveCount(1);
    await expect(page.getByTestId("turn-work-fold")).toHaveCount(2);
  });
});

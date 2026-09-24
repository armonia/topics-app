import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

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

    const fold = page.getByTestId("turn-work-fold");
    await expect(fold).toHaveCount(1, { timeout: 15_000 });
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

    // The turn waiting on a question is shown whole: nothing of it folded.
    await expect(page.locator('[data-testid="tool-call-row-t5"]')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("turn-fold.png") });
  });
});

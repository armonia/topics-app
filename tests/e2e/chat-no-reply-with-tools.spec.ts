import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A REPLY SENT THROUGH A TOOL AND CLOSED WITH NO_REPLY STAYS IN THE CHAT.
 *
 * Jarvis answers on a channel with `jc s "..."` and then writes `NO_REPLY`, so
 * the channel does not get the text twice. The list dropped every message whose
 * text was `NO_REPLY`, tools included: 219 real answers of 226 vanished and the
 * chat read as if nobody had replied. Only the word is hidden now; a message
 * that is nothing but the word is still dropped.
 *
 * @covers REAL-TC-01
 */
test.describe("chat NO_REPLY with tools", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    topicName = `no-reply-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const row = (role: "user" | "assistant", content: string, blocks?: unknown[]) =>
      request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
        data: { role, content, ...(blocks ? { blocks } : {}) }, ignoreHTTPSErrors: true,
      });
    await row("user", "come va la build?");
    await row("assistant", "NO_REPLY", [
      {
        kind: "tool",
        toolCall: {
          id: "send-1", name: "Bash", args: { command: 'jc s "La build passa"' }, status: "success",
          detail: { type: "shell", command: 'jc s "La build passa"', output: "sent" },
        },
      },
      { kind: "text", text: "NO_REPLY" },
    ]);
    await row("user", "grazie");
    await row("assistant", "NO_REPLY");
    await row("user", "ultima riga visibile");
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("the tool of the reply is shown, the word NO_REPLY is not, a bare NO_REPLY stays hidden", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    await expect(page.getByText("ultima riga visibile")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("tool-call-row-send-1")).toBeVisible();
    await expect(page.getByTestId("message-content-assistant")).toHaveCount(1);
    await expect(page.getByText("NO_REPLY", { exact: false })).toHaveCount(0);
  });
});

import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

/**
 * `/context` is the CLI-parity command that surfaces the context-window usage
 * (tokens / budget / top sources) in a result banner — proves the command
 * dispatch + `/api/context/analyze` wiring end-to-end.
 */
test.describe("Chat /context command", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `ctx-cmd-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("shows a token/budget breakdown banner", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/context");
    // Dismiss the slash-suggestion popup so Enter submits the command rather
    // than picking a menu item, then submit.
    await page.keyboard.press("Escape");
    await chatPage.messageInput.press("Enter");

    // The command-result banner shows "Contesto: <used> / <budget> token (<n>%)".
    await expect(page.locator("body")).toContainText(/Contesto:\s*[\d.]+k?\s*\/\s*[\d.]+k?\s*token/i, {
      timeout: 10_000,
    });
    await expect(page.locator("body")).toContainText(/%/, { timeout: 2_000 });
  });
});

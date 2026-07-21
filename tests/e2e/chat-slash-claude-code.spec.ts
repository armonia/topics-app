import { expect, type Page } from "@playwright/test";
import { test, ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

/**
 * `/model`, `/effort` and `/reasoning` used to hard-400 on a claude-code topic
 * ("… not supported by this provider") — the reason "the slash commands don't
 * work". They now persist the per-topic spawn flag (model/effort) and respawn,
 * and /reasoning points to /effort instead of erroring.
 */
test.describe("Chat slash commands (claude-code)", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `slash-cc-${Date.now()}`;
    const t = await createTopic(request, topicName, { provider: "claude-code" });
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  async function runCmd(chatPage: ChatPage, page: Page, cmd: string) {
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill(cmd);
    await page.keyboard.press("Escape"); // dismiss the slash-suggestion popup
    await chatPage.messageInput.press("Enter");
  }

  test("/model, /effort, /reasoning no longer 400 on claude-code", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // /model — persists the per-topic model, no 400.
    await runCmd(chatPage, page, "/model claude-opus-4-8");
    await expect(page.locator("body")).toContainText(/Modello impostato: claude-opus-4-8/i, { timeout: 10_000 });
    await expect(page.locator("body")).not.toContainText(/not supported by this provider/i);
    await page.waitForTimeout(5500); // banner auto-dismisses after 5s

    // /effort — persists the per-topic effort tier, no 400.
    await runCmd(chatPage, page, "/effort high");
    await expect(page.locator("body")).toContainText(/Effort impostato: high/i, { timeout: 10_000 });
    await page.waitForTimeout(5500);

    // /reasoning — redirects to /effort instead of the old hard 400.
    await runCmd(chatPage, page, "/reasoning");
    await expect(page.locator("body")).toContainText(/effort/i, { timeout: 10_000 });
    await expect(page.locator("body")).not.toContainText(/not supported by this provider/i);
  });
});

import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * `/context` opens the context inspector, the same one the ring opens.
 *
 * It used to print the envelope's own estimate in a green banner
 * («Contesto: 872 / 1000k token»), measured live on 2026-10-03, while the ring
 * one row below read the model's real count when it had one: two answers to
 * one question, the banner the wrong one. Now there is one answer.
 *
 * @covers CMD-06
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

  // `chatPage.messageInput` è STRICT (nessun .first()): basta una pane chat
  // lasciata aperta da un file precedente — il pane-store è uno solo per tutta
  // la suite seriale — perché risolva a 2 elementi e il file muoia in blocco.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("opens the inspector the ring opens, with no banner of its own", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-06" });
    const isTopicAnalysis = (raw: string) => {
      const url = new URL(raw);
      return url.pathname === "/api/context/analyze" && url.searchParams.get("topicId") === topicId;
    };
    let analyses = 0;
    page.on("request", (request) => { if (isTopicAnalysis(request.url())) analyses++; });
    const firstAnalysis = page.waitForResponse((response) => isTopicAnalysis(response.url()));
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await firstAnalysis;
    // The composer consumes this analysis for its ring and file-token hints.
    // ChatPanel used to start a second request and discard the whole result.
    console.info(JSON.stringify({ probe: "chat-panel-context-analysis", requestsAtOpen: analyses }));
    expect(analyses).toBe(1);

    const ring = page.getByTestId("chat-input-context-ring");
    await expect(ring).toHaveAttribute("aria-expanded", "false");
    await chatPage.messageInput.click();
    await chatPage.messageInput.fill("/context");
    // Dismiss the slash-suggestion popup so Enter submits the command rather
    // than picking a menu item, then submit.
    await page.keyboard.press("Escape");
    await chatPage.messageInput.press("Enter");

    await expect(ring).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
    const viaCommand = page.locator('[data-popover="context-inspector"]').getByTestId("context-inspector");
    await expect(viaCommand).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("chat-command-result")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/Contesto:\s*[\d.]+k?\s*\/\s*[\d.]+k?\s*token/i);
    await expect(chatPage.messageInput).toHaveValue("");
  });
});

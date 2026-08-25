/**
 * The composer's provider/model picker: the pair chosen there is the pair that
 * travels in the body of the chat request.
 *
 * @covers CHAT-DEF-03
 */
import { expect, type Route } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { mockChatStream } from "./helpers/sse-helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe.serial("Provider/Model picker", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Picker E2E " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Il pane-store è UNO per l'intera suite seriale: i file eseguiti prima
  // lasciano le loro pane aperte, e `getByTestId("provider-model-picker")` —
  // uno per pane chat montata — finisce in strict-mode violation. Riportiamo
  // lo store al solo topic seminato dal beforeAll.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  // Provider/model REST shape is covered in `provider-snapshot-sync.spec.ts`
  // (single source of truth — the picker reads the same payload). We don't
  // duplicate it here.

  test("selecting a provider/model adds it to the chat payload", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Set up mock first, then add capture as a NEWER route — Playwright
    // resolves to the most recently-registered matching route, so the capture
    // wraps the mock and forwards via route.fallback().
    await mockChatStream(page, {
      chunks: ["ok"],
      userMessage: "ping",
    });
    let capturedBody: any = null;
    await page.route("**/api/chat", async (route: Route) => {
      if (route.request().method() === "POST") {
        try { capturedBody = JSON.parse(route.request().postData() ?? ""); } catch {}
      }
      return route.fallback();
    });

    // Open the picker
    const pickerBtn = page.getByTestId("provider-model-picker");
    await pickerBtn.waitFor({ state: "visible", timeout: 5_000 });
    await pickerBtn.click();

    // Pick the first ENABLED model row INSIDE the popover. The picker's button
    // also shows the resolved model name now (matches the regex), so we scope
    // the search to the open popover via its data-testid.
    const popover = page.getByTestId("provider-model-popover");
    await popover.waitFor({ state: "visible", timeout: 5_000 });
    const enabledModel = popover
      .locator("button:not([disabled])")
      .filter({ hasText: /^(claude-|gpt-|o\d|openclaw)/ })
      .first();

    if (await enabledModel.count() === 0) {
      test.skip(true, "No 'ready' provider with models available in this environment");
    }
    await enabledModel.click();

    // Send message
    await textarea.click();
    await textarea.fill("ping");
    await textarea.press("Enter");

    // Wait for the request to fire
    await expect.poll(() => !!capturedBody, { timeout: 10_000 }).toBe(true);
    expect(capturedBody).toHaveProperty("provider");
    expect(typeof capturedBody.provider).toBe("string");
    expect(capturedBody).toHaveProperty("model");
    expect(typeof capturedBody.model).toBe("string");
  });
});

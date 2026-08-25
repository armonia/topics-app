/**
 * @covers CHAT-COMPACT-03
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Interface-level handling of the CLI auto-compaction recap: a message whose
 * body carries the "This session is being continued…" preamble must fold the
 * ~24 KB summary behind a toggle (collapsed by default) instead of dumping it
 * into the transcript as a wall of prose. Real content before it stays visible.
 */
const PREAMBLE = "This session is being continued from a previous conversation that ran out of context";
const SUMMARY_MARKER = "MARKER_RIASSUNTO_INTERNO_XYZ";
const BEFORE = "Contenuto reale prima della compaction.";

test.describe("Chat compaction summary fold", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `compaction-fold-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Le pane lasciate aperte dai file precedenti montano altre chat: la history
  // mockata qui vale per questo topic, ma i marker si cercherebbero in un DOM
  // che ne contiene anche altre. Reset al solo topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("folds the compaction recap; before-content stays visible; expands on click", async ({ page, chatPage }) => {
    const content = `${BEFORE}\n\n${PREAMBLE}. Summary: ${SUMMARY_MARKER} ${"lorem ipsum ".repeat(200)}`;
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        json: {
          messages: [
            { id: "u1", role: "user", content: "vai", timestamp: new Date().toISOString() },
            { id: "a1", role: "assistant", content, timestamp: new Date().toISOString() },
          ],
        },
      });
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // The fold chip is present…
    const fold = page.locator('[data-testid="compaction-summary-fold"]');
    await expect(fold).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("body")).toContainText("Riassunto del contesto compattato");

    // …the real before-content is shown as prose…
    await expect(page.locator("body")).toContainText(BEFORE);

    // …but the recap body is collapsed (its inner marker not rendered yet).
    await expect(page.locator("body")).not.toContainText(SUMMARY_MARKER);

    // Expanding reveals it.
    await fold.getByRole("button").first().click();
    await expect(page.locator("body")).toContainText(SUMMARY_MARKER, { timeout: 5_000 });
  });
});

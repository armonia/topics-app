/**
 * @covers CHAT-COMPACT-03
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
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
const CONTENT = `${BEFORE}\n\n${PREAMBLE}. Summary: ${SUMMARY_MARKER} ${"lorem ipsum ".repeat(200)}`;

test.describe("Chat compaction summary fold", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  /**
   * The recap lives in the DATABASE, not in a `page.route` mock.
   *
   * WHY. `openTopic` goes through `ensureTopicVisible`, which, whenever the
   * sidebar row is not already on screen at the first load, detaches the client
   * (`page.goto("about:blank")`), re-seeds the pane store and RELOADS. The
   * comment there claims a `page.route` mock survives that; under webkit it does
   * NOT. Measured on 2026-11-13, 20 repetitions: the 5 that failed are exactly
   * the 5 that loaded the app twice, and in those the client's
   * `POST /api/history/<sessionKey>` reached the real server (no route handler
   * ran), so the chat rendered an EMPTY thread and no fold could exist. Which
   * path `ensureTopicVisible` takes depends on the pane store, i.e. on what ran
   * before: the fold assertion was riding on that coin toss.
   *
   * With the two rows seeded through `POST /api/test/seed-message`, the real
   * history endpoint returns them, and any number of reloads stays harmless.
   */
  test.beforeAll(async ({ request }) => {
    topicName = `compaction-fold-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
    await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "vai",
      id: `${topicId}-u1`,
      parentId: null,
      sortOrder: 1000,
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: CONTENT,
      id: `${topicId}-a1`,
      parentId: `${topicId}-u1`,
      sortOrder: 1001,
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Le pane lasciate aperte dai file precedenti montano altre chat: la history
  // seminata qui vale per questo topic, ma i marker si cercherebbero in un DOM
  // che ne contiene anche altre. Reset al solo topic di questo file.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("folds the compaction recap; before-content stays visible; expands on click", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-COMPACT-03" });
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

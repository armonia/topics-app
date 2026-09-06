import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";
import { HISTORY_FIRST_PAGE } from "../../shared/history-paging";
import { VISIBLE_CHAT_SCROLLER, wheelUpUntilVisible } from "./helpers/wheel-scroll";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * CHAT-HISTORY-WINDOW — a topic longer than the old 100-message fetch window
 * must make its ENTIRE thread reachable, head included.
 *
 * Regression for the "chat tagliata" bug: the client fetched history with
 * limit:100 while the server returns the LAST `limit` messages of the thread,
 * so any topic past 100 messages lost its oldest ones — the head was missing
 * from the APP, with no way to ask for it, and the chat began mid-conversation.
 *
 * The chat now opens TAIL-FIRST on purpose (CHAT-HIST-01, shared/history-paging.ts,
 * chat-tail-first.spec.ts): the first request brings the last HISTORY_FIRST_PAGE
 * messages, the rest is merged out of sight or on request through the row at
 * the top of the loaded window. So "the head loads" no longer means "the head
 * is in the DOM on open": the app KNOWS what is missing, names the count, and
 * one click brings it all. The probe seeds three pages (120: >100 old window,
 * <500 server clamp) with a unique HEAD marker on the first message: on open
 * the tail is there and the list says partial; up top sits the row saying
 * «(80)» and not the head; the click completes the list, the row goes, and
 * scrolling on reaches the HEAD marker the old window could never show.
 */
test.describe("Chat history window", () => {
  // Pane-store reset: only this test's chat is on screen, so the visible scroller is its own.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("loads the full thread head for a >100-message topic", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    test.setTimeout(120_000); // 120 sequential seeds + load + two wheel climbs

    const stamp = Date.now();
    const topic = await createTopic(request, `History Window ${stamp}`);
    const sk = `topic:${topic.id.slice(0, 8)}`;
    const TOTAL = HISTORY_FIRST_PAGE * 3; // 120: > old 100 window, < 500 server clamp
    const MISSING = TOTAL - HISTORY_FIRST_PAGE; // what the first page leaves above
    const HEAD_MARKER = `HISTORY-HEAD-${stamp}`;
    const TAIL_MARKER = `HISTORY-TAIL-${stamp}`;

    try {
      // Seed a linear chain: message 0 is the head (root), the rest chain off
      // their predecessor via parentId so loadActiveThread walks all 120.
      let parentId: string | undefined;
      for (let i = 0; i < TOTAL; i++) {
        const isFirst = i === 0;
        const isLast = i === TOTAL - 1;
        const content = isFirst
          ? HEAD_MARKER
          : isLast
            ? TAIL_MARKER
            : `filler message ${i}`;
        const seeded = await seedMessage(request, {
          sessionKey: sk,
          role: i % 2 === 0 ? "user" : "assistant",
          content,
          parentId,
          timestamp: new Date(stamp - (TOTAL - i) * 1000).toISOString(),
        });
        parentId = seeded.id;
      }

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(`History Window ${stamp}`));

      // The tail (newest) is where the pane lands on open — proves it loaded.
      const head = page.locator(".message-content").filter({ hasText: HEAD_MARKER });
      await expect(
        page.locator(".message-content").filter({ hasText: TAIL_MARKER })
      ).toBeVisible({ timeout: 15_000 });
      // Partial, and honest about it: the pane is on screen, so nothing has
      // been merged behind the reader's back.
      const scroller = page.locator(VISIBLE_CHAT_SCROLLER);
      await expect(scroller).toHaveAttribute("data-history", "partial");

      // Up to the top of the loaded window: the row names the eighty messages
      // it hides, and the head is among them — not in the DOM, on offer.
      const divider = page.getByTestId("chat-load-older");
      await wheelUpUntilVisible(page, divider);
      await expect(divider).toContainText(`(${MISSING})`);
      await expect(head).toHaveCount(0);

      // The click is the request: the list becomes whole and the row goes.
      await page.getByTestId("chat-load-older-button").click();
      await expect(scroller).toHaveAttribute("data-history", "complete", { timeout: 15_000 });
      await expect(divider).toHaveCount(0);

      // And the head — message #1, beyond the old 100-window — is up there.
      await wheelUpUntilVisible(page, head, 120);
    } finally {
      await deleteTopic(request, topic.id);
    }
  });
});

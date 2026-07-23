import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";

/**
 * CHAT-HISTORY-WINDOW — a topic with more than the old 100-message fetch
 * window must load its ENTIRE thread, head included.
 *
 * Regression for the "chat tagliata" bug: the client fetched history with
 * limit:100 while the server returns the LAST `limit` messages of the
 * linearized thread. Any topic past 100 messages therefore loaded only its
 * most recent 100 — the oldest messages (the conversation's head) silently
 * vanished and the chat rendered starting mid-conversation, with no scroll-up
 * pagination to recover them. The fetch window is now pinned to the server's
 * own ceiling (500), so every real chat loads complete.
 *
 * The probe: seed 120 messages (>100 old window, <500 server clamp). The very
 * first message carries a unique HEAD marker. With the old limit the server
 * would return messages 21..120 and the HEAD marker would never enter the DOM,
 * no matter how far up you scroll. With the fix all 120 load and scrolling to
 * the top reveals it.
 */
test.describe("Chat history window", () => {
  test("loads the full thread head for a >100-message topic", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HISTORY-WINDOW" });
    test.setTimeout(120_000); // 120 sequential seeds + load + scroll-up poll

    const stamp = Date.now();
    const topic = await createTopic(request, `History Window ${stamp}`);
    const sk = `topic:${topic.id.slice(0, 8)}`;
    const TOTAL = 120; // > old 100 window, < 500 server clamp
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
      await expect(
        page.locator(".message-content").filter({ hasText: TAIL_MARKER })
      ).toBeVisible({ timeout: 15_000 });

      // Scroll the Virtuoso list to the very top; the head marker (message #1,
      // beyond the old 100-window) must materialize. Poll-scroll because
      // Virtuoso renders progressively and the app's scroll guards may nudge.
      const scroller = page.locator("[data-virtuoso-scroller]").first();
      const head = page.locator(".message-content").filter({ hasText: HEAD_MARKER });
      await expect(async () => {
        await scroller.evaluate((el) => { el.scrollTop = 0; });
        await expect(head).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
    } finally {
      await deleteTopic(request, topic.id);
    }
  });
});

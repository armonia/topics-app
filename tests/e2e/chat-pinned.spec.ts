import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, fetchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

/**
 * A PINNED MESSAGE IS SEEN (CMDUI-10): «Appunta» puts the message in the
 * agent's context (slot `pinned`), and nothing showed it. Now the message
 * carries the mark outside the hover, and a line above the messages says how
 * many there are and that they stay in the context; it opens the list, whose
 * entries lead to their message and unpin from there.
 *
 * @covers CMDUI-10
 */
test.describe("Appunta", () => {
  test("pinning the second of three: mark and line; the list leads to it; unpinning takes both away", async ({ page, request, chatPage }) => {
    const name = `pinned-${Date.now()}`;
    const topic = await createTopic(request, name);
    try {
      const sessionKey = ((await fetchTopic(request, topic.id)) as unknown as { sessionKey: string }).sessionKey;
      await seedMessage(request, { sessionKey, role: "user", content: "primo messaggio" });
      const second = await seedMessage(request, { sessionKey, role: "assistant", content: "secondo messaggio da appuntare" });
      await seedMessage(request, { sessionKey, role: "user", content: "terzo messaggio" });
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(name));
      await expect(page.getByText("secondo messaggio da appuntare")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("chat-pinned-line")).toHaveCount(0);
      await expect(page.getByTestId("message-pinned-mark")).toHaveCount(0);

      // The second message's own button: every bubble has one in the DOM.
      const bubble = page.locator(`[data-message-id="${second.id}"]`);
      await bubble.hover();
      await bubble.getByRole("button", { name: /Appunta|Pin/ }).first().click();
      const line = page.getByTestId("chat-pinned-line");
      await expect(line).toHaveText("1 appuntato · resta nel contesto dell'agente", { timeout: 10_000 });
      // The mark is there without the pointer over the message.
      await page.mouse.move(0, 0);
      await expect(page.getByTestId("message-pinned-mark")).toHaveCount(1);
      await expect(page.getByTestId("message-pinned-mark")).toBeVisible();
      expect(second.id).toBeTruthy();

      await line.click();
      const entry = page.getByTestId("chat-pinned-entry");
      await expect(entry).toContainText("secondo messaggio da appuntare");
      await entry.getByTestId("chat-pinned-unpin").click();
      await expect(line).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByTestId("message-pinned-mark")).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id);
    }
  });
});

/**
 * Card 067a1f5b: the session controls sit in a bar INSIDE the composer card,
 * and the form keeps an 8px margin, so the card ends close to the window bottom.
 */
import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("composer controls bar", () => {
  let topicId = "";
  const topicName = `controls-bar-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    topicId = (await createTopic(request, topicName)).id;
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("controls live inside the card, which ends at most 20px from the bottom", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const card = page.getByTestId("composer-card");
    const bar = card.getByTestId("composer-controls");
    await expect(bar).toBeVisible();
    const [cardBox, barBox, area] = [
      await card.boundingBox(),
      await bar.boundingBox(),
      await page.getByTestId("chat-input-area").boundingBox(),
    ];
    expect(cardBox && barBox && area).toBeTruthy();
    // The bar is under the field and fully inside the card.
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height + 0.5);
    const gap = area!.y + area!.height - (cardBox!.y + cardBox!.height);
    expect(gap).toBeLessThanOrEqual(20);
  });
});

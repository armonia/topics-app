/**
 * A new chat's text and its first send survive a reload: typed text comes back
 * with the draft, and a first message whose topic request never got an answer
 * is back in the field after the restart (it is never just gone).
 *
 * @covers LAYOUT-02
 */
import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ video: "on" });

test.describe.serial("Draft survives a restart", () => {
  let topicId = "";

  test.beforeAll(async ({ request }) => {
    topicId = (await createTopic(request, `Draft Restart ${Date.now()}`)).id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("typed text is still there after a reload, and so is an unanswered first send", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+t");
    const composer = () => page.getByRole("textbox", { name: /Campo del messaggio per New Chat/ });
    await expect(composer()).toBeVisible({ timeout: 10_000 });

    await composer().fill("bozza da non perdere");
    await page.reload();
    await expect(composer()).toHaveValue("bozza da non perdere", { timeout: 15_000 });

    // The topic request never gets its answer: the app goes away mid-send.
    await page.route("**/api/topics", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await composer().press("Enter");
    await page.unroute("**/api/topics");
    await page.reload();
    await expect(composer()).toHaveValue("bozza da non perdere", { timeout: 15_000 });
  });
});

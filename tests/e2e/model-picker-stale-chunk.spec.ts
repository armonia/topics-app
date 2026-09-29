/**
 * @covers BUNDLE-TOAST-02
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * "Sto su un topic e non mi va: il selettore del modello non si apre proprio"
 * (Attilio, 29/09).
 *
 * The chip's menu is a chunk of its own, loaded on the first hover or click.
 * A window open across a rebuild keeps an index whose chunk name is gone from
 * the server: the import 404s. That click used to do nothing at all, with the
 * reload prompt either absent or parked in a sidebar slid off screen. The
 * contract: the failed click shows the prompt IN the viewport and marks the
 * chip, nothing else breaks, and once the chunk is reachable again the next
 * click opens the menu with its rows.
 *
 * The 404 is made with `page.route`, the same answer the server gives for an
 * asset swept after a rebuild.
 */
// Any query string too: the retry after a failure asks for the same file under
// a fresh URL (`reimportChunk`), and a swept file is gone for that one as well.
const MENU_CHUNK = /\/assets\/AiExecutionMenuOptions-[^/]+\.js(\?.*)?$/;

async function failMenuChunk(page: Page): Promise<() => number> {
  let hits = 0;
  await page.route(MENU_CHUNK, (route) => {
    hits += 1;
    return route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
  });
  return () => hits;
}

test.describe("model chip: a menu chunk that fails to load is never silent", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Stale chunk " + Date.now();
    topicId = (await createTopic(request, topicName)).id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function openChat(page: Page) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const chip = page.getByTestId("provider-model-picker");
    await chip.waitFor({ state: "visible", timeout: 10_000 });
    return chip;
  }

  test("404 on the menu chunk: prompt in view, chip marked; chunk back: the menu opens", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "BUNDLE-TOAST-02" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const menuRequests = await failMenuChunk(page);
    const chip = await openChat(page);
    await chip.click();

    // The load really went to the network and really failed.
    await expect.poll(menuRequests).toBeGreaterThan(0);
    const prompt = page.getByTestId("bundle-stale-toast");
    await expect(prompt).toBeInViewport({ ratio: 1 });
    await expect(prompt).toContainText(/reload|ricarica/i);
    await expect(page.getByTestId("bundle-stale-reload")).toBeVisible();
    // The chip says the click failed instead of looking dead. Soft, so a red
    // run still reports what the next click does.
    await expect.soft(chip).toHaveAttribute("data-load-state", "failed");
    await expect(page.getByTestId("provider-model-popover")).toBeHidden();

    // Nothing else breaks: the composer still takes text.
    const composer = page.locator('[role="main"] textarea').first();
    await composer.fill("still typing");
    await expect(composer).toHaveValue("still typing");

    // The chunk is reachable again: the NEXT click opens the menu with its rows.
    await page.unroute(MENU_CHUNK);
    await chip.click();
    const popover = page.getByTestId("provider-model-popover");
    await expect(popover).toBeVisible();
    await expect(popover.locator("[data-ai-selector-auto]")).toBeVisible();
    await expect(popover.locator('button[data-provider="claude-code"]')).toBeVisible();
    await expect(chip).not.toHaveAttribute("data-load-state", "failed");

    // A missing chunk is a caught failure, not an uncaught page error.
    expect(pageErrors).toEqual([]);
  });

  test("with the sidebar collapsed the prompt is still in view", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "BUNDLE-TOAST-02" });
    const menuRequests = await failMenuChunk(page);
    const chip = await openChat(page);

    // Cmd+B slides the sidebar off screen (translateX(-100%), still mounted).
    await page.keyboard.press("Meta+b");
    await expect.poll(async () => {
      const box = await page.locator('[aria-label="Topics sidebar"]').boundingBox();
      return box ? box.x + box.width : 0;
    }).toBeLessThan(2);

    await chip.click();
    await expect.poll(menuRequests).toBeGreaterThan(0);
    await expect.soft(chip).toHaveAttribute("data-load-state", "failed");
    // Whole, not a sliver: the slot of a collapsed sidebar is off screen.
    await expect(page.getByTestId("bundle-stale-toast")).toBeInViewport({ ratio: 1 });
  });
});

/**
 * @covers BUNDLE-TOAST-02
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/**
 * Attilio, 29/09: on a topic, the model selector does not open at all.
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
const MENU_CHUNK = /\/assets\/ModelList-[^/]+\.js(\?.*)?$/;

async function failMenuChunk(page: Page): Promise<() => number> {
  let hits = 0;
  await page.route(MENU_CHUNK, (route) => {
    hits += 1;
    return route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
  });
  return () => hits;
}

/** The chunk ARRIVES and throws while evaluating: a bug, not an old build. */
async function breakMenuChunk(page: Page): Promise<() => number> {
  let hits = 0;
  await page.route(MENU_CHUNK, (route) => {
    hits += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "throw new Error('menu-chunk-eval-bug');\nexport const ModelList = null;\n",
    });
  });
  return () => hits;
}

test.describe("model chip: a menu chunk that fails to load is never silent", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Stale chunk " + Date.now();
    topicId = (await createTopic(request, topicName)).id;
    // A topic WITH a conversation, as in the report: the composer then sits at
    // the bottom of the window, where a floating prompt would land on it. An
    // empty topic centres the composer and hides that collision.
    for (let i = 0; i < 25; i++) {
      const seeded = await request.post(`${E2E_BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `line ${i} ` + "lorem ipsum ".repeat(20) },
      });
      expect(seeded.ok(), `system-message -> ${seeded.status()}`).toBe(true);
    }
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

  test("a retry that opens the menu takes the prompt down and raises no new one", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "BUNDLE-TOAST-02" });
    const menuRequests = await failMenuChunk(page);
    const chip = await openChat(page);
    await chip.click();
    await expect.poll(menuRequests).toBeGreaterThan(0);
    const prompt = page.getByTestId("bundle-stale-toast");
    await expect(prompt).toBeVisible();

    // Every stale signal from here on, whatever raises it.
    await page.evaluate(() => {
      const w = window as unknown as { __staleSignals: number };
      w.__staleSignals = 0;
      window.addEventListener("topics:bundle-stale", () => { w.__staleSignals += 1; });
    });

    // The chunk is back: the next click opens the menu. The plain import
    // rejected again from WebKit's memory before the fresh URL loaded, and
    // Vite announced that rejection: the prompt came back on the click that
    // worked, and stayed up saying a part of the app did not load.
    await page.unroute(MENU_CHUNK);
    await chip.click();
    await expect(page.getByTestId("provider-model-popover")).toBeVisible();
    await expect(prompt).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __staleSignals: number }).__staleSignals)).toBe(0);
  });

  test("the update panel's warm-up that fails is reported, not swallowed", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "BUNDLE-TOAST-02" });
    const logged: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") logged.push(message.text()); });
    let hits = 0;
    await page.route(/\/assets\/VersionPanel-[^/]+\.js(\?.*)?$/, (route) => {
      hits += 1;
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: "throw new Error('version-panel-eval-bug');\nexport const VersionPanel = null;\n",
      });
    });
    await goToApp(page);
    // The system menu warms the panel as soon as it mounts, i.e. when the
    // card's menu opens.
    await page.getByTestId("identity-me-profile").click();
    await expect(page.getByTestId("sidebar-system-menu")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => hits).toBeGreaterThan(0);
    await expect.poll(() => logged.some((line) => line.includes("failed to evaluate"))).toBe(true);
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
    const prompt = page.getByTestId("bundle-stale-toast");
    await expect(prompt).toBeInViewport({ ratio: 1 });

    // And on top of NOTHING: the composer is at the bottom (a conversation is
    // there), and a card floating in the corner covered its voice and send
    // buttons. Every composer control is still the element under its own
    // centre, and the two boxes do not meet.
    const composer = page.getByTestId("composer-card");
    const [promptBox, composerBox] = [await prompt.boundingBox(), await composer.boundingBox()];
    expect(promptBox && composerBox).toBeTruthy();
    const overlap = !(
      promptBox!.x >= composerBox!.x + composerBox!.width ||
      promptBox!.x + promptBox!.width <= composerBox!.x ||
      promptBox!.y >= composerBox!.y + composerBox!.height ||
      promptBox!.y + promptBox!.height <= composerBox!.y
    );
    expect(overlap, `prompt ${JSON.stringify(promptBox)} vs composer ${JSON.stringify(composerBox)}`).toBe(false);
    const covered = await composer.evaluate((card) =>
      Array.from(card.querySelectorAll<HTMLElement>("button, textarea"))
        .filter((control) => control.getBoundingClientRect().width > 0)
        .filter((control) => {
          const box = control.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !hit || !control.contains(hit);
        })
        .map((control) => control.getAttribute("aria-label") ?? control.tagName),
    );
    expect(covered).toEqual([]);
  });

  test("a chunk that arrived and threw: logged, no reload prompt, the chip does not say reload", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "BUNDLE-TOAST-02" });
    const logged: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") logged.push(message.text()); });

    const menuRequests = await breakMenuChunk(page);
    const chip = await openChat(page);
    await chip.click();

    await expect.poll(menuRequests).toBeGreaterThan(0);
    // The chip answers the click, as a bug and not as a stale build.
    await expect(chip).toHaveAttribute("data-load-state", "broken");
    await expect(chip).not.toHaveAttribute("title", /reload|ricarica/i);
    // The prompt is raised in the same pass as the rejection, before the chip
    // records it: by now it would be there.
    await expect(page.getByTestId("bundle-stale-toast")).toHaveCount(0);
    await expect.poll(() => logged.some((line) => line.includes("failed to evaluate"))).toBe(true);
    await expect(page.getByTestId("provider-model-popover")).toBeHidden();
  });
});

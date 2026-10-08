import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { closeAllBrowserContexts, createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { didascalia, beat } from "./helpers/evidence";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * TOPIC-BROWSER-01, a topic's browser window holding more pages than its bar.
 *
 * Squeezed to fit, the pages could not be read: measured on 2026-10-08 in a
 * minimized window (420 px), eight pages were 35 px wide with 14 px of title,
 * fifteen were 17 px with none, and the «+» was 13 px wide already with three.
 * Now the bar scrolls sideways: every page keeps a title, the active one is in
 * view, the «+» stays whole, and the first page is reached by scrolling.
 *
 * @covers TOPIC-BROWSER-01
 */

const PAGES = 15;
/** The narrowest a page may get: about eight characters of title beside its close button. */
const MIN_TAB_PX = 88;
/** The «+» is a 24 px control (`w-6`). */
const ADD_PX = 24;

async function seedWindow(request: APIRequestContext, topicId: string, value: Record<string, unknown>): Promise<void> {
  const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topicId}`, { data: value, ignoreHTTPSErrors: true });
  expect(res.ok()).toBeTruthy();
}

/** Is the element inside the part of the bar on screen? */
async function inView(strip: Locator, el: Locator): Promise<boolean> {
  const [bar, box] = await Promise.all([strip.boundingBox(), el.boundingBox()]);
  return !!bar && !!box && box.x >= bar.x - 1 && box.x + box.width <= bar.x + bar.width + 1;
}

/** Does a hand reach it: whatever sits at its center must be the element itself. */
async function reachable(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!onTop && node.contains(onTop);
  });
}

test.describe("TOPIC-BROWSER-01 una finestra browser con tante pagine", () => {
  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
  });

  test("con quindici pagine la barra scorre, ogni scheda resta leggibile e il «+» intero", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-BROWSER-01" });
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TBW-Strip-${Date.now()}`);
    try {
      const tabs = Array.from({ length: PAGES }, (_, i) => ({
        contextId: `tbw-strip-${i + 1}`,
        url: "about:blank",
        title: `Pagina ${String(i + 1).padStart(2, "0")} di una ricerca lunga`,
        openedBy: "user",
      }));
      await seedWindow(request, topic.id, {
        mode: "min",
        minPos: { right: 24, bottom: 24 },
        expandedWidth: null,
        tabs,
        activeContextId: `tbw-strip-${PAGES}`,
        promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`).first().click();
      const win = page.getByTestId("topic-browser-window");
      await expect(win).toHaveAttribute("data-mode", "min", { timeout: 10_000 });
      // The pages are found by themselves, not inside the strip: on the bar that squeezed them the
      // assertion that must go red is the width, not a missing container.
      const pages = win.getByTestId("topic-browser-tab");
      await expect(pages).toHaveCount(PAGES);
      const strip = win.getByTestId("topic-browser-strip");
      await didascalia(page, "Quindici pagine nella finestra browser della topic: la barra scorre, ogni scheda ha il suo titolo");

      const widths = await pages.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
      expect(Math.min(...widths), `page widths ${widths.join(",")}`).toBeGreaterThanOrEqual(MIN_TAB_PX);
      expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth), "the bar scrolls").toBe(true);
      const last = pages.last();
      await expect(last).toHaveAttribute("data-active", "true");
      expect(await inView(strip, last), "the bar opens on the active page").toBe(true);

      const add = win.getByTestId("topic-browser-add");
      const [addBox, winBox] = await Promise.all([add.boundingBox(), win.boundingBox()]);
      expect(Math.round(addBox!.width), "the «+» keeps its width").toBe(ADD_PX);
      expect(addBox!.x + addBox!.width).toBeLessThanOrEqual(winBox!.x + winBox!.width);
      expect(await reachable(add), "the «+» is reachable").toBe(true);

      // The first page is reached by scrolling the bar, and a click makes it the active one.
      const first = pages.first();
      expect(await inView(strip, first)).toBe(false);
      const bar = (await strip.boundingBox())!;
      await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await expect.poll(async () => {
        await page.mouse.wheel(-400, 0);
        return inView(strip, first);
      }, { message: "scrolling the bar brings the first page into view" }).toBe(true);
      await first.click();
      await expect(first).toHaveAttribute("data-active", "true");
      expect(await inView(strip, first)).toBe(true);
      await didascalia(page, "Scorrendo la barra si arriva alla prima pagina, e un click la apre");
      await beat(page, 1200);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

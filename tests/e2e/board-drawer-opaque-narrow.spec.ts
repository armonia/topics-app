/**
 * board-drawer-opaque-narrow.spec.ts - the task drawer covers the board with a
 * solid ground when the window is narrow.
 *
 * WHY. Below `lg` the task drawer is a full-screen overlay (`absolute inset-0`)
 * on top of the columns. It carries `.pane-frost`, and under the desktop shell
 * (`html.native-frost`) that class is `transparent !important` so a pane can
 * let the native glass through. An overlay has no glass under it, it has the
 * board's cards: seen in the native browser pane (WKWebView, ~525x446), the
 * drawer's text read mixed with the cards behind it, and a screenshot three
 * seconds later was identical, so it was not an animation caught half way.
 *
 * HOW. `native-frost` is put on `<html>` (what the shell does at boot), a card
 * is opened at 375 and at 525 px, and the drawer's computed background must be
 * opaque: alpha 1. The two screenshots are attached for the eye.
 *
 * @covers KANBAN-MOBILE-06
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "drawer-opaque-e2e001";
const WIDTHS = [375, 525] as const;
const HEIGHT = 446;

/** The alpha of a computed CSS colour: `rgb()`, `rgba()` and `color(srgb r g b / a)`. */
function alphaOf(color: string): number {
  const slash = color.match(/\/\s*([\d.]+%?)\s*\)/);
  if (slash) return slash[1].endsWith("%") ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
  const parts = color.match(/rgba?\(([^)]+)\)/)?.[1].split(/[\s,/]+/).filter(Boolean);
  if (parts && parts.length === 4) return parseFloat(parts[3]);
  return 1;
}

async function openBoard(page: Page) {
  await page.goto("/");
  await page.waitForSelector("body", { state: "visible" });
  // What the desktop shell adds to <html> at boot (`useFloatingVibrancy`).
  await page.evaluate(() => document.documentElement.classList.add("native-frost"));
  const door = page.locator('[data-testid="mobile-chrome-board"]');
  if (await door.isVisible({ timeout: 5_000 }).catch(() => false)) await door.click();
  else await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
  // On a phone the sidebar is a sheet over the board: the sidebar shortcut folds it away.
  const sidebar = page.locator('[aria-label="Topics sidebar"]');
  if ((await sidebar.getAttribute("data-drawer")) === "open") {
    await page.keyboard.press("ControlOrMeta+b");
    await expect(sidebar).toHaveAttribute("data-drawer", "closed", { timeout: 5_000 });
  }
}

test.describe("Board drawer: opaque ground in a narrow window", () => {
  test.describe.configure({ timeout: 90_000 });

  const stamp = Date.now();
  const title = `Drawer opaco ${stamp}`;
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
      data: { text: title, status: "todo", description: "Card sotto la scheda: non deve trasparire." },
    });
    expect(res.ok(), "the board API refused to seed the card").toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
    // Neighbours, so there is something under the drawer to show through.
    for (let i = 0; i < 4; i++) {
      await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text: `${title} vicina ${i}`, status: "todo" } });
    }
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, BOARD_ID, taskId).catch(() => {});
  });

  for (const width of WIDTHS) {
    test(`at ${width}px the open drawer paints a solid background`, async ({ page }, testInfo) => {
      test.info().annotations.push({ type: "spec", description: "KANBAN-MOBILE-06" });
      await resetPaneStore(page.request, ["__board__"]);
      await page.setViewportSize({ width, height: HEIGHT });
      await openBoard(page);

      await page.locator(`[data-task-card="${taskId}"]`).first().click();
      const drawer = page.getByTestId("task-detail-drawer");
      await expect(drawer).toBeVisible({ timeout: 10_000 });
      // The enter animation fades the drawer in: read the ground once it has settled.
      await expect.poll(() => drawer.evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 5_000 }).toBe(1);

      const ground = await drawer.evaluate((el) => getComputedStyle(el).backgroundColor);
      const shot = testInfo.outputPath(`board-drawer-opaque-${width}.png`);
      await page.screenshot({ path: shot });
      await testInfo.attach(`drawer-${width}`, { path: shot, contentType: "image/png" });
      console.log(`[drawer-opaque] ${width}px ground=${ground} shot=${shot}`);

      expect(alphaOf(ground), `drawer background at ${width}px is ${ground}: the board shows through it`).toBe(1);
    });
  }
});

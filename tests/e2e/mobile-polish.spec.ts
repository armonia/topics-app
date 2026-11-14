/**
 * THE PHONE PASS OF 14/11: six defects found by touring every surface at
 * 375px with a finger, each one measured here on the DOM.
 *
 * MOBILE-POLISH-01  a chat table breaks between words, never inside one, and a
 *                   reply uses the whole row on a phone
 * MOBILE-POLISH-02  the usage KPI cards show their whole value on a phone
 * MOBILE-POLISH-03  a tap never opens a hover tooltip
 * MOBILE-POLISH-04  a pane stacked under another in the same cell is shown alone
 * MOBILE-POLISH-05  the empty chat names no keyboard shortcut on a phone
 * MOBILE-POLISH-06  a level opened from a sheet dims the sheet under it
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteAllTerminalSessions } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, locale: "it-IT" });

const BAR = '[data-testid="mobile-chrome-bar"]';
const TABLE = "| colonna | valore | nota lunga | altra colonna | ancora una | e un'altra |\n|---|---|---|---|---|---|\n| primo | 1 | una nota abbastanza lunga | x | y | z |\n| secondo | 2 | corta | x | y | z |";

let topicId = "";
let topicName = "";

test.beforeAll(async ({ request }) => {
  topicName = `Ritocco telefono ${Date.now()}`;
  topicId = (await createTopic(request, topicName)).id;
  await request.post(`${E2E_BASE}/api/topics/${topicId}/system-message`, { data: { content: TABLE }, ignoreHTTPSErrors: true });
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  await deleteAllTerminalSessions(request);
  if (topicId) await deleteTopic(request, topicId);
});

async function open(page: Page) {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 20_000 });
}

/** How many line boxes the text of an element breaks into. */
async function lineCount(page: Page, selector: string, text: RegExp): Promise<number> {
  const cell = page.locator(selector, { hasText: text }).first();
  await expect(cell).toBeVisible();
  return cell.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
    return tops.size;
  });
}

test("MOBILE-POLISH-01: a chat table breaks between words, never inside one", async ({ page, request }) => {
  await resetPaneStore(request, [topicId]);
  await open(page);
  const row = page.getByText(topicName).first();
  if (await row.isVisible()) await row.tap();
  await expect(page.getByTestId("chat-message-list")).toBeVisible({ timeout: 15_000 });
  await waitForLayoutSettled(page);
  // «colonna», «valore», «secondo» are single words: each one is ONE line. allow-italian: the table cells under test
  // The bug squeezed them to «col/onna», «va/lor/e», «sec/on/do».
  expect(await lineCount(page, ".message-content th", /^colonna$/)).toBe(1);
  expect(await lineCount(page, ".message-content th", /^valore$/)).toBe(1);
  expect(await lineCount(page, ".message-content td", /^secondo$/)).toBe(1);
  // And the page never scrolls sideways: a table that still does not fit
  // scrolls inside its own wrapper.
  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(docOverflow).toBeLessThanOrEqual(0);
  // …and a reply uses the whole row. The phone used to cap every reply 64px
  // short of the edge (`calc(100vw - 5rem)`, from when the sidebar sat beside
  // the chat), so a table was cut while empty room sat on its right.
  const gap = await page.locator(".message-content table").first().evaluate((t) => {
    const row = t.closest('[data-testid="chat-message"]')!.getBoundingClientRect();
    return Math.round(row.right - t.parentElement!.getBoundingClientRect().right);
  });
  expect(gap).toBeLessThanOrEqual(4);
});

test("MOBILE-POLISH-02: the usage KPI cards show their whole value on a phone", async ({ page, request }) => {
  await resetPaneStore(request, []);
  await open(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } })));
  const grid = page.getByTestId("kpi-card-grid");
  await expect(grid).toBeVisible({ timeout: 15_000 });
  await waitForLayoutSettled(page);
  const cards = await grid.locator('[data-testid="kpi-card"]').evaluateAll((els) =>
    els.map((card) => {
      const r = card.getBoundingClientRect();
      const clipped = Array.from(card.querySelectorAll<HTMLElement>("*")).filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).length;
      return { w: Math.round(r.width), clipped };
    }),
  );
  expect(cards.length).toBe(9);
  // Two columns on a phone: every card at least 140px wide (it was 60).
  for (const c of cards) expect(c.w).toBeGreaterThanOrEqual(140);
  // The value of a card that has one is never cut to «$…».
  const valuesClipped = await grid.locator('[data-testid="kpi-card"] .text-headline').evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1).length,
  );
  expect(valuesClipped).toBe(0);
});

test("MOBILE-POLISH-03: a tap never opens a hover tooltip", async ({ page, request }) => {
  await resetPaneStore(request, []);
  await open(page);
  // A control with a `title` that stays on screen after the tap (it opens a
  // sheet, it does not navigate): the delegate moves the `title` to `data-tip`
  // the moment it decides to show a tooltip, synchronously on `mouseover`.
  const target = page.getByTestId("sidebar-topics-menu");
  await expect(target).toBeVisible();
  const title = await target.getAttribute("title");
  expect(title).toBeTruthy();
  await target.tap();
  // The compatibility `mouseover` that follows a tap is gone through already:
  // after the tap the attribute is still a `title`, not a pending tooltip.
  await expect(page.getByTestId("app-tooltip")).toHaveCount(0);
  const stillTitled = await page.locator(`[data-tip]`).count();
  expect(stillTitled).toBe(0);
});

test("MOBILE-POLISH-04: a pane stacked under another in the same cell is shown alone", async ({ page, request }) => {
  await resetPaneStore(request, []);
  await deleteAllTerminalSessions(request);
  await open(page);
  // Terminal first, then a browser from the same door: the browser lands
  // stacked under the terminal in its cell.
  await page.getByTestId("mobile-chrome-search").tap();
  await page.getByText(/^Terminale$/).first().tap();
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("mobile-chrome-search").tap();
  await page.getByText(/^Browser$/).first().tap();
  await expect(page.getByTestId("browser-pane").first()).toBeVisible({ timeout: 20_000 });
  await waitForLayoutSettled(page);
  const visible = await page.evaluate(() => {
    const shown = (sel: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    const browser = shown('[data-testid="browser-pane"]')[0];
    return {
      terminals: shown(".xterm").length,
      browserHeight: browser ? Math.round(browser.getBoundingClientRect().height) : 0,
      vh: innerHeight,
    };
  });
  // One surface: the terminal is out of the layout, the browser has the screen.
  expect(visible.terminals).toBe(0);
  expect(visible.browserHeight).toBeGreaterThan(visible.vh * 0.6);
});

test("MOBILE-POLISH-05: the empty chat names no keyboard shortcut on a phone", async ({ page, request }) => {
  await resetPaneStore(request, []);
  await open(page);
  // The «+» in the middle of the row starts a new, empty chat.
  await page.locator(`${BAR} button`).nth(1).tap();
  const empty = page.getByTestId("chat-empty-state");
  await expect(empty).toBeVisible({ timeout: 15_000 });
  await expect(empty.locator("kbd")).toHaveCount(0);
});

test("MOBILE-POLISH-06: a level opened from a sheet dims the sheet under it", async ({ page, request }) => {
  await resetPaneStore(request, []);
  await open(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-user-menu", { detail: { level: "view" } })));
  const level = page.getByTestId("topics-menu-view-menu");
  await expect(level).toBeVisible({ timeout: 15_000 });
  await waitForLayoutSettled(page);
  // The point just above the level's top edge: what a finger lands on there is
  // the level's veil, not a row of the sheet underneath still lit and live.
  const hitAbove = await level.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(1, r.top - 12));
    return hit ? { veil: hit.classList.contains("bg-black/40"), inLevel: el.contains(hit) } : null;
  });
  expect(hitAbove).toEqual({ veil: true, inLevel: false });
});

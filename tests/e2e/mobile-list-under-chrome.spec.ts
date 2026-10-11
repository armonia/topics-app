/**
 * THE LIST RUNS UNDER THE TOP ROW AND UNDER THE BUTTON ROW AT THE BOTTOM.
 *
 * Asked from a phone: the list starts right after the safe area and scrolls
 * UNDER the header and UNDER the button row at the bottom, the way a native
 * list does — and at the end of the run the last row is entirely above the
 * buttons.
 *
 * MOBILE-LIST-01  at rest the first row starts right after `--sat` (under the
 *                 compact header, which is compact for exactly that reason)
 * MOBILE-LIST-02  the scroller reaches the screen bottom, so rows travel behind
 *                 the button row (the column is not cut where the row begins)
 * MOBILE-LIST-03  scrolled to the end, the last row is entirely above the row
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BAR = '[data-testid="mobile-chrome-bar"]';
const SCROLLER = '[aria-label="Topics sidebar"] .sidebar-column';
const SHOTS = process.env.LIST_SHOTS_DIR;
// Enough rows to overflow 844px on their own: the list only scrolls under the
// bar if it is longer than the screen. 14 used to be enough because the seeded
// chats with unread messages kept rows of their own; since notifications-redesign
// (ATTN-14) a chat with no tab stays in the sidebar only while it is lit, and 14
// tabs plus the board row end at 774px, inside the screen.
const CROWD = 20;
let ids: string[] = [];

test.beforeAll(async ({ request }) => {
  for (let i = 0; i < CROWD; i++) ids.push((await createTopic(request, `Lista sotto la chrome ${i}`)).id);
  await resetPaneStore(request, ids);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  for (const id of ids) await deleteTopic(request, id);
  ids = [];
});

async function measure(page: Page) {
  return page.evaluate(() => {
    const column = document.querySelector('[aria-label="Topics sidebar"]')!;
    const header = column.firstElementChild as HTMLElement;
    const scroller = column.querySelector<HTMLElement>(".sidebar-column")!;
    const bar = document.querySelector<HTMLElement>('[data-testid="mobile-chrome-bar"]')!;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const r = (e: Element) => e.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      headerBottom: r(header).bottom,
      scrollerTop: r(scroller).top,
      scrollerBottom: r(scroller).bottom,
      paddingBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
      barTop: r(bar).top,
      firstTop: rows.length ? r(rows[0]).top : null,
      lastBottom: rows.length ? r(rows[rows.length - 1]).bottom : null,
      rows: rows.length,
      overflow: scroller.scrollHeight - scroller.clientHeight,
      sat: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat")) || 0,
    };
  });
}

test("MOBILE-LIST — la lista parte dalla safe area e scorre sotto header e footer", async ({ page }) => {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible();
  await expect.poll(async () => (await measure(page)).rows).toBeGreaterThan(8);

  const atRest = await measure(page);
  console.log("RIPOSO", JSON.stringify(atRest));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${process.env.LIST_TAG ?? "x"}-riposo.png` });
  // 01 — the first row starts right after the safe area, under the compact
  // header (mobile-chrome-feedback A1): the compact row at rest exists so the
  // rows can begin there instead of a full row below.
  expect(Math.abs(atRest.firstTop! - atRest.sat)).toBeLessThanOrEqual(1);
  // 02 — the scroller itself runs down to the glass, so rows pass behind the buttons.
  expect(atRest.overflow, "the list must overflow, or there is nothing to scroll under").toBeGreaterThan(0);
  expect(atRest.scrollerBottom).toBeGreaterThanOrEqual(atRest.vh - 1);

  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = s.scrollHeight;
  }, SCROLLER);
  await waitForLayoutSettled(page, SCROLLER);
  const atEnd = await measure(page);
  console.log("FONDO", JSON.stringify(atEnd));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${process.env.LIST_TAG ?? "x"}-fondo.png` });
  // 03 — at the end the last row is whole, above the button row.
  expect(atEnd.lastBottom!).toBeLessThanOrEqual(atEnd.barTop + 1);
});

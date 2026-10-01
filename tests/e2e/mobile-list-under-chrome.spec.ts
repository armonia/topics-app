/**
 * LA LISTA PASSA SOTTO LA RIGA IN ALTO E SOTTO LA FILA IN BASSO.
 *
 * Asked from a phone: the list scrolls UNDER the header and UNDER the button
 * row at the bottom, and still nothing is hidden at rest — the first row starts
 * below the header, the last row ends above the buttons.
 *
 * MOBILE-LIST-01  at rest the first row sits below the header
 * MOBILE-LIST-02  the scroller reaches the screen bottom, so rows travel behind
 *                 the button row (the column is not cut where the row begins)
 * MOBILE-LIST-03  scrolled to the end, the last row is entirely above the row
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BARRA = '[data-testid="mobile-chrome-bar"]';
const SHOTS = process.env.LIST_SHOTS_DIR;
const CROWD = 14;
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

async function misura(page: Page) {
  return page.evaluate(() => {
    const colonna = document.querySelector('[aria-label="Topics sidebar"]')!;
    const header = colonna.firstElementChild as HTMLElement;
    const scroller = colonna.querySelector<HTMLElement>(".sidebar-column")!;
    const barra = document.querySelector<HTMLElement>('[data-testid="mobile-chrome-bar"]')!;
    const righe = Array.from(scroller.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const r = (e: Element) => e.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      headerBottom: r(header).bottom,
      scrollerTop: r(scroller).top,
      scrollerBottom: r(scroller).bottom,
      paddingBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
      barTop: r(barra).top,
      primoTop: righe.length ? r(righe[0]).top : null,
      ultimoBottom: righe.length ? r(righe[righe.length - 1]).bottom : null,
      righe: righe.length,
      overflow: scroller.scrollHeight - scroller.clientHeight,
    };
  });
}

test("MOBILE-LIST — la lista sta sotto header e footer, e a riposo non copre niente", async ({ page }) => {
  await page.goto(E2E_BASE);
  await expect(page.locator(BARRA)).toBeVisible();
  await expect.poll(async () => (await misura(page)).righe).toBeGreaterThan(8);

  const riposo = await misura(page);
  console.log("RIPOSO", JSON.stringify(riposo));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${process.env.LIST_TAG ?? "x"}-riposo.png` });
  // 01 — the first row starts below the header.
  expect(riposo.primoTop!).toBeGreaterThanOrEqual(riposo.headerBottom - 1);
  // 02 — the scroller itself runs down to the glass, so rows pass behind the buttons.
  expect(riposo.overflow, "the list must overflow, or there is nothing to scroll under").toBeGreaterThan(0);
  expect(riposo.scrollerBottom).toBeGreaterThanOrEqual(riposo.vh - 1);

  await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[aria-label="Topics sidebar"] .sidebar-column')!;
    s.scrollTop = s.scrollHeight;
  });
  await page.waitForTimeout(200);
  const fondo = await misura(page);
  console.log("FONDO", JSON.stringify(fondo));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${process.env.LIST_TAG ?? "x"}-fondo.png` });
  // 03 — at the end the last row is whole, above the button row.
  expect(fondo.ultimoBottom!).toBeLessThanOrEqual(fondo.barTop + 1);
});

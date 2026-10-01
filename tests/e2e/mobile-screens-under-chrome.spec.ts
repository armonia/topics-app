/**
 * THE PHONE'S OTHER SCREENS: THE LIST RUNS UNDER THE ROW, EVERYTHING ELSE STAYS ABOVE.
 *
 * `mobile-list-under-chrome.spec.ts` states the rule for the sidebar. Here the
 * same rule for the screens that used to stop at the row's edge because the
 * app root reserved the band for them (`paddingBottom: --mobile-chrome-h`):
 * the scroller ended above the buttons, the last card was cut in half on the
 * edge and nothing ever passed behind them.
 *
 * MOBILE-SCREEN-01  chat: the transcript scrolls under the composer (a declared
 *                   overlay), the composer sits WHOLE above the buttons and works
 * MOBILE-SCREEN-02  board: the columns reach the glass, at the end the last card
 *                   sits above the composer, and the composer above the buttons
 * MOBILE-SCREEN-03  profile and dashboard: the scroller reaches the glass, at the
 *                   end the last element is above the buttons
 * MOBILE-SCREEN-04  a task opened from the board: its composer sits above the buttons
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BAR = '[data-testid="mobile-chrome-bar"]';
const SHOTS = process.env.LIST_SHOTS_DIR;
const TAG = process.env.LIST_TAG ?? "x";
const PROJECT_ID = projectIdForPath(`${canonicalTmpRoot()}/e2e-screens-under-${Date.now()}`);

let topicId = "";
const taskIds: string[] = [];

test.beforeAll(async ({ request }) => {
  topicId = (await createTopic(request, `Schermate sotto la chrome ${Date.now()}`)).id;
  for (let i = 0; i < 40; i++) {
    await request.post(`${E2E_BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `#${i + 1} ` + "riga di prova ".repeat((i % 5) + 1) },
      ignoreHTTPSErrors: true,
    });
  }
  for (let i = 0; i < 14; i++) {
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text: `Task sotto la chrome ${i}`, status: "backlog" } });
    expect(res.ok()).toBe(true);
    taskIds.push(((await res.json()) as { id: string }).id);
  }
  await resetPaneStore(request, [topicId]);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  for (const id of taskIds) await deleteTask(request, PROJECT_ID, id);
  await deleteTopic(request, topicId);
});

async function open(page: Page) {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible();
}

/** The rect that matters, in viewport coordinates. */
async function rect(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  }, selector);
}

async function barTop(page: Page) {
  return (await rect(page, BAR))!.top;
}

/** Scrolls a scroller to the end and returns the bottom edge of its last child. */
async function scrollToEnd(page: Page, selector: string, lastSelector?: string) {
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = s.scrollHeight;
  }, selector);
  await waitForLayoutSettled(page, selector);
  return page.evaluate(([sel, last]) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    const el = last ? Array.from(s.querySelectorAll<HTMLElement>(last)).pop()! : (s.lastElementChild as HTMLElement);
    return { lastBottom: el.getBoundingClientRect().bottom, overflow: s.scrollHeight - s.clientHeight };
  }, [selector, lastSelector ?? ""] as const);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${TAG}-${name}.png` });
}

test("MOBILE-SCREEN-01 — chat: il trascritto arriva al vetro, il composer sta sopra i tasti", async ({ page }) => {
  await open(page);
  await page.getByText(/Schermate sotto la chrome/).first().tap();
  await expect(page.getByTestId("chat-message-list")).toBeVisible({ timeout: 15_000 });
  await waitForLayoutSettled(page);
  const vh = page.viewportSize()!.height;
  const bar = await barTop(page);
  const ta = (await rect(page, "textarea"))!;
  const list = (await rect(page, '[data-testid="chat-message-list"]'))!;
  const area = (await rect(page, '[data-testid="chat-input-area"]'))!;
  console.log("CHAT", JSON.stringify({ vh, bar, ta, list, area }));
  await shot(page, "chat");
  // The transcript runs down to the glass, under the buttons, like every list…
  expect(list.bottom).toBeGreaterThanOrEqual(vh - 1);
  // …and the composer (and so the textarea) is whole above the row.
  expect(ta.bottom).toBeLessThanOrEqual(bar);
  // At the end the last message sits above the textarea's top edge.
  const atEnd = await scrollToEnd(page, '[data-testid="chat-message-list"]', "[data-index]");
  console.log("CHAT-FONDO", JSON.stringify(atEnd));
  expect(atEnd.lastBottom).toBeLessThanOrEqual(ta.top);
  // Usable: the textarea takes focus and the text goes in.
  await page.locator("textarea").first().tap();
  await page.keyboard.type("ciao");
  await expect(page.locator("textarea").first()).toHaveValue(/ciao/);
});

test("MOBILE-SCREEN-01b — chat con la tastiera aperta: niente banda dei tasti, il composer resta in vista", async ({ page }) => {
  await open(page);
  await page.getByText(/Schermate sotto la chrome/).first().tap();
  await expect(page.getByTestId("chat-message-list")).toBeVisible({ timeout: 15_000 });
  await page.locator("textarea").first().tap();
  // Headless WebKit has no software keyboard: shrink the visual viewport the way
  // iOS does when it comes up, and tell the listeners (useMobile, useSidebarAndLayout).
  const KEYBOARD_VV = 480;
  await page.evaluate((h) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, "height", { configurable: true, get: () => h });
    vv.dispatchEvent(new Event("resize"));
  }, KEYBOARD_VV);
  await expect(page.locator(BAR)).toBeHidden();
  await expect.poll(async () => (await rect(page, '[data-testid="chat-band-spacer"]'))!.height).toBe(0);
  await waitForLayoutSettled(page);
  const ta = (await rect(page, "textarea"))!;
  const area = (await rect(page, '[data-testid="chat-input-area"]'))!;
  console.log("CHAT-TASTIERA", JSON.stringify({ vv: KEYBOARD_VV, ta, area }));
  await shot(page, "chat-tastiera");
  // The composer sits on the keyboard's edge, whole, with no band left under it.
  expect(ta.bottom).toBeLessThanOrEqual(KEYBOARD_VV);
  expect(area.bottom).toBeLessThanOrEqual(KEYBOARD_VV + 1);
  expect(area.bottom).toBeGreaterThanOrEqual(KEYBOARD_VV - 1);
});

test("MOBILE-SCREEN-02— board: le colonne passano sotto i tasti, il composer resta sopra", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="mobile-chrome-board"]').tap();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  const body = '[data-testid="kanban-column-body-backlog"]';
  await expect.poll(async () => page.locator(`${body} [data-task-card]`).count(), { timeout: 15_000 }).toBeGreaterThan(5);
  await waitForLayoutSettled(page, '[data-testid="kanban-board"]');
  const bar = await barTop(page);
  const vh = await page.evaluate(() => window.innerHeight);
  const row = (await rect(page, '[data-testid="kanban-columns-row"]'))!;
  const col = (await rect(page, body))!;
  const composer = (await rect(page, '[data-testid="board-task-composer"]'))!;
  console.log("BOARD", JSON.stringify({ vh, bar, row, col, composer }));
  await shot(page, "board-riposo");
  // The columns reach under the row (they overlap it): they pass behind the buttons.
  expect(col.bottom).toBeGreaterThan(bar + 20);
  // The composer is whole above the buttons.
  expect(composer.bottom).toBeLessThanOrEqual(bar);
  const atEnd = await scrollToEnd(page, body, '[data-task-card]');
  console.log("BOARD-FONDO", JSON.stringify(atEnd));
  await shot(page, "board-fondo");
  // At the end the last card sits above the composer: nothing covers it.
  expect(atEnd.overflow).toBeGreaterThan(0);
  expect(atEnd.lastBottom).toBeLessThanOrEqual(composer.top + 1);
});

test("MOBILE-SCREEN-03 — profilo e dashboard: lo scroller arriva al vetro, l'ultimo elemento sta sopra i tasti", async ({ page }) => {
  await open(page);
  const screens = [
    { name: "profile", open: () => page.locator('[data-testid="mobile-chrome-profile"]').tap(), pane: '[data-testid="profile-pane"]', scroller: '[data-testid="profile-pane"] > div:last-child' },
    {
      name: "dashboard",
      open: () => page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }))),
      pane: '[data-testid="dashboard-pane"]',
      scroller: '[data-testid="dashboard-pane"]',
    },
  ];
  for (const s of screens) {
    await s.open();
    await expect(page.locator(s.pane)).toBeVisible({ timeout: 15_000 });
    await waitForLayoutSettled(page, s.pane);
    const bar = await barTop(page);
    const vh = await page.evaluate(() => window.innerHeight);
    // Short content on the test bench: a tall block is appended to the
    // scroller, so the spacer (which comes AFTER it) has something to push.
    await page.evaluate((sel) => {
      const filler = document.createElement("div");
      filler.setAttribute("data-filler", "");
      filler.style.cssText = "height:1800px;flex:none";
      document.querySelector(sel)!.appendChild(filler);
    }, s.scroller);
    const r = (await rect(page, s.scroller))!;
    const atEnd = await scrollToEnd(page, s.scroller, "[data-filler]");
    expect(atEnd.overflow).toBeGreaterThan(0);
    console.log("SCREEN", s.name, JSON.stringify({ vh, bar, r, atEnd }));
    await shot(page, s.name);
    expect(r.bottom).toBeGreaterThanOrEqual(vh - 1);
    expect(atEnd.lastBottom).toBeLessThanOrEqual(bar + 1);
  }
});

test("MOBILE-SCREEN-02b — board in vista elenco: l'ultima card sta sopra il composer", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("topics.board.layout", "list"));
  await open(page);
  await page.locator('[data-testid="mobile-chrome-board"]').tap();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator("[data-task-card]").count(), { timeout: 15_000 }).toBeGreaterThan(5);
  await waitForLayoutSettled(page, '[data-testid="kanban-board"]');
  const bar = await barTop(page);
  const composer = (await rect(page, '[data-testid="board-task-composer"]'))!;
  const row = (await rect(page, '[data-testid="kanban-columns-row"]'))!;
  const atEnd = await scrollToEnd(page, '[data-testid="kanban-columns-row"]', "[data-task-card]");
  console.log("BOARD-LIST", JSON.stringify({ bar, composer, row, atEnd }));
  await shot(page, "board-elenco-fondo");
  expect(row.bottom).toBeGreaterThan(bar + 20);
  expect(composer.bottom).toBeLessThanOrEqual(bar);
  expect(atEnd.lastBottom).toBeLessThanOrEqual(composer.top + 1);
});

test("MOBILE-SCREEN-04 — un task aperto dalla board: il suo composer sta sopra i tasti", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="mobile-chrome-board"]').tap();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator("[data-task-card]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.locator("[data-task-card]").first().tap();
  const drawer = '[data-testid="task-detail-drawer"]';
  await expect(page.locator(drawer)).toBeVisible({ timeout: 15_000 });
  await waitForLayoutSettled(page, drawer);
  const bar = await barTop(page);
  const ta = (await rect(page, `${drawer} textarea`))!;
  console.log("TASK", JSON.stringify({ bar, ta, drawer: await rect(page, drawer) }));
  await shot(page, "task");
  expect(ta.bottom).toBeLessThanOrEqual(bar);
});

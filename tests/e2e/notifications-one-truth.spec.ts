/**
 * ONE SEEN-STATE PER SUBJECT, end to end: what the notifications panel says and
 * what every other surface shows are the same fact.
 *
 * The report (2026-09-29): «vedo 133 notifiche, aprendo le notifiche della
 * sidebar se ne vanno ma restano ovunque». Measured on the live DB: 0 unseen
 * notification rows, 132 unread messages on 6 chats, a dock at 133. Two
 * defects, both proven here:
 *   - the global number (dock, tray, PWA badge) summed MESSAGES: a chat with 4
 *     unread counted 4 while the panel listed it once;
 *   - seeing notifications in the panel cleared the panel only: the chats kept
 *     their unread, so their badges and the dock stayed lit.
 *
 * The global number is read where the Dock and the PWA badge read it: the
 * Badging API (`navigator.setAppBadge`), stubbed to record its last value. The
 * sidebar's count is the bell's badge. Nothing internal is mocked.
 *
 * Order: the panel is opened FIRST, empty, because opening it IS the mark all;
 * the two chats' notifications then arrive while it is open, which is the only
 * way one of them can be seen on its own in the panel.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";

hermetic(test);

const BASE = E2E_BASE;
const TS = Date.now();
const BOARD = "__board__";

type Unread = Record<string, { unreadCount?: number } | undefined>;

async function unreadOf(request: APIRequestContext, topicId: string): Promise<number> {
  const res = await request.get(`${BASE}/api/unread`);
  return ((await res.json()) as Unread)[topicId]?.unreadCount ?? 0;
}

/** Raise a chat's unread the way a real message does (message:new + bump). */
async function messages(request: APIRequestContext, topicId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await request.post(`${BASE}/api/topics/${topicId}/system-message`, { data: { content: `msg ${i + 1}` } });
    expect(res.ok()).toBe(true);
  }
}

/** A notification row about a chat, through the same POST the banner door uses. */
async function notify(request: APIRequestContext, topicId: string, title: string): Promise<void> {
  const res = await request.post(`${BASE}/api/notifications`, {
    data: { kind: "chat-message", title, targetKind: "topic", targetId: topicId, dedupeKey: `one-truth:${topicId}:${TS}` },
  });
  expect(res.ok()).toBe(true);
  expect(((await res.json()) as { recorded: boolean }).recorded).toBe(true);
}

/** The Dock / PWA number, as last painted. */
const globalNumber = (page: Page) =>
  page.evaluate(() => (window as unknown as { __appBadge: number }).__appBadge);

const bell = (page: Page) => page.getByTestId("notification-history-button");
const bellCount = (page: Page) => bell(page).locator("[data-notification-count]");
const panel = (page: Page) => page.getByTestId("notification-history-panel");
const panelRowOf = (page: Page, topicId: string) =>
  page.locator(`[data-testid="notification-history-row"][data-target="/topic/${topicId}"]`);
const rowBadge = (page: Page, name: string) =>
  page.getByRole("treeitem", { name: new RegExp(name) }).first().locator("[data-notification-count]");
const tabBadge = (page: Page, topicId: string) =>
  page.locator(`[data-pane-id="${topicId}"] [data-notification-count]`);

let a: { id: string; name: string };
let b: { id: string; name: string };
let stale: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  a = await createTopic(request, `OneTruth-Many-${TS}`);
  b = await createTopic(request, `OneTruth-Few-${TS}`);
  stale = await createTopic(request, `OneTruth-Stale-${TS}`);
});

test.afterAll(async ({ request }) => {
  for (const t of [a, b, stale]) if (t) await deleteTopic(request, t.id).catch(() => {});
});

test("NOTIF-ONE: the global number counts chats, and seeing in the panel clears them everywhere", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-01" });
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-02" });
  test.setTimeout(90_000);

  // The OS badge, recorded where the app paints it.
  await page.addInitScript(() => {
    const w = window as unknown as { __appBadge: number };
    w.__appBadge = 0;
    const nav = navigator as unknown as {
      setAppBadge: (n?: number) => Promise<void>;
      clearAppBadge: () => Promise<void>;
    };
    nav.setAppBadge = (n?: number) => { w.__appBadge = n ?? 0; return Promise.resolve(); };
    nav.clearAppBadge = () => { w.__appBadge = 0; return Promise.resolve(); };
  });

  // A clean start on BOTH sides of the fix: every chat of the seeded baseline
  // read through the route that has always cleared a chat, every row seen.
  const unread = (await (await page.request.get(`${BASE}/api/unread`)).json()) as Unread;
  for (const [id, u] of Object.entries(unread)) {
    if ((u?.unreadCount ?? 0) > 0) await page.request.post(`${BASE}/api/topics/${id}/read`);
  }
  await page.request.post(`${BASE}/api/notifications/seen`, { data: { upTo: new Date().toISOString() } });

  // The three chats have a tab each; the board holds the focus, so no chat is
  // the active one (an active chat hides its own badge by design).
  const panes = [a.id, b.id, stale.id, BOARD];
  await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: panes } });
  await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: panes, pinned: panes } });
  await resetPaneStore(page.request, panes);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
  await page.locator(`[data-pane-id="${BOARD}"]`).click();
  // Whatever the baseline leaves on the OS badge (board cards in review) is
  // not ours: every assertion below is measured from here.
  const base = await globalNumber(page);

  // The panel opens first, with nothing new in it.
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(bellCount(page)).toHaveCount(0);

  // ── (a) two chats, six messages: the global number says TWO ──────────────
  await messages(page.request, a.id, 4);
  await messages(page.request, b.id, 2);
  await notify(page.request, a.id, "Many replied");
  await notify(page.request, b.id, "Few replied");
  await expect(rowBadge(page, a.name)).toHaveAttribute("data-notification-count", "4", { timeout: 10_000 });
  await expect(rowBadge(page, b.name)).toHaveAttribute("data-notification-count", "2");
  await expect(tabBadge(page, a.id)).toHaveAttribute("data-notification-count", "4");
  await expect(bellCount(page)).toHaveAttribute("data-notification-count", "2");
  await expect.poll(() => globalNumber(page), { timeout: 10_000 }).toBe(base + 2);
  await didascalia(page, "a · 2 chats, 6 messages: the bell and the Dock both say 2");
  await beat(page, 1600);

  // ── (b) one chat's notification seen in the panel ────────────────────────
  await expect(panelRowOf(page, a.id)).toBeVisible();
  await panelRowOf(page, a.id).click();
  await expect.poll(() => unreadOf(page.request, a.id), { timeout: 10_000 }).toBe(0);
  await expect(rowBadge(page, a.name)).toHaveCount(0);
  await expect(tabBadge(page, a.id)).toHaveCount(0);
  await expect(bellCount(page)).toHaveAttribute("data-notification-count", "1");
  await expect.poll(() => globalNumber(page), { timeout: 10_000 }).toBe(base + 1);
  // The other chat is untouched.
  await expect(rowBadge(page, b.name)).toHaveAttribute("data-notification-count", "2");
  await didascalia(page, "b · one notification seen: its chat and the Dock drop together");
  await beat(page, 1600);

  // ── (c) mark all, including a chat with unread and no row ────────────────
  // `stale` is the live case: unread messages, no unseen notification left.
  await messages(page.request, stale.id, 3);
  await expect(rowBadge(page, stale.name)).toHaveAttribute("data-notification-count", "3", { timeout: 10_000 });
  await expect.poll(() => globalNumber(page), { timeout: 10_000 }).toBe(base + 2);
  await expect(bellCount(page)).toHaveAttribute("data-notification-count", "1");

  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(bellCount(page)).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => unreadOf(page.request, b.id), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => unreadOf(page.request, stale.id), { timeout: 10_000 }).toBe(0);
  await expect(rowBadge(page, b.name)).toHaveCount(0);
  await expect(rowBadge(page, stale.name)).toHaveCount(0);
  await expect(tabBadge(page, stale.id)).toHaveCount(0);
  await expect.poll(() => globalNumber(page), { timeout: 10_000 }).toBe(base);
  await didascalia(page, "c · panel opened: every chat clears, the stale one too; Dock back to 0");
  await beat(page, 2000);
});

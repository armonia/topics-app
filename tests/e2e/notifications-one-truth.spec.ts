/**
 * ONE SEEN-STATE PER SUBJECT, end to end: what the notifications panel says and
 * what every other surface shows are the same fact.
 *
 * The report (2026-09-29): 133 on the dock; opening the sidebar's notifications
 * cleared them there and nowhere else. Measured on the live DB: 0 unseen
 * notification rows, 132 unread messages on 6 chats, a dock at 133. Two
 * defects, both proven here:
 *   - the global number (dock, tray, PWA badge) summed MESSAGES: a chat with 4
 *     unread counted 4 while the panel listed it once;
 *   - seeing notifications in the panel cleared the panel only: the chats kept
 *     their unread, so their badges and the dock stayed lit.
 *
 * The global number is read where the Dock and the PWA badge read it: the
 * Badging API (`navigator.setAppBadge`), stubbed to record its last value. The
 * bell shows THE SAME number (NOTIF-ONE-02), and every assertion on one is made
 * on the other. Nothing internal is mocked.
 *
 * Order: the panel is opened FIRST, empty, because opening it IS the mark all;
 * the two chats' notifications then arrive while it is open, which is the only
 * way one of them can be seen on its own in the panel.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
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
/** The bell's number; its badge hides at zero. */
const bellNumber = async (page: Page): Promise<number> =>
  (await bellCount(page).count()) ? Number(await bellCount(page).getAttribute("data-notification-count")) : 0;
/** Both surfaces at once: the dock and the bell must say the same thing. */
async function expectBoth(page: Page, n: number): Promise<void> {
  await expect.poll(() => globalNumber(page), { timeout: 10_000 }).toBe(n);
  await expect.poll(() => bellNumber(page), { timeout: 10_000 }).toBe(n);
}
const panel = (page: Page) => page.getByTestId("notification-history-panel");
const panelRowOf = (page: Page, topicId: string) =>
  page.locator(`[data-testid="notification-history-row"][data-target="/topic/${topicId}"]`);
const rowBadge = (page: Page, name: string) =>
  page.getByRole("treeitem", { name: new RegExp(name) }).first().locator("[data-notification-count]");
const tabBadge = (page: Page, topicId: string) =>
  page.locator(`[data-pane-id="${topicId}"] [data-notification-count]`);

/** The OS badge, recorded where the app paints it. */
async function stubAppBadge(page: Page): Promise<void> {
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
}

/** A clean start on BOTH sides of the fix: every chat of the seeded baseline
 *  read through the route that has always cleared a chat, every row seen. */
async function cleanStart(page: Page): Promise<void> {
  const unread = (await (await page.request.get(`${BASE}/api/unread`)).json()) as Unread;
  for (const [id, u] of Object.entries(unread)) {
    if ((u?.unreadCount ?? 0) > 0) await page.request.post(`${BASE}/api/topics/${id}/read`);
  }
  await page.request.post(`${BASE}/api/notifications/seen`, { data: { upTo: new Date().toISOString() } });
}

async function openWith(page: Page, panes: string[], focus: string): Promise<void> {
  await page.request.put(`${BASE}/api/ui-state/panels`, { data: { openPanels: panes } });
  await page.request.put(`${BASE}/api/ui-state/panel-order`, { data: { order: panes, pinned: panes } });
  await resetPaneStore(page.request, panes);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
  await page.locator(`[data-pane-id="${focus}"]`).click();
}

let a: { id: string; name: string };
let b: { id: string; name: string };
let stale: { id: string; name: string };
let late: { id: string; name: string };
const CARD_BOARD = `one-truth-${TS}`;
let cardId = "";

test.beforeAll(async ({ request }) => {
  a = await createTopic(request, `OneTruth-Many-${TS}`);
  b = await createTopic(request, `OneTruth-Few-${TS}`);
  stale = await createTopic(request, `OneTruth-Stale-${TS}`);
  late = await createTopic(request, `OneTruth-Late-${TS}`);
});

test.afterAll(async ({ request }) => {
  for (const t of [a, b, stale, late]) if (t) await deleteTopic(request, t.id).catch(() => {});
  if (cardId) await deleteTask(request, CARD_BOARD, cardId).catch(() => {});
});

test("NOTIF-ONE: the global number counts chats, and seeing in the panel clears them everywhere", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-01" });
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-02" });
  test.setTimeout(90_000);

  await stubAppBadge(page);
  await cleanStart(page);

  // The three chats have a tab each; the board holds the focus, so no chat is
  // the active one (an active chat hides its own badge by design).
  await openWith(page, [a.id, b.id, stale.id, BOARD], BOARD);
  // Whatever the baseline leaves on the OS badge (board cards in review) is
  // not ours: every assertion below is measured from here.
  const base = await globalNumber(page);

  // The panel opens first, with nothing new in it.
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expectBoth(page, base);

  // ── (a) two chats, six messages: the global number says TWO ──────────────
  await messages(page.request, a.id, 4);
  await messages(page.request, b.id, 2);
  await notify(page.request, a.id, "Many replied");
  await notify(page.request, b.id, "Few replied");
  await expect(rowBadge(page, a.name)).toHaveAttribute("data-notification-count", "4", { timeout: 10_000 });
  await expect(rowBadge(page, b.name)).toHaveAttribute("data-notification-count", "2");
  await expect(tabBadge(page, a.id)).toHaveAttribute("data-notification-count", "4");
  await expectBoth(page, base + 2);
  await didascalia(page, "a · 2 chats, 6 messages: the bell and the Dock both say 2");
  await beat(page, 1600);

  // ── (b) one chat's notification seen in the panel ────────────────────────
  await expect(panelRowOf(page, a.id)).toBeVisible();
  await panelRowOf(page, a.id).click();
  await expect.poll(() => unreadOf(page.request, a.id), { timeout: 10_000 }).toBe(0);
  await expect(rowBadge(page, a.name)).toHaveCount(0);
  await expect(tabBadge(page, a.id)).toHaveCount(0);
  await expectBoth(page, base + 1);
  // The other chat is untouched.
  await expect(rowBadge(page, b.name)).toHaveAttribute("data-notification-count", "2");
  await didascalia(page, "b · one notification seen: its chat and the Dock drop together");
  await beat(page, 1600);

  // ── (c) mark all, including a chat with unread and no row ────────────────
  // `stale` is the live case: unread messages, no unseen notification left.
  await messages(page.request, stale.id, 3);
  await expect(rowBadge(page, stale.name)).toHaveAttribute("data-notification-count", "3", { timeout: 10_000 });
  // `stale` has no notification but asks for something: the bell counts it too.
  await expectBoth(page, base + 2);

  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => unreadOf(page.request, b.id), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => unreadOf(page.request, stale.id), { timeout: 10_000 }).toBe(0);
  await expect(rowBadge(page, b.name)).toHaveCount(0);
  await expect(rowBadge(page, stale.name)).toHaveCount(0);
  await expect(tabBadge(page, stale.id)).toHaveCount(0);
  await expectBoth(page, base);
  await didascalia(page, "c · panel opened: every chat clears, the stale one too; Dock back to 0");
  await beat(page, 2000);
});

test("NOTIF-ONE: a card in review with no notification is on the bell AND in the panel, not only on the Dock", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-02" });
  test.setTimeout(60_000);
  await stubAppBadge(page);
  await cleanStart(page);
  await openWith(page, [BOARD], BOARD);
  const base = await globalNumber(page);
  await expectBoth(page, base);

  // A card enters review; nothing writes a notification row for it.
  const created = await page.request.post(`${BASE}/api/boards/${CARD_BOARD}/tasks`, {
    data: { text: `OneTruth card ${TS}`, status: "review" },
  });
  expect(created.ok()).toBe(true);
  cardId = ((await created.json()) as { id: string }).id;
  const rows = (await (await page.request.get(`${BASE}/api/notifications`)).json()) as {
    rows: Array<{ targetId: string | null }>;
  };
  expect(rows.rows.filter((r) => r.targetId === cardId)).toHaveLength(0);

  await expectBoth(page, base + 1);
  await didascalia(page, "d · a card in review, no notification row: the Dock and the bell both say it");
  await beat(page, 1400);

  // Opening the panel (the mark all) cannot clear a decision: the card stays
  // counted, and the panel says WHAT is counted instead of "No notifications".
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  const waitingRow = page.locator(`[data-testid="notification-waiting-row"][data-subject="task:${cardId}"]`);
  await expect(waitingRow).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("notification-history-empty")).toHaveCount(0);
  await expectBoth(page, base + 1);
  await didascalia(page, "d · the panel lists the card under Waiting for you; bell = Dock");
  await beat(page, 1600);

  // Deciding it is what clears it, everywhere at once.
  const moved = await page.request.patch(`${BASE}/api/boards/${CARD_BOARD}/tasks/${cardId}`, { data: { status: "done" } });
  expect(moved.ok()).toBe(true);
  await expect(waitingRow).toHaveCount(0, { timeout: 10_000 });
  await expectBoth(page, base);
});

test("NOTIF-ONE: opening a chat whose notification was born after its unread was cleared sees that notification", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-01" });
  test.setTimeout(60_000);
  await stubAppBadge(page);
  await cleanStart(page);
  await openWith(page, [late.id, BOARD], BOARD);
  const base = await globalNumber(page);
  await expectBoth(page, base);

  // Unread zero, one unseen notification: the multi-window case.
  expect(await unreadOf(page.request, late.id)).toBe(0);
  await notify(page.request, late.id, "Late replied");
  await expectBoth(page, base + 1);

  // Opening the chat from its tab is the seen: the POST must go out even with
  // nothing unread, and the bell and the Dock drop with it.
  const read = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith(`/api/topics/${late.id}/read`),
    { timeout: 15_000 },
  );
  await page.locator(`[data-pane-id="${late.id}"]`).click();
  await read;
  await expect.poll(async () => {
    const listed = (await (await page.request.get(`${BASE}/api/notifications`)).json()) as {
      rows: Array<{ targetId: string | null; seenAt: string | null }>;
    };
    return listed.rows.filter((r) => r.targetId === late.id && !r.seenAt).length;
  }, { timeout: 10_000 }).toBe(0);
  await expectBoth(page, base);
  await didascalia(page, "e · the chat opened: its late notification is seen, bell and Dock back");
  await beat(page, 1400);
});

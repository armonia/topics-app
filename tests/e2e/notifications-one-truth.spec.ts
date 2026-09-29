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

/** Relays the page's real socket and returns a way to inject a frame into it,
 *  with the shape the server broadcasts (an external boundary). */
async function relaySocket(page: Page): Promise<(frame: Record<string, unknown>) => void> {
  let inject: ((data: string) => void) | null = null;
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    inject = (data: string) => ws.send(data);
  });
  return (frame) => {
    if (!inject) throw new Error("the page has not opened its socket yet");
    inject(JSON.stringify(frame));
  };
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
let shown: { id: string; name: string };
let muted: { id: string; name: string };
let finished: { id: string; name: string };
let crossDone: { id: string; name: string };
const CARD_BOARD = `one-truth-${TS}`;
let cardId = "";

test.beforeAll(async ({ request }) => {
  a = await createTopic(request, `OneTruth-Many-${TS}`);
  b = await createTopic(request, `OneTruth-Few-${TS}`);
  stale = await createTopic(request, `OneTruth-Stale-${TS}`);
  late = await createTopic(request, `OneTruth-Late-${TS}`);
  shown = await createTopic(request, `OneTruth-Shown-${TS}`);
  muted = await createTopic(request, `OneTruth-Muted-${TS}`);
  // The per-topic mute (migration 073): its turns raise no banner, hence no row.
  const res = await request.patch(`${BASE}/api/topics/${muted.id}`, { data: { muted: true } });
  expect(res.ok()).toBe(true);
  // Hookless AND muted: its finished turn writes no banner row, so only the
  // 'done' mark can make it count.
  finished = await createTopic(request, `OneTruth-Finished-${TS}`, { provider: "topics" });
  const mute = await request.patch(`${BASE}/api/topics/${finished.id}`, { data: { muted: true } });
  expect(mute.ok()).toBe(true);
  // Same shape, for the two-window case: its only trace is the windows' marks.
  crossDone = await createTopic(request, `OneTruth-CrossDone-${TS}`, { provider: "topics" });
  expect((await request.patch(`${BASE}/api/topics/${crossDone.id}`, { data: { muted: true } })).ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  for (const t of [a, b, stale, late, shown, muted, finished, crossDone]) if (t) await deleteTopic(request, t.id).catch(() => {});
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

test("NOTIF-ONE: the mark all clears what the panel listed, and a muted chat whose messages came after the list keeps its unread", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-01" });
  test.info().annotations.push({ type: "spec", description: "MUTE-01" });
  test.setTimeout(60_000);
  await stubAppBadge(page);
  await cleanStart(page);
  await openWith(page, [shown.id, muted.id, BOARD], BOARD);
  const base = await globalNumber(page);
  await expectBoth(page, base);

  // `shown` is in the panel when it opens: unread and a notification.
  await messages(page.request, shown.id, 2);
  await notify(page.request, shown.id, "Shown replied");
  await expectBoth(page, base + 1);

  // The mark all is held on the wire (passed through untouched) so that the
  // muted chat's messages land AFTER the list was read and BEFORE the server
  // applies the mark all. A muted chat raises no banner, so it never has a row
  // that could spare it: only what the panel listed may be cleared.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let posted!: () => void;
  const seenPosted = new Promise<void>((r) => { posted = r; });
  await page.route("**/api/notifications/seen", async (route) => {
    posted();
    await gate;
    await route.continue();
  });

  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await seenPosted;
  await messages(page.request, muted.id, 3);
  await expect(rowBadge(page, muted.name)).toHaveAttribute("data-notification-count", "3", { timeout: 10_000 });
  const applied = page.waitForResponse((r) => r.url().endsWith("/api/notifications/seen") && r.request().method() === "POST");
  release();
  expect((await applied).ok()).toBe(true);
  await page.unroute("**/api/notifications/seen");

  // What the panel listed is seen; the muted chat it had not shown is not.
  await expect.poll(() => unreadOf(page.request, shown.id), { timeout: 10_000 }).toBe(0);
  expect(await unreadOf(page.request, muted.id)).toBe(3);
  await expect(rowBadge(page, muted.name)).toHaveAttribute("data-notification-count", "3");
  await expect(page.locator(`[data-testid="notification-waiting-row"][data-subject="topic:${muted.id}"]`)).toBeVisible();
  // Mute silences the banner, never the count (MUTE-01): it is still one.
  await expectBoth(page, base + 1);
  await didascalia(page, "f · mark all: the listed chat clears, the muted one that came after keeps its 3");
});

test("NOTIF-ONE: a hookless chat that finished counts one on the bell and the Dock, is listed, and the mark all clears it", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "NOTIF-ONE-02" });
  test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
  test.setTimeout(60_000);
  await stubAppBadge(page);
  // The turn end arrives on the real socket, injected with the shape the
  // server broadcasts (an external boundary); the server's own frames pass.
  const inject = await relaySocket(page);
  const topics = (await (await page.request.get(`${BASE}/api/topics`)).json()) as {
    topics: Record<string, { sessionKey?: string }>;
  };
  const sessionKey = topics.topics[finished.id]?.sessionKey;
  expect(sessionKey).toBeTruthy();

  await cleanStart(page);
  // Its tab is open (a chat with neither a tab nor unread has no row), the
  // board holds the focus: nobody is looking at the chat when it finishes.
  await openWith(page, [finished.id, BOARD], BOARD);
  const finishedRow = page.getByRole("treeitem", { name: finished.name, exact: true });
  await expect(finishedRow).toBeVisible({ timeout: 15_000 });
  const base = await globalNumber(page);

  // The panel is open first, so the mark arrives while it is on screen.
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expectBoth(page, base);

  inject({
    type: "stream:end", sessionKey, topicId: finished.id, messageId: `done-${TS}`, completed: true, stopReason: "end_turn",
  });
  await expect(finishedRow).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
  // Nothing but the mark: no unread, no notification row (muted, no banner).
  expect(await unreadOf(page.request, finished.id)).toBe(0);
  const listed = (await (await page.request.get(`${BASE}/api/notifications`)).json()) as {
    rows: Array<{ targetId: string | null }>;
  };
  expect(listed.rows.filter((r) => r.targetId === finished.id)).toHaveLength(0);

  // One subject, like a finished terminal, on both numbers and in the panel.
  await expectBoth(page, base + 1);
  const waitingRow = page.locator(`[data-testid="notification-waiting-row"][data-subject="topic:${finished.id}"]`);
  await expect(waitingRow).toBeVisible({ timeout: 10_000 });
  await didascalia(page, "g · a hookless chat finished: one more on the bell and the Dock, listed in the panel");

  // Closing and reopening the panel is the mark all: the mark goes everywhere.
  await bell(page).click();
  await expect(panel(page)).toHaveCount(0);
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(finishedRow).not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
  await expect(waitingRow).toHaveCount(0);
  await expectBoth(page, base);
  await didascalia(page, "g · panel reopened: the finished chat's mark is seen, bell and Dock back");
});

test("NOTIF-ONE: a finished chat opened in one window drops its 'done' mark in the other, with no unread and no row", async ({ page, browser }) => {
  test.info().annotations.push({ type: "spec", description: "CHAT-DONE-01" });
  test.setTimeout(90_000);
  // Two windows: this page (A) and a second context (B), each with its own
  // device-local focus, like the Mac app and a browser tab on the same server.
  const other = await browser.newContext({ recordVideo: { dir: test.info().outputPath("window-b") } });
  try {
    const windowB = await other.newPage();
    const injectA = await relaySocket(page);
    const injectB = await relaySocket(windowB);
    const topics = (await (await page.request.get(`${BASE}/api/topics`)).json()) as {
      topics: Record<string, { sessionKey?: string }>;
    };
    const sessionKey = topics.topics[crossDone.id]?.sessionKey;
    expect(sessionKey).toBeTruthy();

    await cleanStart(page);
    // Both windows show the chat's tab with the board in front: nobody is
    // looking at the chat when its turn ends.
    await openWith(page, [crossDone.id, BOARD], BOARD);
    await windowB.goto("/");
    await windowB.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
    await windowB.locator(`[data-pane-id="${BOARD}"]`).click();
    const rowA = page.getByRole("treeitem", { name: crossDone.name, exact: true });
    const rowB = windowB.getByRole("treeitem", { name: crossDone.name, exact: true });
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible({ timeout: 15_000 });

    const end = { type: "stream:end", sessionKey, topicId: crossDone.id, messageId: `cross-${TS}`, completed: true, stopReason: "end_turn" };
    injectA(end);
    injectB(end);
    await expect(rowA).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(rowB).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    // Nothing but the marks: no unread, no notification row (muted, no banner).
    expect(await unreadOf(page.request, crossDone.id)).toBe(0);
    const listed = (await (await page.request.get(`${BASE}/api/notifications`)).json()) as {
      rows: Array<{ targetId: string | null }>;
    };
    expect(listed.rows.filter((r) => r.targetId === crossDone.id)).toHaveLength(0);
    await didascalia(page, "h · a hookless chat finished: 'done' in both windows, nothing on the server");

    // Opened in A: A drops its mark at once, and after the seen dwell the
    // server's frame drops it in B too.
    await page.bringToFront();
    await page.locator(`[data-pane-id="${crossDone.id}"]`).click();
    await expect(rowA).not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
    await expect(rowB, "the chat seen in A is seen in B").not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
    await didascalia(page, "h · opened in A: the mark is gone in B as well");
  } finally {
    await other.close();
  }
});

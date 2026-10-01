/**
 * ONE "SEEN" PER PANE, whatever brought the pane in front.
 *
 * The report (01/10): notifications still disagree. A pane whose tab is blue
 * keeps its blue when you click INSIDE it; clicking its TAB clears it. The tab
 * click carried a private clear for the terminal mark, the terminal body
 * cleared its own mark as soon as it was merely VISIBLE (focused or not), and a
 * chat already in front whose Claude phase came back to `awaiting-user` was
 * never seen again (the dwell had already fired once for that focus).
 *
 * The rule proved here: a pane is seen when it is THE focused pane of the
 * window (tab click, click inside, keyboard, sidebar row: any input), with the
 * window awake, for the seen dwell. That one event clears every mark of the
 * pane on every surface at once: tab, sidebar row, the bell (whose number is
 * the Dock's, NOTIF-ONE-02). A mark on a pane that is visible in a split but
 * not focused stays.
 *
 * What is faked: the server's frames for the marks are injected on the real
 * socket (an external boundary) with the shape the server broadcasts; the
 * shell's own `terminal:activity` frames are filtered out so a prompt repaint
 * cannot clear the injected mark behind the test's back. The window is pinned
 * awake (visible + focused) so the dwell does not depend on the headless
 * browser's focus. Everything in between is the real code.
 *
 * No sleep: "a dwell has passed" is read off a witness, the focused chat's own
 * blue fill, which a new `awaiting-user` lights and the dwell switches off.
 * Where no witness can exist (a permission wait is never switched off by a
 * look; the unread door has no mark of its own), `page.clock` is moved past the
 * dwell instead.
 *
 * Also proved: a pane is in front with no focus to name it (nothing clicked
 * yet, the group draws its active tab as focused), the board's coordinator in
 * its drawer is in front when the board is, a permission wait stays amber on
 * every surface after a look, and the unread of the chat in front is read
 * once the window comes back.
 *
 * @covers SEEN-ANY-FOCUS-01
 * @covers SEEN-ANY-FOCUS-02
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { splitViaContextMenu } from "./helpers/layout";
import {
  createTerminalSession,
  createTopic,
  deleteTerminalSession,
  deleteTopic,
  resetPaneStore,
  seedPaneStore,
  unarchiveTopic,
} from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

const BASE = E2E_BASE;

async function sessionKeyOf(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/topics/${id}`, { ignoreHTTPSErrors: true });
  const { topic } = (await res.json()) as { topic: { sessionKey: string } };
  return topic.sessionKey;
}

/** The window is in front of the person: visible and focused, pinned. */
async function pinAwake(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.hasFocus = () => true;
  });
}

/** The window starts awake and the test can send it behind and back
 *  (`setAwake`); the Badging API records every number the Dock is given. */
async function awakeWithDock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __awake: boolean; __dock: number[] };
    w.__awake = true;
    w.__dock = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__awake ? "visible" : "hidden") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !w.__awake });
    document.hasFocus = () => w.__awake;
    const nav = navigator as unknown as { setAppBadge: (n?: number) => Promise<void>; clearAppBadge: () => Promise<void> };
    nav.setAppBadge = (n?: number) => { w.__dock.push(n ?? 0); return Promise.resolve(); };
    nav.clearAppBadge = () => { w.__dock.push(0); return Promise.resolve(); };
  });
}

async function setAwake(page: Page, awake: boolean): Promise<void> {
  await page.evaluate((a) => {
    (window as unknown as { __awake: boolean }).__awake = a;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(a ? "focus" : "blur"));
  }, awake);
}

const dockHistory = (page: Page) => page.evaluate(() => (window as unknown as { __dock: number[] }).__dock.slice());

/** SEEN_DWELL_MS (client/src/state/signals.ts) three times over: the clock is
 *  moved past the dwell, not waited for (`page.clock`, as in mute-and-badge). */
const PAST_THE_DWELL_MS = 3 * 1200;

/** Relay the page's socket, drop the server's own `terminal:activity` frames for
 *  `quietTerminals`, and return a way to inject a frame. */
async function relay(page: Page, quietTerminals: () => string[]): Promise<(frame: Record<string, unknown>) => void> {
  let inject: ((data: string) => void) | null = null;
  // The app's socket only (`/ws`): a terminal pane opens its own socket under
  // `/ws/...`, and a frame injected there would be typed into the shell.
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === "string" && m.includes('"terminal:activity"')) {
        const id = (JSON.parse(m) as { id?: string }).id;
        if (id && quietTerminals().includes(id)) return;
      }
      ws.send(m);
    });
    inject = (data: string) => ws.send(data);
  });
  return (frame) => {
    if (!inject) throw new Error("the page has not opened its socket yet");
    inject(JSON.stringify(frame));
  };
}

const bellCount = (page: Page) => page.getByTestId("notification-history-button").locator("[data-notification-count]");
const bellNumber = async (page: Page): Promise<number> =>
  (await bellCount(page).count()) ? Number(await bellCount(page).getAttribute("data-notification-count")) : 0;

const tab = (page: Page, paneId: string) => page.locator(`[role="tab"][data-pane-id="${paneId}"]`);
const chatRow = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const terminalRow = (page: Page, sid: string) => page.locator(`[data-terminal-row="${sid}"]`);
const badgeOf = (surface: Locator) => surface.locator("[data-notification-count]");

/** The registry's state of the newest row grouped under the terminal. */
async function terminalRowState(request: APIRequestContext, sid: string): Promise<"none" | "seen" | "unseen"> {
  const res = await request.get(`${BASE}/api/notifications?limit=50`, { ignoreHTTPSErrors: true });
  const { rows } = (await res.json()) as { rows?: Array<{ groupKey: string | null; seenAt: string | null }> };
  const row = (rows ?? []).find((x) => x.groupKey === `terminal:${sid}`);
  return row ? (row.seenAt ? "seen" : "unseen") : "none";
}

/** The row a hook-driven claude-code terminal's banner writes: grouped under
 *  the session, no target, and no finished mark beside it (its phase drives
 *  attention, so `terminal:activity` never marks it). Same shape as
 *  `recordNotificationSent` from `useCompletionNotifier`. */
async function recordTerminalBannerRow(request: APIRequestContext, sid: string): Promise<void> {
  const res = await request.post(`${BASE}/api/notifications`, {
    data: { kind: "session", title: "Claude Code", body: "Turn finished", dedupeKey: `terminal:seen-${sid}-${Date.now()}`, groupKey: `terminal:${sid}`, source: "banner" },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok(), `POST /api/notifications ${res.status()}`).toBe(true);
}

/** Click inside the pane's BODY (not its tab): the middle of its split card,
 *  below the tab bar. */
async function clickInside(page: Page, paneId: string): Promise<void> {
  const card = page.locator("[data-split-card]").filter({ has: tab(page, paneId) });
  const box = await card.boundingBox();
  if (!box) throw new Error(`no split card holds the pane ${paneId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  // The click moved the focus: the pane is now the one in front.
  await expect(tab(page, paneId), `a click inside ${paneId} did not focus it`).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
}

test.describe("Seen on any focus: one event clears a pane's marks everywhere", () => {
  let focusChat: { id: string; name: string };
  let doneChat: { id: string; name: string };
  let term: { id: string; name: string };
  let termPane: string;
  let focusKey: string;
  let doneKey: string;

  test.beforeEach(async ({ request }) => {
    const stamp = Date.now();
    focusChat = await createTopic(request, `Seen-Focus-${stamp}`, { provider: "topics" });
    // Muted, both: a finished turn writes no banner row, so the marks under
    // test are the only things the two chats can put on the bell.
    expect((await request.patch(`${BASE}/api/topics/${focusChat.id}`, { data: { muted: true } })).ok()).toBe(true);
    doneChat = await createTopic(request, `Seen-Done-${stamp}`, { provider: "topics" });
    expect((await request.patch(`${BASE}/api/topics/${doneChat.id}`, { data: { muted: true } })).ok()).toBe(true);
    focusKey = await sessionKeyOf(request, focusChat.id);
    doneKey = await sessionKeyOf(request, doneChat.id);
    // A plain shell: no CLI is spawned. Its "finished" mark is injected.
    term = await createTerminalSession(request, { name: `Seen-Term-${stamp}`, cols: 80, rows: 24 });
    termPane = `terminal:${term.id}`;
    await request.post(`${BASE}/api/notifications/seen`, { data: { upTo: new Date().toISOString() } });
  });

  test.afterEach(async ({ request }) => {
    for (const t of [focusChat, doneChat]) if (t) await deleteTopic(request, t.id).catch(() => {});
    if (term) await deleteTerminalSession(request, term.id);
  });

  /** Three cells side by side, the focus on the first: the chat and the
   *  terminal are VISIBLE and not focused. */
  async function threeCells(page: Page): Promise<void> {
    await resetPaneStore(page.request, [focusChat.id, doneChat.id, termPane]);
    await goToApp(page);
    await expect(tab(page, termPane)).toBeVisible({ timeout: 20_000 });
    await splitViaContextMenu(page, "Dividi a destra", 1);
    await splitViaContextMenu(page, "Dividi a destra", 1);
    await expect(page.locator("[data-split-card]")).toHaveCount(3, { timeout: 10_000 });
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-active", "true");
    await expect(tab(page, doneChat.id)).toBeVisible();
    await expect(tab(page, termPane)).toBeVisible();
    await expect(chatRow(page, doneChat.name)).toBeVisible({ timeout: 15_000 });
    await expect(terminalRow(page, term.id)).toBeVisible({ timeout: 15_000 });
  }

  /** A new "your turn" on a chat: its Claude phase leaves and re-enters
   *  `awaiting-user`, as two frames the store applies apart, so the rising
   *  edge exists. Waits for the state on the tab: the edge has been applied. */
  async function newTurnParks(page: Page, inject: (f: Record<string, unknown>) => void, topicId: string, key: string, rev: number): Promise<void> {
    inject({ type: "session:state", sessionKey: key, state: { phase: "running", rev, claudeSessionId: key } });
    await expect(tab(page, topicId)).not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
    inject({ type: "session:state", sessionKey: key, state: { phase: "awaiting-user", rev: rev + 1, claudeSessionId: key } });
    await expect(tab(page, topicId)).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
  }

  test("SEEN-ANY-FOCUS-01: a visible but unfocused pane keeps its mark; a click inside it clears tab, row and bell", async ({ page }) => {
    test.setTimeout(90_000);
    await pinAwake(page);
    const inject = await relay(page, () => [term.id]);
    await threeCells(page);
    const base = await bellNumber(page);

    // Both turns end while the person looks at the first cell...
    inject({ type: "stream:end", sessionKey: doneKey, topicId: doneChat.id, messageId: `seen-${Date.now()}`, completed: true, stopReason: "end_turn" });
    inject({ type: "terminal:activity", id: term.id, busy: false, finished: true, kind: "claude-code" });
    await expect(tab(page, doneChat.id), "the finished chat's tab is not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name)).toHaveAttribute("data-attention", "done");
    await expect(badgeOf(tab(page, termPane)), "the finished terminal's tab carries no badge").toHaveAttribute("data-notification-count", "1", { timeout: 10_000 });
    await expect(badgeOf(terminalRow(page, term.id))).toHaveAttribute("data-notification-count", "1");
    await expect.poll(() => bellNumber(page), { timeout: 10_000 }).toBe(base + 2);

    // ...and the witness: the chat in front parks on a new turn after them.
    // Its fill goes once a dwell has passed (the pane is seen), so by then
    // the dwell had every chance to clear the two visible panes too.
    await newTurnParks(page, inject, focusChat.id, focusKey, 1);
    await expect(tab(page, focusChat.id), "the witness: the focused chat was never seen").not.toHaveAttribute("data-attention-fill", /done|input/, { timeout: 10_000 });
    // The focused chat's phase is a state the bell counts (out of this test).
    await expect.poll(() => bellNumber(page), { timeout: 10_000 }).toBe(base + 3);

    // Visible is not seen: both marks are still on every surface.
    await expect(tab(page, doneChat.id), "a visible, unfocused chat lost its mark").toHaveAttribute("data-attention", "done");
    await expect(chatRow(page, doneChat.name)).toHaveAttribute("data-attention", "done");
    await expect(badgeOf(tab(page, termPane)), "a visible, unfocused terminal lost its mark").toHaveAttribute("data-notification-count", "1");
    await expect(badgeOf(terminalRow(page, term.id))).toHaveAttribute("data-notification-count", "1");

    // A click INSIDE the chat, not on its tab: the chat's marks go everywhere.
    await clickInside(page, doneChat.id);
    await expect(tab(page, doneChat.id), "a click inside the chat left its tab marked").not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name), "a click inside the chat left its row marked").not.toHaveAttribute("data-attention", /done|input/);
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the bell still counts the seen chat" }).toBe(base + 2);
    // The terminal was not looked at: it keeps its mark.
    await expect(badgeOf(tab(page, termPane))).toHaveAttribute("data-notification-count", "1");
    await expect(badgeOf(terminalRow(page, term.id))).toHaveAttribute("data-notification-count", "1");

    // A click INSIDE the terminal: its marks go everywhere too.
    await clickInside(page, termPane);
    await expect(badgeOf(terminalRow(page, term.id)), "a click inside the terminal left its row badge").toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the bell still counts the seen terminal" }).toBe(base + 1);
    // Leave it: the tab of a pane you no longer look at shows what is left.
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-active", "true");
    await expect(badgeOf(tab(page, termPane)), "a click inside the terminal left its tab badge").toHaveCount(0);
  });

  test("SEEN-ANY-FOCUS-02: a pane already focused when its turn ends is never left marked, on any surface", async ({ page }) => {
    test.setTimeout(90_000);
    await pinAwake(page);
    const inject = await relay(page, () => [term.id]);
    await threeCells(page);

    // The chat parks while unfocused: blue on its tab and its row.
    await newTurnParks(page, inject, doneChat.id, doneKey, 1);
    await expect(tab(page, doneChat.id)).toHaveAttribute("data-attention-fill", "done");
    await expect(chatRow(page, doneChat.name)).toHaveAttribute("data-attention-fill", "done");
    // Focused from inside: seen after the dwell, on both surfaces.
    await clickInside(page, doneChat.id);
    await expect(tab(page, doneChat.id)).not.toHaveAttribute("data-attention-fill", /done|input/, { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name)).not.toHaveAttribute("data-attention-fill", /done|input/);

    // Still in front of the person, the chat parks on a NEW turn. The blue
    // may show for the dwell; it must not stay on the pane you look at.
    await newTurnParks(page, inject, doneChat.id, doneKey, 3);
    await expect(tab(page, doneChat.id), "the focused chat's tab stays blue").not.toHaveAttribute("data-attention-fill", /done|input/, { timeout: 10_000 });
    await expect(chatRow(page, doneChat.name), "the focused chat's row stays blue").not.toHaveAttribute("data-attention-fill", /done|input/);

    // The terminal, focused from inside, finishes a turn in front of you.
    await clickInside(page, termPane);
    const base = await bellNumber(page);
    inject({ type: "terminal:activity", id: term.id, busy: false, finished: true, kind: "claude-code" });
    // The sentinel: a chat that is NOT in front finishes after it. Frames are
    // applied in order, so once its mark is on, the terminal's was handled.
    inject({ type: "stream:end", sessionKey: focusKey, topicId: focusChat.id, messageId: `sentinel-${Date.now()}`, completed: true, stopReason: "end_turn" });
    await expect(tab(page, focusChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(badgeOf(terminalRow(page, term.id)), "the focused terminal's row kept a badge").toHaveCount(0, { timeout: 10_000 });
    // Its banner still goes out ("notify even when focused" is on by default)
    // and leaves a history row: about the pane in front, so never unseen on
    // the bell and the Dock. Only the sentinel counts.
    await expect.poll(() => terminalRowState(page.request, term.id), { timeout: 10_000, message: "the focused terminal's banner left no row" }).not.toBe("none");
    await expect.poll(() => terminalRowState(page.request, term.id), { timeout: 10_000, message: "the focused terminal's row stays unseen" }).toBe("seen");
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the bell counts the terminal you are looking at" }).toBe(base + 1);
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-active", "true");
    await expect(badgeOf(tab(page, termPane)), "the focused terminal's tab kept a badge").toHaveCount(0);
  });
  test("SEEN-ANY-FOCUS-01b: a terminal's banner row with no finished mark goes from the bell when its tab or its row focuses it", async ({ page }) => {
    test.setTimeout(90_000);
    await pinAwake(page);
    await relay(page, () => [term.id]);
    await threeCells(page);
    const base = await bellNumber(page);

    // Its banner row lands while another cell is focused: one more on the bell.
    await recordTerminalBannerRow(page.request, term.id);
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the terminal's row is not on the bell" }).toBe(base + 1);
    // The TAB focuses it: the seen event clears the row.
    await tab(page, termPane).click();
    await expect(tab(page, termPane)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the tab click left the terminal's row on the bell" }).toBe(base);
    await expect.poll(() => terminalRowState(page.request, term.id), { timeout: 10_000 }).toBe("seen");

    // Away from it, a new row for the same terminal (already seen once).
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await recordTerminalBannerRow(page.request, term.id);
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the second row is not on the bell" }).toBe(base + 1);
    // The sidebar ROW focuses it: the same event clears it.
    await terminalRow(page, term.id).click();
    await expect(tab(page, termPane)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the row click left the terminal's row on the bell" }).toBe(base);
  });

  /** One group seeded with `paneIds`, nothing clicked: `focusedPanelId` stays
   *  null (a new device, a fresh PWA, the state after a drop) and the group
   *  draws its first tab as the focused one. */
  async function noFocusYet(page: Page, paneIds: string[]): Promise<void> {
    await resetPaneStore(page.request, paneIds);
    await goToApp(page);
    await expect(tab(page, paneIds[0]), "the first tab is not the active one").toHaveAttribute("data-active", "true", { timeout: 20_000 });
    await expect(tab(page, paneIds[0]), "the active tab is not drawn as focused").toHaveAttribute("data-focused", "true");
    await expect(tab(page, paneIds[1])).toBeVisible();
  }

  test("SEEN-ANY-FOCUS-02b: with no pane focused yet, the terminal its group draws in front finishes a turn and is left with no mark", async ({ page }) => {
    test.setTimeout(90_000);
    await pinAwake(page);
    const inject = await relay(page, () => [term.id]);
    await noFocusYet(page, [termPane, doneChat.id]);
    await expect(terminalRow(page, term.id)).toBeVisible({ timeout: 15_000 });
    const base = await bellNumber(page);

    // The terminal drawn in front finishes; then the sentinel, the chat in the
    // tab behind it, ends a turn. Frames are applied in order.
    inject({ type: "terminal:activity", id: term.id, busy: false, finished: true, kind: "claude-code" });
    inject({ type: "stream:end", sessionKey: doneKey, topicId: doneChat.id, messageId: `sentinel-${Date.now()}`, completed: true, stopReason: "end_turn" });
    await expect(tab(page, doneChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(badgeOf(terminalRow(page, term.id)), "the terminal drawn in front kept a row badge").toHaveCount(0);
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the bell counts the terminal drawn in front" }).toBe(base + 1);
    await tab(page, doneChat.id).click();
    await expect(tab(page, doneChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(badgeOf(tab(page, termPane)), "the terminal drawn in front kept a tab badge").toHaveCount(0);
  });

  test("SEEN-ANY-FOCUS-02c: with no pane focused yet, the chat its group draws in front ends a turn and is left with no mark", async ({ page }) => {
    test.setTimeout(90_000);
    await pinAwake(page);
    const inject = await relay(page, () => [term.id]);
    await noFocusYet(page, [focusChat.id, doneChat.id]);
    await expect(chatRow(page, focusChat.name)).toBeVisible({ timeout: 15_000 });
    const base = await bellNumber(page);

    inject({ type: "stream:end", sessionKey: focusKey, topicId: focusChat.id, messageId: `front-${Date.now()}`, completed: true, stopReason: "end_turn" });
    inject({ type: "stream:end", sessionKey: doneKey, topicId: doneChat.id, messageId: `sentinel-${Date.now()}`, completed: true, stopReason: "end_turn" });
    await expect(tab(page, doneChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(tab(page, focusChat.id), "the chat drawn in front kept its done mark").not.toHaveAttribute("data-attention", /done|input/);
    await expect(chatRow(page, focusChat.name), "the row of the chat drawn in front kept its done mark").not.toHaveAttribute("data-attention", /done|input/);
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "the bell counts the chat drawn in front" }).toBe(base + 1);
  });

  test("SEEN-ANY-FOCUS-02d: the board's coordinator, open in its drawer, ends a turn with no mark on the bell and no blink on the Dock", async ({ page }) => {
    test.setTimeout(90_000);
    await awakeWithDock(page);
    const inject = await relay(page, () => [term.id]);
    const board = "__board__";
    await resetPaneStore(page.request, [focusChat.id, doneChat.id, board]);
    await goToApp(page);
    await tab(page, board).click();
    await expect(tab(page, board)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("board-open-orchestrator").click();
    const drawer = page.getByTestId("board-orchestrator-drawer");
    await expect(drawer.getByTestId("chat-panel")).toBeVisible({ timeout: 15_000 });
    const res = await page.request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const all = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string; isGlobalOrchestrator?: boolean; muted?: boolean }> }).topics;
    const coordinator = Object.values(all).find((t) => t.isGlobalOrchestrator);
    expect(coordinator, "no coordinator topic").toBeTruthy();
    const wasMuted = coordinator!.muted === true;
    try {
      // Loud and muted: a loud end lit the Dock and took it back (a blink), a
      // muted one stayed on the bell. A sentinel chat behind the board ends a
      // turn after it each time: frames are applied in order.
      for (const [muted, sentinel] of [[false, focusChat], [true, doneChat]] as const) {
        expect((await page.request.patch(`${BASE}/api/topics/${coordinator!.id}`, { data: { muted } })).ok()).toBe(true);
        const base = await bellNumber(page);
        const dockFrom = (await dockHistory(page)).length;
        inject({ type: "stream:end", sessionKey: coordinator!.sessionKey, topicId: coordinator!.id, messageId: `coord-${muted}-${Date.now()}`, completed: true, stopReason: "end_turn" });
        inject({ type: "stream:end", sessionKey: sentinel === focusChat ? focusKey : doneKey, topicId: sentinel.id, messageId: `sentinel-${muted}-${Date.now()}`, completed: true, stopReason: "end_turn" });
        await expect(tab(page, sentinel.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
        await expect.poll(() => bellNumber(page), { timeout: 10_000, message: `the bell counts the coordinator you are looking at (muted: ${muted})` }).toBe(base + 1);
        const dock = (await dockHistory(page)).slice(dockFrom);
        expect(Math.max(base + 1, ...dock), `the Dock counted the coordinator you are looking at (muted: ${muted}): ${JSON.stringify(dock)}`).toBe(base + 1);
      }
    } finally {
      await page.request.patch(`${BASE}/api/topics/${coordinator!.id}`, { data: { muted: wasMuted } });
    }
  });

  test("SEEN-ANY-FOCUS-01c: a permission wait on the focused chat stays amber on its tab, its row and its group card past the dwell", async ({ page }) => {
    test.setTimeout(90_000);
    await pinAwake(page);
    await page.clock.install();
    const inject = await relay(page, () => [term.id]);
    // A second group, so the group cards are drawn.
    const SPACE_ID = "space:seen-any-focus";
    await Promise.all([focusChat.id, doneChat.id].map((id) => unarchiveTopic(page.request, id)));
    await seedPaneStore(page.request, () => {
      const openedAt = Date.now();
      const pane = (id: string, spaceId?: string) => ({ id, type: "chat", title: "", topicId: id, openedAt, ...(spaceId ? { spaceId } : {}) });
      return {
        panes: { [focusChat.id]: pane(focusChat.id), [doneChat.id]: pane(doneChat.id, SPACE_ID) },
        groups: { "group:default": { id: "group:default", paneIds: [focusChat.id, doneChat.id], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {}, groupOrder: ["group:default"], closedStack: [],
        spaces: { [SPACE_ID]: { id: SPACE_ID, name: "Seen Group", order: 1, updatedAt: openedAt } },
      };
    });
    await goToApp(page);
    const mainCard = page.locator(`[role="tab"][data-space-id="space:default"]`);
    await expect(mainCard).toBeVisible({ timeout: 20_000 });
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });

    inject({ type: "session:state", sessionKey: focusKey, state: { phase: "running", rev: 1, claudeSessionId: focusKey } });
    await expect(tab(page, focusChat.id)).not.toHaveAttribute("data-attention", /done|input/, { timeout: 10_000 });
    inject({ type: "session:state", sessionKey: focusKey, state: { phase: "awaiting-approval", rev: 2, claudeSessionId: focusKey } });
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-attention", "input", { timeout: 10_000 });
    // In front of the person, awake, for three dwells: the chat is SEEN.
    await page.clock.runFor(PAST_THE_DWELL_MS);
    // A look does not answer a permission: every surface still asks for it.
    await expect(mainCard, "the group card dropped the permission wait").toHaveAttribute("data-attention", "input");
    await expect(tab(page, focusChat.id), "the focused chat's tab dropped the amber of a pending permission").toHaveAttribute("data-attention-fill", "input");
    await expect(chatRow(page, focusChat.name), "the focused chat's row dropped the amber of a pending permission").toHaveAttribute("data-attention-fill", "input");
  });

  test("SEEN-ANY-FOCUS-01d: the focused chat read while the window was behind is seen on the bell and the Dock once the window comes back", async ({ page }) => {
    test.setTimeout(90_000);
    await awakeWithDock(page);
    await page.clock.install();
    const inject = await relay(page, () => [term.id]);
    await page.request.post(`${BASE}/api/topics/${focusChat.id}/read`, { ignoreHTTPSErrors: true });
    await resetPaneStore(page.request, [focusChat.id, doneChat.id]);
    await goToApp(page);
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await page.clock.runFor(PAST_THE_DWELL_MS);
    const base = await bellNumber(page);

    // The window goes behind; a reply lands on the chat in front and its turn ends.
    await setAwake(page, false);
    const reply = await page.request.post(`${BASE}/api/topics/${focusChat.id}/system-message`, { data: { content: "a reply while away" }, ignoreHTTPSErrors: true });
    expect(reply.ok(), `system-message ${reply.status()}`).toBe(true);
    inject({ type: "stream:end", sessionKey: focusKey, topicId: focusChat.id, messageId: `away-${Date.now()}`, completed: true, stopReason: "end_turn" });
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "nothing counted while the window was behind" }).toBeGreaterThan(base);

    // Back, looking at the same chat for three dwells.
    await setAwake(page, true);
    await page.clock.runFor(PAST_THE_DWELL_MS);
    await expect.poll(() => bellNumber(page), { timeout: 10_000, message: "back in front of the chat, the bell still counts it" }).toBe(base);
    await expect.poll(async () => (await dockHistory(page)).at(-1) ?? 0, { timeout: 10_000, message: "back in front of the chat, the Dock still counts it" }).toBe(base);
    // Leave it: nothing is left on its row or its tab.
    await tab(page, doneChat.id).click();
    await expect(tab(page, doneChat.id)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
    await expect(badgeOf(chatRow(page, focusChat.name)), "the chat read on return kept a row badge").toHaveCount(0);
    await expect(badgeOf(tab(page, focusChat.id)), "the chat read on return kept a tab badge").toHaveCount(0);
  });
});

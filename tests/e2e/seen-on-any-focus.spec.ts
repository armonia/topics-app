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
 * No clock: "a dwell has passed" is read off a witness, the focused chat's own
 * blue fill, which a new `awaiting-user` lights and the dwell switches off.
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
    inject({ type: "terminal:activity", id: term.id, busy: false, finished: true, kind: "claude-code" });
    // The sentinel: a chat that is NOT in front finishes after it. Frames are
    // applied in order, so once its mark is on, the terminal's was handled.
    inject({ type: "stream:end", sessionKey: focusKey, topicId: focusChat.id, messageId: `sentinel-${Date.now()}`, completed: true, stopReason: "end_turn" });
    await expect(tab(page, focusChat.id), "the sentinel chat was not marked").toHaveAttribute("data-attention", "done", { timeout: 10_000 });
    await expect(badgeOf(terminalRow(page, term.id)), "the focused terminal's row kept a badge").toHaveCount(0, { timeout: 10_000 });
    await tab(page, focusChat.id).click();
    await expect(tab(page, focusChat.id)).toHaveAttribute("data-active", "true");
    await expect(badgeOf(tab(page, termPane)), "the focused terminal's tab kept a badge").toHaveCount(0);
  });
});

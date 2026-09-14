import { test, expect, type Page, type Locator, type Request, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  createTerminalSession,
  deleteTerminalSession,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { projectPanesKey } from "../../shared/project-keys";
import { removeTmpDir } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * Seed a topic's browser window straight into its ui-state row.
 *
 * The DOORS that put a sheet in the window (a link clicked in the chat, the
 * agent's `open_browser_pane`, `/browser`) are Tornata 5. What this file checks
 * is the WINDOW: a topic that already has one, and what the layout around it
 * does. Seeding the row is how a topic gets one today, and it is also the
 * shortest description of the precondition each scenario states.
 */
async function seedWindow(
  request: APIRequestContext,
  topicId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`${BASE}/api/ui-state/topic-browser:${topicId}`, {
    data: value,
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBeTruthy();
}

const sheet = (contextId: string, url = "https://example.com") => ({
  contextId,
  url,
  title: "Example",
  openedBy: "user",
});

/** The room the chat really has: the window is drawn over the padding the
 *  panel cedes, so the border box alone would say nothing. */
/** Click a topic wherever the layout put it: a pane tab, or a sidebar row. */
async function selectTopic(page: Page, topicId: string): Promise<void> {
  await page
    .locator(`[data-pane-id="${topicId}"], [data-topic-id="${topicId}"]`)
    .first()
    .click();
}

async function chatContentWidth(page: Page): Promise<number> {
  return page.locator('[data-testid="chat-panel"]').first().evaluate((el) => {
    const style = getComputedStyle(el);
    return el.clientWidth - parseFloat(style.paddingRight || "0");
  });
}

/**
 * Click a menu item ONLY WHERE A HAND COULD CLICK IT.
 *
 * Playwright waits for the element to be visible and stable and then delivers
 * the click BY COORDINATE, so an item drawn UNDER the window that owns it is
 * clicked all the same: the scenario would stay green on exactly the defect the
 * «+» menu was rebuilt for, a menu clipped away by a 36 px bar. The gate here is
 * the one a hand has: whatever sits at the center of the item must BE the item.
 */
async function clickMenuItem(item: Locator): Promise<void> {
  await expect(item).toBeVisible();
  const ownsItsCenter = await item.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!onTop && el.contains(onTop);
  });
  expect(ownsItsCenter, "another element covers the center of the menu item").toBe(true);
  await item.click();
}

/** Open the window's «+» and return the menu, which is a portal on the body. */
async function openAddMenu(page: Page): Promise<Locator> {
  await page.locator('[data-testid="topic-browser-add"]').click();
  const menu = page.locator('[data-testid="topic-browser-add-menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** The chat floor, stated here and not imported: `MIN_CHAT_WIDTH` is the number
 *  under test, and reading it from the source would move the bar with it. */
const MIN_CHAT_WIDTH = 320;

/** Narrowest area that can hold an OPERABLE docked window (a bar wide enough
 *  to show the way back out) plus a usable chat beside it. Stated here for the
 *  same reason as `MIN_CHAT_WIDTH`: imported, a regression that moved the
 *  threshold would move the bar with it, and the scenarios would follow the
 *  defect instead of catching it. */
const MIN_DOCK_AREA = 480;

/**
 * Does a hand actually reach this element?
 *
 * `toBeVisible` does not answer that: the window crushed to 2px was "visible",
 * and so is a control drawn under something else. What a hand has is the
 * center pixel, so whatever sits there must BE the element.
 */
async function reachable(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!onTop && node.contains(onTop);
  });
}

/** Do these two rectangles share a single pixel? */
function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Split ONE named tab out to the right.
 *
 * `splitViaContextMenu` in `helpers/layout.ts` addresses tabs by index under
 * `[role="main"]`; inside a project window that picks the project's own tab in
 * the outer strip, not the one in the project's inner strip. This scenario
 * needs a specific inner tab, so it names it.
 */
async function splitTabRight(page: Page, tab: Locator): Promise<void> {
  await expect(tab).toBeVisible({ timeout: 15000 });
  await tab.click({ button: "right" });
  const item = page.getByText("Dividi a destra", { exact: true });
  await expect(item).toBeVisible({ timeout: 5000 });
  await item.click();
}

/** The seed endpoint keys on the SESSION, which is not the topic id. */
async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await res.json()) as {
    topics: Record<string, { id: string; sessionKey: string }>;
  };
  return Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
}

/**
 * Seed a project's inner layout with an open CHAT and an open BROWSER pane.
 *
 * The browser pane is what the scenario needs and what `seedProjectInnerChats`
 * cannot give: a page the PROJECT layout owns, which the pane store has never
 * heard of. Seeded rather than opened by hand because opening one moves the
 * active tab of its group, and a chat collapsed to zero parks the very window
 * under test.
 */
async function seedProjectLayout(
  request: APIRequestContext,
  projectPath: string,
  topicId: string,
  /** null = the project opens with the conversation ALONE, one pane wide. */
  browserContextId: string | null,
): Promise<void> {
  const res = await request.put(`${BASE}/api/ui-state/${projectPanesKey(realpathSync(projectPath))}`, {
    data: {
      nonChatPanes: browserContextId ? [{
        id: `browser:${browserContextId}`,
        type: "browser",
        title: "Project page",
        url: "https://example.com/project-pane",
        projectPath,
      }] : [],
      openChatTopicIds: [topicId],
      activeChatTopicId: topicId,
    },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Seed a conversation, and wait for it to be ON SCREEN.
 *
 * Two messages and not one: the hover toolbar of a message is drawn ABOVE it
 * (`bottom-full`), so only a transcript with something in it puts a toolbar in
 * the band the window's controls live in — and only a transcript with something
 * in it docks the composer at the bottom instead of centering it.
 *
 * The wait is not politeness. The list opens behind a curtain and lifts it only
 * once its geometry has been still for two frames (`MessageList`): measured
 * before that, every rectangle here is the rectangle of a hidden node, and an
 * assertion about where things are would be an assertion about a layout that
 * nobody ever sees.
 */
const FIRST_USER_MESSAGE = "Apri la pagina di esempio, per favore.";
async function seedConversation(
  request: APIRequestContext,
  topicId: string,
): Promise<void> {
  const sessionKey = await sessionKeyOf(request, topicId);
  await seedMessage(request, { sessionKey, role: "user", content: FIRST_USER_MESSAGE });
  await seedMessage(request, { sessionKey, role: "assistant", content: "Fatto, e' aperta." });
}
async function waitForConversation(page: Page): Promise<void> {
  await expect(page.getByText(FIRST_USER_MESSAGE)).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator('[data-testid="chat-input-area"]').first(),
  ).toHaveAttribute("data-composer-centered", "false", { timeout: 10000 });
}

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("TOPIC-BROWSER-01 la finestra browser della topic", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "TOPIC-BROWSER-01" });
    await resetPaneStore(request, []);
  });

  test("TOPIC-BROWSER-01: minimizzata la finestra non toglie larghezza alla chat", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-TBW-Min-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible();
      const before = await chatContentWidth(page);

      await seedWindow(request, topic.id, {
        mode: "min",
        minPos: { right: 24, bottom: 24 },
        expandedWidth: null,
        tabs: [sheet("tbw-min-1")],
        activeContextId: "tbw-min-1",
        promoted: [],
      });
      await page.reload();
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);

      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-mode", "min");

      // THE assertion of the scenario, and the one the falsification attacks:
      // a floating window takes nothing from the chat.
      expect(await chatContentWidth(page)).toBeCloseTo(before, 0);

      // And it really is drawn inside the topic area, not somewhere else.
      const area = await page.locator('[data-testid="chat-panel"]').first().boundingBox();
      const win = await windowEl.boundingBox();
      expect(area && win).toBeTruthy();
      expect(win!.x + win!.width).toBeLessThanOrEqual(area!.x + area!.width + 1);
      expect(win!.y + win!.height).toBeLessThanOrEqual(area!.y + area!.height + 1);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01b: espansa la chat cede lo spazio e il suo bordo resta entro la finestra", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-TBW-Exp-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible();
      const before = await chatContentWidth(page);

      await seedWindow(request, topic.id, {
        mode: "exp",
        minPos: null,
        expandedWidth: 480,
        tabs: [sheet("tbw-exp-1")],
        activeContextId: "tbw-exp-1",
        promoted: [],
      });
      await page.reload();
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);

      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-mode", "exp");

      const after = await chatContentWidth(page);
      expect(after).toBeLessThan(before - 100);

      // The chat ends where the window begins: nothing of the conversation is
      // under the page.
      const win = (await windowEl.boundingBox())!;
      const input = (await page.locator('[data-testid="chat-input-area"]').first().boundingBox())!;
      expect(input.x + input.width).toBeLessThanOrEqual(win.x + 2);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01c: la posizione e' della topic e sopravvive a cambio topic e ricarica", async ({ page, request }) => {
    const first = await createTopic(request, `E2E-TBW-PosA-${Date.now()}`);
    const second = await createTopic(request, `E2E-TBW-PosB-${Date.now()}`);
    try {
      await seedWindow(request, first.id, {
        mode: "min",
        minPos: { right: 120, bottom: 90 },
        expandedWidth: null,
        tabs: [sheet("tbw-pos-1")],
        activeContextId: "tbw-pos-1",
        promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, first.id);
      await waitForTopicVisible(page, second.id);
      await selectTopic(page, first.id);

      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      const placed = (await windowEl.boundingBox())!;

      // The other topic shows no window. The first topic's window is PARKED
      // (kept in the DOM, hidden) rather than unmounted, because unmounting it
      // would destroy the page inside: either way, nothing is on screen here.
      await selectTopic(page, second.id);
      await expect(windowEl).not.toBeVisible({ timeout: 10000 });

      // Back, and after a full reload: same corner, same distance.
      await selectTopic(page, first.id);
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      expect((await windowEl.boundingBox())!.x).toBeCloseTo(placed.x, 0);

      await page.reload();
      await waitForTopicVisible(page, first.id);
      await selectTopic(page, first.id);
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      const reloaded = (await windowEl.boundingBox())!;
      expect(reloaded.x).toBeCloseTo(placed.x, 0);
      expect(reloaded.y).toBeCloseTo(placed.y, 0);
    } finally {
      await deleteTopic(request, first.id).catch(() => {});
      await deleteTopic(request, second.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01d: promozione a tab e ritorno, stesso contesto", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-TBW-Promote-${Date.now()}`);
    const ctx = `tbw-promote-${Date.now()}`;
    try {
      await seedWindow(request, topic.id, {
        mode: "min",
        minPos: { right: 24, bottom: 24 },
        expandedWidth: null,
        tabs: [sheet(ctx)],
        activeContextId: ctx,
        promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);

      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });

      await page.locator('[data-testid="topic-browser-open-as-tab"]').click();

      // The page is a pane of the layout now, with the SAME context, and the
      // window keeps only its bar: that page is on loan, not gone.
      await expect(page.locator(`[data-pane-id="browser:${ctx}"]`).first()).toBeVisible({ timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-mode", "loaned", { timeout: 10000 });
      await expect(page.locator('[data-testid="topic-browser-sheet"]')).toHaveCount(0);

      // Back into the window through the «+», which lists what the layout holds.
      const menu = await openAddMenu(page);
      await clickMenuItem(menu.locator('[data-testid="topic-browser-add-existing"]').first());

      await expect(page.locator(`[data-pane-id="browser:${ctx}"]`)).toHaveCount(0, { timeout: 10000 });
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"]`)).toHaveCount(1, { timeout: 10000 });
      // Same context, so the same page: nothing was opened a second time.
      await expect(page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${ctx}"]`)).toHaveCount(1);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01e: una tab promossa e CHIUSA torna disponibile alla finestra", async ({ page, request }) => {
    // The gap the pure state left open: `promoted` only ever emptied through
    // the return-to-chat control. Closing the tab in the layout left the id there,
    // and from then on the window refused that context in silence.
    const topic = await createTopic(request, `E2E-TBW-Release-${Date.now()}`);
    const ctx = `tbw-release-${Date.now()}`;
    try {
      await seedWindow(request, topic.id, {
        mode: "min",
        minPos: { right: 24, bottom: 24 },
        expandedWidth: null,
        tabs: [sheet(ctx)],
        activeContextId: ctx,
        promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(page.locator('[data-testid="topic-browser-window"]')).toBeVisible({ timeout: 10000 });
      await page.locator('[data-testid="topic-browser-open-as-tab"]').click();

      const tab = page.locator(`[data-pane-id="browser:${ctx}"]`).first();
      await expect(tab).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="topic-browser-window"]')).toHaveAttribute("data-mode", "loaned", { timeout: 10000 });

      // Close the tab the way anybody closes a tab (the X carries a countdown).
      await tab.hover();
      await tab.locator('[data-testid="pane-tab-close"]').first().click();
      await expect(page.locator(`[data-pane-id="browser:${ctx}"]`)).toHaveCount(0, { timeout: 20000 });

      // The id is released: the window stops holding a page nobody can reach.
      await expect.poll(async () => {
        const res = await request.get(`${BASE}/api/ui-state/topic-browser:${topic.id}`, { ignoreHTTPSErrors: true });
        const body = await res.json().catch(() => null);
        return (body?.value?.promoted ?? []) as string[];
      }, { timeout: 15000 }).not.toContain(ctx);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });


  test("TOPIC-BROWSER-01g: dopo il ritorno nella finestra, riapri-tab-chiusa non duplica la pagina", async ({ page, request }) => {
    // The invariant: a sheet is in the window OR in the layout, never both.
    // Taking the page back used to CLOSE its pane, and a closed pane leaves an
    // undo record: Cmd+Shift+T then re-opened the very page the window was
    // already showing, and two panels fought over one native view.
    const topic = await createTopic(request, `E2E-TBW-Undo-${Date.now()}`);
    const ctx = `tbw-undo-${Date.now()}`;
    try {
      await seedWindow(request, topic.id, {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [sheet(ctx)], activeContextId: ctx, promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(page.locator('[data-testid="topic-browser-window"]')).toBeVisible({ timeout: 10000 });

      await page.locator('[data-testid="topic-browser-open-as-tab"]').click();
      await expect(page.locator(`[data-pane-id="browser:${ctx}"]`).first()).toBeVisible({ timeout: 10000 });

      const menu = await openAddMenu(page);
      await clickMenuItem(menu.locator('[data-testid="topic-browser-add-existing"]').first());
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"]`)).toHaveCount(1, { timeout: 10000 });

      await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+T" : "Control+Shift+T");

      // The page stays where it is: in the window, once.
      await expect(page.locator(`[data-pane-id="browser:${ctx}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${ctx}"]`)).toHaveCount(1);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01h: con tutte le pagine in prestito il menu «+» resta raggiungibile", async ({ page, request }) => {
    // The window is down to its 36px bar, and that bar clips its own content:
    // the menu that gives the page back was drawn inside it and was therefore
    // unreachable by hand. It is a portal on the body now.
    const topic = await createTopic(request, `E2E-TBW-Menu-${Date.now()}`);
    const ctx = `tbw-menu-${Date.now()}`;
    try {
      await seedWindow(request, topic.id, {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [sheet(ctx)], activeContextId: ctx, promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await page.locator('[data-testid="topic-browser-open-as-tab"]').click();
      await expect(windowEl).toHaveAttribute("data-mode", "loaned", { timeout: 10000 });

      await page.locator('[data-testid="topic-browser-add"]').click();
      const menu = page.locator('[data-testid="topic-browser-add-menu"]');
      await expect(menu).toBeVisible();

      // Not clipped by the bar: the menu is taller than the window it hangs
      // from, and it is inside the viewport.
      const bar = (await windowEl.boundingBox())!;
      const box = (await menu.boundingBox())!;
      expect(box.height).toBeGreaterThan(bar.height);
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);

      // And it works by hand, which is the whole point.
      await clickMenuItem(menu.locator('[data-testid="topic-browser-add-existing"]').first());
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctx}"]`)).toHaveCount(1, { timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01i: la finestra si trascina dalla barra, e la posizione sopravvive a una ricarica immediata", async ({ page, request }) => {
    // Two bugs in one scenario: the drag only worked on the 6px of padding
    // that no pointer ever finds, and the position was written behind an
    // 800 ms debounce that a reload did not wait for.
    const topic = await createTopic(request, `E2E-TBW-Drag-${Date.now()}`);
    try {
      await seedWindow(request, topic.id, {
        mode: "min", minPos: { right: 40, bottom: 40 }, expandedWidth: null,
        tabs: [sheet("tbw-drag-1")], activeContextId: "tbw-drag-1", promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      const before = (await windowEl.boundingBox())!;

      // Grab the MIDDLE of the bar, where the empty space between the sheets
      // and the buttons is, not its edge.
      const bar = (await page.locator('[data-testid="topic-browser-bar"]').boundingBox())!;
      await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await page.mouse.down();
      await page.mouse.move(bar.x + bar.width / 2 - 120, bar.y + bar.height / 2 - 60, { steps: 12 });
      await page.mouse.up();

      const moved = (await windowEl.boundingBox())!;
      expect(moved.x).toBeLessThan(before.x - 80);
      expect(moved.y).toBeLessThan(before.y - 30);

      // Reload NOW, inside the debounce window.
      await page.reload();
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      const reloaded = (await windowEl.boundingBox())!;
      expect(reloaded.x).toBeCloseTo(moved.x, 0);
      expect(reloaded.y).toBeCloseTo(moved.y, 0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01j: cambiando topic la pagina della finestra e' parcheggiata, non distrutta", async ({ page, request }) => {
    // Unmounting the window took RemoteBrowserPanel down with it, and with it
    // the page: coming back reloaded the site and lost the history. Parked
    // means the same DOM node comes back, which is the same page.
    const first = await createTopic(request, `E2E-TBW-ParkA-${Date.now()}`);
    const second = await createTopic(request, `E2E-TBW-ParkB-${Date.now()}`);
    try {
      await seedWindow(request, first.id, {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [sheet("tbw-park-1")], activeContextId: "tbw-park-1", promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, first.id);
      await waitForTopicVisible(page, second.id);
      await selectTopic(page, first.id);
      const sheetEl = page.locator('[data-testid="topic-browser-sheet"][data-context-id="tbw-park-1"]');
      await expect(sheetEl).toBeVisible({ timeout: 10000 });

      // Mark the live node: a node that survives is a page that was not rebuilt.
      await sheetEl.evaluate((el) => { el.setAttribute("data-e2e-mark", "alive"); });

      await selectTopic(page, second.id);
      await expect(page.locator('[data-testid="topic-browser-window"]')).not.toBeVisible({ timeout: 10000 });

      await selectTopic(page, first.id);
      await expect(sheetEl).toBeVisible({ timeout: 10000 });
      await expect(sheetEl).toHaveAttribute("data-e2e-mark", "alive");
    } finally {
      await deleteTopic(request, first.id).catch(() => {});
      await deleteTopic(request, second.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01f: sotto 768 px la finestra non esiste", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-TBW-Phone-${Date.now()}`);
    try {
      await seedWindow(request, topic.id, {
        mode: "exp",
        minPos: null,
        expandedWidth: 480,
        tabs: [sheet("tbw-phone-1")],
        activeContextId: "tbw-phone-1",
        promoted: [],
      });
      // Open the topic on a desktop viewport (on a phone the topic list lives
      // behind a drawer), see the window, then shrink to a phone.
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="topic-browser-window"]')).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('[data-testid="topic-browser-window"]')).toHaveCount(0);
      // And the chat keeps the whole phone: nothing was ceded to a window that
      // is not there.
      const panel = await page.locator('[data-testid="chat-panel"]').first().boundingBox();
      expect(await chatContentWidth(page)).toBeCloseTo(panel!.width, 0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01l: a 900 px di viewport la finestra espansa non copre il composer", async ({ page, request }) => {
    // The narrow desktop is where the two formulas disagreed: the window floored
    // its width at its own minimum and the chat's padding did not, so between
    // them they handed the composer to the page. One number now
    // (`expandedInsetFor`), and this is the width at which it has to hold.
    const topic = await createTopic(request, `E2E-TBW-Narrow-${Date.now()}`);
    try {
      await page.setViewportSize({ width: 900, height: 800 });
      await seedWindow(request, topic.id, {
        mode: "exp",
        minPos: null,
        expandedWidth: 520,
        tabs: [sheet("tbw-narrow-1")],
        activeContextId: "tbw-narrow-1",
        promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);

      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-mode", "exp");

      // THE assertion: the composer ends where the window begins. Not "mostly
      // visible" — the send button lived under the page at exactly this width.
      const win = (await windowEl.boundingBox())!;
      const composer = (await page.locator('[data-testid="chat-input-area"]').first().boundingBox())!;
      expect(composer.x + composer.width).toBeLessThanOrEqual(win.x + 1);

      // And what is left of the conversation is a conversation: the window gives
      // up width before the chat goes under its floor.
      expect(await chatContentWidth(page)).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH - 1);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01m: dalla tab promossa «Riporta nella chat» riporta la pagina nella finestra", async ({ page, request }) => {
    // The window's own «+» is one way home; this is the OTHER one, and the only
    // one reachable from the page itself: the sheet of the promoted tab.
    const topic = await createTopic(request, `E2E-TBW-Sheet-${Date.now()}`);
    const ctx = `tbw-sheet-${Date.now()}`;
    try {
      await seedWindow(request, topic.id, {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [sheet(ctx)], activeContextId: ctx, promoted: [],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });

      await page.locator('[data-testid="topic-browser-open-as-tab"]').click();
      const paneTab = page.locator(`[data-pane-id="browser:${ctx}"]`).first();
      await expect(paneTab).toBeVisible({ timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-mode", "loaned", { timeout: 10000 });

      // THE TAB COMES FIRST, ITS PANEL A BEAT LATER, and the chrome with the
      // panel: clicked before that, the label is a label and nothing happens.
      // Measured here, and it is why this scenario was red three times.
      await expect(page.locator(`[data-browser-pane="${ctx}"]`)).toHaveCount(1, { timeout: 15000 });

      // The tab is the chrome, and its label is the door of its sheet: ONE click,
      // on a tab that is already the active one. `cursor-text` is how the label
      // says so, and waiting for it is what replaces the click that would
      // otherwise open the sheet and be closed again by the next one.
      const label = paneTab.getByTestId("pane-tab-label").first();
      await expect(label).toHaveClass(/cursor-text/, { timeout: 10000 });
      await label.click();
      await expect(page.getByTestId("browser-tab-sheet")).toBeVisible({ timeout: 10000 });
      await page.getByTestId("browser-tab-return-to-window").click();

      // Same contextId back in the window, and gone from the layout: one page,
      // one place.
      await expect(page.locator(`[data-pane-id="browser:${ctx}"]`)).toHaveCount(0, { timeout: 10000 });
      await expect(page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${ctx}"]`)).toHaveCount(1, { timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-mode", "min");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01n: chiusa con la X e riaperta col comando, la finestra ha ancora le sue schede", async ({ page, request }) => {
    // The X puts the window AWAY, it does not throw the pages away: closing it
    // and asking for it back has to give back the same sheets, or the X is a
    // destructive button wearing a close icon.
    const topic = await createTopic(request, `E2E-TBW-Reopen-${Date.now()}`);
    const first = `tbw-reopen-a-${Date.now()}`;
    const second = `tbw-reopen-b-${Date.now()}`;
    try {
      await seedWindow(request, topic.id, {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [sheet(first, "https://example.com/a"), sheet(second, "https://example.com/b")],
        activeContextId: first,
        promoted: [],
      });
      // A CONVERSATION, because the geometry below is measured against one.
      //
      // In an EMPTY topic the composer is centered in the middle of the pane,
      // so «the reopen command does not intersect the composer» was true by
      // accident and would have stayed true with the command drawn anywhere in
      // the top half — including on top of the send button, which is the state
      // it was moved out of. Seeded, the composer docks at the bottom and the
      // first message puts its hover toolbar in the band the command lives in:
      // both assertions now have something to be wrong about.
      await seedConversation(request, topic.id);
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="topic-browser-tab"]')).toHaveCount(2);
      await waitForConversation(page);

      // THE IDENTITY OF THE LIVE PAGE, marked the way 01j marks it.
      //
      // Same sheets is NOT the same pages: a close that destroyed the contexts
      // and a reopen that made two new ones would satisfy every assertion
      // below and still have thrown away history, forms and the agent's own
      // view. A node that comes back wearing its mark was never unmounted.
      const sheetEl = page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${first}"]`);
      await expect(sheetEl).toBeVisible({ timeout: 10000 });
      await sheetEl.evaluate((el) => { el.setAttribute("data-e2e-mark", "alive"); });

      // And the same claim read from the wire, which is where a destructive X
      // would leave its trace even if the DOM were rebuilt convincingly.
      const lifecycle: string[] = [];
      const watchWire = (req: Request) => {
        const method = req.method();
        if (method !== "DELETE" && method !== "POST") return;
        if (/\/api\/browsers?\//.test(req.url())) lifecycle.push(`${method} ${req.url()}`);
      };
      page.on("request", watchWire);

      await page.locator('[data-testid="topic-browser-close"]').click();
      // PARKED, not unmounted: the node stays, hidden. `toHaveCount(0)` here
      // was the assertion of the destructive X — it passed precisely because
      // the pages were being thrown away.
      await expect(windowEl).toBeHidden({ timeout: 10000 });
      await expect(windowEl).toHaveAttribute("data-parked", "", { timeout: 10000 });

      // The way back has to EXIST: a window with pages behind it and no command
      // to reopen is a topic whose browser is unreachable for good.
      const reopen = page.locator('[data-testid="topic-browser-reopen"]');
      await expect(reopen).toBeVisible({ timeout: 10000 });

      // And it has to be somewhere a hand can use WITHOUT costing the composer.
      // It lived in `ChatPanel`'s header first, and that header does not exist
      // in `bodyOnly` — which is how a standalone chat pane renders, i.e. the
      // ordinary case: the pages were parked with no way back at all. It is a
      // component of its own now, mounted beside the window in both hosts, so
      // the two assertions below are where it may NOT be: on the composer, or
      // under something else.
      const reopenBox = (await reopen.boundingBox())!;
      const composerBox = (await page.locator('[data-testid="chat-input-area"]').first().boundingBox())!;
      expect(
        overlaps(reopenBox, composerBox),
        "il comando di riapertura interseca il composer",
      ).toBe(false);
      expect(await reachable(reopen), "il centro del comando di riapertura non e' suo").toBe(true);

      // AND THE SEND BUTTON IS STILL THE SEND BUTTON.
      //
      // The rectangle above is not enough on its own: the composer is capped
      // (`chat-measure`, 820 px) and centered, so in a wide pane the right edge
      // is empty and a command parked in that corner overlaps nothing while
      // sitting exactly where the old pill sat — over the send button, which it
      // covered by 11 px. What that costs is a click, so a click is what is
      // measured.
      const send = page.locator('[aria-label="Invia il messaggio"]').first();
      await expect(send).toBeVisible({ timeout: 10000 });
      expect(
        await reachable(send),
        "il comando di riapertura sta sul bottone di invio",
      ).toBe(true);

      // AND NOT ON THE MESSAGE'S ACTIONS EITHER, which is the other thing
      // that lives in the top-right band: the hover toolbar of the first
      // message is drawn ABOVE it, right-aligned for a message of ours.
      // Measured at 1280 the two rectangles read 1102..1260 and 1248..1272:
      // a 7 px bite taken by the command out of «Elimina il messaggio». allow-italian: quoted UI label
      // Sideways there is no room to give: 20 px between the toolbar and the
      // pane edge, for a 24 px button. So the command moved DOWN, and this is
      // the margin it has to keep.
      const firstMessage = page.getByText(FIRST_USER_MESSAGE).first();
      await firstMessage.hover();
      const deleteBtn = page.locator('[data-testid="msg-action-delete"]').first();
      const toolbar = deleteBtn.locator("xpath=..");
      await expect(toolbar).toBeVisible({ timeout: 10000 });
      const toolbarBox = (await toolbar.boundingBox())!;
      expect(
        overlaps(reopenBox, toolbarBox),
        "il comando di riapertura interseca la barra azioni del messaggio",
      ).toBe(false);
      expect(
        reopenBox.y - (toolbarBox.y + toolbarBox.height),
        "il comando di riapertura e la barra azioni si sfiorano",
      ).toBeGreaterThanOrEqual(4);
      expect(
        await reachable(deleteBtn),
        "il centro di «Elimina il messaggio» non e' suo: il comando di riapertura ci sta sopra",
      ).toBe(true);

      await reopen.click();

      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${first}"]`)).toHaveCount(1);
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${second}"]`)).toHaveCount(1);

      // THE POINT: the same page came back, and nothing was spent to get it.
      await expect(sheetEl).toHaveAttribute("data-e2e-mark", "alive");
      page.off("request", watchWire);
      expect(lifecycle, "la X ha chiuso o riaperto un contesto browser").toEqual([]);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-01o: dentro un progetto la finestra e' quella della topic, e il prestito passa dal layout del progetto", async ({ page, request }) => {
    // A PROJECT WINDOW KEEPS ITS PANES OUT OF THE PANE STORE.
    //
    // Everything the window knows about the layout it reads from `usePaneStore`,
    // and a project's panes are React state inside `useProjectLayout`. Read
    // through the store alone the project is EMPTY: the link would open a pane
    // beside the chat instead of a sheet, the «+» would list nothing, and the
    // return trip would not remove the project's pane, so one contextId would be
    // drawn twice. The three acts below are those three blindnesses.
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-project-"));
    const topic = await createTopic(request, `E2E-TBW-Proj-${Date.now()}`, { projectPath });
    const seeded = `tbw-proj-${Date.now()}`;
    const projectCtx = `tbw-projpane-${Date.now()}`;
    try {
      await resetProjectPanes(request, projectPath);
      await seedProjectPane(request, projectPath);
      await seedProjectLayout(request, projectPath, topic.id, projectCtx);
      await seedMessage(request, {
        sessionKey: await sessionKeyOf(request, topic.id),
        role: "assistant",
        content: "Guarda [la pagina](https://example.com/from-project-chat).",
      });
      await seedWindow(request, topic.id, {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [sheet(seeded)], activeContextId: seeded, promoted: [],
      });

      await goToApp(page);
      // Inside a project the conversation is a tab like any other, named
      // `chat:<topicId>`, and it shares its strip with the project's panes: the
      // seeded browser pane holds the slot until the chat is asked for.
      const chatTab = page.locator(`[data-pane-id="chat:${topic.id}"]`).first();
      await expect(chatTab).toBeVisible({ timeout: 20000 });
      await chatTab.click();
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 15000 });

      // (a) A link clicked in the chat lands in the WINDOW of this topic. The
      // falsifiable half is the second assertion: opening a pane of the project
      // layout also makes a page appear, and it is the wrong place.
      const projectPanes = page.locator('[data-testid="project-window"] [data-pane-id^="browser:"]');
      const panesBefore = await projectPanes.count();
      const link = page.locator('a[href="https://example.com/from-project-chat"]').first();
      await expect(link).toBeVisible({ timeout: 15000 });
      await link.click();
      await expect(page.locator('[data-testid="topic-browser-sheet"]')).toHaveCount(2, { timeout: 15000 });
      await expect(projectPanes).toHaveCount(panesBefore);

      // (b) The «+» sees the PROJECT's own panes, and not only the pane store's:
      // `projectCtx` is open in the project layout and nowhere else.
      await expect(page.locator(`[data-pane-id="browser:${projectCtx}"]`).first()).toBeVisible({ timeout: 15000 });
      const menu = await openAddMenu(page);
      await expect(menu.locator(`[data-testid="topic-browser-add-existing"][data-context-id="${projectCtx}"]`)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);

      // (c) The seeded sheet goes out to the project layout and comes back, on
      // the same contextId: the page moved, it was never reopened.
      await page.locator(`[data-testid="topic-browser-tab"][data-context-id="${seeded}"]`).click();
      await page.locator('[data-testid="topic-browser-open-as-tab"]').click();
      await expect(page.locator(`[data-testid="project-window"] [data-pane-id="browser:${seeded}"]`)).toHaveCount(1, { timeout: 15000 });

      // The promoted page took the visible slot of the strip: ask for the
      // conversation back, which is where the «+» lives.
      await chatTab.click();
      await expect(windowEl).toBeVisible({ timeout: 15000 });
      const back = await openAddMenu(page);
      await clickMenuItem(back.locator(`[data-testid="topic-browser-add-existing"][data-context-id="${seeded}"]`));
      await expect(page.locator(`[data-pane-id="browser:${seeded}"]`)).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${seeded}"]`)).toHaveCount(1);
    } finally {
      // The project layout and the browser contexts live on the SERVER, so
      // they outlive the page: left behind, the next spec finds a project
      // window that already has the panes this one opened.
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });

  test("TOPIC-BROWSER-01p: in un'area troppo stretta la finestra non si aggancia, e la sua barra resta raggiungibile", async ({ page, request }) => {
    // AN AREA TOO NARROW TO DOCK IN.
    //
    // Docking needs room for the window AND a usable chat. A split project at
    // 1024 leaves the conversation a third of the width: docked there the
    // window came out a couple of pixels wide, its own controls could not be
    // hit, and the `exp` sitting in ui-state had no way out — the topic was
    // stuck in a state whose only exit was the button that state had crushed.
    //
    // The precondition is MEASURED and asserted, not assumed. If the split ever
    // stopped making the area narrow, all three assertions below would pass on
    // a wide area and prove nothing at all (HERO-R-003).
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-nodock-"));
    const topic = await createTopic(request, `E2E-TBW-NoDock-${Date.now()}`, { projectPath });
    const projectCtx = `tbw-nodock-pane-${Date.now()}`;
    try {
      await page.setViewportSize({ width: 1024, height: 800 });
      await resetProjectPanes(request, projectPath);
      await seedProjectPane(request, projectPath);
      await seedProjectLayout(request, projectPath, topic.id, projectCtx);
      // The persisted state SAYS docked. The area is about to say it cannot be.
      await seedWindow(request, topic.id, {
        mode: "exp", minPos: null, expandedWidth: 520,
        tabs: [sheet("tbw-nodock-1")], activeContextId: "tbw-nodock-1", promoted: [],
      });

      await goToApp(page);
      const browserTab = page.locator(`[data-pane-id="browser:${projectCtx}"]`).first();
      await expect(browserTab).toBeVisible({ timeout: 20000 });
      // Divide the project: the conversation keeps one column of two.
      await splitTabRight(page, browserTab);

      const chatTab = page.locator(`[data-pane-id="chat:${topic.id}"]`).first();
      await chatTab.click();
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 15000 });

      // The precondition, measured on the element the window itself measures.
      // Inside a project the conversation is a `ChatPane`, not the `ChatPanel`
      // of a standalone topic: there is no `chat-panel` here, and the area the
      // window reads is the pane root that carries the topic id.
      const area = await page
        .locator(`[data-testid="project-window"] [data-chat-topic-id="${topic.id}"]`)
        .first()
        .evaluate((el) => el.clientWidth);
      expect(area, "lo split deve lasciare la chat sotto la soglia di aggancio").toBeLessThan(MIN_DOCK_AREA);
      expect(area, "e la chat deve comunque esistere").toBeGreaterThan(0);

      // (1) A persisted `exp` does not survive an area that cannot host it.
      await expect(windowEl).toHaveAttribute("data-mode", "min");
      // (2) The control that would dock it is not offered at all: an area that
      // cannot hold a docked window must not invite one.
      await expect(page.locator('[data-testid="topic-browser-expand"]')).toHaveCount(0);
      // (3) THE POINT, and the half that `toBeVisible` cannot state: the bar is
      // reachable by a hand. The crushed window was "visible" at two pixels too.
      const close = page.locator('[data-testid="topic-browser-close"]');
      await expect(close).toBeVisible();
      expect(
        await reachable(close),
        "il centro della X non appartiene alla X: la barra e' schiacciata o coperta",
      ).toBe(true);
    } finally {
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });

  test("TOPIC-BROWSER-01q: in un progetto, la finestra espansa non copre il composer ne' il bottone di invio", async ({ page, request }) => {
    // THE PADDING BOX IS NOT THE BORDER BOX.
    //
    // The pane cedes the docked window's width with `padding-right`, and that
    // is enough for everything laid out in the flow. The composer is not laid
    // out in the flow: it is `absolute bottom-0 left-0 right-0`, and an
    // absolutely positioned child is resolved against the PADDING box, so its
    // `right: 0` IS the pane's border edge. The padding it was supposed to
    // respect it never saw: the composer ran the whole width, under the page,
    // and the send button with it.
    //
    // 01l states the same law at 900px in a standalone topic. This one is the
    // host where it was measured broken — a project pane, where the chat is a
    // `ChatPane` and not the `ChatPanel` — and it asks the second question a
    // rectangle cannot answer: not «do they overlap» but «whose pixel is it».
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-composer-"));
    const topic = await createTopic(request, `E2E-TBW-Composer-${Date.now()}`, { projectPath });
    try {
      await resetProjectPanes(request, projectPath);
      await seedProjectPane(request, projectPath);
      // One pane: the conversation alone, the full width of the project window.
      await seedProjectLayout(request, projectPath, topic.id, null);
      await seedConversation(request, topic.id);
      await seedWindow(request, topic.id, {
        mode: "exp", minPos: null, expandedWidth: 520,
        tabs: [sheet("tbw-composer-1")], activeContextId: "tbw-composer-1", promoted: [],
      });

      await goToApp(page);
      const chatTab = page.locator(`[data-pane-id="chat:${topic.id}"]`).first();
      await expect(chatTab).toBeVisible({ timeout: 20000 });
      await chatTab.click();

      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 15000 });
      // DOCKED, and asserted: floating, the window overlaps nothing by design
      // and every line below would pass without ever exercising the inset.
      await expect(windowEl).toHaveAttribute("data-mode", "exp");
      await waitForConversation(page);

      // (1) The composer ends where the window begins.
      const win = (await windowEl.boundingBox())!;
      const composer = (await page.locator('[data-testid="chat-input-area"]').first().boundingBox())!;
      expect(
        composer.x + composer.width,
        "il composer arriva sotto la finestra",
      ).toBeLessThanOrEqual(win.x + 1);

      // (2) THE HALF A RECTANGLE CANNOT STATE. The window is a sibling with a
      // higher stacking order: «not overlapping» is a claim about geometry,
      // «clickable» is a claim about the pixel, and the defect was the second
      // one — the send button was there, visible, and belonged to the page.
      const send = page.locator('[aria-label="Invia il messaggio"]').first();
      await expect(send).toBeVisible({ timeout: 10000 });
      const coveredBy = await send.evaluate((el) => {
        const r = el.getBoundingClientRect();
        let node: Element | null = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        while (node) {
          if (node.getAttribute("data-testid") === "topic-browser-window") return "topic-browser-window";
          node = node.parentElement;
        }
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
          ? "send"
          : "other";
      });
      expect(coveredBy, "al centro del bottone di invio c'e' altro").toBe("send");
    } finally {
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });

  test("TOPIC-BROWSER-01r: minimizzata nella posizione predefinita, la finestra non copre il composer", async ({ page, request }) => {
    // THE DEFAULT CORNER WAS ON THE SEND BUTTON.
    //
    // 01l and 01q state the law for the DOCKED window, which cedes width. This
    // is the other window: the floating one, in the corner nobody chose, in a
    // topic where nothing was ever dragged. 24px from the bottom of a 1280x800
    // area put its 420x320 body exactly over the band the composer occupies,
    // so `elementFromPoint` on the send button answered the window — in every
    // topic, from the first delivery on. The window measures that band now
    // (`useComposerBand`) and `resolveMinRect` keeps off it.
    //
    // A SEEDED CONVERSATION IN BOTH HALVES, and it is load-bearing, not decor:
    // in an empty topic the composer is CENTERED in the middle of the pane, so
    // a window parked in the bottom-right corner overlaps nothing whatever the
    // floor says. Measured on the empty state this scenario would be green on
    // the very defect it exists for (HERO-R-003). Docked at the bottom by a
    // transcript, the two rectangles finally have somewhere to collide.
    //
    // TWO HOSTS, because the composer and the area are different components in
    // each: a standalone topic renders `ChatPanel`, a topic inside a project
    // renders a `ChatPane` whose root carries the topic id — and the floor is
    // read from the area root, whichever one it is.
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-floor-"));
    const solo = await createTopic(request, `E2E-TBW-FloorSolo-${Date.now()}`);
    const inProject = await createTopic(request, `E2E-TBW-FloorProj-${Date.now()}`, { projectPath });

    // THE LIVE WINDOW, and not just «a window». Act (a) leaves its topic open
    // as a pane, and a topic that loses the screen keeps its window in the DOM,
    // PARKED (01c, 01j): unqualified, the locator matches two elements in act
    // (b) and Playwright refuses to measure either.
    const windowEl = page.locator('[data-testid="topic-browser-window"]:not([data-parked])');

    /**
     * The two controls a person needs to send a message, checked the only way
     * that answers: whatever sits on their center pixel must BE them.
     *
     * Everything is addressed THROUGH THE AREA OF ITS OWN TOPIC. With two
     * conversations mounted — and both seeded with the same first message —
     * `chat-input-area`, the send button and `FIRST_USER_MESSAGE` all exist
     * twice, so `.first()` and `waitForConversation` would just as happily
     * measure the parked half. `data-chat-topic-id` is on the root of both
     * hosts, and it is the very element the window reads its floor from.
     */
    const composerIsReachable = async (where: string, topicId: string): Promise<void> => {
      const area = page.locator(`[data-chat-topic-id="${topicId}"]`).first();
      const send = area.locator('[aria-label="Invia il messaggio"]').first();
      const input = area.locator('[data-testid="chat-message-input"]').first();

      // The conversation has to be ON SCREEN before anything is measured: the
      // list lifts its curtain only once its geometry has been still for two
      // frames, and the composer docks at the bottom only then. Same two
      // conditions `waitForConversation` states, scoped to this topic.
      await expect(area.getByText(FIRST_USER_MESSAGE).first()).toBeVisible({ timeout: 15000 });
      await expect(area.locator('[data-testid="chat-input-area"]').first())
        .toHaveAttribute("data-composer-centered", "false", { timeout: 10000 });
      await expect(send).toBeVisible({ timeout: 10000 });
      await expect(input).toBeVisible({ timeout: 10000 });

      // THE PRECONDITION, measured. The claim below is about a window that is
      // in the way; a window drawn somewhere else entirely would satisfy it
      // without ever being tested. The send button has to be in the window's
      // own column, and only the vertical band may separate them.
      const win = (await windowEl.boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      const sendCenterX = sendBox.x + sendBox.width / 2;
      expect(
        sendCenterX >= win.x && sendCenterX <= win.x + win.width,
        `${where}: il bottone di invio non e' nella colonna della finestra, lo scenario non misura niente`,
      ).toBe(true);

      expect(await reachable(send), `${where}: la finestra sta sul bottone di invio`).toBe(true);
      expect(await reachable(input), `${where}: la finestra sta sul campo di testo`).toBe(true);
    };

    try {
      await page.setViewportSize({ width: 1280, height: 800 });

      // EVERYTHING IS SEEDED BEFORE THE ONE AND ONLY PAGE LOAD, and the two
      // hosts are then reached by clicking, not by reloading between them.
      // Seeding the project half after act (a) does not survive: the page of
      // act (a) flushes its own pane store as it unloads, and that beacon
      // lands on top of the seed — the project pane is gone before the new
      // page hydrates, so the project window never opens at all. Measured:
      // `chat:<topicId>` not found, twice, on a window that is correct.
      await resetProjectPanes(request, projectPath);
      const projectPaneId = await seedProjectPane(request, projectPath);
      await seedProjectLayout(request, projectPath, inProject.id, null);
      await seedConversation(request, inProject.id);
      await seedWindow(request, inProject.id, {
        mode: "min", minPos: null, expandedWidth: null,
        tabs: [sheet("tbw-floor-proj")], activeContextId: "tbw-floor-proj", promoted: [],
      });
      await seedConversation(request, solo.id);
      await seedWindow(request, solo.id, {
        mode: "min", minPos: null, expandedWidth: null,
        tabs: [sheet("tbw-floor-solo")], activeContextId: "tbw-floor-solo", promoted: [],
      });

      await goToApp(page);

      // (a) A STANDALONE TOPIC, opened from the sidebar. `minPos: null` is the
      // whole point: no drag ever happened here, so the corner is the one the
      // code picks by itself.
      await waitForTopicVisible(page, solo.id);
      await selectTopic(page, solo.id);
      await expect(windowEl).toBeVisible({ timeout: 15000 });
      await expect(windowEl).toHaveAttribute("data-mode", "min");
      await composerIsReachable("topic autonoma", solo.id);

      // (b) THE SAME TOPIC AREA, HOSTED BY A PROJECT: one pane, the
      // conversation alone, the full width of the project window. Inside a
      // project the chat is a `ChatPane` and not the `ChatPanel` of act (a),
      // so the area the floor is read from is a different element entirely.
      await page.locator(`[data-pane-id="${projectPaneId}"]`).first().click();
      const chatTab = page.locator(`[data-pane-id="chat:${inProject.id}"]`).first();
      await expect(chatTab).toBeVisible({ timeout: 20000 });
      await chatTab.click();
      await expect(windowEl).toBeVisible({ timeout: 15000 });
      await expect(windowEl).toHaveAttribute("data-mode", "min");
      await composerIsReachable("topic dentro un progetto", inProject.id);
    } finally {
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, solo.id).catch(() => {});
      await deleteTopic(request, inProject.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });
});

/**
 * TOPIC-BROWSER-04: a site opened without the user's gesture does not change
 * the layout.
 *
 * The door is the agent's real one (`POST /api/topics/:id/browser/open-pane`,
 * i.e. the `open_browser_pane` tool), not a shortcut of the test: the defect
 * these two scenarios watch lived downstream of that route, in the
 * `requestBrowserSolo` that split the cell in two.
 */
test.describe("TOPIC-BROWSER-04 le aperture che nessuno ha chiesto a mano", () => {
  // These two drive the agent's REAL route, which spins up a browser context
  // and its CDP target: the same real work that makes `browser-open-pane-orphan`
  // ask for 90 s. The default 30 s ran out with trace and video on, while every
  // assertion was still true - a budget that expires under load is not a red.
  test.beforeEach(async ({}, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "TOPIC-BROWSER-04" });
    testInfo.setTimeout(90_000);
  });

  /** What the agent asks to open: `data:` so the scenario measures the layout
   *  and not the network. */
  const AGENT_URL = (label: string): string =>
    `data:text/html,<body style='margin:0;background:%23101418'>${label}</body>`;

  /** The geometry of the layout CELLS, by their `row-col` key. THIS is where a
   *  split shows up, and `paneRects` below is not: in the main layout
   *  `[data-pane-id]` lives on the TAB LABELS of the bar (`PaneTabBar`), so an
   *  invariant written on it alone was comparing two 150x28 tabs and would have
   *  let a whole new cell through. Sub-pixel slivers are dropped: a cell that
   *  small is a divider, not a pane. */
  async function cellRects(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-panel-cell]"))) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        out[el.getAttribute("data-panel-cell") ?? ""] =
          `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
      }
      return out;
    });
  }

  /** The tab labels of the bar, by pane id: the second half of "the same panes",
   *  since a pane arriving inside an existing cell shows up here and not in the
   *  geometry of the cells. */
  async function paneRects(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("[data-pane-id]"))) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out[el.getAttribute("data-pane-id") ?? ""] =
          `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
      }
      return out;
    });
  }

  test("TOPIC-BROWSER-04a: l'agente apre un sito e il layout non si muove di un pixel", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-TBW-Agent-${Date.now()}`);
    const term = await createTerminalSession(request, { cwd: "/tmp", name: "tbw-agent" });
    // A page with NO NETWORK behind it (`data:`), so a red of connectivity
    // could never dress up as a red of the product.
    const url = AGENT_URL("dall-agente");
    try {
      // The scenario's precondition: chat and terminal in the layout, and NO
      // browser window at all (the ui-state row does not exist).
      await resetPaneStore(request, [topic.id, `terminal:${term.id}`]);
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`[data-pane-id="terminal:${term.id}"]`).first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('[data-testid="topic-browser-window"]')).toHaveCount(0);

      const before = await paneRects(page);
      expect(Object.keys(before).length).toBeGreaterThan(1);
      const beforeCells = await cellRects(page);
      expect(Object.keys(beforeCells).length).toBeGreaterThan(0);

      // The agent's own door.
      const res = await request.post(
        `${BASE}/api/topics/${encodeURIComponent(topic.id)}/browser/open-pane`,
        { data: { url }, ignoreHTTPSErrors: true },
      );
      expect(res.ok()).toBeTruthy();

      // THE DELIVERY: the window showed up minimised, with the sheet on that
      // URL.
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 20000 });
      await expect(windowEl).toHaveAttribute("data-mode", "min");
      await expect(
        page.locator(`[data-testid="topic-browser-tab"][data-context-id="${topic.id}"]`),
      ).toHaveCount(1, { timeout: 15000 });
      await expect.poll(async () => {
        const r = await request.get(`${BASE}/api/ui-state/topic-browser:${topic.id}`, { ignoreHTTPSErrors: true });
        const body = await r.json().catch(() => null);
        const tabs = (body?.value?.tabs ?? []) as Array<{ url?: string }>;
        return tabs.map((t) => t.url ?? "");
      }, { timeout: 15000 }).toContain(url);

      // AND THE INVARIANT: the same cells at the same sizes (a split lands
      // here), and the same tabs on the bar (a pane joining an existing cell
      // lands there). One without the other is half a measurement.
      expect(await cellRects(page)).toEqual(beforeCells);
      expect(await paneRects(page)).toEqual(before);
    } finally {
      await deleteTerminalSession(request, term.id).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  /** The DOM door, fired the way its two producers fire it. `source` is the
   *  only thing that separates them. */
  async function openAndNavigate(
    page: Page,
    topicId: string,
    url: string,
    source?: string,
  ): Promise<void> {
    await page.evaluate(
      ({ tid, u, src }) => {
        window.dispatchEvent(
          new CustomEvent("browser:open-and-navigate", {
            detail: { topicId: tid, url: u, ...(src ? { source: src } : {}) },
          }),
        );
      },
      { tid: topicId, u: url, src: source },
    );
  }

  test("TOPIC-BROWSER-04c: solo il comando del composer va nella finestra, il resto nel layout", async ({ page, request }) => {
    // `browser:open-and-navigate` has TWO producers: `/browser` typed in the
    // composer, and the task drawer replaying a task's tabs. Only the first
    // asks to LOOK, so only the first opens the window - and the mark on the
    // event is the whole difference. Widen the rule back to the bare event
    // name and this scenario goes red, which is why it exists.
    const typed = await createTopic(request, `E2E-TBW-Slash-${Date.now()}`);
    const replayed = await createTopic(request, `E2E-TBW-Replay-${Date.now()}`);
    try {
      await resetPaneStore(request, [typed.id, replayed.id]);
      await goToApp(page);
      await waitForTopicVisible(page, typed.id);
      await selectTopic(page, typed.id);
      await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15000 });

      // (a) The typed command: the window, EXPANDED, and no pane in the layout.
      await openAndNavigate(page, typed.id, AGENT_URL("dal-composer"), "slash-command");
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 15000 });
      await expect(windowEl).toHaveAttribute("data-mode", "exp");
      await expect(page.locator('[data-pane-id^="browser:"]')).toHaveCount(0);

      // (b) The same event WITHOUT the mark, on a topic whose chat is MOUNTED
      // and therefore HAS a door to fool: unchanged, i.e. a pane of the layout.
      // Selecting the topic first is the whole point of this half. While it ran
      // on a chat nobody had mounted there was no door in the first place, the
      // event fell into the layout for a reason that had nothing to do with the
      // mark, and dropping the `source` check from the product left this test
      // green.
      await selectTopic(page, replayed.id);
      await expect(page.locator('[data-testid="chat-panel"]').first()).toBeVisible({ timeout: 15000 });
      // The door of THIS topic is open now, and half (a) is the proof: it is
      // the same chat surface that registered it there.
      await openAndNavigate(page, replayed.id, AGENT_URL("dal-task"));
      await expect(page.locator(`[data-pane-id="browser:${replayed.id}"]`)).toHaveCount(1, { timeout: 15000 });
    } finally {
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, typed.id).catch(() => {});
      await deleteTopic(request, replayed.id).catch(() => {});
    }
  });

  test("TOPIC-BROWSER-04b: con la scheda gia' promossa a tab, naviga la tab e nessuna finestra compare", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-TBW-AgentTab-${Date.now()}`);
    const url = AGENT_URL("sulla-tab");
    try {
      // The topic's page is already OUT, on loan to the layout: its pane
      // exists and its contextId is recorded as promoted.
      await resetPaneStore(request, [topic.id, `browser:${topic.id}`]);
      await seedWindow(request, topic.id, {
        mode: "hidden",
        minPos: null,
        expandedWidth: null,
        tabs: [],
        activeContextId: null,
        promoted: [topic.id],
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      const tab = page.locator(`[data-pane-id="browser:${topic.id}"]`).first();
      await expect(tab).toBeVisible({ timeout: 20000 });
      const beforeCells = await cellRects(page);
      expect(Object.keys(beforeCells).length).toBeGreaterThan(0);

      const res = await request.post(
        `${BASE}/api/topics/${encodeURIComponent(topic.id)}/browser/open-pane`,
        { data: { url }, ignoreHTTPSErrors: true },
      );
      expect(res.ok()).toBeTruthy();

      // The tab stays where it is and IT navigates: no window appears, and the
      // page does not land in the layout a second time.
      await expect(tab).toBeVisible();
      await expect(page.locator(`[data-pane-id="browser:${topic.id}"]`)).toHaveCount(1);
      await expect(page.locator('[data-testid="topic-browser-sheet"]')).toHaveCount(0);
      await expect
        .poll(async () => {
          const r = await request.get(`${BASE}/api/ui-state/topic-browser:${topic.id}`, { ignoreHTTPSErrors: true });
          const body = await r.json().catch(() => null);
          return ((body?.value?.tabs ?? []) as unknown[]).length;
        }, { timeout: 8000 })
        .toBe(0);

      // AND it NAVIGATED: "the tab is still there" would also be true of an
      // opening that went nowhere. The url the pane persists is the observable.
      await expect
        .poll(async () => {
          const r = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
          const body = await r.json().catch(() => null);
          const panes = (body?.value?.panes ?? {}) as Record<string, { url?: string }>;
          return panes[`browser:${topic.id}`]?.url ?? "";
        }, { timeout: 15000 })
        .toBe(url);

      // AND no split: the cell this pane already lived in is untouched. The
      // product only splits a cell for a pane that did NOT exist; without this
      // line "always a new pane" passes the scenario unnoticed.
      expect(await cellRects(page)).toEqual(beforeCells);
    } finally {
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
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
  browserContextId: string,
): Promise<void> {
  const res = await request.put(`${BASE}/api/ui-state/${projectPanesKey(realpathSync(projectPath))}`, {
    data: {
      nonChatPanes: [{
        id: `browser:${browserContextId}`,
        type: "browser",
        title: "Project page",
        url: "https://example.com/project-pane",
        projectPath,
      }],
      openChatTopicIds: [topicId],
      activeChatTopicId: topicId,
    },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBeTruthy();
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
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await selectTopic(page, topic.id);
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="topic-browser-tab"]')).toHaveCount(2);

      await page.locator('[data-testid="topic-browser-close"]').click();
      await expect(windowEl).toHaveCount(0, { timeout: 10000 });

      // The way back has to EXIST: a window with pages behind it and no command
      // to reopen is a topic whose browser is unreachable for good.
      const reopen = page.locator('[data-testid="topic-browser-reopen"]');
      await expect(reopen).toBeVisible({ timeout: 10000 });
      await reopen.click();

      await expect(windowEl).toBeVisible({ timeout: 10000 });
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${first}"]`)).toHaveCount(1);
      await expect(page.locator(`[data-testid="topic-browser-tab"][data-context-id="${second}"]`)).toHaveCount(1);
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
});

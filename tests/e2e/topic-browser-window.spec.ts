import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
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
      await page.locator('[data-testid="topic-browser-add"]').click();
      await page.locator('[data-testid="topic-browser-add-existing"]').first().click();

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

      await page.locator('[data-testid="topic-browser-add"]').click();
      await page.locator('[data-testid="topic-browser-add-existing"]').first().click();
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
      await menu.locator('[data-testid="topic-browser-add-existing"]').first().click();
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
});

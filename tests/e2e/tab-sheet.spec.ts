/**
 * tab-sheet.spec.ts — a tab has ONE command surface, and it is the tab itself.
 *
 * What this file defends is the change `tab-menu-unico`: the right click on a
 * tab used to open a dropdown of seventeen flat rows, while a click on an
 * active browser tab opened a second surface (the sheet) with twenty-two more,
 * one command twice under two names and each surface missing half of the
 * other. Now every door of a tab opens the same sheet, grown out of the tab,
 * with its commands on a first level and in levels beside it.
 *
 * The browser panes never load their page: the server's headless browser is
 * the external boundary, and its socket is routed nowhere (`noServerBrowser`).
 * What is under test is the tab and its sheet, which the pane feeds from the
 * address it knows.
 *
 * @covers TABSHEET-01 @covers TABSHEET-02 @covers TABSHEET-03 @covers TABSHEET-04 @covers TOPIC-BROWSER-02 @covers CTXMENU-01 @covers LAYOUT-02
 */
import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic, seedPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { longPress } from "./helpers/long-press";
import { openSheetLevel, openTabSheet, tabSheet } from "./helpers/tab-sheet";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE PAGE'S HEADLESS BROWSER IS THE EXTERNAL BOUNDARY, and it is not started:
 * the pane's socket to the server's browser goes nowhere, so the server never
 * launches one. The tab and its sheet do not need the page to be loaded: the
 * pane publishes its chrome from the address it knows.
 */
async function noServerBrowser(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/browser\//, () => {});
}

/**
 * Hold `selector` down with a finger. WebKit on the desktop has no `Touch`
 * constructor, so there the same sheet is asked for with the other gesture the
 * requirement names, the right click; the long press itself is measured on the
 * engines that can synthesize one (the `chromium` project runs this spec too).
 */
async function holdOrRightClick(page: Page, selector: string, until: Locator): Promise<void> {
  const canTouch = await page.evaluate(() => {
    try { return !!new Touch({ identifier: 0, target: document.body, clientX: 0, clientY: 0 }); } catch { return false; }
  });
  if (canTouch) {
    await longPress(page, selector, { until });
    return;
  }
  test.info().annotations.push({ type: "gesture", description: "right click: this engine cannot build a Touch" });
  await page.locator(selector).first().click({ button: "right" });
  await expect(until).toBeVisible();
}

/**
 * Hold `target` down for `ms` with a touch WebKit on the desktop can build: it
 * has no `Touch` constructor, but React's `onTouchStart` only reads the event's
 * `touches`, so a plain event that carries them walks the same path. Used to
 * ask whether a long press INSIDE an open sheet reaches a surface it must not.
 */
async function holdInside(target: Locator, ms = 900): Promise<void> {
  await target.evaluate(async (el, hold) => {
    const r = el.getBoundingClientRect();
    const point = { clientX: r.left + 10, clientY: r.top + r.height / 2, identifier: 1, target: el };
    const fire = (type: string, touches: unknown[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "touches", { value: touches });
      Object.defineProperty(e, "targetTouches", { value: touches });
      Object.defineProperty(e, "changedTouches", { value: [point] });
      el.dispatchEvent(e);
    };
    fire("touchstart", [point]);
    await new Promise((done) => setTimeout(done, hold));
    fire("touchend", []);
  }, ms);
}

/** A clipboard that remembers what it was given (`window.__copied`). */
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = store;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { store.push(text); } },
    });
  });
}

function copied(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

/** Two chats and a browser pane on `url`, in one group, the browser in front
 *  unless `activePaneId` says otherwise. */
async function seedBar(request: APIRequestContext, chatA: string, chatB: string, browserId: string, url: string, activePaneId?: string): Promise<void> {
  const openedAt = Date.now();
  await seedPaneStore(request, () => ({
    panes: {
      [chatA]: { id: chatA, type: "chat", topicId: chatA, title: "Chat A", openedAt },
      [chatB]: { id: chatB, type: "chat", topicId: chatB, title: "Chat B", openedAt },
      [browserId]: { id: browserId, type: "browser", url, openedAt },
    },
    groups: {
      "group:default": {
        id: "group:default", paneIds: [chatA, chatB, browserId], splitRatio: 1, splitAxis: "horizontal",
        ...(activePaneId ? { activePaneId } : {}),
      },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
}

/** The rows of the first level, as a person counts them. */
async function firstLevelRows(page: Page): Promise<string[]> {
  return page.getByTestId("tab-sheet-commands").evaluate((list) =>
    Array.from(list.querySelectorAll(':scope > [role="menuitem"]'))
      .map((el) => (el.getAttribute("data-testid") ?? el.textContent ?? "").trim()),
  );
}

/** Two animation frames: long enough for a request that was going to reopen it. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

test.describe("TABSHEET: the tab is the command surface", () => {
  test.describe.configure({ timeout: 120_000 });

  const topics: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of topics) await deleteTopic(request, id).catch(() => {});
  });

  async function scene(page: Page, request: APIRequestContext, tag: string) {
    const a = await createTopic(request, `E2E-TABSHEET-A-${tag}-${Date.now()}`);
    const b = await createTopic(request, `E2E-TABSHEET-B-${tag}-${Date.now()}`);
    topics.push(a.id, b.id);
    const browserId = `browser:tabsheet-${tag}-${Date.now()}`;
    // A reserved name (RFC 6761): the page is never fetched, from anywhere.
    const url = "http://tabsheet.test/a";
    await seedBar(request, a.id, b.id, browserId, url);
    await noServerBrowser(page);
    await goToApp(page);
    await waitForTopicVisible(page, a.id);
    const browserTab = page.locator(`[data-testid="pane-tab-${browserId}"]`);
    const chatTab = page.locator(`[data-testid="pane-tab-${a.id}"]`);
    const otherChatTab = page.locator(`[data-testid="pane-tab-${b.id}"]`);
    await expect(browserTab).toBeVisible({ timeout: 30_000 });
    await browserTab.click();
    // A pane that opened its own sheet (a blank one does) is closed first.
    await page.keyboard.press("Escape");
    await expect(tabSheet(page)).toHaveCount(0);
    return { browserTab, chatTab, otherChatTab, browserId, chatId: a.id };
  }

  test("TABSHEET-01: right click, click and the door that closes, on one surface grown out of the tab", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSHEET-01" });
    const { browserTab, chatTab } = await scene(page, request, "01");
    const sheet = tabSheet(page);
    const address = page.getByTestId("browser-tab-address-input");

    // 1. THE RIGHT CLICK OPENS THE SHEET, from the commands door: the focus on
    //    the first row, the address visible and without focus, no suggestion,
    //    and no cursor menu anywhere.
    await browserTab.click({ button: "right" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-door", "commands");
    await expect(sheet).toHaveAttribute("data-pane-type", "browser");
    await expect(page.locator('[role="menu"]:not([data-testid="tab-sheet-commands"])'), "no cursor menu").toHaveCount(0);
    await expect(page.locator('[data-testid="tab-sheet-commands"] [role="menuitem"]').first()).toBeFocused();
    await expect(address).toBeVisible();
    await expect(address).not.toBeFocused();
    await expect(page.getByTestId("tab-sheet-suggestions")).toHaveCount(0);

    // 2. ONE SURFACE: the tab says so, the sheet starts on its bottom edge and
    //    on its left edge, and the two are painted with the same fill.
    await expect(browserTab).toHaveAttribute("data-sheet-open", "");
    const tabBox = (await browserTab.boundingBox())!;
    const sheetBox = (await sheet.boundingBox())!;
    expect(Math.abs(sheetBox.y - (tabBox.y + tabBox.height)), "the sheet starts on the tab's bottom edge").toBeLessThanOrEqual(1);
    expect(Math.abs(sheetBox.x - tabBox.x), "the sheet starts on the tab's left edge").toBeLessThanOrEqual(1);
    const fills = await page.evaluate(([tabSel]) => {
      const tab = document.querySelector(tabSel)!;
      const panel = document.querySelector('[data-testid="tab-sheet"]')!;
      return { tab: getComputedStyle(tab).backgroundColor, sheet: getComputedStyle(panel).backgroundColor };
    }, [`[data-testid="${await browserTab.getAttribute("data-testid")}"]`]);
    expect(fills.tab, "the tab and the sheet share the fill").toBe(fills.sheet);
    // ...in the dark theme too: the fill is the sheet's token, not a colour.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    const dark = await page.evaluate(([tabSel]) => {
      const tab = document.querySelector(tabSel)!;
      const panel = document.querySelector('[data-testid="tab-sheet"]')!;
      return { tab: getComputedStyle(tab).backgroundColor, sheet: getComputedStyle(panel).backgroundColor };
    }, [`[data-testid="${await browserTab.getAttribute("data-testid")}"]`]);
    expect(dark.tab, "dark: the tab and the sheet share the fill").toBe(dark.sheet);
    expect(dark.sheet, "dark: the fill changed with the theme").not.toBe(fills.sheet);
    await page.emulateMedia({ colorScheme: "light" });

    // 3. THE DOOR CLOSES: a right click on the same tab closes it, for good.
    await browserTab.click({ button: "right" });
    await expect(sheet).toHaveCount(0);
    await nextFrames(page);
    await expect(sheet, "the same gesture does not reopen it").toHaveCount(0);
    await expect(browserTab).not.toHaveAttribute("data-sheet-open", "");

    // 4. ANOTHER TAB: only its sheet is open.
    await browserTab.click({ button: "right" });
    await expect(sheet).toHaveAttribute("data-pane-type", "browser");
    await chatTab.click({ button: "right" });
    await expect(sheet).toHaveCount(1);
    await expect(sheet).toHaveAttribute("data-pane-type", "chat");
    await expect(page.getByTestId("tab-sheet-title")).toBeVisible();

    // 5. Esc closes it and the focus goes back to the tab.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(chatTab).toBeFocused();

    // 6. A CLICK ON THE ACTIVE BROWSER TAB opens the same sheet from the
    //    address door: the field focused and all selected, the same commands
    //    under it.
    await browserTab.getByTestId("pane-tab-label").click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-door", "address");
    await expect(address).toBeFocused();
    const allSelected = await address.evaluate((el) => {
      const i = el as HTMLInputElement;
      return i.value.length > 0 && i.selectionStart === 0 && i.selectionEnd === i.value.length;
    });
    expect(allSelected, "the whole address is selected").toBe(true);
    await expect(page.getByTestId("tab-sheet-commands").getByTestId("tab-menu-find"), "the same commands as the right click").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("TABSHEET-02: the first level reads at a glance, the levels open beside it, and all of it by keyboard", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSHEET-02" });
    const { browserTab, chatTab } = await scene(page, request, "02");
    const sheet = tabSheet(page);

    // 1. THE FIRST LEVEL of a browser tab: at most eleven rows, the levels in
    //    their fixed order, and every level that is drawn holds two rows or
    //    more (one row goes up, none is not drawn).
    await openTabSheet(page, browserTab);
    const rows = await firstLevelRows(page);
    expect(rows.length, `first level: ${rows.join(" | ")}`).toBeLessThanOrEqual(11);
    const levels = ["page", "tools", "session", "tab", "layout"].filter((id) => rows.includes(`tab-sheet-level-${id}`));
    expect(levels.map((id) => rows.indexOf(`tab-sheet-level-${id}`)), "the levels keep their order")
      .toEqual(levels.map((id) => rows.indexOf(`tab-sheet-level-${id}`)).sort((x, y) => x - y));
    expect(levels, "Tab and Layout are there on a browser tab with splits").toEqual(expect.arrayContaining(["tab", "layout"]));
    for (const id of levels) {
      const panel = await openSheetLevel(page, id as "page" | "tools" | "session" | "tab" | "layout");
      // The level opens BESIDE its row, not in place of the sheet.
      const rowBox = (await page.getByTestId(`tab-sheet-level-${id}`).boundingBox())!;
      const panelBox = (await panel.boundingBox())!;
      expect(panelBox.x >= rowBox.x + rowBox.width - 2 || panelBox.x + panelBox.width <= rowBox.x + 2, `${id} opens beside its row`).toBe(true);
      const count = await panel.locator('[role="menuitem"], [data-testid^="browser-tab-"]').count();
      expect(count, `the ${id} level has two rows or more`).toBeGreaterThanOrEqual(2);
      await expect(sheet, "a level open does not close the sheet").toBeVisible();
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // 3. ALL OF IT BY KEYBOARD, on a chat tab: Shift+F10, the arrows down to
    //    Layout, the right arrow into it, Esc one level per press.
    // The pointer is parked away from where the panels open: a level that
    // appears under a resting mouse opens by hover, and this part is about
    // the keyboard alone.
    await page.mouse.move(2, 790);
    await chatTab.focus();
    await page.keyboard.press("Shift+F10");
    await expect(sheet).toBeVisible();
    const layoutRow = page.getByTestId("tab-sheet-level-layout");
    for (let i = 0; i < 12; i++) {
      if (await layoutRow.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(layoutRow).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const layoutLevel = page.getByTestId("tab-sheet-level-layout-menu");
    await expect(layoutLevel).toBeVisible();
    await expect(layoutLevel.locator('[role="menuitem"]').first(), "the focus is on the level's first row").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(layoutLevel).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(layoutRow).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(chatTab).toBeFocused();
  });

  test("TABSHEET-03: every command has one place, and Close closes now", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSHEET-03" });
    const { browserTab, otherChatTab } = await scene(page, request, "03");
    const sheet = tabSheet(page);

    // 1. NOTHING IS LOST on a browser tab, one level at a time.
    await openTabSheet(page, browserTab);
    for (const id of ["browser-tab-back", "browser-tab-forward", "tab-sheet-reload", "browser-tab-copy-url", "tab-menu-find", "tab-sheet-close", "tab-sheet-close-others"]) {
      await expect(sheet.getByTestId(id), id).toHaveCount(1);
    }
    // ...the page address is copied by ONE row, the copy icon.
    await expect(page.getByText(/Copia URL della pagina|Copy page URL/)).toHaveCount(0);
    const tabLevel = await openSheetLevel(page, "tab");
    for (const id of ["tab-sheet-rename", "tab-menu-pin-tab", "tab-sheet-copy-link"]) await expect(tabLevel.getByTestId(id), id).toHaveCount(1);
    const layoutLevel = await openSheetLevel(page, "layout");
    for (const id of ["tab-sheet-split-right", "tab-sheet-split-down"]) await expect(layoutLevel.getByTestId(id), id).toHaveCount(1);
    // ...and no close with a countdown anywhere in the sheet.
    await expect(page.getByText(/conto alla rovescia|countdown/i)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // 2. CLOSE CLOSES NOW: the tab goes without a countdown, the sheet with it.
    await openTabSheet(page, otherChatTab);
    await sheet.getByTestId("tab-sheet-close").click();
    await expect(otherChatTab).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
  });

  test("nothing is lost (TABSHEET-03): a browser tab never brought to the front still shows its address and copies it", async ({ page, request }) => {
    const a = await createTopic(request, `E2E-TABSHEET-A-cold-${Date.now()}`);
    const b = await createTopic(request, `E2E-TABSHEET-B-cold-${Date.now()}`);
    topics.push(a.id, b.id);
    const browserId = `browser:tabsheet-cold-${Date.now()}`;
    // The chat is in front: the browser pane is never mounted, so it never
    // publishes its chrome. The address is still known (the store has it).
    await seedBar(request, a.id, b.id, browserId, "http://tabsheet.test/a", a.id);
    await noServerBrowser(page);
    await recordClipboard(page);
    await goToApp(page);
    await waitForTopicVisible(page, a.id);
    const browserTab = page.locator(`[data-testid="pane-tab-${browserId}"]`);
    await expect(browserTab).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-browser-pane="${browserId}"]`), "the browser pane was never mounted").toHaveCount(0);

    const sheet = await openTabSheet(page, browserTab);
    await expect(sheet).toHaveAttribute("data-pane-type", "browser");
    await expect(sheet.getByTestId("tab-sheet-address"), "the address is shown").toHaveText("http://tabsheet.test/a");
    await sheet.getByTestId("browser-tab-copy-url").click();
    await expect.poll(() => copied(page), { message: "the copy icon copies the page address" }).toEqual(["http://tabsheet.test/a"]);
  });

  test("one surface (TABSHEET-01): with a level open, a command of the sheet's header still runs", async ({ page, request }) => {
    await recordClipboard(page);
    const { browserTab } = await scene(page, request, "header");
    const sheet = tabSheet(page);

    // Copy, with the Layout level open: the address reaches the clipboard.
    await openTabSheet(page, browserTab);
    await openSheetLevel(page, "layout");
    await sheet.getByTestId("browser-tab-copy-url").click();
    await expect.poll(() => copied(page), { message: "Copy ran with a level open" }).toEqual(["http://tabsheet.test/a"]);

    // Reload, with the Layout level open: the command runs, and an action
    // closes the sheet, as it does with no level open.
    await openSheetLevel(page, "layout");
    await sheet.getByTestId("tab-sheet-reload").click();
    await expect(sheet, "Reload ran and closed the sheet").toHaveCount(0);
  });

  test("a level carries out its command: Layout splits a browser tab, Tab renames a chat", async ({ page, request }) => {
    const { browserTab, chatTab, chatId } = await scene(page, request, "levels");
    const sheet = tabSheet(page);
    const cellsBefore = await page.locator('[data-testid="panel-tab-bar"]').count();

    // Right click on the browser tab, Layout, Split right: a new cell.
    await openTabSheet(page, browserTab);
    const layout = await openSheetLevel(page, "layout");
    await layout.getByTestId("tab-sheet-split-right").click();
    await expect(sheet, "an action closes the sheet").toHaveCount(0);
    await expect.poll(() => page.locator('[data-testid="panel-tab-bar"]').count(), { timeout: 10_000 }).toBeGreaterThan(cellsBefore);

    // The same tab clicked: the address, selected.
    await browserTab.getByTestId("pane-tab-label").click();
    await expect(sheet).toHaveAttribute("data-door", "address");
    await expect(page.getByTestId("browser-tab-address-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // Right click on the chat, Tab, Rename: the new name is on the tab.
    const name = `Rinominata ${Date.now()}`;
    await openTabSheet(page, chatTab);
    const tabLevel = await openSheetLevel(page, "tab");
    await tabLevel.getByTestId("tab-sheet-rename").click();
    const field = tabLevel.getByTestId("tab-sheet-rename-input");
    await expect(field).toBeFocused();
    await field.fill(name);
    await field.press("Enter");
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(`[data-testid="pane-tab-${chatId}"]`)).toContainText(name, { timeout: 10_000 });
  });

  test("in English nothing in the sheet is Italian", async ({ page, request }) => {
    await page.request.put(`${E2E_BASE}/api/ui-state/settings`, { data: { language: "en" } });
    await page.addInitScript(() => {
      const KEY = "app-settings";
      let cur: Record<string, unknown> = {};
      try { cur = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>; } catch { /* empty */ }
      localStorage.setItem(KEY, JSON.stringify({ ...cur, language: "en" }));
    });
    try {
      const { chatTab } = await scene(page, request, "en");
      await openTabSheet(page, chatTab);
      const tabLevel = await openSheetLevel(page, "tab");
      const words = `${await tabSheet(page).innerText()}\n${await tabLevel.innerText()}`;
      expect(words).not.toMatch(/\b(Chiudi|Cerca|Fissa|Rinomina|Copia|Disposizione|Impostazioni|Dividi|Sposta|altre)\b/);
      expect(words).toMatch(/Close/);
    } finally {
      await page.request.put(`${E2E_BASE}/api/ui-state/settings`, { data: { language: "it" } });
    }
  });

  test.describe("with a finger", () => {
    test.use({ hasTouch: true });

    test("holding a tab opens the same sheet as the right click", async ({ page, request }) => {
      const { chatId } = await scene(page, request, "touch");
      await holdOrRightClick(page, `[data-testid="pane-tab-${chatId}"]`, tabSheet(page));
      await expect(tabSheet(page)).toHaveAttribute("data-door", "commands");
      await expect(tabSheet(page)).toHaveAttribute("data-pane-type", "chat");
    });
  });
});

test.describe("TABSHEET-04: the topic's window and the phone title open the same sheet", () => {
  test.describe.configure({ timeout: 120_000 });

  let topicId = "";

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test("TABSHEET-04: a sheet of the topic's window: Open as tab on the first level, no layout", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSHEET-04" });
    const topic = await createTopic(request, `E2E-TABSHEET-WIN-${Date.now()}`);
    topicId = topic.id;
    const ctxA = `tabsheet-win-a-${Date.now()}`;
    const ctxB = `tabsheet-win-b-${Date.now()}`;
    await seedPaneStore(request, () => ({
      panes: { [topic.id]: { id: topic.id, type: "chat", topicId: topic.id, title: "Chat", openedAt: Date.now() } },
      groups: { "group:default": { id: "group:default", paneIds: [topic.id], splitRatio: 1, splitAxis: "horizontal" } },
      projects: {}, groupOrder: ["group:default"], closedStack: [],
    }));
    const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topic.id}`, {
      data: {
        mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
        tabs: [
          { contextId: ctxA, url: "http://tabsheet.test/uno", title: "Uno", openedBy: "user" },
          { contextId: ctxB, url: "http://tabsheet.test/due", title: "Due", openedBy: "user" },
        ],
        activeContextId: ctxA, promoted: [],
      },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    await noServerBrowser(page);
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await page.locator(`[data-pane-id="${topic.id}"]`).first().click();
    const win = page.getByTestId("topic-browser-window");
    await expect(win).toBeVisible({ timeout: 15_000 });

    const second = win.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctxB}"]`);
    const sheet = await openTabSheet(page, second);
    await expect(sheet).toHaveAttribute("data-surface", "window");
    await expect(sheet.getByTestId("tab-sheet-open-as-tab")).toBeVisible();
    await expect(page.getByTestId("tab-sheet-level-layout")).toHaveCount(0);
    await expect(page.getByTestId("tab-sheet-level-tab")).toHaveCount(0);
    await expect(sheet.getByTestId("browser-tab-return-to-window")).toHaveCount(0);

    await sheet.getByTestId("tab-sheet-open-as-tab").click();
    await expect(page.locator(`[data-browser-pane="${ctxB}"]`).first()).toBeVisible({ timeout: 15_000 });
    await expect(win.locator('[data-testid="topic-browser-tab"]')).toHaveCount(1);
    await expect(win.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctxA}"]`)).toBeVisible();
  });

  test.describe("the topic's window, with a finger", () => {
    test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });

    test("the window's sheet (TABSHEET-04): a finger held inside it does not reopen it", async ({ page, request }) => {
      const topic = await createTopic(request, `E2E-TABSHEET-WINTOUCH-${Date.now()}`);
      topicId = topic.id;
      const ctxA = `tabsheet-wint-a-${Date.now()}`;
      await seedPaneStore(request, () => ({
        panes: { [topic.id]: { id: topic.id, type: "chat", topicId: topic.id, title: "Chat", openedAt: Date.now() } },
        groups: { "group:default": { id: "group:default", paneIds: [topic.id], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {}, groupOrder: ["group:default"], closedStack: [],
      }));
      const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topic.id}`, {
        data: {
          mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
          tabs: [{ contextId: ctxA, url: "http://tabsheet.test/uno", title: "Uno", openedBy: "user" }],
          activeContextId: ctxA, promoted: [],
        },
        ignoreHTTPSErrors: true,
      });
      expect(res.ok()).toBeTruthy();
      await noServerBrowser(page);
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.locator(`[data-pane-id="${topic.id}"]`).first().click();
      const win = page.getByTestId("topic-browser-window");
      await expect(win).toBeVisible({ timeout: 15_000 });

      // The active window tab opens its sheet on the address.
      await win.locator(`[data-testid="topic-browser-tab"][data-context-id="${ctxA}"]`).click();
      const sheet = tabSheet(page);
      await expect(sheet).toHaveAttribute("data-door", "address");
      const address = sheet.getByTestId("browser-tab-address-input");
      await address.fill("typed-by-me");
      await holdInside(address);
      await expect(address, "what was typed is still there").toHaveValue("typed-by-me");
      await expect(sheet, "the sheet was not reopened on the commands").toHaveAttribute("data-door", "address");
    });
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("the phone title (TABSHEET-04): with three tabs Close others is offered, and a finger held inside the sheet does not reopen it", async ({ page, request }) => {
      const a = await createTopic(request, `E2E-TABSHEET-PH3-A-${Date.now()}`);
      const b = await createTopic(request, `E2E-TABSHEET-PH3-B-${Date.now()}`);
      topicId = a.id;
      const browserId = `browser:tabsheet-ph3-${Date.now()}`;
      await seedBar(request, a.id, b.id, browserId, "http://tabsheet.test/a", browserId);
      await noServerBrowser(page);
      await goToApp(page);
      // The phone opens on the list: the browser is chosen from it.
      const drawer = page.locator('[data-sidebar][data-drawer="open"]');
      const row = drawer.getByText("Browser", { exact: true }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      const title = page.getByTestId("mobile-pane-title");
      await expect(title).toBeVisible({ timeout: 30_000 });
      await holdOrRightClick(page, '[data-testid="mobile-pane-title"]', tabSheet(page));
      const sheet = tabSheet(page);
      await expect(sheet).toHaveAttribute("data-surface", "title");
      await expect(sheet).toHaveAttribute("data-pane-type", "browser");

      // 1. A FINGER HELD ON THE ADDRESS (to paste, to move the caret) keeps
      //    what was typed: the hold belongs to the field, not to the title.
      const address = sheet.getByTestId("browser-tab-address-input");
      await address.fill("typed-by-me");
      await holdInside(address);
      await expect(address, "what was typed is still there").toHaveValue("typed-by-me");
      await expect(sheet, "the sheet was not reopened on the commands").toHaveAttribute("data-door", "commands");
      await expect(address).toBeFocused();

      // 2. CLOSE OTHERS, as on every tab of a group with more than one.
      const closeOthers = sheet.getByTestId("tab-sheet-close-others");
      await expect(closeOthers).toBeVisible();
      await closeOthers.click();
      await expect(sheet).toHaveCount(0);
      await title.click({ button: "right" });
      await expect(tabSheet(page)).toBeVisible();
      await expect(tabSheet(page).getByTestId("tab-sheet-close-others"), "one tab left: nothing else to close").toHaveCount(0);
    });

    test("holding the title opens the chat's sheet from the bottom, finger-sized and without layout", async ({ page, request }) => {
      const name = `E2E-TABSHEET-PHONE-${Date.now()}`;
      const topic = await createTopic(request, name);
      topicId = topic.id;
      await seedPaneStore(request, () => ({
        panes: { [topic.id]: { id: topic.id, type: "chat", topicId: topic.id, title: "Chat", openedAt: Date.now() } },
        groups: { "group:default": { id: "group:default", paneIds: [topic.id], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {}, groupOrder: ["group:default"], closedStack: [],
      }));
      await goToApp(page);
      // The phone opens on the list: the chat is chosen from it, as a person does.
      const row = page.getByText(name, { exact: true }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      const title = page.getByTestId("mobile-pane-title");
      await expect(title).toBeVisible({ timeout: 30_000 });
      await holdOrRightClick(page, '[data-testid="mobile-pane-title"]', tabSheet(page));
      const sheet = tabSheet(page);
      await expect(sheet).toHaveAttribute("data-surface", "title");
      const box = (await sheet.boundingBox())!;
      expect(box.width, "full width").toBeGreaterThanOrEqual(389);
      expect(Math.round(box.y + box.height), "from the bottom").toBeGreaterThanOrEqual(843);
      await expect(sheet.getByTestId("tab-sheet-close")).toBeVisible();
      await expect(sheet.getByTestId("tab-sheet-chat-settings")).toBeVisible();
      await expect(sheet.getByTestId("tab-sheet-level-tab")).toBeVisible();
      await expect(sheet.getByTestId("tab-sheet-level-layout")).toHaveCount(0);
      const short = await sheet.locator('[role="menuitem"]').evaluateAll((rows) =>
        rows.map((r) => ({ name: (r.textContent ?? "").trim(), h: r.getBoundingClientRect().height })).filter((r) => r.h < 44));
      expect(short, "every row is at least 44 px").toEqual([]);
    });
  });
});

/**
 * The command palette when a result is opened and while the query is typed
 * (CMD-01): what the first frame after Enter holds for a chat that has to
 * mount, and a card that keeps one size with the selection in view. The rest
 * of the palette is in command-palette.spec.ts.
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/command-palette.fixture";
import { createTopic, cleanupAll, resetPaneStore, unarchiveTopic, patchTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Command Palette, opening and typing", () => {
  const TS = Date.now();
  const topicIds: string[] = [];
  const anchorIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const anchor = await createTopic(request, `E2E-PalAnchor-${TS}`);
    topicIds.push(anchor.id);
    anchorIds.push(anchor.id);
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: topicIds });
  });

  // One chat open: every other topic is one the palette has to mount.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, anchorIds);
  });

  test("PALETTE-17: Enter on a chat that has to mount paints the palette away first, with the history already asked for", async ({
    commandPalettePage,
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    // CS-05 (client-speed audit 2026-09-30): the row's action opened the chat
    // inside the keydown, so the whole render of the new pane ran in the input
    // task (a 150-190 ms frame with the palette frozen on screen), and its
    // history request only left from the pane's mount effect, after that
    // render. A chat already mounted keeps opening in the input task: that
    // case is TABSWITCH-01 (tab-switch-instant.spec.ts).
    const name = `E2E-PalCold-${TS}`;
    const cold = await createTopic(request, name);
    topicIds.push(cold.id);
    const topics = ((await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
    const sessionKey = Object.values(topics).find((x) => x.id === cold.id)!.sessionKey;
    for (let i = 0; i < 60; i++) {
      await seedMessage(request, { sessionKey, role: i % 2 ? "assistant" : "user", content: i === 59 ? "PAL-COLD-END final line" : `Row ${i}. ${"Lorem ipsum dolor sit amet. ".repeat(6)}` });
    }
    await unarchiveTopic(request, cold.id);

    await page.addInitScript((target) => {
      const w = window as unknown as { __pal: Record<string, unknown> };
      w.__pal = {};
      const shell = () => !!document.querySelector(`[data-pane-shell="${CSS.escape(target.id)}"]`);
      const realFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (w.__pal.enterAt !== undefined && w.__pal.historyAt === undefined && decodeURIComponent(url).includes(`/history/${target.sessionKey}`)) {
          w.__pal.historyAt = performance.now();
          w.__pal.shellAtHistory = shell();
        }
        return realFetch(input, init);
      }) as typeof window.fetch;
      window.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !document.querySelector('[data-testid="command-palette"]')) return;
        w.__pal.enterAt = performance.now();
        requestAnimationFrame(() => {
          w.__pal.frameAt = performance.now();
          w.__pal.shellAtFrame = shell();
          w.__pal.paletteAtFrame = !!document.querySelector('[data-testid="command-palette"]');
        });
      }, true);
    }, { id: cold.id, sessionKey });

    await goToApp(page);
    await commandPalettePage.search(name);
    await expect(commandPalettePage.overlay.getByRole("option", { name: new RegExp(name) })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-pane-shell="${cold.id}"] [data-testid="chat-message"]`).filter({ hasText: "PAL-COLD-END" })).toBeVisible({ timeout: 20_000 });

    const r = (await page.evaluate(() => (window as unknown as { __pal: Record<string, number | boolean> }).__pal)) as {
      enterAt: number; frameAt: number; historyAt?: number; shellAtFrame: boolean; shellAtHistory?: boolean; paletteAtFrame: boolean;
    };
    const ms = (t?: number) => (t === undefined ? "never" : `${Math.round(t - r.enterAt)}ms`);
    test.info().annotations.push({ type: "Enter to first frame / to history request", description: `${ms(r.frameAt)} / ${ms(r.historyAt)}` });
    expect(r.paletteAtFrame, "the palette is gone on the first frame after Enter").toBe(false);
    expect(r.shellAtFrame, `the first frame after Enter is not held by the chat's render (frame at ${ms(r.frameAt)})`).toBe(false);
    expect(r.historyAt, "the chat's history was asked for").toBeDefined();
    expect(r.shellAtHistory, `the history request leaves before the pane renders, not from its mount effect (at ${ms(r.historyAt)})`).toBe(false);
  });

  test("PALETTE-18: the palette keeps one size while typing, and the selected row stays in view", async ({
    commandPalettePage,
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    // The card was sized by its content up to 76vh: every keystroke that
    // changed the results resized it, and the footer and the rows under the
    // pointer jumped with it. A fixed box scrolls its results inside.
    const prefix = `E2E-PalBox-${TS}`;
    for (let i = 0; i < 24; i++) {
      const t = await createTopic(request, `${prefix}-${String(i).padStart(2, "0")}${i < 3 ? "x" : ""}`);
      topicIds.push(t.id);
    }
    await goToApp(page);
    await commandPalettePage.open();
    // The card: the dialog's second child, after the veil.
    const panel = commandPalettePage.overlay.locator(":scope > div").nth(1);
    const height = () => panel.evaluate((el) => new Promise<number>((res) => requestAnimationFrame(() => res(Math.round(el.getBoundingClientRect().height)))));
    const heights: Record<string, number> = { "": await height() };
    // Empty query, then more and more of the name: from the two empty-state
    // columns to 24 results, to 3, to 1, to none.
    for (const q of ["E2E-Pal", prefix, `${prefix}-0`, `${prefix}-00`, `${prefix}-00x`, `${prefix}-00xq`]) {
      await commandPalettePage.searchInput.fill(q);
      await expect(commandPalettePage.searchInput).toHaveValue(q);
      heights[q] = await height();
    }
    expect(new Set(Object.values(heights)).size, `one height for every query: ${JSON.stringify(heights)}`).toBe(1);

    // Down past the fold: the selected row follows into view.
    await commandPalettePage.searchInput.fill(prefix);
    const selected = commandPalettePage.overlay.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toContainText(`${prefix}-`);
    const inView = () => selected.evaluate((el) => {
      let box: Element | null = el.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
      const r = el.getBoundingClientRect();
      const b = (box ?? document.documentElement).getBoundingClientRect();
      return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    });
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    await expect(selected).toHaveAttribute("data-cmd-idx", "20");
    expect(await inView(), "after 20 x ArrowDown the selected row is in view").toBe(true);

    // Back on the first row, the results scrolled down by the trackpad (the
    // pointer has not moved, so it takes no selection), then one keystroke:
    // the selection is the first row, and the first row is on screen.
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowUp");
    await expect(selected).toHaveAttribute("data-cmd-idx", "0");
    await commandPalettePage.overlay.locator('section[role="listbox"]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await inView(), "scrolled down, the first row is out of view").toBe(false);
    await page.keyboard.type("-");
    await expect(commandPalettePage.searchInput).toHaveValue(`${prefix}-`);
    await expect(selected).toHaveAttribute("data-cmd-idx", "0");
    await expect.poll(inView, { message: "after a keystroke the selected first row is in view" }).toBe(true);
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("PALETTE-19: results scrolled by finger stay where they are when a chat is updated in the background", async ({
      commandPalettePage,
      page,
      request,
    }) => {
      test.info().annotations.push({ type: "spec", description: "CMD-01" });
      // A finger scroll sends no mouse event, so the selection stays on the
      // first row while the list goes down. The selected row was scrolled back
      // into view on every change of the result list, and the list changes on
      // every topic:updated (the end of a turn in any chat, a rename, a new
      // chat): the list jumped back to the top under the user's finger.
      const prefix = `E2E-PalTouch-${TS}`;
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const t = await createTopic(request, `${prefix}-${String(i).padStart(2, "0")}`);
        topicIds.push(t.id);
        ids.push(t.id);
      }
      await goToApp(page);
      await commandPalettePage.search(prefix);
      await expect(commandPalettePage.overlay.getByRole("option", { name: new RegExp(`${prefix}-00`) })).toBeAttached();
      const selected = commandPalettePage.overlay.locator('[role="option"][aria-selected="true"]');
      await expect(selected).toHaveAttribute("data-cmd-idx", "0");
      // The phone's list is one scroller holding both columns.
      const list = selected.locator("xpath=ancestor::*[contains(@class,'overflow-y-auto')][1]");
      const bottom = await list.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
      expect(bottom, "the results are long enough to scroll").toBeGreaterThan(200);

      // One of the listed chats is renamed elsewhere: the rename reaching the
      // list is the sync point, the scroll position is what is read.
      const renamed = `${prefix}-05-renamed`;
      await patchTopic(request, ids[5], { name: renamed });
      await expect(commandPalettePage.overlay.getByRole("option", { name: new RegExp(renamed) })).toBeAttached();
      await expect(selected).toHaveAttribute("data-cmd-idx", "0");
      const after = await list.evaluate((el) => new Promise<number>((res) => requestAnimationFrame(() => res(el.scrollTop))));
      expect(after, `the list stays where the finger left it (${bottom} -> ${after})`).toBeGreaterThanOrEqual(bottom - 2);
    });
  });
});

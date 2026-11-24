/**
 * The tabs in the column, with the defaults of 24/11.
 *
 * A new client lists its tabs in the column instead of the strip on top, and
 * every tab has three states: open (the row has a background), closed (the
 * row stays, without one), archived (the row leaves). Pinned tabs open on
 * their own and cannot be closed. The rows keep the order the person gives
 * them by dragging.
 *
 * The rest of the suite starts with the options of before (see the
 * `storageState` in playwright.config.ts): this file drops them, so what runs
 * here is what a person who never touched the View menu gets.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from "@playwright/test";
import { createTopic, deleteTopic, fetchTopic, seedPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { findRowInTabSheet, openTabSheet } from "./helpers/tab-sheet";

hermetic(test);

// The board keys of the shared storageState, without `app-settings`: the defaults.
test.use({
  storageState: {
    cookies: [],
    origins: [{
      origin: E2E_BASE,
      localStorage: [
        { name: "topics.board.showDone", value: "true" },
        { name: "topics.board.preset", value: "all" },
      ],
    }],
  },
});

type Made = { id: string; name: string };

async function openChats(request: APIRequestContext, chats: Made[]): Promise<void> {
  await seedPaneStore(request, () => ({
    panes: Object.fromEntries(chats.map((c) => [c.id, { id: c.id, type: "chat", title: c.name, topicId: c.id }])),
    groups: {
      "group:default": { id: "group:default", paneIds: chats.map((c) => c.id), splitRatio: 1, splitAxis: "horizontal" },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
}

async function setSidebar(request: APIRequestContext, extra: Record<string, unknown>): Promise<void> {
  await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [], ...extra },
    ignoreHTTPSErrors: true,
  });
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 15_000 });
}

/** The row of a top-level chat in the hand-ordered list. */
const row = (page: Page, id: string): Locator => page.locator(`[data-order-id="${id}"] [role="treeitem"]`).first();

/** The ids of `ids` in the order the column shows them. */
async function shownOrder(page: Page, ids: string[]): Promise<string[]> {
  return page.evaluate((wanted) => {
    const all = [...document.querySelectorAll<HTMLElement>("[data-order-list] > [data-order-id]")].map((el) => el.dataset.orderId ?? "");
    return all.filter((id) => wanted.includes(id));
  }, ids);
}

/** Open per the pane store: the pane exists and a group holds it. */
async function isOpen(request: APIRequestContext, id: string): Promise<boolean> {
  const res = await request.get(`${E2E_BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
  const body = (await res.json()) as { value?: { panes?: Record<string, unknown>; groups?: Record<string, { paneIds?: string[] }> } };
  const store = body.value ?? {};
  return !!store.panes?.[id] && Object.values(store.groups ?? {}).some((g) => g.paneIds?.includes(id));
}

test.describe("@sidebar-tab-states tabs in the column: open, closed, archived", () => {
  const made: Made[] = [];

  test.afterEach(async ({ request }) => {
    for (const t of made.splice(0)) await deleteTopic(request, t.id).catch(() => {});
  });

  test("side is the default: no strip on top, open tabs are rows with a background", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABPOS-01" });
    const a = await createTopic(request, `Side-A-${Date.now()}`);
    const b = await createTopic(request, `Side-B-${Date.now()}`);
    made.push(a, b);
    await openChats(request, [a, b]);
    await gotoApp(page);

    await expect(row(page, a.id)).toHaveAttribute("data-tab-state", "open", { timeout: 10_000 });
    await expect(row(page, b.id)).toHaveAttribute("data-tab-state", "open");
    await expect(page.getByTestId("panel-tab-bar")).toHaveCount(0);
  });

  test("closing a row leaves it closed, a click opens it again, its circle archives it", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABPOS-02" });
    // Two undoable countdowns of 3 s each (close, then archive) on top of a
    // load: measured 9 s for the first navigation on a busy runner, 30 s ran out.
    test.setTimeout(60_000);
    const a = await createTopic(request, `Close-A-${Date.now()}`);
    const b = await createTopic(request, `Close-B-${Date.now()}`);
    made.push(a, b);
    await openChats(request, [a, b]);
    await gotoApp(page);

    // One gesture closes: the row stays, without its background (the bug of
    // before marked it "done" and wanted a second close).
    const rb = row(page, b.id);
    await rb.hover();
    await rb.getByTestId("topic-row-close").click();
    await expect(rb).toHaveAttribute("data-tab-state", "closed", { timeout: 10_000 });
    await expect.poll(() => isOpen(request, b.id), { timeout: 10_000 }).toBe(false);
    expect((await fetchTopic(request, b.id))?.archived).toBeFalsy();

    // A click on the closed row opens the tab again.
    await rb.click();
    await expect(rb).toHaveAttribute("data-tab-state", "open", { timeout: 10_000 });

    // Closed again, the circle now archives: the row leaves the column.
    await rb.hover();
    await rb.getByTestId("topic-row-close").click();
    await expect(rb).toHaveAttribute("data-tab-state", "closed", { timeout: 10_000 });
    await rb.hover();
    await rb.getByTestId("topic-row-archive").click();
    await expect(page.locator(`[data-order-id="${b.id}"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await fetchTopic(request, b.id))?.archived, { timeout: 10_000 }).toBe(true);
  });

  test("a pinned tab opens on its own and cannot be closed", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABPOS-03" });
    const p = await createTopic(request, `Pinned-${Date.now()}`);
    made.push(p);
    await openChats(request, []);
    await setSidebar(request, { pinnedItems: [p.id] });
    await gotoApp(page);

    await expect.poll(() => isOpen(request, p.id), { timeout: 15_000 }).toBe(true);

    const tile = page.getByTestId("sidebar-pinned-section").getByTestId("pinned-tile").and(page.getByRole("treeitem", { name: p.name }));
    await tile.click();
    // Without the strip a tab closes from its title's sheet (⌘W is the desktop
    // shell's): for a pinned tab the sheet has no Close anywhere, and unpinning
    // is the way out.
    await openTabSheet(page, page.getByTestId("mobile-pane-title"));
    expect(await findRowInTabSheet(page, "Chiudi")).toBeNull();
    expect(await findRowInTabSheet(page, "Rimuovi dai Fissati")).not.toBeNull();
    expect(await isOpen(request, p.id)).toBe(true);
  });

  test("on the phone, the pins that open on load leave the open tabs open", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABPOS-03" });
    const p = await createTopic(request, `PhonePin-${Date.now()}`);
    const o = await createTopic(request, `PhoneOpen-${Date.now()}`);
    made.push(p, o);
    await openChats(request, [o]);
    await setSidebar(request, { pinnedItems: [p.id] });
    // On the phone opening a chat REPLACES the open ones: the pins must not go that way.
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      storageState: { cookies: [], origins: [] },
    });
    const page = await ctx.newPage();
    await page.goto(E2E_BASE + "/");
    await expect.poll(() => isOpen(request, p.id), { timeout: 15_000 }).toBe(true);
    expect(await isOpen(request, o.id)).toBe(true);
    await expect(row(page, o.id)).toHaveAttribute("data-tab-state", "open");
    await ctx.close();
  });

  test("rows keep the order they are dragged into, across a reload", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABPOS-04" });
    const a = await createTopic(request, `Order-A-${Date.now()}`);
    const b = await createTopic(request, `Order-B-${Date.now()}`);
    const c = await createTopic(request, `Order-C-${Date.now()}`);
    made.push(a, b, c);
    await openChats(request, [a, b, c]);
    await gotoApp(page);
    const ids = [a.id, b.id, c.id];
    await expect.poll(() => shownOrder(page, ids).then((o) => o.length), { timeout: 10_000 }).toBe(3);

    const before = await shownOrder(page, ids);
    const last = before[2];
    const first = before[0];
    // The order reaches the server with the sidebar state, a second after the
    // drag: the reload waits for that write, not for a clock.
    const saved = page.waitForResponse((r) => r.url().includes("/api/ui-state/sidebar-state") && r.request().method() === "PUT");
    // Drop on the top edge of the first row: the last one goes above it. The
    // gesture is HTML5 events on one DataTransfer, as in drag-preview.spec.ts:
    // the system drag through the remote browser sometimes never delivered the
    // drop, and a red that measures the harness says nothing about the list.
    const source = row(page, last);
    const target = row(page, first);
    const dt = await page.evaluateHandle(() => new DataTransfer());
    const at = async (l: Locator, fy: number) => {
      const box = (await l.boundingBox())!;
      return { clientX: box.x + 40, clientY: box.y + box.height * fy };
    };
    await source.dispatchEvent("dragstart", { dataTransfer: dt, ...(await at(source, 0.5)) });
    await target.dispatchEvent("dragenter", { dataTransfer: dt, ...(await at(target, 0.1)) });
    await target.dispatchEvent("dragover", { dataTransfer: dt, ...(await at(target, 0.1)) });
    await expect(page.getByTestId("order-drop-line")).toBeVisible();
    await target.dispatchEvent("drop", { dataTransfer: dt, ...(await at(target, 0.1)) });
    await source.dispatchEvent("dragend", { dataTransfer: dt });
    const expected = [last, before[0], before[1]];
    await expect.poll(() => shownOrder(page, ids), { timeout: 5_000 }).toEqual(expected);
    await saved;

    await page.reload();
    await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => shownOrder(page, ids), { timeout: 10_000 }).toEqual(expected);
  });
});

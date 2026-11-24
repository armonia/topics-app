/**
 * THE SPLIT, REDONE FROM ZERO: one vocabulary on every surface and from every
 * source (openspec/changes/archive/2026-11-24-split-da-zero).
 *
 * Measured broken on 24/11 with the tabs at the side (the default): a row of
 * the column could not split at all, the drop preview was an empty tint, a
 * split cell said neither what it held nor who had the focus, the dividers
 * were mouse-only and a project row could not tell a divided window from a
 * single pane. Each scenario below is one of those, done the way a person does
 * it: a drag, a menu, a key.
 *
 * @covers SPLIT-01 @covers SPLIT-02 @covers SPLIT-03 @covers SPLIT-04 @covers SPLIT-05 @covers SPLIT-06 @covers SPLIT-07
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
// The tabs at the side, the default a person gets: the suite runs with both
// strips on (`both`), where a cell keeps its tab bar and has no title.
test.use({
  viewport: { width: 1440, height: 900 },
  storageState: { cookies: [], origins: [{ origin: E2E_BASE, localStorage: [{ name: "app-settings", value: JSON.stringify({ tabsPosition: "side" }) }] }] },
});

const cells = (page: Page) => page.locator("[data-split-card]");
const row = (page: Page, name: string) => page.locator(`[role="treeitem"][aria-label="${name}"]`).first();

/** The row menu's Layout level, then one side. */
async function openBeside(page: Page, name: string, side: RegExp): Promise<void> {
  await row(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^(Disposizione|Layout)$/ }).click();
  await page.getByRole("menuitem", { name: side }).click();
}

/** The title of every cell, left to right then top to bottom. */
async function cellTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-split-card]")]
    .map((el) => ({ r: el.getBoundingClientRect(), t: el.querySelector('[data-testid="mobile-pane-title"]')?.textContent?.trim() ?? "" }))
    .filter((c) => c.r.width > 0)
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
    .map((c) => c.t));
}

/** N painted frames: the observers' chain (measure, setState, render) settles inside them. */
async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate((k) => new Promise<void>((done) => {
    const step = (left: number): void => { if (left > 0) requestAnimationFrame(() => step(left - 1)); else done(); };
    step(k);
  }), n);
}

/** Three cells side by side, built the way SPLIT-05 proves: from the row menu. */
async function threeCells(page: Page, request: APIRequestContext, [a, b, c]: Array<{ id: string; name: string }>): Promise<void> {
  await resetPaneStore(request, [a.id, b.id, c.id]);
  await goToApp(page);
  await expect(row(page, c.name)).toBeVisible({ timeout: 20_000 });
  await openBeside(page, b.name, /^(Apri a destra|Open on the right)$/);
  await expect(cells(page)).toHaveCount(2, { timeout: 10_000 });
  await openBeside(page, c.name, /^(Apri a sinistra|Open on the left)$/);
  await expect(cells(page)).toHaveCount(3, { timeout: 10_000 });
}

test.describe("split, from zero", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  const made: Array<{ id: string; name: string }> = [];
  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    for (const n of ["Alfa", "Beta", "Gamma"]) made.push(await createTopic(request, `split-${n}-${stamp}`));
  });
  test.afterAll(async ({ request }) => {
    for (const t of made) await deleteTopic(request, t.id).catch(() => {});
  });

  test("SPLIT-05: a row opens beside, on every side, from its menu", async ({ page, request }) => {
    const [a, b, c] = made;
    await resetPaneStore(request, [a.id, b.id, c.id]);
    await goToApp(page);
    await expect(row(page, b.name)).toBeVisible({ timeout: 20_000 });
    await expect(cells(page)).toHaveCount(1);

    await openBeside(page, b.name, /^(Apri a destra|Open on the right)$/);
    await expect(cells(page)).toHaveCount(2, { timeout: 10_000 });
    await expect.poll(async () => (await cellTitles(page)).at(-1)).toContain(b.name);

    await openBeside(page, c.name, /^(Apri a sinistra|Open on the left)$/);
    await expect(cells(page)).toHaveCount(3, { timeout: 10_000 });
    await expect.poll(async () => (await cellTitles(page))[0]).toContain(c.name);
  });

  test("SPLIT-03: a split cell says what it holds and which one has the focus", async ({ page, request }) => {
    await threeCells(page, request, made);
    const handles = page.getByTestId("cell-title-handle");
    await expect(handles).toHaveCount(3);
    await expect(handles.first()).toHaveAttribute("draggable", "true");

    // Clicking a cell lights its title, and only its.
    await handles.nth(1).click();
    await expect(page.locator('[data-cell-lit="true"]')).toHaveCount(1);
    const litTitle = await page.locator('[data-cell-lit="true"] [data-testid="cell-title-handle"]').textContent();
    expect(litTitle).toBe(await handles.nth(1).textContent());

    // Zoom and back from the title, without a sheet.
    const lit = page.locator('[data-cell-lit="true"]');
    await lit.getByTestId("cell-header-zoom").click();
    await expect(page.locator("[data-pane-zoom]")).toHaveCount(1, { timeout: 5_000 });
    await page.locator("[data-testid=\"cell-header-zoom\"]:visible").click();
    await expect(page.locator("[data-pane-zoom]")).toHaveCount(0, { timeout: 5_000 });
  });

  test("SPLIT-03b: a short narrow cell keeps its empty chat's greeting under its title", async ({ page, request }) => {
    // 768 wide, one column stacked: the starters wrap and the greeting used to
    // climb over the cell's title bar.
    const [a, b, c] = made;
    await page.setViewportSize({ width: 768, height: 1024 });
    await resetPaneStore(request, [a.id, b.id, c.id]);
    await goToApp(page);
    await expect(row(page, c.name)).toBeVisible({ timeout: 20_000 });
    await openBeside(page, b.name, /^(Apri a destra|Open on the right)$/);
    await expect(cells(page)).toHaveCount(2, { timeout: 10_000 });
    await openBeside(page, c.name, /^(Apri in basso|Open below)$/);
    await expect(cells(page)).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator('[data-testid="chat-empty-state"]:not([aria-hidden]):visible')).toHaveCount(3, { timeout: 10_000 });
    await frames(page, 4);
    const overlaps = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-split-card]")].flatMap((card) => {
      const greeting = card.querySelector<HTMLElement>('[data-testid="chat-empty-state"]:not([aria-hidden])');
      const title = card.querySelector<HTMLElement>('[data-testid="mobile-pane-title"]');
      if (!greeting || !title) return [];
      const under = greeting.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      return under < 0 ? [`${title.textContent?.trim()}: ${Math.round(under)}px`] : [];
    }));
    expect(overlaps, "a greeting climbs over its cell's title").toEqual([]);
    // The narrowest cell's empty field stays one line: its placeholder used to
    // wrap and make it two lines tall. Two steps of the divider take the right
    // column to about 205 px.
    const divider = page.locator('[data-split-divider][tabindex="0"]').first();
    await divider.focus();
    const share = Number(await divider.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(share + 8);
    await frames(page, 4);
    const fieldHeights = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-split-card] textarea")]
      .filter((ta) => ta.getBoundingClientRect().width > 0)
      .map((ta) => Math.round(ta.getBoundingClientRect().height)));
    expect(new Set(fieldHeights).size, `empty fields of different heights: ${fieldHeights.join(", ")}`).toBe(1);
  });

  test("SPLIT-04: a divider moves with the arrows and evens out with Enter", async ({ page, request }) => {
    await threeCells(page, request, made);
    const divider = page.locator('[data-split-divider][tabindex="0"]').first();
    await divider.focus();
    const axis = await divider.getAttribute("data-resize-axis");
    const before = Number(await divider.getAttribute("aria-valuenow"));
    await page.keyboard.press(axis === "col" ? "ArrowRight" : "ArrowDown");
    await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(before + 2);
    // Enter evens the band: three columns side by side, a third each.
    await page.keyboard.press("Enter");
    await expect.poll(async () => Math.abs(Number(await divider.getAttribute("aria-valuenow")) - 33)).toBeLessThanOrEqual(1);
  });

  test("SPLIT-06: ⌘⌥ + arrow walks the focus to the cell beside", async ({ page, request }) => {
    await threeCells(page, request, made);
    const handles = page.getByTestId("cell-title-handle");
    await handles.first().click();
    const first = await handles.first().textContent();
    await expect(page.locator('[data-cell-lit="true"] [data-testid="cell-title-handle"]')).toHaveText(first ?? "");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(page.locator('[data-cell-lit="true"] [data-testid="cell-title-handle"]')).not.toHaveText(first ?? "", { timeout: 5_000 });
  });

  test("SPLIT-01 + SPLIT-02: a row dragged to an edge splits, and the footprint names it", async ({ page, request }) => {
    const [a, b] = made;
    await resetPaneStore(request, [a.id, b.id]);
    await goToApp(page);
    await expect(row(page, b.name)).toBeVisible({ timeout: 20_000 });
    await expect(cells(page)).toHaveCount(1);

    const src = await row(page, b.name).boundingBox();
    const main = await cells(page).first().boundingBox();
    if (!src || !main) throw new Error("no geometry to drag on");
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2 + 12, src.y + src.height / 2 + 6, { steps: 4 });
    await page.mouse.move(main.x + main.width - 24, main.y + main.height / 2, { steps: 12 });

    // The footprint is the right half, and it carries the name of what lands.
    const footprint = page.locator('[data-grid-split-overlay="right"]');
    await expect(footprint).toBeVisible({ timeout: 5_000 });
    await expect(footprint.locator("[data-drop-label]")).toContainText(b.name);

    await page.mouse.up();
    await expect(cells(page)).toHaveCount(2, { timeout: 10_000 });
    await expect.poll(async () => (await cellTitles(page)).at(-1)).toContain(b.name);

    // Over ANOTHER cell's centre the preview is an outline of that cell, not a
    // second kind of tint. Released back on the column, nothing moves.
    const from = await row(page, a.name).boundingBox();
    const right = await cells(page).last().boundingBox();
    if (!from || !right) throw new Error("no geometry for the centre");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 6, { steps: 4 });
    // The pane body, above the composer (which takes drops of its own).
    await page.mouse.move(right.x + right.width / 2, right.y + right.height / 3, { steps: 12 });
    const centerOverlay = page.locator('[data-grid-split-overlay="center"]');
    await expect(centerOverlay).toBeVisible({ timeout: 5_000 });
    await expect(centerOverlay).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(centerOverlay.locator("[data-drop-label]")).toContainText(a.name);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(cells(page)).toHaveCount(2);
  });

  test("SPLIT-07: a project row maps the splits inside its window", async ({ page, request }) => {
    const projectPath = canonicalTmpDir("e2e-split-project");
    mkdirSync(projectPath, { recursive: true });
    const projectName = projectPath.split("/").pop()!;
    const stamp = Date.now();
    const one = await createTopic(request, `split-in-one-${stamp}`, { projectPath, provider: "claude-code" });
    const two = await createTopic(request, `split-in-two-${stamp}`, { projectPath, provider: "claude-code" });
    try {
      await resetPaneStore(request, []);
      await seedProjectPane(request, projectPath);
      await seedProjectInnerChats(request, projectPath, [one.id, two.id]);
      await goToApp(page);
      const project = projectRow(page, projectName);
      await expect(project).toBeVisible({ timeout: 20_000 });
      await expect(row(page, two.name)).toBeVisible({ timeout: 20_000 });

      await openBeside(page, two.name, /^(Apri a destra|Open on the right)$/);
      const map = project.locator("xpath=..").getByTestId("split-mini-map");
      await expect(map).toHaveCount(1, { timeout: 10_000 });
      await expect(map.locator(":scope > span > span")).toHaveCount(2);
    } finally {
      await deleteTopic(request, one.id).catch(() => {});
      await deleteTopic(request, two.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });
});

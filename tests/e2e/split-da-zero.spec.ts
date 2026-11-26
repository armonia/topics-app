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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedPaneStore, seedProjectInnerChats, seedProjectInnerPanes, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
// The tabs at the side, the default a person gets: the suite runs with both
// strips on (`both`), where a cell keeps its tab bar and has no title.
const SIDE_TABS = { cookies: [], origins: [{ origin: E2E_BASE, localStorage: [{ name: "app-settings", value: JSON.stringify({ tabsPosition: "side" }) }] }] };
test.use({ viewport: { width: 1440, height: 900 }, storageState: SIDE_TABS });

const cells = (page: Page) => page.locator("[data-split-card]");
/** A cell's title with the tabs at the side: the real tab of the surface in front, alone. */
const TITLE = '[data-testid="cell-title-tab"] [role="tab"]';
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
    .map((el) => ({ r: el.getBoundingClientRect(), t: el.querySelector('[data-testid="cell-title-tab"] [role="tab"]')?.textContent?.trim() ?? "" }))
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

/** The chat just opened takes the keyboard into its field, a frame after it
 *  lands: a focus given before that is taken away, and the next key is typed
 *  in the field. Wait for the LAST opened chat's field (the one before it took
 *  the focus first) before handing the focus to a divider. */
async function fieldHasFocus(page: Page, lastOpened: string): Promise<void> {
  const cell = cells(page).filter({ has: page.locator(TITLE).filter({ hasText: lastOpened }) });
  await expect(cell.locator("textarea:focus")).toHaveCount(1, { timeout: 5_000 });
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
    const handles = page.locator(TITLE);
    await expect(handles).toHaveCount(3);
    await expect(handles.first()).toHaveAttribute("draggable", "true");

    // Clicking a cell lights its title, and only its.
    await handles.nth(1).click();
    await expect(page.locator('[data-cell-lit="true"]')).toHaveCount(1);
    const litTitle = await page.locator(`[data-cell-lit="true"] ${TITLE}`).textContent();
    expect(litTitle).toBe(await handles.nth(1).textContent());

    // Zoom and back from the title, without a sheet.
    const lit = page.locator('[data-cell-lit="true"]');
    await lit.getByTestId("cell-header-zoom").click();
    await expect(page.locator("[data-pane-zoom]")).toHaveCount(1, { timeout: 5_000 });
    await page.locator("[data-testid=\"cell-header-zoom\"]:visible").click();
    await expect(page.locator("[data-pane-zoom]")).toHaveCount(0, { timeout: 5_000 });
  });

  test("SPLIT-03c: a cell remembered for a closed pane does not make a lone pane a split one", async ({ browser, request }) => {
    // 25/11: the saved layout still named a cell whose pane had been closed,
    // and the only pane on screen wore the lit focus line under its title.
    const [a, b] = made;
    await resetPaneStore(request, [a.id]);
    const layout = JSON.stringify({ gridRows: [{ itemKeys: [`solo:${b.id}`], widths: [1] }], gridRowHeights: [1], soloCells: [[b.id]] });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: { cookies: [], origins: [{ origin: E2E_BASE, localStorage: [
        { name: "app-settings", value: JSON.stringify({ tabsPosition: "side" }) },
        { name: "topics-panel-grid-layout:space:default", value: layout },
      ] }] },
    });
    const page = await ctx.newPage();
    await goToApp(page);
    await expect(row(page, a.name)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("textarea:visible").first()).toBeVisible({ timeout: 10_000 });
    await frames(page, 3);
    await expect(page.locator("[data-cell-lit]")).toHaveCount(0);
    // A lone pane's title drags too (25/11), but it carries no cell commands.
    await expect(page.getByTestId("cell-header-commands")).toHaveCount(0);
    // The remembered cell is still there: the case held, it was not pruned away.
    const kept = await page.evaluate(() => localStorage.getItem("topics-panel-grid-layout:space:default") ?? "");
    expect(kept).toContain(b.id);
    await ctx.close();
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
      const title = card.querySelector<HTMLElement>('[data-testid="cell-title-tab"] [role="tab"]');
      if (!greeting || !title) return [];
      const under = greeting.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      return under < 0 ? [`${title.textContent?.trim()}: ${Math.round(under)}px`] : [];
    }));
    expect(overlaps, "a greeting climbs over its cell's title").toEqual([]);
    // The narrowest cell's empty field stays one line: its placeholder used to
    // wrap and make it two lines tall. Two steps of the divider take the right
    // column to about 205 px.
    await fieldHasFocus(page, c.name);
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
    await fieldHasFocus(page, made[2].name);
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
    const handles = page.locator(TITLE);
    await handles.first().click();
    const first = await handles.first().textContent();
    await expect(page.locator(`[data-cell-lit="true"] ${TITLE}`)).toHaveText(first ?? "");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(page.locator(`[data-cell-lit="true"] ${TITLE}`)).not.toHaveText(first ?? "", { timeout: 5_000 });
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

  test("SPLIT-03d: a project's window shows only its title, which is its tab and drags into a split", async ({ page, request }) => {
    // 25/11: only the title on a project's window, the tab under the pointer on
    // the title, and the title is what drags into a split.
    const [a] = made;
    const projectPath = canonicalTmpDir("e2e-title-tab");
    mkdirSync(projectPath, { recursive: true });
    const projectName = projectPath.split("/").pop()!;
    // Three changes, so the git command on the title carries a badge.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=e2e@e.test", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "start");
    for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(`${projectPath}/${f}`, f);
    const inner = await createTopic(request, `title-tab-in-${Date.now()}`, { projectPath, provider: "claude-code" });
    const fill = (el: HTMLElement): number => {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? [];
      return m.length === 4 ? Number(m[3]) : m.length === 3 ? 1 : 0;
    };
    try {
      await resetPaneStore(request, [a.id]);
      await seedProjectPane(request, projectPath);
      await seedProjectInnerChats(request, projectPath, [inner.id]);
      await goToApp(page);
      const project = projectRow(page, projectName);
      await expect(project).toBeVisible({ timeout: 20_000 });
      await project.click();
      const win = page.getByTestId("project-window");
      await expect(win).toBeVisible({ timeout: 10_000 });
      const title = page.locator(TITLE).filter({ hasText: projectName });
      await expect(title).toBeVisible();
      // As on the window of 25/11: a chat open inside.
      await row(page, inner.name).click();
      await expect(win.locator("textarea:visible")).toHaveCount(1, { timeout: 10_000 });
      const tools = page.getByTestId("title-project-tools");
      // The column open: its commands stay on the title (25/11), the toggle says
      // it is open, and the column has no header repeating them.
      await expect(page.getByTestId("project-sidebar")).toBeVisible();
      await expect(tools.getByTestId("project-rail-button")).toHaveCount(3);
      await expect(tools.getByTestId("project-card")).toHaveAttribute("aria-expanded", "true");
      // Its sections are islands: each a rounded card, the column with no
      // ground or edge of its own.
      const column = await page.getByTestId("project-sidebar").evaluate((el) => {
        const s = getComputedStyle(el);
        const git = el.querySelector<HTMLElement>('[data-testid="project-sidebar-git-section"]');
        return { ground: s.backgroundColor, edge: s.borderRightWidth, radius: git ? getComputedStyle(git).borderTopLeftRadius : "" };
      });
      expect(column).toEqual({ ground: "rgba(0, 0, 0, 0)", edge: "0px", radius: "12px" });
      // A command on the open column opens or closes its section.
      const gitSection = page.getByTestId("project-sidebar-git-section");
      const gitOpen = await gitSection.evaluate((el) => el.clientHeight);
      await tools.getByTestId("project-rail-button").nth(1).click();
      await expect.poll(() => gitSection.evaluate((el) => el.clientHeight)).not.toBe(gitOpen);
      await tools.getByTestId("project-rail-button").nth(1).click();
      await expect.poll(() => gitSection.evaluate((el) => el.clientHeight)).toBe(gitOpen);
      await tools.getByTestId("project-card").click();
      await expect(page.getByTestId("project-sidebar")).toHaveCount(0);

      // No bar of its own: no tab of its chats, its commands on the title row.
      await expect(page.locator(`[role="tab"][data-pane-id="${inner.id}"]`)).toHaveCount(0);
      await expect(tools.getByTestId("project-card")).toBeVisible();
      await expect(tools.getByTestId("project-card")).toHaveAttribute("aria-expanded", "false");
      await expect(tools.getByTestId("project-rail-button").first()).toBeVisible();
      // The git badge hangs inside the bar, not cut by it (25/11).
      const badge = tools.getByTestId("project-rail-button").nth(1).locator("span.absolute");
      await expect(badge).toHaveText("3", { timeout: 15_000 });
      const cut = await badge.evaluate((b) => {
        const r = b.getBoundingClientRect();
        for (let p = b.parentElement; p; p = p.parentElement) {
          if (!getComputedStyle(p).overflow.includes("hidden")) continue;
          const q = p.getBoundingClientRect();
          if (r.bottom > q.bottom + 0.5 || r.top < q.top - 0.5 || r.right > q.right + 0.5) return p.className;
        }
        return null;
      });
      expect(cut, "badge cut by an ancestor").toBeNull();
      // The body starts under the title, with no empty band where the bar was.
      const gap = await page.evaluate((name) => {
        const handle = [...document.querySelectorAll<HTMLElement>('[data-testid="cell-title-tab"] [role="tab"]')].find((el) => el.textContent?.includes(name));
        const bar = handle?.closest<HTMLElement>(".pane-chrome-bar");
        const body = document.querySelector<HTMLElement>('[data-testid="project-window"] [data-pane-content]');
        if (!bar || !body) return Number.NaN;
        return body.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
      }, projectName);
      expect(Math.abs(gap), `band between title and body: ${gap}px`).toBeLessThan(2);

      // At rest a title; under the pointer the tab's fill.
      await page.mouse.move(700, 600);
      expect(await title.evaluate(fill)).toBe(0);
      await title.hover();
      await expect.poll(() => title.evaluate(fill)).toBeGreaterThan(0);
      await page.screenshot({ path: test.info().outputPath("project-title-hover-1440.png") });

      // No "+" on the title: the project's row in the column has it.
      await expect(page.locator(".pane-chrome-bar", { has: title }).getByTestId("pane-add-menu-trigger")).toHaveCount(0);

      // The title drags into a split: from the left of a chat to its right.
      await openBeside(page, a.name, /^(Apri a destra|Open on the right)$/);
      await expect(page.locator("[data-cell-lit]")).toHaveCount(2, { timeout: 10_000 });
      await expect.poll(async () => (await cellTitles(page)).filter(Boolean)[0]).toContain(projectName);
      const other = cells(page).filter({ has: page.locator(TITLE).filter({ hasText: a.name }) });
      const src = await title.boundingBox();
      const target = await other.boundingBox();
      if (!src || !target) throw new Error("no geometry to drag on");
      await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
      await page.mouse.down();
      await page.mouse.move(src.x + src.width / 2 + 12, src.y + src.height / 2 + 6, { steps: 4 });
      await page.mouse.move(target.x + target.width - 24, target.y + target.height / 2, { steps: 12 });
      await expect(page.locator('[data-grid-split-overlay="right"]')).toBeVisible({ timeout: 5_000 });
      await page.mouse.up();
      await expect.poll(async () => (await cellTitles(page)).filter(Boolean).at(-1)).toContain(projectName);
      await expect(page.locator("[data-cell-lit]")).toHaveCount(2);
      await page.screenshot({ path: test.info().outputPath("project-title-dragged-1440.png") });
    } finally {
      await deleteTopic(request, inner.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });

  test("SPLIT-03e: the title is the real tab, with everything a tab shows", async ({ page, request }) => {
    // 25/11: the title written by hand lost the browser's icon and commands and
    // the countdown of a close; the real tab carries them.
    // A topic of its own: this test lets a close run out.
    const a = await createTopic(request, `split-Title-${Date.now()}`);
    made.push(a);
    const browserId = `browser:title-tab-${Date.now()}`;
    const openedAt = Date.now();
    await page.routeWebSocket(/\/ws\/browser\//, () => {});
    await seedPaneStore(request, () => ({
      panes: {
        [a.id]: { id: a.id, type: "chat", topicId: a.id, title: a.name, openedAt },
        [browserId]: { id: browserId, type: "browser", url: "http://title-tab.test/page", openedAt },
      },
      groups: { "group:default": { id: "group:default", paneIds: [browserId, a.id], splitRatio: 1, splitAxis: "horizontal", activePaneId: browserId } },
      projects: {},
    }));
    await goToApp(page);
    const title = page.locator(TITLE);
    await expect(title).toHaveAttribute("data-pane-id", browserId, { timeout: 20_000 });
    await expect(page.getByTestId("panel-tab-bar")).toHaveCount(0);
    // The browser's tab: its site icon, its menu and its commands under the pointer.
    await title.hover();
    await expect(title.getByTestId("browser-tab-menu")).toBeVisible();
    await expect(title.locator(".tab-extras")).toHaveCount(1);
    // Its commands take their own room on the title: the address stays whole,
    // with no fade under them.
    const label = title.getByTestId("pane-tab-label");
    await expect.poll(() => label.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await expect(label).toHaveCSS("mask-image", "none");
    await page.screenshot({ path: test.info().outputPath("browser-title-hover-1440.png") });

    const pending = title.locator('.tab-slot-command[data-pending="true"]');
    // The browser's close counts down on the title too, and the browser stays
    // in front while it runs.
    await title.getByTestId("pane-tab-close").click();
    await expect(pending).toHaveCount(1);
    await expect(title).toHaveAttribute("data-pane-id", browserId);
    await title.getByTestId("pane-tab-close").click();
    await expect(pending).toHaveCount(0);

    // A chat in front: its close counts down ON THE TITLE. The front does not
    // jump to the next tab first (25/11: the title showed the browser and the
    // progress was nowhere), and a second click cancels it.
    await row(page, a.name).click();
    await expect(title).toHaveAttribute("data-pane-id", a.id);
    await title.hover();
    await title.getByTestId("pane-tab-close").click();
    await expect(pending).toHaveCount(1);
    await expect(title).toHaveAttribute("data-pane-id", a.id);
    await page.screenshot({ path: test.info().outputPath("chat-title-closing-1440.png") });
    await title.getByTestId("pane-tab-close").click();
    await expect(pending).toHaveCount(0);
    await expect(title).toHaveAttribute("data-pane-id", a.id);
    // Let it run out: the commit moves the front to the tab left.
    await title.hover();
    await title.getByTestId("pane-tab-close").click();
    await expect(title).toHaveAttribute("data-pane-id", a.id);
    await expect(title).toHaveAttribute("data-pane-id", browserId, { timeout: 10_000 });
  });

  test("SPLIT-03f: inside a project the browser in front is the title, and its page is an island", async ({ page, request, browser }) => {
    // 25/11, on a project's browser: the title on top was the project's tab and
    // the browser's tab was nowhere, and the page was a square slab against the
    // window's rounded corner.
    // Names that read like a real board in the photos (25/11, "not even in a
    // demo"): the run's uniqueness is in the parent folder, not in the name.
    const scratch = canonicalTmpDir("e2e-title-browser");
    const projectPath = join(scratch, "sito-vetrina");
    mkdirSync(projectPath, { recursive: true });
    const projectName = "sito-vetrina";
    const inner = await createTopic(request, "Revisione della home", { projectPath, provider: "claude-code" });
    const ctx = `title-in-project-${Date.now()}`;
    const browserId = `browser:${ctx}`;
    await page.routeWebSocket(/\/ws\/browser\//, () => {});
    try {
      await resetPaneStore(request, []);
      await seedProjectPane(request, projectPath);
      await seedProjectInnerPanes(request, projectPath, [
        { id: browserId, type: "browser", title: "gtm", titleSource: "user", url: "http://gtm.sito-vetrina.test/container" },
      ], [inner.id]);
      await goToApp(page);
      const project = projectRow(page, projectName);
      await expect(project).toBeVisible({ timeout: 20_000 });
      await project.click();
      await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10_000 });
      const title = page.locator(TITLE);
      const tools = page.getByTestId("title-project-tools");

      // A chat in front: the title stays the project's (approved 25/11).
      await row(page, inner.name).click();
      await expect(page.getByTestId("project-window").locator("textarea:visible")).toHaveCount(1, { timeout: 10_000 });
      await expect(title).toHaveCount(1);
      await expect(title).toHaveAttribute("data-pane-id", /^project:/);

      // The browser in front: the title is ITS tab, the project's commands stay
      // at the right of the same row.
      // The browser's row in the column, by the name it shows.
      await page.getByRole("tree").getByText("gtm", { exact: true }).click();
      await expect(page.locator(`[data-browser-pane="${ctx}"]`)).toBeVisible({ timeout: 10_000 });
      // The window at the widths a person uses, before anything is asserted and
      // each from a page of its own (a phone width folds the columns, and that
      // would follow the next width): the same photos come out of the bundle
      // before the change and after it.
      for (const width of [375, 768, 1440, 3440]) {
        // The project and its browser in front are the saved state: the page
        // comes back to them by itself.
        const shot = await browser.newPage({ baseURL: E2E_BASE, viewport: { width, height: 900 }, storageState: SIDE_TABS });
        await shot.routeWebSocket(/\/ws\/browser\//, () => {});
        await goToApp(shot);
        await expect(shot.locator(`[data-browser-pane="${ctx}"]`)).toBeVisible({ timeout: 10_000 });
        await frames(shot, 6);
        await shot.screenshot({ path: test.info().outputPath(`project-browser-${width}.png`) });
        await shot.close();
      }
      await expect(title).toHaveAttribute("data-pane-id", browserId, { timeout: 10_000 });
      await expect(title).toHaveCount(1);
      await expect(title.getByTestId("pane-tab-label")).toHaveText(/gtm/);
      await expect(tools.getByTestId("project-card")).toBeVisible();
      const [t, k] = await Promise.all([title.boundingBox(), tools.boundingBox()]);
      if (!t || !k) throw new Error("no geometry for the title row");
      // 25/11, the owner: "the tab in the top bar should be bigger, now it is
      // tiny". A row's height, at least as wide as the active browser tab of a
      // strip (300), and the address beside the name, always on.
      expect(Math.round(t.height), "the title tab is a row tall").toBe(34);
      expect(t.width, "the title tab is as wide as an active browser tab").toBeGreaterThanOrEqual(300);
      // As a strip shows it (`prettyUrl`): https is dropped, http is said.
      await expect(title.getByTestId("cell-title-tab-address")).toHaveText("http://gtm.sito-vetrina.test/container");
      expect(Math.abs((t.y + t.height / 2) - (k.y + k.height / 2)), "title and project commands on one row").toBeLessThan(2);
      expect(k.x, "the project commands at the right of the title").toBeGreaterThan(t.x + t.width);
      // Its menu and commands under the pointer, as on a cell's title.
      await title.hover();
      await expect(title.getByTestId("browser-tab-menu")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("project-browser-title-1440.png") });
      // Its close counts down on the title, and the browser stays in front.
      const pending = title.locator('.tab-slot-command[data-pending="true"]');
      await title.getByTestId("pane-tab-close").click();
      await expect(pending).toHaveCount(1);
      await expect(title).toHaveAttribute("data-pane-id", browserId);
      await title.getByTestId("pane-tab-close").click();
      await expect(pending).toHaveCount(0);
      await expect(title).toHaveAttribute("data-pane-id", browserId);

      // The page is an island: off the window's edges by the islands' gap, its
      // four corners rounded to the window's radius less that gap (16 − 6).
      await page.mouse.move(700, 600);
      const shape = await page.getByTestId("browser-island").evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const islands = [...document.querySelectorAll<HTMLElement>('[data-testid="project-sidebar"] [data-section-island]')]
          .map((i) => i.getBoundingClientRect()).filter((b) => b.height > 0);
        return {
          radii: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius],
          clips: s.overflow,
          declared: el.getAttribute("data-native-card-radius"),
          right: Math.round(window.innerWidth - r.right),
          bottom: Math.round(window.innerHeight - r.bottom),
          gapToIslands: Math.round(r.left - Math.max(...islands.map((b) => b.right))),
          topVsIslands: Math.round(r.top - Math.min(...islands.map((b) => b.top))),
          bottomVsIslands: Math.round(r.bottom - Math.max(...islands.map((b) => b.bottom))),
        };
      });
      expect(shape).toEqual({
        radii: ["10px", "10px", "10px", "10px"], clips: "hidden", declared: "10",
        right: 6, bottom: 6, gapToIslands: 6, topVsIslands: 0, bottomVsIslands: 0,
      });
    } finally {
      await deleteTopic(request, inner.id).catch(() => {});
      removeTmpDir(scratch);
    }
  });

  test("SPLIT-03g: rows, island headers and the foot share one height and spacing, and no ground at rest", async ({ page, request, browser }) => {
    // 25/11: everything consistent, the island headers' heights and spacings
    // like the tabs' and like the user and Sistema buttons', and none of them
    // with a background unless it is active in some way, as the tabs.
    const scratch = canonicalTmpDir("e2e-row-grammar");
    const projectPath = join(scratch, "gestionale-ordini");
    mkdirSync(projectPath, { recursive: true });
    const projectName = "gestionale-ordini";
    const inner = await createTopic(request, "Bozza del preventivo", { projectPath, provider: "claude-code" });
    // A second chat of the project, closed from its row for the photo of a
    // closed tab under the pointer.
    const releaseNotes = await createTopic(request, "Note di rilascio", { projectPath, provider: "claude-code" });
    const NONE = "rgba(0, 0, 0, 0)";
    try {
      await resetPaneStore(request, []);
      await seedProjectPane(request, projectPath);
      await seedProjectInnerChats(request, projectPath, [inner.id, releaseNotes.id]);
      await goToApp(page);
      const project = projectRow(page, projectName);
      await expect(project).toBeVisible({ timeout: 20_000 });
      await project.click();
      await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10_000 });
      const processes = page.getByTestId("project-sidebar-processes");
      await expect(processes).toBeVisible({ timeout: 10_000 });
      if ((await processes.getAttribute("aria-expanded")) === "true") await processes.click();
      await expect(processes).toHaveAttribute("aria-expanded", "false");

      // The photos first, from pages of their own, so the bundle before the
      // change gives the same ones. The phone's Board row is read there too.
      let phoneBoard: { h: number; ground: string } | null = null;
      for (const width of [375, 1440]) {
        const shot = await browser.newPage({ baseURL: E2E_BASE, viewport: { width, height: 900 }, storageState: SIDE_TABS });
        await goToApp(shot);
        const board = shot.getByTestId("sidebar-board-generale");
        await expect(board).toBeVisible({ timeout: 15_000 });
        if (width > 768) await expect(shot.getByTestId("project-sidebar-processes")).toBeVisible({ timeout: 10_000 });
        await shot.mouse.move(width - 2, 899);
        await frames(shot, 12);
        await shot.screenshot({ path: test.info().outputPath(`rows-${width}.png`) });
        if (width === 1440) {
          // A closed tab under the pointer (25/11: "on hover the ground should
          // appear for all of them"): closed from its row, the pointer leaves
          // and comes back.
          const notes = shot.getByRole("treeitem", { name: releaseNotes.name });
          await notes.hover();
          await notes.getByTestId("topic-row-close").click();
          await expect(notes).toHaveAttribute("data-tab-state", "closed", { timeout: 15_000 });
          await shot.mouse.move(width - 2, 899);
          await notes.hover();
          await frames(shot, 12);
          await shot.screenshot({ path: test.info().outputPath("rows-1440-closed-hover.png") });
        }
        if (width === 375) {
          phoneBoard = await board.evaluate((el) => ({ h: Math.round(el.getBoundingClientRect().height), ground: getComputedStyle(el).backgroundColor }));
        }
        await shot.close();
      }
      expect(phoneBoard, "on the phone the Board row is a row: 44 high, no ground at rest").toEqual({ h: 44, ground: NONE });

      type Box = { h: number; pl: string; pr: string; ground: string } | null;
      const measure = () => page.evaluate((chat) => {
        const box = (el: Element | null | undefined) => {
          if (!el) return null;
          const s = getComputedStyle(el);
          return { h: Math.round(el.getBoundingClientRect().height), pl: s.paddingLeft, pr: s.paddingRight, ground: s.backgroundColor };
        };
        const q = (sel: string) => document.querySelector(sel);
        const proc = q('[data-testid="project-sidebar-processes"]');
        return {
          tab: box(q(`[role="treeitem"][aria-label="${chat}"]`)),
          board: box(q('[data-testid="sidebar-board-generale"]')),
          system: box(q('[data-testid="sidebar-system"]')),
          me: box(q('[data-testid="identity-me-profile"]')),
          header: box(proc),
          island: box(proc?.closest("[data-section-island]")),
        };
      }, inner.name) as Promise<Record<string, Box>>;
      const row = (ground: string) => ({ h: 34, pl: "8px", pr: "8px", ground });
      // Pointer parked on the page, colours settled (`transition-colors`).
      await page.mouse.move(900, 500);
      await expect.poll(measure, { timeout: 5_000 }).toEqual({
        // The reference: an open tab has its ground, it is active.
        tab: { ...row(NONE), ground: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/) },
        board: row(NONE), system: row(NONE), me: row(NONE), header: row(NONE),
        // A closed island is only its header: no ground of its own either.
        island: { h: 34, pl: "0px", pr: "0px", ground: NONE },
      });

      // Active in some way: an open island is the card, the header stays a
      // row on its ground; the user's row while its menu is open.
      await processes.click();
      await page.mouse.move(900, 500);
      await expect.poll(async () => {
        const m = await measure();
        return { island: m.island?.ground !== NONE, header: m.header?.ground };
      }, { timeout: 5_000 }).toEqual({ island: true, header: NONE });
      await processes.click();
      await page.getByTestId("identity-me-profile").click();
      await page.mouse.move(900, 500);
      await expect.poll(async () => (await measure()).me?.ground, { timeout: 5_000 }).not.toBe(NONE);
      // The menu is lazy: an Escape sent before it mounts is lost, and the
      // next outside click (the bell, below) would only close it, eaten by
      // `useDismissable`. Wait for it, and for it to be gone.
      await expect(page.getByTestId("profile-menu")).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("profile-menu")).toHaveCount(0);

      // The sidebar's buttons are tabs (25/11, the owner: "all the
      // notification and sidebar buttons [must] have the tabs' behaviour, size
      // and colours"): a row tall, no ground at rest, the hover ground under
      // the pointer, an open tab's ground while their panel is open. And the
      // column's toggle sits before the bell, the content's own gone while the
      // column is open.
      const HEAD = '[aria-label="Topics sidebar"] .sidebar-header';
      const buttons = {
        toggle: `${HEAD} [data-testid="sidebar-collapse"]`,
        bell: `${HEAD} [data-testid="inbox-button"]`,
        search: `${HEAD} [aria-label="Search, open the command palette"]`,
        add: `${HEAD} [data-testid="pane-add-menu-trigger"]`,
      };
      const look = () => page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, sel]) => {
        const el = document.querySelector(sel)!;
        const r = el.getBoundingClientRect();
        return [k, { h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), ground: getComputedStyle(el).backgroundColor }];
      })), buttons) as Promise<Record<keyof typeof buttons, { h: number; left: number; right: number; ground: string }>>;
      await page.mouse.move(900, 500);
      const atRest = await expect.poll(look, { timeout: 5_000 }).toMatchObject({
        toggle: { h: 34, ground: NONE }, bell: { h: 34, ground: NONE }, search: { h: 34, ground: NONE }, add: { h: 34, ground: NONE },
      }).then(look);
      expect(atRest.toggle.right, "the column's toggle comes before the bell").toBeLessThanOrEqual(atRest.bell.left);
      await expect(page.getByTestId("sidebar-reopen")).toBeHidden();
      for (const k of Object.keys(buttons) as (keyof typeof buttons)[]) {
        await page.locator(buttons[k]).hover();
        await expect.poll(async () => (await look())[k].ground, { message: `${k} under the pointer` }).not.toBe(NONE);
      }
      await page.locator(buttons.bell).click();
      await expect(page.getByTestId("inbox-panel")).toBeVisible();
      await page.mouse.move(900, 500);
      await expect.poll(async () => (await look()).bell.ground, { message: "the bell while its panel is open" }).not.toBe(NONE);
      await page.keyboard.press("Escape");
    } finally {
      await deleteTopic(request, inner.id).catch(() => {});
      await deleteTopic(request, releaseNotes.id).catch(() => {});
      removeTmpDir(scratch);
    }
  });
});

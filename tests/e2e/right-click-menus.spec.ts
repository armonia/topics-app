/**
 * THE RIGHT-CLICK, SURFACE BY SURFACE (CTXMENU-01).
 *
 * Where the app has commands for an element, the right-click opens the app's
 * menu on the shared cursor menu; where it has none, the system menu stays.
 * Each surface below is driven with a real right-click and asserted on the
 * whole contract, not on "a menu appeared":
 *
 *  - the `contextmenu` event is `defaultPrevented` exactly where a menu of
 *    ours opens (read on `window`, after React's root listener: that is what
 *    decides whether WebKit draws its own menu), and NOT on the composer;
 *  - one menu, inside the viewport, and flipped to the other side of the
 *    pointer when opened near the bottom-right corner;
 *  - a right-click ON the open menu does not ask for the system menu on top,
 *    except on text selected inside it (a diff, a console log), where the
 *    system menu is the only way to Copy;
 *  - Esc and an outside press close it, and the focus goes back to the
 *    element that was right-clicked;
 *  - Shift+F10 on the focused element opens the same menu.
 *
 * @covers CTXMENU-01
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectInnerPanes, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, initGitRepo, removeTmpDir } from "./helpers/file-project";
import { projectRowSelector } from "./fixtures/file-explorer.fixture";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";

hermetic(test);

declare global {
  interface Window {
    __ctx?: boolean[];
  }
}

/**
 * Every `contextmenu` dispatched in the page, as its `defaultPrevented` once
 * the dispatch is over: that is what decides whether WebKit draws its own menu.
 * Caught in the CAPTURE phase on `window`, so a handler that stops the
 * propagation (a menu panel, the tab, the file row) cannot hide it, and read
 * one task later, when every listener has had its say.
 */
async function recordContextMenus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__ctx = [];
    window.addEventListener("contextmenu", (e) => {
      // Only a TRUSTED event can raise the system menu; the ones the app
      // synthesizes itself (long press, Shift+F10) never do.
      if (e.isTrusted) setTimeout(() => window.__ctx!.push(e.defaultPrevented), 0);
    }, true);
  });
}

async function takeContextMenus(page: Page): Promise<boolean[]> {
  return page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 0));
    const seen = window.__ctx ?? [];
    window.__ctx = [];
    return seen;
  });
}

/** True when the focus is on `target` or inside it. */
async function focusIsOn(target: Locator): Promise<boolean> {
  return target.evaluate((el) => !!document.activeElement && (el === document.activeElement || el.contains(document.activeElement)));
}

async function expectInsideViewport(page: Page, menu: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const vp = page.viewportSize()!;
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  return box;
}

interface Exercise {
  /** Where the focus must be after Esc. Default: the right-clicked element. */
  focusBack?: Locator;
  /** The element to focus for Shift+F10. Default: the right-clicked element. */
  keyboard?: Locator | null;
  /** The menu opens at the pointer (true) or under its anchor (false). */
  atPointer?: boolean;
}

/** The whole contract on one surface. */
async function exerciseMenu(page: Page, target: Locator, opts: Exercise = {}): Promise<void> {
  const { focusBack = target, keyboard = target, atPointer = true } = opts;
  const menu = page.getByRole("menu");
  const vp = page.viewportSize()!;
  await takeContextMenus(page);

  // A right-click: our menu, and the system's is turned down.
  await target.click({ button: "right" });
  await expect(menu).toHaveCount(1);
  expect(await takeContextMenus(page)).toEqual([true]);
  await expectInsideViewport(page, menu);

  // A right-click ON our menu does not stack the system menu over it.
  const panelBox = (await menu.boundingBox())!;
  await page.mouse.click(panelBox.x + panelBox.width / 2, panelBox.y + 3, { button: "right" });
  expect(await takeContextMenus(page)).toEqual([true]);
  await expect(menu).toHaveCount(1);

  // Esc closes it and the focus is back where the gesture came from.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => focusIsOn(focusBack)).toBe(true);

  // An outside press closes it. Dispatched on <body>: any real point on screen
  // would also activate whatever sits there, which is not what is under test.
  // The whole press, click included: the press that closes a menu eats the
  // click that follows it (lib/outsidePress), and a press without its click
  // would leave that guard armed for the next real click of the test.
  await target.click({ button: "right" });
  await expect(menu).toHaveCount(1);
  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await expect(menu).toHaveCount(0);

  if (atPointer) {
    // Near the bottom-right corner the menu opens to the LEFT of and ABOVE the
    // pointer, instead of being slid back under it. 30px from each edge: no
    // menu of the app fits in there, and a clamp would end it at the 8px
    // margin, past the pointer.
    const at = { x: vp.width - 30, y: vp.height - 30 };
    // A real MouseEvent at that point: Playwright's `dispatchEvent` builds a
    // plain Event for this type, without coordinates.
    await target.evaluate((el, p) => {
      el.dispatchEvent(new MouseEvent("contextmenu", { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
    }, at);
    await expect(menu).toHaveCount(1);
    const box = await expectInsideViewport(page, menu);
    expect(box.x + box.width).toBeLessThanOrEqual(at.x + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(at.y + 1);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }

  if (keyboard) {
    // Shift+F10 on the focused element opens the same menu, and Esc gives the focus back.
    await keyboard.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toHaveCount(1);
    await expectInsideViewport(page, menu);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => focusIsOn(keyboard)).toBe(true);
  }
}

test.describe("Right-click across the app (CTXMENU-01)", () => {
  const projectDir = canonicalTmpDir(`e2e-rclick-${process.pid}`);
  const stamp = Date.now();
  const nameA = `RCLICK-A-${stamp}`;
  const nameB = `RCLICK-B-${stamp}`;
  let topicId = "";
  let otherId = "";
  let projectTopicId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(`${projectDir}/src`, { recursive: true });
    writeFileSync(`${projectDir}/README.md`, "# right click\n");
    writeFileSync(`${projectDir}/src/index.ts`, "export const x = 1;\n");
    initGitRepo(projectDir);
    topicId = (await createTopic(request, nameA)).id;
    otherId = (await createTopic(request, nameB)).id;
    projectTopicId = (await createTopic(request, `RCLICK-P-${stamp}`, { projectPath: projectDir })).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [topicId, otherId, projectTopicId]) if (id) await deleteTopic(request, id).catch(() => {});
    removeTmpDir(projectDir);
  });

  async function openApp(page: Page, panes: string[]) {
    await recordContextMenus(page);
    await resetPaneStore(page.request, panes);
    await goToApp(page);
    await expect(page.locator(`[data-pane-id="${panes[0]}"]`).first()).toBeVisible({ timeout: 10_000 });
  }

  test("RC-01 sidebar topic row: the app menu, flipped at the edge, focus back on the row, Shift+F10", async ({ page }) => {
    await openApp(page, [topicId, otherId]);
    const row = page.getByLabel("Topics sidebar").getByRole("treeitem", { name: nameA, exact: true }).first();
    await expect(row).toBeVisible();
    await exerciseMenu(page, row);

    // One at a time: a second row's menu replaces the first.
    const other = page.getByLabel("Topics sidebar").getByRole("treeitem", { name: nameB, exact: true }).first();
    await row.click({ button: "right" });
    await other.click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(1);
    await expect(page.getByRole("menu")).toHaveAttribute("aria-label", new RegExp(nameB));
    await page.keyboard.press("Escape");
  });

  /** The app with the project's window open, and its row in the sidebar. */
  async function openProject(page: Page, innerPanes: Array<{ id: string; type: string; title: string }> = []) {
    await recordContextMenus(page);
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, projectDir);
    if (innerPanes.length > 0) await seedProjectInnerPanes(page.request, projectDir, innerPanes);
    await seedProjectPane(page.request, projectDir).catch(() => {});
    await goToApp(page);
    const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
    if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
      await projectsSection.click();
    }
    const row = page.locator(projectRowSelector(projectDir)).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    return row;
  }

  test("RC-02 sidebar project row", async ({ page }) => {
    const row = await openProject(page);
    await exerciseMenu(page, row);
  });

  test("RC-03 sidebar board row", async ({ page }) => {
    await openApp(page, [topicId]);
    const row = page.getByTestId("sidebar-board-generale");
    await expect(row).toBeVisible();
    await exerciseMenu(page, row);
  });

  test("RC-04 pane tab: the menu opens under the tab and the focus goes back where it was", async ({ page }) => {
    await openApp(page, [topicId, otherId]);
    const tab = page.locator(`[role="tab"][data-pane-id="${topicId}"]`).first();
    await expect(tab).toBeVisible();
    // A tab is not a focus stop (clicking one would light the bar's
    // focus-within reveal), so the focus returns to what held it before the
    // right-click: the composer.
    const composer = page.getByTestId("chat-message-input").first();
    await composer.focus();
    await exerciseMenu(page, tab, { focusBack: composer, keyboard: null, atPointer: false });
    const tabBox = (await tab.boundingBox())!;
    await tab.click({ button: "right" });
    const menuBox = (await page.getByRole("menu").boundingBox())!;
    expect(menuBox.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height - 1);
    await page.keyboard.press("Escape");
  });

  test("RC-05 sidebar group header", async ({ page }) => {
    await openApp(page, [topicId, otherId]);
    await page.locator(`[role="tab"][data-pane-id="${otherId}"]`).first().click({ button: "right" });
    await page.getByText("Sposta nel gruppo", { exact: true }).click();
    await page.getByRole("menu").getByRole("button", { name: "Nuovo gruppo" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    const header = page.locator('[data-testid="space-row"], [data-testid="space-row-active"]').first();
    await expect(header).toBeVisible({ timeout: 10_000 });
    // The header is a strip of two buttons (chevron, name): the name is what
    // the pointer lands on and what the focus comes back to.
    const name = header.locator("button").nth(1);
    await exerciseMenu(page, name);
    await expect(page.getByTestId("space-menu")).toHaveCount(0);
  });

  test("RC-06 file tree row, and Shift+F10 on the tree opens the current row's menu", async ({ page }) => {
    await (await openProject(page)).click();
    const tree = page.locator('[data-testid="file-tree"]').first();
    await expect(tree).toBeVisible({ timeout: 15_000 });
    const readme = tree.getByRole("treeitem", { name: /README\.md/ });
    await expect(readme).toBeVisible({ timeout: 10_000 });
    await exerciseMenu(page, readme, { keyboard: null });

    // The tree keeps the focus on itself and walks its rows with the arrows.
    await tree.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toHaveCount(1);
    await expectInsideViewport(page, page.getByRole("menu"));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("RC-08 editor tab: the file tab has its own menu", async ({ page }) => {
    // The full file explorer (a "files" tab inside the project) has its own
    // editor strip; the sidebar's compact tree opens files as project tabs.
    await (await openProject(page, [{ id: "files:rclick", type: "files", title: "Files" }])).click();
    const tree = page.locator('[data-testid="file-tree"]').last();
    await expect(tree).toBeVisible({ timeout: 15_000 });
    await tree.getByRole("treeitem", { name: /README\.md/ }).click();
    const tab = page.locator('[data-editor-tab$="README.md"]').first();
    await expect(tab).toBeVisible({ timeout: 10_000 });
    // The tab is not a focus stop; its close button is, and the key opens the
    // tab's menu from there. After a right-click the focus goes back to what
    // held it: the tree.
    await tree.focus();
    await exerciseMenu(page, tab, { focusBack: tree, keyboard: tab.getByRole("button", { name: /README\.md/ }) });
    await tab.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Copy path" }).or(page.getByRole("menuitem", { name: "Copia percorso" }))).toBeVisible();
    await page.getByRole("menuitem", { name: /^(Close|Chiudi)$/ }).click();
    await expect(tab).toHaveCount(0);
  });

  test("RC-07 the composer keeps the system menu, and no menu of ours opens", async ({ page }) => {
    await openApp(page, [topicId]);
    const composer = page.getByTestId("chat-message-input").first();
    await expect(composer).toBeVisible();
    await composer.fill("text to copy");
    await takeContextMenus(page);
    await composer.click({ button: "right" });
    expect(await takeContextMenus(page)).toEqual([false]);
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Nor from the keyboard: in a text field the key is the system's.
    await composer.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

test.describe("Right-click on text inside a menu panel (CTXMENU-01)", () => {
  const repo = canonicalTmpDir(`e2e-rclick-diff-${process.pid}`);
  const projectId = projectIdForPath(repo);
  const stamp = Date.now();
  let topicId = "";
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(repo, { recursive: true });
    writeFileSync(`${repo}/README.md`, "# diff\n");
    initGitRepo(repo);
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@test", "-c", "commit.gpgsign=false", "-C", repo, ...a], { encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", `topics/rclick-${stamp}`);
    mkdirSync(`${repo}/src`, { recursive: true });
    writeFileSync(`${repo}/src/only.ts`, "export const COPYMEDIFF = 'line in the diff';\n");
    git("add", "-A");
    git("commit", "-q", "-m", "delivery");
    const commit = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    topicId = (await createTopic(request, `RCLICK-D-${stamp}`, { projectPath: repo })).id;
    const created = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: { text: "right-click on the diff", status: "review" } });
    expect(created.ok(), `create task ${created.status()}`).toBe(true);
    taskId = ((await created.json()) as { id: string }).id;
    const delivered = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/delivery`, {
      data: { branch: `topics/rclick-${stamp}`, commit, filesChanged: 1, insertions: 1, deletions: 0 },
    });
    expect(delivered.ok(), `delivery ${delivered.status()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, projectId, taskId).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    removeTmpDir(repo);
  });

  /** The centre of `needle` as laid out inside `root`. */
  async function textPoint(root: Locator, needle: string, select: boolean): Promise<{ x: number; y: number }> {
    const p = await root.evaluate((el, a) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = (n.textContent ?? "").indexOf(a.needle);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + a.needle.length);
        if (a.select) {
          const s = window.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
        }
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    }, { needle, select });
    expect(p, `"${needle}" on screen`).not.toBeNull();
    return p!;
  }

  test("RC-09 the task's changes panel: selected diff text keeps the system menu, its commands do not", async ({ page }) => {
    await recordContextMenus(page);
    await resetPaneStore(page.request, []);
    await page.goto(`/task/${taskId}`);
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await drawer.getByTestId("task-delivery-toggle").click();
    await drawer.getByTestId("task-changes-trigger").click();
    const panel = page.getByTestId("task-changes-panel");
    await expect(panel).toContainText("COPYMEDIFF", { timeout: 20_000 });
    await takeContextMenus(page);

    // A command of the panel (the file header) is still the panel's: no
    // system menu over it, even though WebKit selects the word under a
    // right-click.
    const header = await textPoint(panel.getByTestId("diff-file").locator("button").first(), "only.ts", false);
    await page.mouse.click(header.x, header.y, { button: "right" });
    expect(await takeContextMenus(page)).toEqual([true]);
    await expect(panel).toBeVisible();

    // A diff line, selected: the system menu (Copy) opens, the panel stays,
    // and the row behind the portal does not open a menu of its own. Last: in
    // WebKit a right-click after the system menu opened dispatched no
    // `contextmenu` at all (measured when this step came first).
    const line = await textPoint(panel, "COPYMEDIFF", true);
    expect(await page.evaluate(() => String(window.getSelection()))).toBe("COPYMEDIFF");
    await page.mouse.click(line.x, line.y, { button: "right" });
    expect(await takeContextMenus(page)).toEqual([false]);
    await expect(panel).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(1);
  });
});

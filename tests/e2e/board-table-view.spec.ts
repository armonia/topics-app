/**
 * board-table-view.spec.ts — the board's TABLE view: one row per card.
 *
 * Two projects, four cards in four different statuses and four priorities, so
 * every sort has an order that differs from every other one:
 *
 *   alfa: «Zeta rifare il login»   todo         priority 1 (Bassa)
 *         «Alfa scrivere i docs»   in_progress  priority 3 (Alta)
 *   zeta: «Gamma pulire backlog»   backlog      priority 2 (Media)
 *         «Beta revisione sicurezza» review     priority 4 (Urgente)
 *
 * The titles start with letters that run against the workflow order, so
 * "sorted by status" and "sorted by title" cannot be mistaken for each other.
 *
 * Contract:
 *  1. The table is a view of the view selector, and its default order is the
 *     workflow's (backlog, todo, in progress, review).
 *  2. A click on a header sorts, a second click flips the direction.
 *  3. A click on a row opens the task drawer.
 *  4. Grouped by project every group has its own rows, yet the cells line up
 *     across groups (same left edge for each column).
 *  5. At 375 px the page does not scroll sideways, and the view survives a
 *     reload.
 *
 * Screenshots for the delivery review go to ~/.topics/media/board-tabella.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Locator, type Page } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
const PATH_A = `${canonicalTmpRoot()}/e2e-table-alfa-${STAMP}`;
const PATH_B = `${canonicalTmpRoot()}/e2e-table-zeta-${STAMP}`;
const ID_A = boardIdForPath(PATH_A);
const ID_B = boardIdForPath(PATH_B);
const MEDIA_DIR = join(homedir(), ".topics", "media", "board-tabella");
const WIDTHS = [375, 768, 1440, 3440] as const;

type Req = import("@playwright/test").APIRequestContext;
const createdTasks: { board: string; id: string }[] = [];
const topics: string[] = [];

interface Seed { key: string; board: string; text: string; status: string; priority: number }
const SEEDS: Seed[] = [
  { key: "login", board: ID_A, text: `Zeta rifare il login ${STAMP}`, status: "todo", priority: 1 },
  { key: "docs", board: ID_A, text: `Alfa scrivere i docs ${STAMP}`, status: "in_progress", priority: 3 },
  { key: "backlog", board: ID_B, text: `Gamma pulire backlog ${STAMP}`, status: "backlog", priority: 2 },
  { key: "review", board: ID_B, text: `Beta revisione sicurezza ${STAMP}`, status: "review", priority: 4 },
];
const ids: Record<string, string> = {};

async function createTask(request: Req, seed: Seed): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${seed.board}/tasks`, { data: { text: seed.text, status: seed.status } });
  expect(res.ok(), `POST ${seed.text}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push({ board: seed.board, id });
  const patch = await request.patch(`${BASE}/api/boards/${seed.board}/tasks/${id}`, { data: { priority: seed.priority } });
  expect(patch.ok(), `PATCH priority ${seed.text}`).toBe(true);
  return id;
}

async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

async function openTable(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    const viewKeys = ["layout", "groupBy", "thenBy", "density", "columns", "collapsedProjects"].map((k) => `topics.board.${k}`);
    // Keep the config's preset and showDone: only the per-board view choices start clean.
    for (const k of Object.keys(localStorage)) if (viewKeys.some((v) => k === v || k.startsWith(`${v}:`))) localStorage.removeItem(k);
  });
  await openGlobalBoard(page);
  await page.getByTestId("board-view-table").click();
  await expect(page.getByTestId("board-view-table")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("board-table")).toBeVisible();
}

/** The seeded rows, in the order the table draws them (other cards are ignored). */
async function seededOrder(page: Page): Promise<string[]> {
  const mine = new Set(Object.values(ids));
  const rows = await page.getByTestId("board-table-row").evaluateAll(
    (els) => els.map((e) => ({ id: e.getAttribute("data-task-id") ?? "", text: (e.textContent ?? "").trim() })),
  );
  const keyOf = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  return rows.filter((r) => mine.has(r.id)).map((r) => keyOf[r.id]);
}

const rowOf = (page: Page, key: string): Locator => page.locator(`[data-testid="board-table-row"][data-task-id="${ids[key]}"]`);

async function shoot(page: Page, name: string) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  await page.screenshot({ path: join(MEDIA_DIR, `${name}.png`) });
}

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, "page scrolls sideways").toBeLessThanOrEqual(0);
}

test.describe("Board — vista Tabella", () => {
  test.describe.configure({ timeout: 150_000 });
  test.beforeEach(() => { test.info().annotations.push({ type: "spec", description: "KANBAN-120" }); });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async ({ request }) => {
    for (const [path, name] of [[PATH_A, "e2e-table-alfa"], [PATH_B, "e2e-table-zeta"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(`${path}/package.json`, JSON.stringify({ name }, null, 2));
      topics.push((await createTopic(request, name, { projectPath: path })).id);
    }
    for (const seed of SEEDS) ids[seed.key] = await createTask(request, seed);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id);
    for (const id of [...topics].reverse()) await deleteTopic(request, id);
    removeTmpDir(PATH_A);
    removeTmpDir(PATH_B);
  });

  test("default order is the workflow's, a header click sorts and a second click flips it", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openTable(page);
    await expect(rowOf(page, "review")).toBeVisible({ timeout: 15000 });

    // 1. Workflow order: backlog, todo, in progress, review.
    expect(await seededOrder(page)).toEqual(["backlog", "login", "docs", "review"]);

    // 2. Title: A to Z by the first letter of the title (Alfa, Beta, Gamma, Zeta).
    await page.getByTestId("board-table-sort-title").click();
    expect(await seededOrder(page)).toEqual(["docs", "review", "backlog", "login"]);
    await expect(page.locator('[role="columnheader"][aria-sort="ascending"]')).toHaveCount(1);
    // Second click flips.
    await page.getByTestId("board-table-sort-title").click();
    expect(await seededOrder(page)).toEqual(["login", "backlog", "review", "docs"]);
    await expect(page.locator('[role="columnheader"][aria-sort="descending"]')).toHaveCount(1);

    // 3. Priority starts from the highest (Urgente, Alta, Media, Bassa).
    await page.getByTestId("board-table-sort-priority").click();
    expect(await seededOrder(page)).toEqual(["review", "docs", "backlog", "login"]);
    await page.getByTestId("board-table-sort-priority").click();
    expect(await seededOrder(page)).toEqual(["login", "backlog", "docs", "review"]);

    // 4. Back to the status column: workflow order again.
    await page.getByTestId("board-table-sort-status").click();
    expect(await seededOrder(page)).toEqual(["backlog", "login", "docs", "review"]);
  });

  test("rows are 32px tall, the review card is flagged as waiting on you, a click opens the drawer", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openTable(page);
    const review = rowOf(page, "review");
    await expect(review).toBeVisible({ timeout: 15000 });

    for (const key of Object.keys(ids)) {
      const box = await rowOf(page, key).boundingBox();
      expect(box?.height, `row ${key}`).toBe(32);
    }
    await expect(review.getByTestId("board-table-waiting")).toBeVisible();
    await expect(rowOf(page, "login").getByTestId("board-table-waiting")).toHaveCount(0);
    // The project column shows on the global board.
    await expect(rowOf(page, "docs")).toContainText("e2e-table-alfa");

    await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0);
    await rowOf(page, "docs").click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer).toContainText(`Alfa scrivere i docs ${STAMP}`);
    await shoot(page, "table-drawer-1440");
  });

  test("grouped by project: two groups, one block of rows each, columns aligned across groups", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openTable(page);
    await expect(rowOf(page, "review")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("board-group-by").click();
    await page.getByRole("option", { name: "Progetto", exact: true }).click();
    const laneA = page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`);
    const laneB = page.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`);
    await expect(laneA).toBeVisible();
    await expect(laneB).toBeVisible();
    await expect(laneA.getByTestId("board-table-row")).toHaveCount(2);
    await expect(laneB.getByTestId("board-table-row")).toHaveCount(2);
    await expect(laneA.locator(`[data-task-id="${ids.docs}"]`)).toBeVisible();
    await expect(laneB.locator(`[data-task-id="${ids.review}"]`)).toBeVisible();

    // Same left edge and width for every cell of the same column in both groups.
    const edges = async (key: string) => rowOf(page, key).locator('[role="cell"]').evaluateAll(
      (cells) => cells.map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }),
    );
    const a = await edges("login");
    const b = await edges("review");
    expect(a.length).toBeGreaterThan(3);
    expect(b).toEqual(a);
    // The row stays 32px tall inside a group too.
    expect((await rowOf(page, "review").boundingBox())?.height).toBe(32);

    await shoot(page, "table-grouped-1440");
  });

  test("screenshots at 375, 768, 1440 and 3440 with no sideways page scroll, and the view survives a reload", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openTable(page);
    await expect(rowOf(page, "review")).toBeVisible({ timeout: 15000 });
    // Sorted by age: the header with the widest content (its label plus the sort arrow).
    await page.getByTestId("board-table-sort-updated").click();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width >= 3000 ? 1440 : 900 });
      await expect(page.getByTestId("board-table")).toBeVisible();
      await expect(rowOf(page, "review")).toBeVisible();
      await noSideScroll(page);
      // No header label is cut to «Aggior…»: «Aggiornato» is the longest label in Italian and English.
      const cut = await page.locator('[data-testid^="board-table-sort-"] > span').evaluateAll(
        (els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => `${e.textContent} wants ${e.scrollWidth}px of ${e.clientWidth}px`),
      );
      expect(cut, `header labels cut at ${width}`).toEqual([]);
      // Status, title and age stay at every width (the extra columns are optional).
      const cells = rowOf(page, "review").locator('[role="cell"]');
      await expect(cells.first()).toBeVisible();
      await shoot(page, `table-${width}`);
    }

    // Narrow: the extra columns are gone, the title cell still has room to read.
    await page.setViewportSize({ width: 375, height: 800 });
    const title = rowOf(page, "review").locator('[role="cell"]').nth(1);
    expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(100);

    // Wide: the extra columns (project, owner, priority, links) are drawn.
    await page.setViewportSize({ width: 1440, height: 900 });
    const visibleCells = await rowOf(page, "review").locator('[role="cell"]').evaluateAll(
      (cs) => cs.filter((c) => (c as HTMLElement).offsetWidth > 0).length,
    );
    expect(visibleCells).toBe(7);

    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("board-view-table")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("board-table")).toBeVisible();
  });
});

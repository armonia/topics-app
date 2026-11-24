/**
 * board-columns-single.spec.ts — empty columns without a background, and the
 * «Colonne: separate | una» switch. (allow-italian: quotes the UI label)
 *
 * Two projects, three statuses seeded (backlog, todo, in progress) and the
 * review column left EMPTY on purpose: its absence of fill is the signal, not
 * the noise. The cards are seeded out of workflow order (the todo card is
 * created first) so «ordered by workflow column» is a real claim.
 *
 * Contract:
 *  1. An empty column keeps its box (same border WIDTH, so nothing shifts) but
 *     paints no fill and no line; a column with a card keeps both. The header
 *     and the count 0 stay.
 *  2. The switch turns each status column into ONE merged column; every card
 *     has a status chip above it, ordered by workflow column; a click on a
 *     card still opens the drawer.
 *  3. Grouped by project, each project is a framed card, stacked vertically
 *     (same left edge, one under the other), none wider than the 3xl cap.
 *  4. The choice survives a reload and the switch is not offered in views
 *     with no status columns (the table).
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
const PATH_A = `${canonicalTmpRoot()}/e2e-single-alfa-${STAMP}`;
const PATH_B = `${canonicalTmpRoot()}/e2e-single-zeta-${STAMP}`;
const ID_A = boardIdForPath(PATH_A);
const ID_B = boardIdForPath(PATH_B);
const MEDIA_DIR = join(homedir(), ".topics", "media", "board-tabella");
const WIDTHS = [375, 768, 1440, 3440] as const;
/** `max-w-3xl` in px: a project card is never wider than this. */
const CARD_CAP = 768;

type Req = import("@playwright/test").APIRequestContext;
const createdTasks: { board: string; id: string }[] = [];
const topics: string[] = [];
const ids: Record<string, string> = {};

async function createTask(request: Req, key: string, board: string, text: string, status: string) {
  const res = await request.post(`${BASE}/api/boards/${board}/tasks`, { data: { text, status } });
  expect(res.ok(), `POST ${text}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push({ board, id });
  ids[key] = id;
}

async function openBoard(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    const viewKeys = ["layout", "groupBy", "thenBy", "density", "columns", "collapsedProjects"].map((k) => `topics.board.${k}`);
    // Keep the config's preset and showDone: only the per-board view choices start clean.
    for (const k of Object.keys(localStorage)) if (viewKeys.some((v) => k === v || k.startsWith(`${v}:`))) localStorage.removeItem(k);
  });
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`[data-task-card="${ids.todoA}"]`)).toBeVisible({ timeout: 15000 });
}

async function groupByProject(page: Page) {
  await page.getByTestId("board-group-by").click();
  await page.getByRole("option", { name: "Progetto", exact: true }).click();
  await expect(page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`)).toBeVisible();
}

async function shoot(page: Page, name: string) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  await page.screenshot({ path: join(MEDIA_DIR, `${name}.png`) });
}

const paint = (loc: Locator) => loc.evaluate((el) => {
  const s = getComputedStyle(el);
  return { bg: s.backgroundColor, border: s.borderTopColor, width: s.borderTopWidth };
});
const isTransparent = (c: string) => c === "transparent" || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c);

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, "page scrolls sideways").toBeLessThanOrEqual(0);
}

test.describe("Board — colonne vuote senza sfondo e colonna unica", () => {
  test.describe.configure({ timeout: 150_000 });
  test.beforeEach(() => { test.info().annotations.push({ type: "spec", description: "KANBAN-121" }); });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async ({ request }) => {
    for (const [path, name] of [[PATH_A, "e2e-single-alfa"], [PATH_B, "e2e-single-zeta"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(`${path}/package.json`, JSON.stringify({ name }, null, 2));
      topics.push((await createTopic(request, name, { projectPath: path })).id);
    }
    // Created out of workflow order on purpose.
    await createTask(request, "todoA", ID_A, `Card in coda alfa ${STAMP}`, "todo");
    await createTask(request, "progA", ID_A, `Card in corso alfa ${STAMP}`, "in_progress");
    await createTask(request, "backlogB", ID_B, `Card in backlog zeta ${STAMP}`, "backlog");
    await createTask(request, "todoB", ID_B, `Card in coda zeta ${STAMP}`, "todo");
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id);
    for (const id of [...topics].reverse()) await deleteTopic(request, id);
    removeTmpDir(PATH_A);
    removeTmpDir(PATH_B);
  });

  test("an empty column keeps its box but paints no fill and no line", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openBoard(page);

    const review = page.getByTestId("kanban-column-review");
    const todo = page.getByTestId("kanban-column-todo");
    await expect(review).toBeVisible();
    await expect(review).toHaveAttribute("data-empty", "true");
    await expect(todo).not.toHaveAttribute("data-empty", "true");

    const empty = await paint(review);
    const full = await paint(todo);
    expect(isTransparent(empty.bg), `empty bg ${empty.bg}`).toBe(true);
    expect(isTransparent(empty.border), `empty border ${empty.border}`).toBe(true);
    expect(isTransparent(full.bg), `full bg ${full.bg}`).toBe(false);
    expect(isTransparent(full.border), `full border ${full.border}`).toBe(false);
    // Same border width: nothing shifts when a card arrives.
    expect(empty.width).toBe(full.width);
    // The header stays, with the count 0.
    await expect(review).toContainText("0");
    await shoot(page, "columns-split-1440");

    // Inside a project card the empty columns are bare too.
    await groupByProject(page);
    const laneA = page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`);
    const bareInLane = laneA.locator('[data-testid^="kanban-column-"][data-empty="true"]').first();
    await expect(bareInLane).toBeVisible();
    const p = await paint(bareInLane);
    expect(isTransparent(p.bg), `lane empty bg ${p.bg}`).toBe(true);
  });

  test("«Una» merges the statuses into one column with a status chip per card, ordered by workflow", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openBoard(page);

    const toggle = page.getByTestId("board-columns-toggle");
    await expect(toggle).toHaveAttribute("data-columns", "split");
    await expect(page.getByTestId("kanban-column-merged")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-columns", "single");

    const merged = page.getByTestId("kanban-column-merged");
    await expect(merged).toHaveCount(1);
    // The per-status columns are gone.
    await expect(page.getByTestId("kanban-column-todo")).toHaveCount(0);
    for (const key of ["todoA", "progA", "backlogB", "todoB"]) {
      await expect(merged.locator(`[data-task-card="${ids[key]}"]`)).toBeVisible();
    }
    // Workflow order: every backlog card, then todo, then in progress.
    const statuses = await merged.locator('[data-testid="merged-status-chip"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute("data-status") ?? ""),
    );
    const mine = statuses.filter((s) => ["backlog", "todo", "in_progress"].includes(s));
    const rank = (s: string) => ["backlog", "todo", "in_progress"].indexOf(s);
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect([...mine].sort((a, b) => rank(a) - rank(b))).toEqual(mine);
    // One chip per card.
    await expect(merged.locator("[data-task-card]")).toHaveCount(await merged.getByTestId("merged-status-chip").count());

    // A click on a card still opens the drawer.
    await merged.locator(`[data-task-card="${ids.progA}"]`).click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("task-detail-drawer")).toContainText(`Card in corso alfa ${STAMP}`);

    // Persisted per board: survives a reload; and back to «Separate» restores the columns.
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("board-columns-toggle")).toHaveAttribute("data-columns", "single");
    await expect(page.getByTestId("kanban-column-merged")).toHaveCount(1);
    await page.getByTestId("board-columns-toggle").click();
    await expect(page.getByTestId("kanban-column-todo")).toBeVisible();
    await expect(page.getByTestId("kanban-column-merged")).toHaveCount(0);
  });

  test("grouped by project, «Una» stacks one framed card per project, one merged column each", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openBoard(page);
    await groupByProject(page);
    await page.getByTestId("board-columns-toggle").click();
    await expect(page.getByTestId("board-columns-toggle")).toHaveAttribute("data-columns", "single");

    const laneA = page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`);
    const laneB = page.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`);
    await expect(laneA.getByTestId("kanban-column-merged")).toHaveCount(1);
    await expect(laneB.getByTestId("kanban-column-merged")).toHaveCount(1);
    await expect(laneA.locator(`[data-task-card="${ids.todoA}"]`)).toBeVisible();
    await expect(laneA.locator(`[data-task-card="${ids.progA}"]`)).toBeVisible();
    await expect(laneB.locator(`[data-task-card="${ids.backlogB}"]`)).toBeVisible();
    // No per-status columns anywhere.
    await expect(page.locator('[data-testid^="kanban-column-"]:not([data-testid="kanban-column-merged"]):not([data-testid^="kanban-column-body"])')).toHaveCount(0);

    // Stacked: same left edge, one under the other, never wider than the cap, with a visible frame.
    const a = await laneA.boundingBox();
    const b = await laneB.boundingBox();
    expect(a && b).toBeTruthy();
    expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(1);
    const [upper, lower] = a!.y < b!.y ? [a!, b!] : [b!, a!];
    expect(lower.y).toBeGreaterThanOrEqual(upper.y + upper.height - 1);
    expect(a!.width).toBeLessThanOrEqual(CARD_CAP + 1);
    expect(b!.width).toBeLessThanOrEqual(CARD_CAP + 1);
    const frame = await paint(laneA);
    expect(isTransparent(frame.border), `project card border ${frame.border}`).toBe(false);
    await shoot(page, "columns-single-grouped-1440-closeup");
  });

  test("the switch is not offered in the table, and the single view reads at 375, 768, 1440 and 3440", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openBoard(page);
    await groupByProject(page);
    await page.getByTestId("board-columns-toggle").click();
    await expect(page.getByTestId("kanban-column-merged")).toHaveCount(2);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width >= 3000 ? 1440 : 900 });
      await expect(page.getByTestId("kanban-column-merged").first()).toBeVisible();
      await noSideScroll(page);
      await shoot(page, `columns-single-${width}`);
    }

    // The flat single column too (screenshot only plus the same no-scroll bar).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("board-group-by").click();
    await page.getByRole("option", { name: "Nessun raggruppamento", exact: true }).click();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width >= 3000 ? 1440 : 900 });
      await noSideScroll(page);
      await shoot(page, `columns-single-flat-${width}`);
    }

    // The table has no status columns: no switch.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("board-view-table").click();
    await expect(page.getByTestId("board-table")).toBeVisible();
    await expect(page.getByTestId("board-columns-toggle")).toHaveCount(0);
  });
});

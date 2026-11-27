/**
 * project-family-label.spec.ts: a sub-project merged (accorpa) under another
 * says BOTH whose it is and which one it is, wherever a card names its
 * project — «Sito Armonia · Nuvola», not just «Nuvola» standing on its own
 * as if it were a project of its own (card 99295d2c).
 *
 * The merge itself is `PATCH /api/projects/:id` with `parentId` + `mergeMode`
 * (already covered end to end, with the UI gesture, by `project-merge.spec.ts`
 * WORKTREE-STD-06); this spec only checks the LABEL that follows it, on the
 * two surfaces the card named: the card chip on the parent's board, and the
 * table's project column.
 *
 * Shot at 375, 768, 1440 and 3440 px for the delivery review.
 */
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { videoAt } from "./video-evidence";

const test = base;
hermetic(test);
test.use({ video: videoAt("on", { width: 1360, height: 860 }) });

const BASE = E2E_BASE;
const STAMP = Date.now();
const ROOT = `${canonicalTmpRoot()}/e2e-family-label-${STAMP}`;
const PARENT_NAME = "Sito Armonia";
const CHILD_NAME = "Nuvola";
const PARENT_DIR = `${ROOT}/sito-armonia`;
const CHILD_DIR = `${ROOT}/nuvola`;
const PARENT_BOARD = projectIdForPath(PARENT_DIR);
const CHILD_BOARD = projectIdForPath(CHILD_DIR);
const MEDIA_DIR = join(homedir(), ".topics", "media", "project-family-label");
const WIDTHS = [375, 768, 1440, 3440] as const;

const topicIds: string[] = [];
const createdTasks: { board: string; id: string }[] = [];
let childCard = "";

async function registerProject(request: APIRequestContext, name: string, path: string): Promise<string> {
  const res = await request.post(`${BASE}/api/projects`, { data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${STAMP}`, path } });
  expect(res.ok(), await res.text()).toBe(true);
  const row = (await res.json()) as { id: string };
  return row.id;
}

async function shoot(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  mkdirSync(MEDIA_DIR, { recursive: true });
  await page.screenshot({ path: join(MEDIA_DIR, `${name}-${width}.png`) });
}

test.describe("project family label (accorpa)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PARENT_DIR, { recursive: true });
    mkdirSync(CHILD_DIR, { recursive: true });
    writeFileSync(`${PARENT_DIR}/package.json`, JSON.stringify({ name: "sito-armonia" }, null, 2));
    writeFileSync(`${CHILD_DIR}/package.json`, JSON.stringify({ name: "nuvola" }, null, 2));

    const parentRowId = await registerProject(request, PARENT_NAME, PARENT_DIR);
    const childRowId = await registerProject(request, CHILD_NAME, CHILD_DIR);
    topicIds.push((await createTopic(request, `sito-armonia-chat-${STAMP}`, { projectPath: PARENT_DIR })).id);
    topicIds.push((await createTopic(request, `nuvola-chat-${STAMP}`, { projectPath: CHILD_DIR })).id);

    // The child is accorpa under the parent BEFORE the card is created, so the
    // card is born already inside the merged family (no later re-read to prove).
    const merge = await request.patch(`${BASE}/api/projects/${childRowId}`, { data: { parentId: parentRowId, mergeMode: "accorpa" } });
    expect(merge.ok(), await merge.text()).toBe(true);

    const card = await request.post(`${BASE}/api/boards/${CHILD_BOARD}/tasks`, { data: { text: `Nuvola, lato caricamento ${STAMP}`, status: "todo" } });
    expect(card.ok(), await card.text()).toBe(true);
    childCard = ((await card.json()) as { id: string }).id;
    createdTasks.push({ board: CHILD_BOARD, id: childCard });
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id).catch(() => {});
    for (const id of [...topicIds].reverse()) await deleteTopic(request, id).catch(() => {});
    removeTmpDir(ROOT);
  });

  test("the card chip and the table's project column both read «Sito Armonia · Nuvola»", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("topics.board.")) localStorage.removeItem(k);
      localStorage.setItem("topics.board.preset", "all");
      localStorage.setItem("topics.board.showDone", "true");
    });
    await page.reload();
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });

    // 1. The grid (default view): the child's card, in the parent's lane, carries
    // the family label on its own chip.
    const card = page.locator(`[data-task-card="${childCard}"]:visible`).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(PARENT_NAME);
    await expect(card).toContainText(CHILD_NAME);
    for (const width of WIDTHS) await shoot(page, "1-card-chip", width);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 2. The table view, UNGROUPED (a grouped lane already says the parent's
    // name once, in its header; the row's own "project" column is the cell a
    // regression to the raw `task.projectId` would actually break).
    await page.getByTestId("board-view-table").click();
    await expect(page.getByTestId("board-table")).toBeVisible({ timeout: 15_000 });
    const row = page.locator(`[data-testid="board-table-row"][data-task-id="${childCard}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const projectCell = row.locator('[data-col="project"]');
    await expect(projectCell).toContainText(PARENT_NAME);
    await expect(projectCell).toContainText(CHILD_NAME);
    for (const width of WIDTHS) await shoot(page, "2-table-project-column", width);
  });
});

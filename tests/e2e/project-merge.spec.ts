/**
 * project-merge.spec.ts: a project whose folder is a git worktree of another
 * project can be merged into it (accorpa) and separated again (separa), and
 * neither gesture touches a card.
 *
 * ONE story, filmed: the child project holds three cards, the parent one.
 *   1. both are projects of their own: the global board has two lanes and the
 *      parent's board has its one card;
 *   2. the child's menu in the sidebar merges it into the parent: the global
 *      board folds the two lanes into one, the parent's board shows the child's
 *      three cards with the child's name on each, and the child leaves the
 *      sidebar (its chats sit under the parent);
 *   3. the parent's menu separates it again: two lanes, one card;
 *   4. the child's menu merges it back.
 * The proof that nothing moved: the child board's own task rows (the columns a merge
 * could rewrite, above all `projectId`) are read at the start and after every
 * gesture and are identical. A merge is a
 * link between two `projects` rows; `tasks.project_id` is never rewritten.
 *
 * The child's folder is registered as a project while it is still a plain
 * folder and becomes a git worktree afterwards: a folder that COMES IN as a
 * worktree is the repository's project by design (WORKTREE-STD-05) and would
 * never get a row of its own to merge.
 *
 * @covers WORKTREE-STD-06
 */
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpRoot, initGitRepo, removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";

const test = base;
hermetic(test);
test.use({ video: "on", viewport: { width: 1360, height: 860 } });

const BASE = E2E_BASE;
const STAMP = Date.now();
const ROOT = `${canonicalTmpRoot()}/e2e-merge-${STAMP}`;
const PARENT_NAME = "e2e-merge-main";
const CHILD_NAME = "e2e-merge-main-wt";
const PARENT_DIR = `${ROOT}/${PARENT_NAME}`;
const CHILD_DIR = `${ROOT}/${CHILD_NAME}`;
const PARENT_BOARD = projectIdForPath(PARENT_DIR);
const CHILD_BOARD = projectIdForPath(CHILD_DIR);

type Task = { id: string; text: string };
const created: Array<{ board: string; id: string }> = [];
const topicIds: string[] = [];
let childCards: string[] = [];
let parentCard = "";

async function addCard(request: APIRequestContext, board: string, text: string, status: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${board}/tasks`, { data: { text, status } });
  expect(res.ok(), await res.text()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  created.push({ board, id });
  return id;
}

const KEPT_COLUMNS = ["id", "projectId", "text", "status", "priority", "kanbanOrder", "assignedTo", "archived", "createdAt", "parentTaskId"] as const;

/** The rows of one board, in a stable order: what "no row changed" compares. */
async function rowsOf(request: APIRequestContext, board: string): Promise<string> {
  const res = await request.get(`${BASE}/api/boards/${board}/tasks`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { tasks?: Task[] } | Task[];
  const tasks = Array.isArray(body) ? body : (body.tasks ?? []);
  // The columns a merge could rewrite. `updatedAt`, `previewImage` and `queueReason` are
  // derived by the server on its own clock (the review card's preview sheet is drawn a few
  // seconds after it is created), so they are not part of what the gesture may touch.
  const keep = (t: Task) => Object.fromEntries(KEPT_COLUMNS.map((k) => [k, (t as Record<string, unknown>)[k]]));
  return JSON.stringify([...tasks].sort((a, b) => a.id.localeCompare(b.id)).map(keep));
}

// A board of an earlier step can stay mounted behind the tab on screen: only what is visible counts.
const lane = (page: Page, id: string) => page.locator(`[data-testid="board-lane"][data-project-id="${id}"]:visible`);
const card = (page: Page, id: string) => page.locator(`[data-task-card="${id}"]:visible`).first();

/** Leaves the page and lets its pane store flush (it writes on unload) BEFORE a view is seeded, so the old view is not restored. */
async function leavePage(page: Page) {
  await page.goto("about:blank");
}

/** The global board, grouped by project: one lane per project. */
async function showGlobalBoard(page: Page) {
  await leavePage(page);
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
  // The boards of earlier steps stay mounted behind their tabs (a device copy of the pane store
  // brings them back on reload): only the one on screen is this step's, so every handle is scoped to it.
  const onScreen = (testId: string) => page.locator(`[data-testid="${testId}"]:visible`).first();
  await expect(onScreen("kanban-board")).toBeVisible({ timeout: 15_000 });
  await onScreen("board-view-list").click();
  await onScreen("board-group-by").click();
  await page.getByRole("option", { name: "Progetto", exact: true }).click();
}

/** The parent's own board, in its project window. */
async function showParentBoard(page: Page) {
  await leavePage(page);
  await resetPaneStore(page.request, []);
  await resetProjectPanes(page.request, PARENT_DIR);
  await seedProjectPane(page.request, PARENT_DIR);
  // The child's project is open too, so it has a row in the sidebar to merge from.
  await seedProjectPane(page.request, CHILD_DIR);
  await page.goto("/");
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("topics.board.")) localStorage.removeItem(k);
    localStorage.setItem("topics.board.preset", "all");
    localStorage.setItem("topics.board.showDone", "true");
  });
  await page.reload();
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") await section.click();
  const row = projectRow(page, new RegExp(`^${PARENT_NAME}$`));
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });
  const projectBoard = page.getByTestId("project-window").getByTestId("kanban-board");
  if (await projectBoard.isVisible().catch(() => false)) return;
  const tab = page.getByTestId("project-window").locator('[data-testid="pane-tab-label"]', { hasText: /^Board$/ });
  if ((await tab.count()) > 0) {
    await tab.first().click();
  } else {
    const triggers = page.getByTestId("pane-add-menu-trigger");
    const item = page.getByTestId("pane-add-menu-kanban");
    for (let i = (await triggers.count()) - 1; i >= 0; i--) {
      if (!(await triggers.nth(i).isVisible().catch(() => false))) continue;
      await triggers.nth(i).click({ timeout: 3_000 }).catch(() => {});
      if (await item.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) { await item.click(); break; }
      await page.keyboard.press("Escape");
    }
  }
  await expect(projectBoard).toBeVisible({ timeout: 15_000 });
}

/** Opens the context menu of a project row in the sidebar. */
async function projectMenu(page: Page, name: string) {
  const row = projectRow(page, new RegExp(`^${name}$`));
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click({ button: "right" });
}

test.describe("Accorpa e separa un progetto figlio", () => {
  test.describe.configure({ timeout: 150_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PARENT_DIR, { recursive: true });
    mkdirSync(CHILD_DIR, { recursive: true });
    writeFileSync(`${PARENT_DIR}/README.md`, "# e2e merge\n");
    initGitRepo(PARENT_DIR);
    for (const [name, dir] of [[PARENT_NAME, PARENT_DIR], [CHILD_NAME, CHILD_DIR]] as const) {
      const res = await request.post(`${BASE}/api/projects`, { data: { name, slug: `${name}-${STAMP}`, path: dir } });
      expect(res.status(), await res.text()).toBe(201);
      topicIds.push((await createTopic(request, `${name}-chat-${STAMP}`, { projectPath: dir })).id);
    }
    // The child folder turns into a linked worktree of the parent: it is empty, which git accepts.
    execFileSync("git", ["worktree", "add", "--detach", CHILD_DIR], { cwd: PARENT_DIR, stdio: "pipe" });

    parentCard = await addCard(request, PARENT_BOARD, `Card del padre ${STAMP}`, "todo");
    childCards = [
      await addCard(request, CHILD_BOARD, `Card figlio uno ${STAMP}`, "todo"),
      await addCard(request, CHILD_BOARD, `Card figlio due ${STAMP}`, "in_progress"),
      await addCard(request, CHILD_BOARD, `Card figlio tre ${STAMP}`, "review"),
    ];
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...created].reverse()) await deleteTask(request, t.board, t.id).catch(() => {});
    for (const id of [...topicIds].reverse()) await deleteTopic(request, id).catch(() => {});
    try { execFileSync("git", ["worktree", "remove", "--force", CHILD_DIR], { cwd: PARENT_DIR, stdio: "pipe" }); } catch { /* already gone */ }
    removeTmpDir(ROOT);
  });

  test("WORKTREE-STD-06: accorpa mostra le card del figlio nel padre, separa le toglie, nessuna riga cambia", async ({ page, request }, testInfo) => {
    // The two meetings this one test films, each in ONE annotation (spec-flow D19): the board grouped
    // by project folds two lanes into one (KANBAN-107), and the sidebar's project row of the merged
    // child leaves the tree and comes back (TOPIC-09).
    testInfo.annotations.push({ type: "spec", description: "WORKTREE-STD-06 KANBAN-107" });
    testInfo.annotations.push({ type: "spec", description: "WORKTREE-STD-06 TOPIC-09" });
    const before = await rowsOf(request, CHILD_BOARD);
    expect(JSON.parse(before)).toHaveLength(3);

    await test.step("due progetti: due corsie e la board del padre ha una card", async () => {
      await showGlobalBoard(page);
      await expect(lane(page, PARENT_BOARD)).toBeVisible({ timeout: 15_000 });
      await expect(lane(page, CHILD_BOARD)).toBeVisible();
      await expect(lane(page, CHILD_BOARD).locator("[data-task-card]:visible")).toHaveCount(3);
      await page.screenshot({ path: testInfo.outputPath("1-separati-board-generale.png") });
      await showParentBoard(page);
      await expect(card(page, parentCard)).toBeVisible({ timeout: 15_000 });
      for (const id of childCards) await expect(page.locator(`[data-task-card="${id}"]:visible`)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("2-separati-board-padre.png") });
    });

    await test.step("il menu del figlio lo accorpa nel padre", async () => {
      await projectMenu(page, CHILD_NAME);
      await page.getByTestId("project-family-merge").click();
      const choices = page.getByTestId("project-family-choices");
      await expect(choices).toBeVisible();
      await choices.getByRole("button", { name: new RegExp(`^${PARENT_NAME}`) }).first().click();
      await expect(page.getByTestId("project-family-choices")).toHaveCount(0);
      // The merged child has no row of its own any more: its chats sit under the parent.
      await expect(projectRow(page, new RegExp(`^${CHILD_NAME}$`))).toHaveCount(0, { timeout: 15_000 });
    });

    await test.step("accorpato: la board del padre mostra le card del figlio con il suo nome", async () => {
      // The parent's board is open: the project update re-reads it by itself.
      for (const id of childCards) await expect(card(page, id)).toBeVisible({ timeout: 15_000 });
      await expect(card(page, parentCard)).toBeVisible();
      for (const id of childCards) await expect(card(page, id)).toContainText(CHILD_NAME);
      await page.screenshot({ path: testInfo.outputPath("3-accorpati-board-padre.png") });
    });

    await test.step("accorpato: la board generale ha una corsia sola", async () => {
      await showGlobalBoard(page);
      await expect(lane(page, PARENT_BOARD)).toBeVisible({ timeout: 15_000 });
      await expect(lane(page, CHILD_BOARD)).toHaveCount(0);
      await expect(lane(page, PARENT_BOARD).locator("[data-task-card]:visible")).toHaveCount(4);
      await page.screenshot({ path: testInfo.outputPath("4-accorpati-board-generale.png") });
      expect(await rowsOf(request, CHILD_BOARD)).toBe(before);
    });

    await test.step("il menu del padre separa il figlio: tornano due corsie", async () => {
      await projectMenu(page, PARENT_NAME);
      await page.getByTestId("project-family-separate-child").click();
      await expect(lane(page, CHILD_BOARD)).toBeVisible({ timeout: 15_000 });
      await expect(lane(page, PARENT_BOARD).locator("[data-task-card]:visible")).toHaveCount(1);
      await expect(lane(page, CHILD_BOARD).locator("[data-task-card]:visible")).toHaveCount(3);
      await page.screenshot({ path: testInfo.outputPath("5-separati-di-nuovo.png") });
      await showParentBoard(page);
      await expect(card(page, parentCard)).toBeVisible({ timeout: 15_000 });
      for (const id of childCards) await expect(page.locator(`[data-task-card="${id}"]:visible`)).toHaveCount(0);
      // The child is back in the sidebar, with its own row.
      await expect(projectRow(page, new RegExp(`^${CHILD_NAME}$`))).toBeVisible({ timeout: 15_000 });
      expect(await rowsOf(request, CHILD_BOARD)).toBe(before);
    });

    await test.step("il menu del figlio lo riaccorpa", async () => {
      await projectMenu(page, CHILD_NAME);
      await page.getByTestId("project-family-toggle").click();
      for (const id of childCards) await expect(card(page, id)).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: testInfo.outputPath("6-riaccorpati.png") });
      expect(await rowsOf(request, CHILD_BOARD)).toBe(before);
    });
  });
});

/**
 * board-group-density.spec.ts — the cross-project board grouped by project,
 * and the compact card, the same in the Kanban and in the Plan.
 *
 * Two projects, two cards each in different columns: with one project a lane
 * would be indistinguishable from the flat board. One card is bound to a live
 * session, because the compact card must keep the session door the full card
 * has (the «sessions around» of the request).
 *
 * The reload is the proof the two choices are preferences of whoever looks at
 * the board, not component state. Folding a lane and then opening the Plan is
 * the proof the two views share one folded set.
 *
 * @covers KANBAN-106
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
const PATH_A = `${canonicalTmpRoot()}/e2e-lane-alfa-${STAMP}`;
const PATH_B = `${canonicalTmpRoot()}/e2e-lane-beta-${STAMP}`;
const ID_A = boardIdForPath(PATH_A);
const ID_B = boardIdForPath(PATH_B);

type Req = import("@playwright/test").APIRequestContext;
const createdTasks: { board: string; id: string }[] = [];
const topics: string[] = [];

async function createTask(request: Req, board: string, text: string, status: string, description?: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${board}/tasks`, { data: { text, status, description } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push({ board, id });
  return id;
}

async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

test.describe("Board per progetto e card compatte", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1360, height: 860 } });

  let live = "";
  let plain = "";

  test.beforeAll(async ({ request }) => {
    for (const [path, name] of [[PATH_A, "e2e-lane-alfa"], [PATH_B, "e2e-lane-beta"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(`${path}/package.json`, JSON.stringify({ name }, null, 2));
      topics.push((await createTopic(request, name, { projectPath: path })).id);
    }
    const session = (await createTopic(request, `Sessione lane ${STAMP}`)).id;
    topics.push(session);
    live = await createTask(request, ID_A, `Card con sessione ${STAMP}`, "in_progress", "Una descrizione che la card compatta non disegna.");
    plain = await createTask(request, ID_A, `Card in coda alfa ${STAMP}`, "todo", "Anche questa descrizione resta nella scheda.");
    await createTask(request, ID_B, `Card in coda beta ${STAMP}`, "todo");
    await createTask(request, ID_B, `Card in backlog beta ${STAMP}`, "backlog");
    const bind = await request.post(`${BASE}/api/test/tasks/${live}/bind-topic`, { data: { topicId: session, dispatchState: "working" } });
    expect(bind.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id);
    for (const id of [...topics].reverse()) await deleteTopic(request, id);
    removeTmpDir(PATH_A);
    removeTmpDir(PATH_B);
  });

  test("raggruppa per progetto, compatta le card, ricorda le scelte e il Piano le rispetta", async ({ page }, testInfo) => {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.evaluate(() => {
      for (const k of ["topics.board.groupBy", "topics.board.density", "topics.board.collapsedProjects"]) localStorage.removeItem(k);
    });
    await openGlobalBoard(page);

    const group = page.getByTestId("board-group-toggle");
    const density = page.getByTestId("board-density-toggle");
    const liveCard = page.locator(`[data-task-card="${live}"]`);
    const plainCard = page.locator(`[data-task-card="${plain}"]`);
    await expect(liveCard).toBeVisible({ timeout: 15000 });

    // ── 1. The default: flat board, full cards, the description is drawn ───
    await expect(group).toHaveAttribute("aria-pressed", "false");
    await expect(density).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("board-lane")).toHaveCount(0);
    await expect(plainCard).toHaveAttribute("data-density", "full");
    await expect(plainCard).toContainText("Anche questa descrizione");
    await expect(liveCard.getByTestId("card-open-session")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("prima.png") });

    // ── 2. Grouped: one lane per project, each with its counts ─────────────
    await group.click();
    await expect(group).toHaveAttribute("aria-pressed", "true");
    const laneA = page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`);
    const laneB = page.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`);
    await expect(laneA).toBeVisible();
    await expect(laneB).toBeVisible();
    await expect(laneA.locator(`[data-task-card="${live}"]`)).toBeVisible();
    await expect(laneA.locator(`[data-task-card="${plain}"]`)).toBeVisible();
    await expect(laneA.getByTestId("board-lane-count-todo")).toHaveText("1");
    await expect(laneA.getByTestId("board-lane-count-in_progress")).toHaveText("1");
    await expect(laneB.getByTestId("board-lane-count-todo")).toHaveText("1");
    await expect(laneB.getByTestId("board-lane-count-backlog")).toHaveText("1");

    // ── 3. Compact: the description goes, the session door stays ──────────
    await density.click();
    await expect(density).toHaveAttribute("aria-pressed", "true");
    await expect(plainCard).toHaveAttribute("data-density", "compact");
    await expect(plainCard).not.toContainText("Anche questa descrizione");
    await expect(liveCard.getByTestId("card-open-session")).toBeVisible();
    await expect(liveCard.getByTestId("card-foot")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("dopo.png") });

    // ── 4. Folding a lane hides its columns, the header stays ─────────────
    await laneB.getByTestId("board-lane-header").getByRole("button").click();
    await expect(laneB).toHaveAttribute("data-collapsed", "true");
    await expect(laneB.locator("[data-task-card]")).toHaveCount(0);

    // ── 5. All three choices survive a reload ─────────────────────────────
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("board-group-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("board-density-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`[data-testid="board-lane"][data-project-id="${ID_B}"]`)).toHaveAttribute("data-collapsed", "true");
    await expect(page.locator(`[data-task-card="${plain}"]`)).toHaveAttribute("data-density", "compact");

    // ── 6. The Plan: same fold, same compact card ─────────────────────────
    await page.getByTestId("board-plan-toggle").click();
    const plan = page.getByTestId("plan-view");
    await expect(plan).toBeVisible({ timeout: 15000 });
    await expect(plan.locator(`[data-testid="plan-project"][data-project-id="${ID_B}"]`)).toHaveAttribute("data-collapsed", "true");
    const tileA = plan.locator(`[data-testid="plan-project"][data-project-id="${ID_A}"]`);
    await expect(tileA).not.toHaveAttribute("data-collapsed", "true");
    const planCard = tileA.locator(`[data-task-card="${live}"]`);
    await expect(planCard).toHaveAttribute("data-density", "compact");
    await expect(planCard.getByTestId("card-open-session")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("piano.png") });
  });
});

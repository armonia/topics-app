/**
 * board-view-grouping.spec.ts: ONE selector for the view (kanban, list, cards)
 * and a two-level grouping («group by», «then by») that works in every view.
 *
 * Two projects: alfa holds two cards of different assignees, zeta holds a card
 * in review that waits for the person (a question with options) and one that
 * waits for nobody. The reload is the proof that the view, the grouping and
 * the second level are kept per board, not component state; the «Needs you»
 * quick filter over project then assignee is the proof the groups are built
 * from the filtered cards.
 *
 * @covers KANBAN-107
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
const PATH_A = `${canonicalTmpRoot()}/e2e-view-alfa-${STAMP}`;
const PATH_B = `${canonicalTmpRoot()}/e2e-view-zeta-${STAMP}`;
const ID_A = boardIdForPath(PATH_A);
const ID_B = boardIdForPath(PATH_B);

type Req = import("@playwright/test").APIRequestContext;
const createdTasks: { board: string; id: string }[] = [];
const topics: string[] = [];

async function createTask(request: Req, board: string, text: string, status: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${board}/tasks`, { data: { text, status, ...extra } });
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

/** Opens one of the grouping menus and picks an entry (or just opens it when `choose` is false). */
async function pick(page: Page, menu: string, label: string, choose = true) {
  await page.getByTestId(menu).click();
  const option = page.getByRole("option", { name: label, exact: true });
  await expect(option).toBeVisible();
  if (choose) await option.click();
}

const lane = (page: Page, id: string) => page.locator(`[data-testid="board-lane"][data-project-id="${id}"]`);

test.describe("Selettore di vista e raggruppamento a due livelli", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1360, height: 860 } });

  let amy = "";
  let bob = "";
  let asked = "";
  let quiet = "";

  test.beforeAll(async ({ request }) => {
    for (const [path, name] of [[PATH_A, "e2e-view-alfa"], [PATH_B, "e2e-view-zeta"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(`${path}/package.json`, JSON.stringify({ name }, null, 2));
      topics.push((await createTopic(request, name, { projectPath: path })).id);
    }
    amy = await createTask(request, ID_A, `Card di amy ${STAMP}`, "todo", { assignee: "amy", priority: 4 });
    bob = await createTask(request, ID_A, `Card di bob ${STAMP}`, "in_progress", { assignee: "bob" });
    asked = await createTask(request, ID_B, `Card che aspetta ${STAMP}`, "review", { assignee: "amy" });
    quiet = await createTask(request, ID_B, `Card tranquilla ${STAMP}`, "todo");
    const sessionKey = `topic:${topics[1]!.slice(0, 8)}`;
    const posted = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${asked}/comments`, {
      data: { content: "Posso procedere?", options: ["Si", "No"] },
    });
    expect(posted.status(), await posted.text()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id);
    for (const id of [...topics].reverse()) await deleteTopic(request, id);
    removeTmpDir(PATH_A);
    removeTmpDir(PATH_B);
  });

  async function freshBoard(page: Page) {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("topics.board.")) localStorage.removeItem(k);
    });
    await page.reload();
    await openGlobalBoard(page);
    await expect(page.locator(`[data-task-card="${amy}"]`).first()).toBeVisible({ timeout: 15000 });
  }

  test("vista, raggruppamento e secondo livello restano dopo un reload", async ({ page }, testInfo) => {
    await freshBoard(page);
    await expect(page.getByTestId("board-view-grid")).toHaveAttribute("aria-checked", "true");
    // The kanban never offers «status»: its columns already are the status.
    await pick(page, "board-group-by", "Nessun raggruppamento", false);
    await expect(page.getByRole("option", { name: "Stato", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("board-then-by")).toHaveCount(0);

    await page.getByTestId("board-view-list").click();
    await pick(page, "board-group-by", "Progetto");
    await pick(page, "board-then-by", "Assegnatario");

    const alfa = lane(page, ID_A);
    await expect(alfa.getByTestId("board-group-count").first()).toHaveText("2");
    const subs = alfa.locator('[data-testid="board-group"][data-group-level="assignee"]');
    await expect(subs).toHaveCount(2);
    await expect(subs.nth(0).getByTestId("board-group-count")).toHaveText("1");
    await page.screenshot({ path: testInfo.outputPath("due-livelli.png") });

    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("board-view-list")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("board-group-by")).toContainText("Progetto");
    await expect(page.getByTestId("board-then-by")).toContainText("Assegnatario");
    await expect(lane(page, ID_A).locator('[data-testid="board-group"][data-group-level="assignee"]')).toHaveCount(2);
  });

  test("«Serve te» con progetto poi assegnatario mostra solo la card che aspetta la persona", async ({ page }, testInfo) => {
    await freshBoard(page);
    await page.getByTestId("board-view-list").click();
    await pick(page, "board-group-by", "Progetto");
    await pick(page, "board-then-by", "Assegnatario");
    await page.getByTestId("board-quick-me").click();
    await expect(page.getByTestId("board-quick-me")).toHaveAttribute("aria-pressed", "true");

    const zeta = lane(page, ID_B);
    await expect(zeta).toBeVisible();
    await expect(zeta.getByTestId("board-group-count").first()).toHaveText("1");
    await expect(zeta.locator('[data-testid="board-group"][data-group-level="assignee"]')).toHaveCount(1);
    await expect(zeta.locator(`[data-task-card="${asked}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-card="${quiet}"]`)).toHaveCount(0);
    await expect(lane(page, ID_A)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("serve-te.png") });
  });

  test("la vista a card raggruppa senza colonne di stato e conta i gruppi", async ({ page }, testInfo) => {
    await freshBoard(page);
    await page.getByTestId("board-view-plan").click();
    await pick(page, "board-group-by", "Chi la chiude");
    const plan = page.getByTestId("plan-view");
    await expect(plan).toBeVisible();
    await expect(plan.getByTestId("kanban-column-todo")).toHaveCount(0);
    // «Needs you» leads the groups, and holds the one card that waits for the person.
    const first = plan.locator('[data-testid="board-group"]').first();
    await expect(first).toHaveAttribute("data-group-path", "me");
    await expect(first.locator(`[data-task-card="${asked}"]`)).toBeVisible();
    await expect(first.getByTestId("board-group-count")).toHaveText("1");
    await page.screenshot({ path: testInfo.outputPath("card-per-chi-la-chiude.png") });
    // A card opened through the API belongs to «Agents», the next group, with its own count.
    const agents = plan.locator('[data-testid="board-group"][data-group-path="agents"]');
    await expect(agents.locator(`[data-task-card="${bob}"]`)).toBeVisible();
  });
});

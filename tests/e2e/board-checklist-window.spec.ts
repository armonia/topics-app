/**
 * board-checklist-window.spec.ts — the five steps a card shows are the five
 * that have something to say.
 *
 * A checklist is worked top-down, so a positional window (`slice(0, 5)`) shows
 * the DONE ones, struck through, and folds the only step still open. That is
 * the exact row the window exists for: the card is the only place on the board
 * where a subtask is ever seen — the columns carry roots only — so a step
 * nobody is working is visible there or nowhere.
 *
 * Measured on 2026-09-12 on a live board: card `e1cdd61d`, six steps, five
 * done, and the sixth (`8951cc50`, in progress since 09/09 with no dispatch
 * state, no agent, zero attempts) was the `+1` behind the fold — with its
 * `subtaskWork: unattended` already computed by the server and already drawn,
 * one click away, in the drawer.
 *
 * @covers KANBAN-81
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpRoot, initGitRepo, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-checkwin-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare la scheda prodotto";
const LIVE_STEP = "Verificare il flusso completo e consegnare";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

const patch = async (request: any, id: string, data: Record<string, unknown>) => {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data });
  expect(res.ok()).toBe(true);
};

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-checkwin/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Checklist della card · quali cinque step", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-checkwin" }, null, 2));
    initGitRepo(PROJECT_PATH);
    const topic = await createTopic(request, "E2E-CheckWin", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("cinque step fatti e uno che nessuno lavora: la card mostra quello, non i primi cinque", async ({ page, request }) => {
    // The parent stays out of a turn, so the chain says nobody is working the
    // step: no bound topic, no dispatch chip, and a column that is not
    // `in_progress`. The step itself is the ambiguous shape — in progress,
    // never dispatched.
    const epica = await createTask(request, { text: EPICA });
    await patch(request, epica.id, { status: "review" });

    for (let i = 1; i <= 5; i++) {
      const done = await createTask(request, { text: `Passo chiuso ${i}`, parentTaskId: epica.id });
      await patch(request, done.id, { status: "done" });
    }
    const live = await createTask(request, { text: LIVE_STEP, parentTaskId: epica.id });
    await patch(request, live.id, { status: "in_progress" });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${epica.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // The sixth step, last in the checklist, is on the card — with its chip.
    const chip = card.getByTestId(`card-subtask-work-${live.id}`);
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toHaveAttribute("data-kind", "unattended");
    await expect(card).toContainText(LIVE_STEP);

    // It took a slot from a done step, and the fold counts one, not zero.
    await expect(card.getByText(/^\+1…/)).toBeVisible();
    await expect(card.getByText("Passo chiuso 5")).toHaveCount(0);
  });
});

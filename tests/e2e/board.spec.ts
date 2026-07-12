/**
 * board.spec.ts — E2E for the Kanban board (kanban-agent-authoring, KANBAN-01/03/05/07).
 *
 * Covers the human board surface end-to-end against the isolated test server:
 *  - project board opens from the project window "+" menu, 5 columns
 *  - inline create in a column → card appears (and dispatch feedback exists)
 *  - live WS update when a task is created via API (no manual refresh)
 *  - agent-surface create (`/api/sessions/:key/tasks`) lands in Backlog (intake)
 *  - review gate: Approva moves review → done
 *  - auto-dispatch pill: "agent: off" by default, flips with the settings toggle
 *  - global board ("Board generale") opens from the standalone "+" menu and
 *    aggregates tasks across projects with project badges
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";

const BASE = "http://localhost:13334";
const PROJECT_PATH = `/tmp/e2e-board-${Date.now()}`;

/** BYTE-IDENTICAL to server/services/tasks.ts:projectIdForPath (parity-tested there). */
function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string },
  projectId = PROJECT_ID,
): Promise<{ id: string; status: string }> {
  const res = await request.post(`${BASE}/api/boards/${projectId}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string; status: string };
  createdTasks.push(`${projectId}:${task.id}`);
  return task;
}

/** Open the e2e project window by clicking its sidebar row (project-tabs pattern). */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /Projects section/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: /e2e-board/ })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

/** Open the project board pane via the project window's "+" menu. */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  // The project window's tab bar hosts its own PaneAddMenu trigger.
  const trigger = page.getByTestId("pane-add-menu-trigger").last();
  await trigger.click();
  await page.getByTestId("pane-add-menu-kanban").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Kanban board", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board" }, null, 2));
    const topic = await createTopic(request, "E2E-Board", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []).catch(() => {});
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  test("BOARD-01: project board renders 5 columns + dispatch pill (agent: off)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await page.goto("/");
    await openProjectBoard(page);

    for (const status of ["backlog", "todo", "in_progress", "review", "done"]) {
      await expect(page.getByTestId(`kanban-column-${status}`)).toBeVisible();
    }
    // The feedback that was missing: the header must SAY dispatch is off.
    await expect(page.getByTestId("board-dispatch-pill")).toBeVisible();
    await expect(page.getByTestId("board-dispatch-pill")).toContainText("agent: off");
  });

  test("BOARD-02: inline create adds a card to the column", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await page.goto("/");
    await openProjectBoard(page);

    const backlog = page.getByTestId("kanban-column-backlog");
    await backlog.getByRole("button", { name: "Aggiungi" }).click();
    const text = `Inline task ${Date.now()}`;
    await backlog.locator("textarea").fill(text);
    await backlog.locator("textarea").press("Enter");
    await expect(backlog.getByText(text)).toBeVisible({ timeout: 10000 });

    // Track for cleanup (created via UI, id unknown → find it via API).
    const res = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks`);
    const { tasks } = (await res.json()) as { tasks: Array<{ id: string; text: string }> };
    const mine = tasks.find((t) => t.text === text);
    if (mine) createdTasks.push(`${PROJECT_ID}:${mine.id}`);
  });

  test("BOARD-03: task created via API appears live (WS, no refresh)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    await page.goto("/");
    await openProjectBoard(page);

    const text = `Live task ${Date.now()}`;
    await apiCreateTask(page.request, { text, status: "todo" });
    await expect(page.getByTestId("kanban-column-todo").getByText(text)).toBeVisible({ timeout: 10000 });
  });

  test("BOARD-04: agent-surface create lands in Backlog (intake, not the run-queue)", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    await page.goto("/");
    await openProjectBoard(page);

    // The MCP adapter drives /api/sessions/:key/tasks; the session key of a
    // topic is `topic:` + first 8 chars of its id (session-control-core).
    const sessionKey = `topic:${projectTopicId!.slice(0, 8)}`;
    const text = `Agent task ${Date.now()}`;
    const res = await page.request.post(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks`,
      { data: { text } },
    );
    expect(res.status()).toBe(201);
    const task = (await res.json()) as { id: string; status: string };
    createdTasks.push(`${PROJECT_ID}:${task.id}`);
    expect(task.status).toBe("backlog");
    await expect(page.getByTestId("kanban-column-backlog").getByText(text)).toBeVisible({ timeout: 10000 });
  });

  test("BOARD-05: review gate — Approva moves review → done", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
    const text = `Review task ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    const patch = await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
      data: { status: "review" },
    });
    expect(patch.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);

    const reviewCol = page.getByTestId("kanban-column-review");
    const card = reviewCol.locator("div", { hasText: text }).last();
    await expect(reviewCol.getByText(text)).toBeVisible({ timeout: 10000 });
    await card.getByRole("button", { name: "Approva" }).click();
    await expect(page.getByTestId("kanban-column-done").getByText(text)).toBeVisible({ timeout: 10000 });
    await expect(reviewCol.getByText(text)).not.toBeVisible();
  });

  test("BOARD-06: dispatch pill flips with the settings toggle", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-07" });
    await page.goto("/");
    await openProjectBoard(page);

    const pill = page.getByTestId("board-dispatch-pill");
    await expect(pill).toContainText("agent: off");
    await pill.click(); // opens the settings panel
    const toggle = page.locator('input[type="checkbox"]').first();
    await toggle.check();
    await expect(pill).toContainText("agent: on");
    // Restore: this board must stay manual for the other tests.
    await toggle.uncheck();
    await expect(pill).toContainText("agent: off");
  });

  test("BOARD-07: Board generale opens from the standalone + menu and crosses projects", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-06" });
    // Seed tasks on TWO boards: the project one + a second ad-hoc board.
    const otherId = "otherproj-e2e001";
    const a = `Cross A ${Date.now()}`;
    const b = `Cross B ${Date.now()}`;
    await apiCreateTask(page.request, { text: a, status: "todo" });
    await apiCreateTask(page.request, { text: b, status: "todo" }, otherId);

    await resetPaneStore(page.request, []).catch(() => {});
    await page.goto("/");

    // Standalone tab bar "+" → Board generale (the entry this change adds).
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();

    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 10000 });
    await expect(board.getByText(a)).toBeVisible({ timeout: 10000 });
    await expect(board.getByText(b)).toBeVisible();
    // Project badge on cross-project cards (label = dirName before the hash).
    await expect(board.getByText("otherproj", { exact: true })).toBeVisible();
  });
});

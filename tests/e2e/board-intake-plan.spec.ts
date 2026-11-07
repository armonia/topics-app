/**
 * board-intake-plan.spec.ts: a request that names a project is PROPOSED
 * before anything is created (card a5906c31). Cancel leaves the board as it
 * was; confirm creates the ticked rows, parent first, the sub-card under it.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { basename } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-plan-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);
const PROJECT_NAME = basename(PROJECT_PATH);
// A second project: a request can span two boards.
const OTHER_PATH = `${canonicalTmpRoot()}/e2e-planb-${Date.now()}`;
const OTHER_ID = boardIdForPath(OTHER_PATH);
const OTHER_NAME = basename(OTHER_PATH);
let otherTopicId: string | null = null;

let projectTopicId: string | null = null;

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    if ((await projectsSection.getAttribute("aria-expanded")) === "false") await projectsSection.click();
  }
  const btn = projectRow(page, new RegExp(PROJECT_NAME));
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
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

async function boardTasks(request: import("@playwright/test").APIRequestContext, boardId = PROJECT_ID) {
  const res = await request.get(`${BASE}/api/boards/${boardId}/tasks`);
  return ((await res.json()) as { tasks: { id: string; text: string; parentTaskId: string | null }[] }).tasks;
}

test.describe("Multi-project intake proposal", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-plan" }, null, 2));
    projectTopicId = (await createTopic(request, "E2E-Plan", { projectPath: PROJECT_PATH })).id;
    mkdirSync(OTHER_PATH, { recursive: true });
    writeFileSync(`${OTHER_PATH}/package.json`, JSON.stringify({ name: "e2e-planb" }, null, 2));
    otherTopicId = (await createTopic(request, "E2E-PlanB", { projectPath: OTHER_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    for (const t of await boardTasks(request)) await deleteTask(request, PROJECT_ID, t.id);
    for (const t of await boardTasks(request, OTHER_ID)) await deleteTask(request, OTHER_ID, t.id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    if (otherTopicId) await deleteTopic(request, otherTopicId);
    removeTmpDir(PROJECT_PATH);
    removeTmpDir(OTHER_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("nothing is created before confirm; confirm creates parent then sub-card", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(`@${PROJECT_NAME} Fix the relay timeout\n  Add a regression test`);
    await page.getByTestId("composer-send").click();

    const plan = page.getByTestId("intake-plan");
    await expect(plan).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("intake-plan-row")).toHaveCount(2);
    expect(await boardTasks(request)).toHaveLength(0);

    // Cancel leaves the board unchanged.
    await page.getByTestId("intake-plan-cancel").click();
    await expect(plan).toHaveCount(0);
    expect(await boardTasks(request)).toHaveLength(0);

    // Send again and confirm.
    await page.getByTestId("composer-send").click();
    await expect(plan).toBeVisible();
    await page.getByTestId("intake-plan-confirm").click();
    await expect(plan).toHaveCount(0, { timeout: 15000 });

    const all = await boardTasks(request);
    const parent = all.find((t) => t.text.startsWith("Fix the relay"));
    expect(parent).toBeTruthy();
    const child = all.find((t) => t.text.startsWith("Add a regression"));
    // Sub-cards are not roots: the roots list holds only the parent.
    expect(child).toBeUndefined();
    const full = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${parent!.id}`);
    expect(JSON.stringify(await full.json())).toContain("Add a regression");
  });
  test("Enter with the proposal open confirms it: one parent, no stray card", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(`@${PROJECT_NAME} Alpha task
  Beta sub task`);
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toBeVisible({ timeout: 10000 });
    expect(await boardTasks(request)).toHaveLength(0);
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toHaveCount(0, { timeout: 15000 });
    const roots = await boardTasks(request);
    expect(roots).toHaveLength(1);
    expect(roots[0].text).toContain("Alpha");
  });

  test("a single line naming a project stays one card, no proposal", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(`@${PROJECT_NAME} Gamma single card`);
    await composer.press("Enter");
    await expect.poll(async () => (await boardTasks(request)).length, { timeout: 15000 }).toBe(1);
    await expect(page.getByTestId("intake-plan")).toHaveCount(0);
  });

  test("a row with no project is not created on Enter, and the text survives", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    const text = `@${PROJECT_NAME} Delta task
- ask @nobody about the retry`;
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toBeVisible({ timeout: 10000 });
    await composer.press("Enter");
    await page.getByTestId("intake-plan").waitFor();
    expect(await boardTasks(request)).toHaveLength(0);
    const stray = await request.get(`${BASE}/api/boards/null/tasks`);
    expect(JSON.stringify(await stray.json().catch(() => []))).not.toContain("Delta");
    await expect(composer).toHaveValue(text);
  });

  test("all rows unticked then Enter creates nothing and keeps the request", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    const text = `@${PROJECT_NAME} Epsilon task
- Zeta task`;
    await composer.fill(text);
    await composer.press("Enter");
    const checks = page.getByTestId("intake-plan-check");
    for (let n = (await checks.count()) - 1; n >= 0; n--) await checks.nth(n).uncheck();
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toBeVisible();
    expect(await boardTasks(request)).toHaveLength(0);
    await expect(composer).toHaveValue(text);
  });

  test("a list for one project can be sent as ONE card", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(`${PROJECT_NAME}: fix the composer
- Enter should confirm
- add tests`);
    await composer.press("Enter");
    await page.getByTestId("intake-plan-single").click();
    await expect.poll(async () => (await boardTasks(request)).length, { timeout: 15000 }).toBe(1);
    await expect(page.getByTestId("intake-plan")).toHaveCount(0);
  });

  test("two projects and a row with no project: nothing is born until the row is dropped, then one card per board", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-106" });
    await page.goto("/");
    await openProjectBoard(page);
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    const text = `@${PROJECT_NAME} Theta task
[${OTHER_NAME}] Iota task
- ask @nobody about the retry`;
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("intake-plan-row")).toHaveCount(3);
    // Enter on a proposal that cannot be confirmed creates nothing on any board, and keeps the text.
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toBeVisible();
    expect(await boardTasks(request)).toHaveLength(0);
    expect(await boardTasks(request, OTHER_ID)).toHaveLength(0);
    expect(await boardTasks(request, "null")).toHaveLength(0);
    await expect(composer).toHaveValue(text);
    // Drop the row without a project: Enter now confirms, one card on each board.
    await page.getByTestId("intake-plan-check").nth(2).uncheck();
    await composer.press("Enter");
    await expect(page.getByTestId("intake-plan")).toHaveCount(0, { timeout: 15000 });
    expect((await boardTasks(request)).map((t) => t.text)).toEqual([expect.stringContaining("Theta")]);
    expect((await boardTasks(request, OTHER_ID)).map((t) => t.text)).toEqual([expect.stringContaining("Iota")]);
  });
});

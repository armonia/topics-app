/**
 * board-misleading-review-buttons.spec.ts — three review-column buttons that
 * said one thing and did another (2026-11-11 review).
 *
 * 1. "Invia all'agente" on a card whose land already closed its loop
 *    (landed): `/comments` keeps any message there a note (tasks-board.ts),
 *    so the composer must not promise a turn — it reads as a plain note
 *    instead (`canSendToAgent` in shared/board.ts).
 * 2. After "Archivia" the open drawer must not keep showing "Review" with
 *    its decision buttons live: it banners "Archiviata" with a restore
 *    button instead (`archived` now rides on the Task/BoardTask shape).
 * 3. "Approva" on a card with a real, unmerged delivery closes the card
 *    WITHOUT merging it (by design — see "approve decoupled from landing" in
 *    tasks.landing.test.ts): the drawer now says so right next to the
 *    button, before the click (`hasDeliveryToMerge` in client/src/lib/board.ts).
 *
 * The fourth button from that review ("Approva" on an un-landed branch
 * closing silently) is the same note as above; the third one (a
 * human-closed card reopening itself after a land retry) has no rendered
 * surface — it is covered server-side in
 * server/routes/tasks.landing-failures.test.ts.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-misleading-btns-${process.pid}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createReviewTask(request: any, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "backlog" } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  const moved = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, { data: { status: "review" } });
  expect(moved.ok()).toBe(true);
  return task;
}

async function bindTopic(request: any, taskId: string): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${taskId}/bind-topic`, { data: { topicId: projectTopicId } });
  expect(res.ok(), `bind-topic: ${res.status()}`).toBe(true);
}

async function seedLanding(
  request: any,
  taskId: string,
  landing: { branch?: string | null; commit?: string | null; state?: string | null; filesChanged?: number },
): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${taskId}/landing`, { data: landing });
  expect(res.ok(), `seed landing: ${res.status()}`).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-misleading-btns/);
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

async function openDrawer(page: Page, text: string) {
  const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.click();
  const drawer = page.getByTestId("task-detail-drawer");
  await expect(drawer).toBeVisible({ timeout: 10000 });
  return drawer;
}

test.describe("Tre bottoni della review che dicevano una cosa e ne facevano un'altra", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 1800, height: 1000 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-misleading-btns" }, null, 2));
    const topic = await createTopic(request, "E2E-MisleadingButtons", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("1. su una card atterrata il composer non promette più un turno all'agente", async ({ page, request }) => {
    const text = `Atterrata ${Date.now()}`;
    const task = await createReviewTask(request, text);
    await bindTopic(request, task.id);
    await seedLanding(request, task.id, { branch: "topics/atterrata", commit: "a".repeat(40), state: "landed" });

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);

    const composer = drawer.getByTestId("task-reply-input");
    await expect(composer).toHaveAttribute("placeholder", "Commenta: resta sulla card.");
    const submit = drawer.getByTestId("task-composer-submit");
    await expect(submit).not.toHaveAttribute("title", "Invia all'agente");
  });

  test("2. dopo «Archivia» il drawer banna «Archiviata», non Review coi bottoni vivi", async ({ page, request }) => {
    const text = `Da archiviare ${Date.now()}`;
    const task = await createReviewTask(request, text);

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);
    await expect(drawer.getByTestId("task-review-actions")).toBeVisible();

    const del = await page.request.delete(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`);
    expect(del.ok()).toBe(true);

    await expect(drawer.getByTestId("task-archived-banner")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-review-actions")).toHaveCount(0);
    await expect(drawer.getByTestId("task-archived-restore")).toBeVisible();
  });

  test("4. «Approva» su un ramo non unito avvisa PRIMA del click", async ({ page, request }) => {
    const text = `Zeno ok informativa ${Date.now()}`;
    const task = await createReviewTask(request, text);
    await bindTopic(request, task.id);
    await seedLanding(request, task.id, { branch: "topics/zeno-informativa", commit: "b".repeat(40), state: "unlanded", filesChanged: 2 });

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);

    await expect(drawer.getByTestId("task-approve-leaves-branch-note")).toBeVisible();
    await expect(drawer.getByTestId("task-approve-leaves-branch-note")).toContainText("Landa su main");
    await expect(drawer.getByTestId("task-land")).toBeVisible();
  });
});

/**
 * board-misleading-review-buttons.spec.ts — three review-column buttons that
 * said one thing and did another (2026-11-11 review).
 *
 * 1. "Invia all'agente" on a card whose land already closed its loop allow-italian: quoted UI label
 *    (landed): `/comments` keeps any message there a note (tasks-board.ts),
 *    so the composer must not promise a turn, it reads as a plain note
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
import { expect, type Locator, type Page } from "@playwright/test";
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

async function taskOf(request: any, id: string): Promise<{ status: string; archived?: boolean; landingState?: string | null }> {
  const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.task ?? body;
}

async function openDrawer(page: Page, text: string) {
  const card = page.getByTestId("kanban-column-review").locator("[data-task-card]", { hasText: text });
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.click();
  const drawer = page.getByTestId("task-detail-drawer");
  await expect(drawer).toBeVisible({ timeout: 10000 });
  return drawer;
}

// The review decisions live under the delivery tab of the drawer, not on the
// default conversation view.
async function openDeliveryTab(drawer: Locator) {
  await drawer.getByTestId("task-delivery-toggle").click();
}

test.describe("Quattro bottoni della review che dicevano una cosa e ne facevano un'altra", () => {
  test.describe.configure({ timeout: 90_000 });
  test.beforeEach(() => {
    test.info().annotations.push({ type: "spec", description: "REVIEW-BUTTONS-01" });
  });
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

  test("1a. su una card atterrata scrivere e inviare salva una nota: il bottone non promette un turno", async ({ page, request }) => {
    const text = `Atterrata ${Date.now()}`;
    const task = await createReviewTask(request, text);
    await bindTopic(request, task.id);
    await seedLanding(request, task.id, { branch: "topics/atterrata", commit: "a".repeat(40), state: "landed" });

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);

    const submit = drawer.getByTestId("task-composer-submit");
    await expect(submit).not.toHaveAttribute("title", "Invia all'agente");
    await drawer.getByTestId("task-reply-input").fill("una cosa in più");
    await submit.click();

    await expect(drawer.getByTestId("task-comment-receipt")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-comment-queued")).toHaveCount(0);
    expect((await taskOf(request, task.id)).status).toBe("review");
  });

  test("1b. a turni finiti il bottone dice «Rimandalo avanti» e l'invio porta la frase", async ({ page, request }) => {
    const text = `[Jarvis] Prova a secco ${Date.now()}`;
    const task = await createReviewTask(request, text);
    await bindTopic(request, task.id);
    const seeded = await request.post(`${BASE}/api/test/tasks/${task.id}/system-delivery`, { data: { cause: "retries_exhausted" } });
    expect(seeded.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);

    const submit = drawer.getByTestId("task-composer-submit");
    await expect(submit).toHaveAttribute("title", "Rimandalo avanti");
    await drawer.getByTestId("task-reply-input").fill("riprova da qui");
    await submit.click();

    // The e2e server has no dispatcher, so the restart itself is proven by
    // server/routes/tasks.archived-comment.test.ts (queued + in_progress);
    // here the button carried the words and the thread shows them.
    await expect(drawer.getByText("riprova da qui")).toBeVisible({ timeout: 10000 });
  });

  test("2. dopo «Archivia» il drawer dice «Archiviata»: niente stato, niente bottoni, niente invio all'agente; «Ripristina» riporta tutto", async ({ page, request }) => {
    const text = `Da archiviare ${Date.now()}`;
    const task = await createReviewTask(request, text);
    await bindTopic(request, task.id);

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);
    await openDeliveryTab(drawer);
    await expect(drawer.getByTestId("task-review-actions")).toBeVisible();
    await expect(drawer.getByTestId("task-status-chip")).toContainText("Review");

    // The real gesture: right click on the card, then «Archivia».
    await page.getByTestId("kanban-column-review").locator(`[data-task-card="${task.id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archivia" }).click();

    await expect(drawer.getByTestId("task-archived-banner")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-status-chip")).toContainText("Archiviata");
    await expect(drawer.getByTestId("task-status-chip")).toBeDisabled();
    await expect(drawer.getByTestId("task-review-actions")).toHaveCount(0);
    await expect(drawer.getByTestId("task-reply-quiet-note")).toHaveCount(0);
    await expect(drawer.getByTestId("task-composer-submit")).not.toHaveAttribute("title", "Invia all'agente");

    // A message on it is a note: the card stays archived and nobody restarts.
    await drawer.getByTestId("task-reply-input").fill("ancora una cosa");
    await drawer.getByTestId("task-composer-submit").click();
    await expect(drawer.getByTestId("task-comment-queued")).toHaveCount(0);
    const still = await taskOf(request, task.id);
    expect(still.status).toBe("review");
    expect(still.archived).toBeTruthy();

    await drawer.getByTestId("task-archived-restore").click();
    await expect(drawer.getByTestId("task-archived-banner")).toHaveCount(0, { timeout: 10000 });
    await expect(drawer.getByTestId("task-status-chip")).toContainText("Review");
    if (!(await drawer.getByTestId("task-review-actions").isVisible())) await openDeliveryTab(drawer);
    await expect(drawer.getByTestId("task-review-actions")).toBeVisible();
  });

  test("4. «Approva» su un ramo non unito: la riga lo dice prima, e dopo il click il codice è davvero ancora fuori", async ({ page, request }) => {
    const text = `Zeno ok informativa ${Date.now()}`;
    const task = await createReviewTask(request, text);
    await bindTopic(request, task.id);
    await seedLanding(request, task.id, { branch: "topics/zeno-informativa", commit: "b".repeat(40), state: "unlanded", filesChanged: 2 });

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openDrawer(page, text);
    await openDeliveryTab(drawer);

    const note = drawer.getByTestId("task-approve-leaves-branch-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Approva");
    await expect(note).toContainText("Landa su main");
    await expect(drawer.getByTestId("task-land")).toHaveText(/Landa su main/);

    await drawer.getByTestId("task-approve").click();
    await expect.poll(async () => (await taskOf(request, task.id)).status, { timeout: 10000 }).toBe("done");
    // Approve closed the card and merged nothing: that is what the line said.
    expect((await taskOf(request, task.id)).landingState).not.toBe("landed");
  });
});

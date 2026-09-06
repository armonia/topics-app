/**
 * board-fanout.spec.ts — il pannello "Tentativi" e la scelta del vincitore.
 *
 * Il fan-out manda lo STESSO task a N agenti in worktree paralleli; a fine giro
 * il task arriva in review con N alternative e una sola sopravvive. Il verbo
 * interessante è la SCELTA: scegliere un tentativo ri-punta
 * `tasks.assigned_topic_id` sul suo topic — l'unica indirezione su cui viaggiano
 * già diff, checks, consegna, land e reap. Se quel ri-puntamento non avviene,
 * l'umano approva il lavoro di un altro agente credendo di approvare quello che
 * ha scelto: è il fallimento silenzioso che questo test rende rumoroso.
 *
 * L'unica scorciatoia è la semina dei tentativi (`POST /api/test/tasks/:id/attempts`,
 * armata solo con TOPICS_E2E=1): quelle righe nel mondo vero le scrive il
 * dispatcher lanciando N agenti Claude, che qui non si possono far girare. Tutto
 * il resto — pannello, bottoni, route di scelta, potatura dei perdenti — è il
 * codice di produzione.
 *
 * @covers KANBAN-13, KANBAN-14
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import {
  createTopic,
  deleteTopic,
  deleteTask,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
} from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-fanout-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
/** Le chat dei due tentativi: topic veri, perché `assigned_topic_id` ha una FK. */
let topicA: string | null = null;
let topicB: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

async function apiCreateTask(request: Req, text: string, status = "review"): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

interface SeedAttempt {
  idx: number; topicId: string; branch?: string; state: "running" | "delivered" | "failed";
  filesChanged?: number; insertions?: number; deletions?: number; summary?: string; commit?: string;
}

/**
 * Semina il giro come lo lascia il dispatcher: le N righe dei tentativi PIÙ il
 * legame del task alla chat del tentativo 1 — che è il deep-link di partenza,
 * quello che la scelta deve spostare.
 */
async function seedAttempts(request: Req, taskId: string, attempts: SeedAttempt[]): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${taskId}/attempts`, { data: { attempts } });
  expect(res.ok()).toBe(true);
  const bind = await request.post(`${BASE}/api/test/tasks/${taskId}/bind-topic`, { data: { topicId: attempts[0].topicId } });
  expect(bind.ok()).toBe(true);
}

async function taskTopic(request: Req, taskId: string): Promise<string | null> {
  const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`);
  expect(res.ok()).toBe(true);
  const { task } = (await res.json()) as { task: { assignedTopicId: string | null } };
  return task.assignedTopicId;
}

/** Apre la finestra del progetto e2e (stesso percorso di board.spec.ts). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-fanout/);
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
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Fan-out: scelta del tentativo", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-fanout" }, null, 2));
    projectTopicId = (await createTopic(request, "E2E-Fanout", { projectPath: PROJECT_PATH })).id;
    topicA = (await createTopic(request, "E2E-Fanout · tentativo 1", { projectPath: PROJECT_PATH })).id;
    topicB = (await createTopic(request, "E2E-Fanout · tentativo 2", { projectPath: PROJECT_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    for (const id of [topicA, topicB, projectTopicId]) if (id) await deleteTopic(request, id);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("FANOUT-01: due tentativi a confronto, e scegliere uno ri-punta il task sulla sua chat", async ({ page }) => {
    const text = `Fanout task ${Date.now()}`;
    const task = await apiCreateTask(page.request, text);
    await seedAttempts(page.request, task.id, [
      { idx: 1, topicId: topicA!, branch: "task/wt-a", state: "delivered", commit: "aaa111", filesChanged: 1, insertions: 5, deletions: 0, summary: "Toppa minima sul solo caso segnalato." },
      { idx: 2, topicId: topicB!, branch: "task/wt-b", state: "delivered", commit: "bbb222", filesChanged: 3, insertions: 40, deletions: 4, summary: "Rifatta la funzione e coperta con due test." },
    ]);

    await page.goto("/");
    await openProjectBoard(page);
    await page.getByTestId("kanban-column-review").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // Il confronto: quanti sono, cosa ha prodotto ognuno, cosa dice di sé.
    await expect(drawer.getByText("2 in parallelo")).toBeVisible({ timeout: 10000 });
    const first = drawer.getByTestId("task-attempt-1");
    const second = drawer.getByTestId("task-attempt-2");
    await expect(first).toContainText("1 file");
    await expect(second).toContainText("3 file");
    await expect(second).toContainText("Rifatta la funzione");
    await expect(second).toContainText("task/wt-b");

    // Il task punta ancora al tentativo 1 (il deep-link di partenza).
    expect(await taskTopic(page.request, task.id)).toBe(topicA);

    await second.getByTestId("task-attempt-pick").click();

    // Esito visibile: uno scelto, l'altro scartato e senza più bottoni.
    await expect(second).toContainText("scelto", { timeout: 10000 });
    await expect(first).toContainText("scartato");
    await expect(drawer.getByTestId("task-attempt-pick")).toHaveCount(0);

    // Esito STRUTTURALE, il vero contratto: il task adesso è il tentativo 2.
    await expect.poll(() => taskTopic(page.request, task.id), { timeout: 10000 }).toBe(topicB);
  });

  test("FANOUT-02: con un tentativo ancora al lavoro non si sceglie niente", async ({ page }) => {
    const text = `Fanout vivo ${Date.now()}`;
    const task = await apiCreateTask(page.request, text, "in_progress");
    await seedAttempts(page.request, task.id, [
      { idx: 1, topicId: topicA!, branch: "task/wt-a", state: "delivered", filesChanged: 2, insertions: 9, deletions: 1, commit: "aaa111" },
      { idx: 2, topicId: topicB!, branch: "task/wt-b", state: "running" },
    ]);

    await page.goto("/");
    await openProjectBoard(page);
    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer.getByText("2 in parallelo")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText("1 in corso")).toBeVisible();
    // Scegliere adesso vorrebbe dire potare un worktree mentre ci lavora un agente.
    await expect(drawer.getByTestId("task-attempt-pick")).toHaveCount(0);
  });
});

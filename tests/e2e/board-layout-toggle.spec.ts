/**
 * board-layout-toggle.spec.ts — la vista lista è un'alternativa al kanban, non
 * un secondo pannello.
 *
 * Il tasto accanto alla ricerca non apre niente: RISCRIVE la board. In vista
 * kanban le colonne stanno affiancate, una corsia di carosello ciascuna; in
 * vista lista si impilano verticali a piena larghezza, e una colonna senza
 * card e senza bozza in corso non disegna nemmeno l'intestazione — è il
 * difetto che la vista lista esiste per correggere (in vista kanban quella
 * stessa colonna vuota resta un bersaglio di drop visibile).
 *
 * Un solo task, in una sola colonna: con card in ogni stato «la lista non
 * mostra le vuote» sarebbe indistinguibile da «la lista mostra tutto». Qui
 * quattro colonne su cinque SONO vuote, quindi la loro assenza è il segnale,
 * non il rumore.
 *
 * Il ricaricamento della pagina è la prova che la scelta persiste: un
 * `aria-pressed` che torna a "false" dopo un F5 sarebbe uno stato del
 * componente, non una preferenza di chi guarda la board.
 *
 * @covers KANBAN-94
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = canonicalTmpDir(`e2e-layouttoggle-${process.pid}`);
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const SOLA_CARD = "Scrivere il changelog";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo" } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-layouttoggle/);
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

const beat = (page: Page, ms = 900) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Vista lista della board · toggle, forma, persistenza", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 1120, height: 620 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-layouttoggle" }, null, 2));
    const topic = await createTopic(request, "E2E-LayoutToggle", { projectPath: PROJECT_PATH });
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

  test("il tasto alterna kanban e lista, le colonne vuote spariscono solo in lista, e la scelta sopravvive al reload", async ({ page, request }) => {
    const task = await createTask(request, SOLA_CARD);

    await page.goto("/");
    await openProjectBoard(page);

    const toggle = page.getByTestId("board-layout-toggle");
    const todoCol = page.getByTestId("kanban-column-todo");
    const backlogCol = page.getByTestId("kanban-column-backlog");
    const card = page.locator(`[data-task-card="${task.id}"]`);

    // ── 1. Kanban di default: tutte le colonne ci sono, anche le vuote ──────
    await expect(todoCol).toBeVisible({ timeout: 10000 });
    await expect(backlogCol).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await beat(page, 1200);

    // ── 2. Un click: la board diventa lista, le colonne vuote spariscono ────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(backlogCol).toHaveCount(0, { timeout: 10000 });
    await expect(todoCol).toBeVisible();
    await expect(todoCol.locator(`[data-task-card="${task.id}"]`)).toContainText(SOLA_CARD);
    await beat(page, 1400);

    // ── 3. Reload: la vista lista non era solo stato del componente ─────────
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(backlogCol).toHaveCount(0, { timeout: 10000 });
    await expect(todoCol).toBeVisible();
    await beat(page, 1400);

    // ── 4. Torna a kanban: le colonne vuote ricompaiono ──────────────────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(backlogCol).toBeVisible({ timeout: 10000 });
    await expect(card).toBeVisible();
    await beat(page, 1200);
  });
});

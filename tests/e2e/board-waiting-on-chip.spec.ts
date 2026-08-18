/**
 * board-waiting-on-chip.spec.ts — «N la aspettano» conta anche i dipendenti che
 * non sono nella lista della board.
 *
 * L'altra metà del legame di `board-blocked-chip.spec.ts`. Il caso che
 * rompeva: la card contava i dipendenti fra i task fetchati — un progetto,
 * `rootsOnly`, non archiviati. Un dipendente fuori da quel taglio (qui: un
 * SOTTOTASK, che per contratto non è mai una card) non veniva contato, e la
 * card del bloccante si presentava libera proprio da dove si decide se
 * chiudere il lavoro. Ora il contatore lo risolve il server
 * (`task.waitingOnCount`), sul DB.
 *
 * È anche la clip di consegna: due dipendenti ma UNA sola card in giro sulla
 * board → «2 la aspettano»; ne chiude uno → «1 la aspetta»; chiude il sottotask
 * (che sulla board non c'è mai stato) → il chip si spegne. Un comportamento,
 * non uno screenshot.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-waiting-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const BLOCCANTE = "Migrare le foto sul nuovo bucket";
const EPICA = "Rifare la scheda prodotto";
const SOTTOTASK = "Ricontrollare i permessi del bucket";
const DIPENDENTE = "Pubblicare la scheda nuova";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function closeTask(request: any, taskId: string): Promise<void> {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status: "done" } });
  expect(res.ok()).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-waiting/);
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

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Chip «N la aspettano» · dipendenti fuori dalla lista", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-waiting" }, null, 2));
    const topic = await createTopic(request, "E2E-Waiting", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // In ordine INVERSO: il figlio prima del padre, il bloccato prima del bloccante.
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("conta anche il dipendente che è un sottotask, e si spegne quando l'ultimo chiude", async ({ page, request }) => {
    const bloccante = await createTask(request, { text: BLOCCANTE, status: "in_progress" });
    const epica = await createTask(request, { text: EPICA, status: "in_progress" });
    // Dipendente n.1: un SOTTOTASK dell'epica — la board fetcha `rootsOnly`,
    // quindi non è mai una card. È il caso che rompeva.
    const sottotask = await createTask(request, { text: SOTTOTASK, parentTaskId: epica.id, blockedByTaskId: bloccante.id });
    // Dipendente n.2: una card normale, quella che si contava già.
    const dipendente = await createTask(request, { text: DIPENDENTE, status: "todo", blockedByTaskId: bloccante.id });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${bloccante.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    // Tre card sulla board (bloccante, epica, dipendente): il sottotask non è
    // fra i task fetchati, eppure il contatore dice DUE — cioè non viene da lì.
    await expect(page.locator("[data-task-card]")).toHaveCount(3);
    const chip = card.getByTestId("card-waiting-on-this");
    await expect(chip).toContainText("2 la aspettano");
    await expect(chip).toHaveAttribute("title", /2 task aspettano questa card/);
    await beat(page, 2200);

    // Chiude il dipendente che è una card: resta quello invisibile, e il
    // contatore lo sa (prima sarebbe andato a zero, cioè chip sparito).
    await closeTask(request, dipendente.id);
    await expect(chip).toContainText("1 la aspetta", { timeout: 10000 });
    await expect(chip).toHaveAttribute("title", /Un task aspetta questa card/);
    await beat(page, 2200);

    // Chiude il sottotask: nessuno aspetta più, il chip si spegne.
    await closeTask(request, sottotask.id);
    await expect(card.getByTestId("card-waiting-on-this")).toHaveCount(0, { timeout: 10000 });
    await beat(page, 2200);
  });
});

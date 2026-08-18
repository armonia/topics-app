/**
 * board-blocked-chip.spec.ts — «aspetta: …» si vede anche quando il bloccante
 * non è nella lista della board.
 *
 * Il caso che rompeva: la card disegnava il chip cercando il bloccante fra i
 * task fetchati — un progetto, `rootsOnly`, non archiviati. Un bloccante fuori
 * da quel taglio (qui: un SOTTOTASK, che per contratto non è mai una card) non
 * si trovava, il chip spariva, e la card sembrava libera di partire mentre il
 * dispatcher la teneva ferma. Ora il bloccante lo risolve il server
 * (`task.blockedBy`) e il chip nasce dal LINK.
 *
 * È anche la clip di consegna: card → drawer → picker → il bloccante chiude e
 * il chip si spegne. Un comportamento, non uno screenshot.
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
const PROJECT_PATH = `/tmp/e2e-blocked-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare la scheda prodotto";
const STEP = "Migrare le foto sul nuovo bucket";
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

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-blocked/);
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

test.describe("Chip «aspetta: …» · bloccante fuori dalla lista", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-blocked" }, null, 2));
    const topic = await createTopic(request, "E2E-Blocked", { projectPath: PROJECT_PATH });
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

  test("il chip c'è anche se il bloccante è un sottotask, e si spegne quando chiude", async ({ page, request }) => {
    // Un'epica con un suo step: lo step NON è mai una card (la board fetcha
    // rootsOnly), quindi il client non ce l'ha in mano. È il caso che rompeva.
    const epica = await createTask(request, { text: EPICA, status: "in_progress" });
    const step = await createTask(request, { text: STEP, parentTaskId: epica.id });
    const dipendente = await createTask(request, { text: DIPENDENTE, status: "todo", blockedByTaskId: step.id });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${dipendente.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    // Sulla board ci sono DUE card (l'epica e la dipendente): il bloccante non è
    // fra i task fetchati, eppure il chip lo nomina — cioè non viene da lì.
    await expect(page.locator("[data-task-card]")).toHaveCount(2);
    await expect(card.getByTestId("card-blocked-by")).toContainText(`aspetta: ${STEP}`);
    await beat(page, 2200);

    // Nel drawer il chip sta IN RIGA, non sepolto nel menu ⋯, e apre il picker.
    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    const chip = drawer.getByTestId("task-blocked-by-chip");
    await expect(chip).toContainText(`aspetta: ${STEP}`);
    await beat(page, 2000);
    await chip.click();
    await expect(page.getByTestId("task-blocker-picker")).toBeVisible({ timeout: 5000 });
    await beat(page, 2000);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5000 });

    // Lo step chiude: il bloccante non blocca più e il chip si spegne da solo
    // (stesso predicato del gate di dispatch, che ora fa partire il task).
    const done = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${step.id}`, {
      data: { status: "done" },
    });
    expect(done.ok()).toBe(true);
    await expect(card.getByTestId("card-blocked-by")).toHaveCount(0, { timeout: 10000 });
    await beat(page, 2200);
  });
});

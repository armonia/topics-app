/**
 * board-composer-start.spec.ts — dove nasce un task scritto nel composer.
 *
 * Il composer galleggiante scriveva `status: 'todo'` fisso: qualunque pensiero
 * buttato lì dentro faceva partire un agent, e per parcheggiarlo bisognava
 * crearlo e poi trascinarlo indietro. Il chip «Avvio» rende la scelta esplicita
 * (Todo o Backlog) e ospita «Piano prima», che prima era un toggle nudo senza
 * etichetta di stato.
 *
 * Il giro qui è quello di una persona: scrivo, scelgo Backlog, accendo il
 * piano, invio. La card deve atterrare nella colonna Backlog (non in Todo), il
 * server deve averla registrata ferma e con `planFirst`, e il chip deve tornare
 * al suo default dopo l'invio. È anche la clip di consegna: la scelta di una
 * colonna è un comportamento a più stati, non uno screenshot.
 *
 * @covers KANBAN-07
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
const PROJECT_PATH = `/tmp/e2e-composer-start-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const IDEA = "Idea da tenere da parte: rivedere le spaziature della barra laterale";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-composer-start/);
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

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). A suite normale vale zero. */
const beat = (page: Page, ms = 1200) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Composer: dove nasce il task", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-composer-start" }, null, 2));
    const topic = await createTopic(request, "E2E-ComposerStart", { projectPath: PROJECT_PATH });
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
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("scelgo Backlog e la card resta ferma lì, col piano acceso", async ({ page, request }) => {
    await page.goto("/");
    await openProjectBoard(page);

    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(IDEA);

    // Il chip parte da Todo: il default è quello di sempre, la scelta è nuova.
    const chip = page.getByTestId("composer-start-chip");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(chip).toContainText("Todo");
    await beat(page, 1400);

    // Backlog, e poi il piano: due decisioni indipendenti nello stesso menu.
    await chip.click();
    await expect(page.getByTestId("composer-start-backlog")).toBeVisible({ timeout: 5000 });
    await beat(page, 1600);
    await page.getByTestId("composer-start-backlog").click();
    await expect(chip).toContainText("Backlog");
    await beat(page);

    await chip.click();
    const planRow = page.getByTestId("composer-plan-first");
    await expect(planRow).toHaveAttribute("aria-checked", "false");
    await planRow.click();
    await expect(planRow).toHaveAttribute("aria-checked", "true");
    await beat(page, 1600);
    await page.keyboard.press("Escape");

    await page.getByTestId("composer-send").click();

    // La card atterra in BACKLOG. La colonna è l'asserzione: «esiste una card»
    // sarebbe passata anche con il comportamento vecchio.
    const backlogColumn = page.getByTestId("kanban-column-backlog");
    const card = backlogColumn.locator("[data-task-card]").filter({ hasText: /Idea da tenere da parte/ });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("kanban-column-todo").locator("[data-task-card]")).toHaveCount(0);
    await beat(page, 2000);

    // E il server la registra ferma: nessun agent assegnato, piano richiesto.
    const list = await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks`)).json() as {
      tasks: { id: string; text: string; status: string; planFirst: boolean; assignedTopicId: string | null }[];
    };
    const born = list.tasks.find((t) => t.text.startsWith("Idea da tenere da parte"))!;
    createdTasks.push(`${PROJECT_ID}:${born.id}`);
    expect(born.status).toBe("backlog");
    expect(born.planFirst).toBe(true);
    expect(born.assignedTopicId).toBeNull();

    // Il chip torna al default: la scelta vale per il task che hai appena
    // mandato, non diventa una preferenza silenziosa per il prossimo.
    await expect(chip).toContainText("Todo");
    await beat(page, 1600);
  });
});

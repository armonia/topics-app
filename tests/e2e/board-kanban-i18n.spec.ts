/**
 * board-kanban-i18n.spec.ts — le superfici KANBAN lette in INGLESE.
 *
 * Perché serve una spec sua. Tutta la suite della board gira in italiano
 * (`playwright.config.ts` fissa `locale: "it-IT"`, e la lingua di ripiego di
 * `lib/i18n.ts` è comunque `it`), quindi ogni altra spec ancora i valori
 * ITALIANI: sono loro il cancello che dice se la conversione ha spostato un
 * byte del testo esistente. Questa dice l'altra metà, la sola che quelle non
 * possono vedere: che un inglese ESISTA davvero. Senza, una chiave aggiunta al
 * solo dizionario italiano passa tutti i controlli e resta italiana in una app
 * che si dichiara `lang="en"`.
 *
 * Stesso metodo di `board-task-panels-i18n.spec.ts`, sulle superfici che quella
 * non tocca: la barra dei filtri, il composer galleggiante, la testa e il piede
 * di una colonna, il menu contestuale di una card e l'anteprima della consegna.
 *
 * Le tre superfici sotto esame sono `Board/KanbanBoardPane.tsx`,
 * `Board/FloatingTaskComposer.tsx` e `Board/Card.tsx`.
 *
 * NON si prova qui, di proposito: i nomi delle etichette (`visibile`,
 * `decisione`, `invisibile`), gli stati e il testo che scrivono gli agenti.
 * Sono DATI, li scrive anche il server, e restano quelli in ogni lingua.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const STAMP = Date.now();
const REPO = `/tmp/topics-e2e-kanban-i18n-${STAMP}`;

const PROJECT_ID = boardIdForPath(REPO);

const CARD_TEXT = `Kanban i18n E2E ${STAMP}`;
let topicId = "";
let taskId = "";

/** Apre la board di PROGETTO: è l'unica con «Add» in colonna e i filtri pieni. */
async function openProjectBoard(page: Page) {
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") {
    await section.click();
  }
  const row = projectRow(page, /topics-e2e-kanban-i18n/);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      await item.click();
      await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("nessun menu «+» con la voce Board");
}

test.describe.serial("Kanban in inglese", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/CLAUDE.md`, "# kanban-i18n\n");
    topicId = (await createTopic(request, `kanban-i18n-${STAMP}`, { projectPath: REPO })).id;
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: CARD_TEXT, status: "todo" },
    });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    rmSync(REPO, { recursive: true, force: true });
    // La lingua è preferenza di UTENTE, condivisa da tutta la suite attraverso
    // `ui_state`: lasciarla in inglese renderebbe rosse le spec italiane dopo.
    await request.put(`${API}/ui-state/settings`, { data: { language: "auto" } });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
    // I DUE depositi che l'app legge: localStorage dipinge il primo frame,
    // `ui_state` idrata subito dopo. Scriverne uno solo vuol dire vedere
    // l'inglese e poi guardarlo tornare italiano.
    await page.request.put(`${API}/ui-state/settings`, { data: { language: "en" } });
    await page.addInitScript(() => {
      const KEY = "app-settings";
      let cur: Record<string, unknown> = {};
      try { cur = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>; } catch { /* vuoto */ }
      localStorage.setItem(KEY, JSON.stringify({ ...cur, language: "en" }));
    });
  });

  test("KANBAN-I18N-01: barra dei filtri e composer parlano inglese", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "I18N-03" });
    await page.goto("/");
    await openProjectBoard(page);

    // Filtri: la ricerca (che ha un nome accessibile, non solo un placeholder),
    // il chip di priorità e quello delle etichette.
    await expect(page.getByLabel("Search the tasks")).toBeVisible({ timeout: 10000 });
    // Priority and assignee are NOT two chips any more: since 8ad974d55 they
    // are a single autocomplete token field, so what gets checked here are the
    // strings that field actually exposes — its accessible label and the hint
    // it shows while empty. Still looking for a «Priority» button would test an
    // interface that no longer exists: the test would stay red forever saying
    // "not translated" about something that merely changed.
    const priorityField = page.getByTestId("filter-token-input");
    await expect(priorityField).toBeVisible();
    await expect(priorityField).toHaveAttribute("aria-label", "Filter by priority or assignee");
    await expect(priorityField).toHaveAttribute("placeholder", "priority, @assignee…");
    await expect(page.getByTestId("filter-labels-chip")).toHaveAttribute("title", "Filter by label");

    // Il menu delle etichette: le INTESTAZIONI si traducono, i nomi delle
    // etichette no (sono dati, il server ci confronta sopra in `whoCloses`).
    await page.getByTestId("filter-labels-chip").click();
    await expect(page.getByText("Who closes it")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Kind")).toBeVisible();
    await expect(page.getByRole("option", { name: "visibile", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    // Composer galleggiante: il placeholder e i chip che decidono come nasce.
    const composer = page.getByTestId("board-task-composer");
    await expect(composer).toBeVisible({ timeout: 10000 });
    await composer.locator("textarea").click();
    await expect(composer.getByPlaceholder("Describe a task for the agent…")).toBeVisible();
    await expect(page.getByTestId("composer-model-chip")).toContainText("Auto model");
    await expect(page.getByTestId("composer-priority-chip")).toContainText("Auto priority");
    await page.getByTestId("composer-start-chip").click();
    await expect(page.getByText("It starts right away: an agent picks it off the queue.")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Plan first")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("KANBAN-I18N-02: colonna e menu della card parlano inglese", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    const todo = page.getByTestId("kanban-column-todo");
    await expect(todo.getByText(CARD_TEXT)).toBeVisible({ timeout: 10000 });

    // Il piede della colonna: «Add», e la sua forma aperta con «Cancel».
    await todo.getByRole("button", { name: "Add" }).click();
    await expect(todo.getByPlaceholder("Task…")).toBeVisible({ timeout: 5000 });
    await expect(todo.getByRole("button", { name: "Cancel" })).toBeVisible();
    await todo.getByRole("button", { name: "Cancel" }).click();

    // Il menu contestuale della card. È la superficie in cui la parola conta di
    // più, perché ogni voce è un'azione: «Open the card» e «Copy task» sono
    // testo di questo file, il resto arriva dalla tavola delle azioni.
    const card = todo.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Open the card" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("menuitem", { name: "Copy task" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

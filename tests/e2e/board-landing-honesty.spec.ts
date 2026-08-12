/**
 * board-landing-honesty.spec.ts — «Done» non deve mentire sulla SINGOLA card.
 *
 * IL GUASTO CHE COPRE. Il 19/07 un task fu approvato, il suo branch potato, e
 * 139 righe non arrivarono mai su main: nessuno se ne accorse per otto giorni,
 * perché «done» era una colonna e non un fatto sul repo. L'audit periodico
 * (`server/services/landing-audit.ts`) adesso stampa il verdetto sul task, e la
 * top bar ne mostra il TOTALE — ma un totale non dice QUALE card. Chi guarda la
 * colonna Done continua a credere finito ciò che non è nel prodotto.
 *
 * COSA MISURA, in ordine di quanto costa sbagliarlo:
 *  1. la card in Done lo DICE, e dice anche su quale ramo sta il lavoro;
 *  2. il drawer lo ripete in cima E OFFRE L'AZIONE che lo risolve — prima la
 *     banda diceva «landa il branch» e non c'era niente da premere, perché il
 *     bottone «Landa su main» era recintato dentro `status === 'review'`;
 *  3. il CONTROLLO NEGATIVO: un task done il cui lavoro È su main non porta
 *     nessun allarme. Senza questa terza asserzione le prime due passerebbero
 *     anche con un chip incollato su ogni card, cioè con la board che grida
 *     sempre — che è l'altro modo di mentire.
 *
 * COME SEMINA. `landing_state` + `delivery_branch/commit` le scrivono solo il
 * dispatcher e la passata di audit contro un repo git vero; qui le mette
 * `POST /api/test/tasks/:id/landing` (armata solo con TOPICS_E2E=1, vedi
 * server/routes/e2e.ts), che chiama gli STESSI verbi del servizio. Il task resta
 * fermo in `done`: qui il contratto sotto esame è quello del client.
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

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-landing-${Date.now()}`;

/** BYTE-IDENTICAL a server/services/tasks.ts:projectIdForPath (come board.spec.ts). */
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

const UNLANDED_BRANCH = "topics/ramo-mai-landato";
const UNLANDED_COMMIT = "1dc0964aabbccddeeff00112233445566778899a";
const LANDED_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

/** Un task chiuso, con la fotografia di consegna e il verdetto dell'audit già scritti. */
async function seedDoneTask(
  request: Req,
  text: string,
  landing: { branch?: string | null; commit?: string | null; state: "landed" | "unlanded" },
): Promise<string> {
  // Il servizio rifiuta per contratto un task che NASCE done ("cannot create a
  // task already done"): si nasce in backlog e ci si sposta, come farebbe la
  // review. Backlog e non todo: `todo` è la coda di esecuzione e su un board con
  // auto-dispatch acceso farebbe partire un agente vero.
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text, status: "backlog" },
  });
  expect(res.ok(), `create task: ${res.status()} ${await res.text()}`).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);

  const moved = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, {
    data: { status: "done" },
  });
  expect(moved.ok(), `move to done: ${moved.status()} ${await moved.text()}`).toBe(true);

  const seeded = await request.post(`${BASE}/api/test/tasks/${task.id}/landing`, {
    data: { branch: landing.branch ?? null, commit: landing.commit ?? null, state: landing.state },
  });
  // Un 404 qui significa route di test non armata: va detto SUBITO, non fra
  // dieci secondi travestito da chip mancante.
  expect(seeded.status(), "POST /api/test/tasks/:id/landing deve essere armata (TOPICS_E2E=1)").toBe(200);
  const body = (await seeded.json()) as { task?: { landingState?: string | null } };
  expect(body.task?.landingState, "il verdetto deve essere davvero sul task").toBe(landing.state);
  return task.id;
}

/** Apre la finestra del progetto e2e dalla riga in sidebar (come board.spec.ts). */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-landing/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/** Apre la board del progetto dal "+" della finestra di progetto. */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const n = await triggers.count();
  let opened = false;
  for (let i = 0; i < n; i++) {
    await triggers.nth(i).click();
    if (await item.count()) { await item.click(); opened = true; break; }
    await page.keyboard.press("Escape");
  }
  expect(opened, "nessun menu + con la voce Board (kanban)").toBe(true);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Done non mente: lo stato di atterraggio sta sulla card", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-landing" }, null, 2));
    // Favicon vera: dall'08/08 la riga della board mostra solo i progetti che
    // ne hanno una. Senza, il progetto non comparirebbe e il rosso parlerebbe
    // del setup invece che della regola.
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const topic = await createTopic(request, "E2E-Landing", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("LANDING-01: la card in Done dichiara «non su main» e nomina il ramo", async ({ page }) => {
    const text = `Non landato ${Date.now()}`;
    await seedDoneTask(page.request, text, {
      branch: UNLANDED_BRANCH,
      commit: UNLANDED_COMMIT,
      state: "unlanded",
    });

    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-done");
    const card = done.locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });

    // La parola, sulla card, senza passare da un hover: su touch il `title` non
    // esiste e la card resterebbe muta proprio dove si guarda la colonna.
    const chip = card.getByTestId("card-not-landed");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("non su main");
    // Il RAMO: senza, la card dice che c'è un problema e non dove sta il lavoro.
    await expect(chip).toContainText(UNLANDED_BRANCH);
  });

  test("LANDING-02: il drawer lo ripete e OFFRE l'azione che lo risolve", async ({ page }) => {
    const text = `Drawer non landato ${Date.now()}`;
    await seedDoneTask(page.request, text, {
      branch: UNLANDED_BRANCH,
      commit: UNLANDED_COMMIT,
      state: "unlanded",
    });

    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-done");
    await expect(done.getByText(text)).toBeVisible({ timeout: 10000 });
    await done.getByText(text).click();

    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    const banner = drawer.getByTestId("task-not-landed-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("non su main");
    await expect(banner).toContainText(UNLANDED_BRANCH);
    await expect(banner).toContainText(UNLANDED_COMMIT.slice(0, 8));

    // L'AZIONE. La banda nomina il landing: se non c'è niente da premere, sta
    // dando un compito invece di offrire una via d'uscita.
    const land = banner.getByTestId("task-not-landed-land");
    await expect(land).toBeVisible();
    await expect(land).toBeEnabled();
  });

  test("LANDING-03: controllo negativo — un done LANDATO non porta allarmi", async ({ page }) => {
    const text = `Landato ${Date.now()}`;
    await seedDoneTask(page.request, text, {
      branch: "topics/ramo-landato",
      commit: LANDED_COMMIT,
      state: "landed",
    });

    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-done");
    const card = done.locator("[data-task-card]", { hasText: text });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("card-not-landed")).toHaveCount(0);

    await done.getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-not-landed-banner")).toHaveCount(0);
  });
});

/**
 * board-subtask-deeplink.spec.ts — un id di SOTTOTASK si risolve, e il drawer si
 * apre.
 *
 * Il caso che rompeva, una causa e due sintomi: `GET /api/all-boards/tasks` è
 * `rootsOnly` (le colonne mostrano le radici) ed era l'unico risolutore
 * cross-progetto che il client avesse. Da un id fuori da quel taglio non si
 * arrivava a niente:
 *  1. la board faceva `tasks.find(t => t.id === selectedId)` → `undefined`, e il
 *     click su uno step nell'albero del drawer CHIUDEVA il drawer invece di
 *     aprire lo step;
 *  2. un deep-link `/task/<id-di-sottotask>` restava appeso per sempre —
 *     `pendingSelect` non veniva mai promosso e il drawer non apriva mai.
 * Ora c'è una porta unica, `GET /api/all-boards/tasks/:taskId` → `boardApi
 * .resolve`, e la board la usa per qualunque id non sia nel feed.
 *
 * È anche la clip di consegna: due stati, non uno screenshot — l'albero che
 * naviga, e la URL nuda che apre lo stesso step dopo un reload.
 *
 * @covers KANBAN-08
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-subdeep-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare la scheda prodotto";
const STEP = "Migrare le foto sul nuovo bucket";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(
  request: import("@playwright/test").APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
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
  const btn = projectRow(page, /e2e-subdeep/);
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

test.describe("Sottotask · dall'id al drawer, a qualunque profondità", () => {
  test.describe.configure({ timeout: 120_000 });
  // Viewport più largo del default della suite (1280×800) per una ragione sola:
  // questa spec È la clip di consegna, e l'anteprima di un task viene resa a
  // 268px di larghezza — oltre un rapporto altezza/larghezza di 0.70 la card
  // TAGLIA invece di rimpicciolire. 1440×760 → il video esce 800×422 (0.528) e
  // ci sta intero. Nessuna asserzione qui dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-subdeep" }, null, 2));
    const topic = await createTopic(request, "E2E-SubDeep", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // In ordine INVERSO: il figlio prima del padre.
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("click su uno step apre il SUO drawer, e `/task/<id-di-sottotask>` pure", async ({ page, request }) => {
    // Un'epica con un suo step. Lo step ha una descrizione perché l'albero rende
    // apribile solo un nodo che nel drawer ha qualcosa da mostrare.
    const epica = await createTask(request, { text: EPICA, status: "in_progress", description: "La scheda va rifatta da zero." });
    const step = await createTask(request, { text: STEP, parentTaskId: epica.id, description: "Bucket nuovo, path invariati." });

    // LA PREMESSA, misurata sul server: il feed che alimenta il client non
    // contiene lo step. Se un giorno smettesse di essere `rootsOnly` questo test
    // proverebbe un caso che non esiste più, e va saputo.
    const feed = await (await request.get(`${BASE}/api/all-boards/tasks`)).json() as { tasks: { id: string }[] };
    expect(feed.tasks.some((t) => t.id === epica.id), "l'epica dovrebbe essere nel feed").toBe(true);
    expect(feed.tasks.some((t) => t.id === step.id), "il feed non è più rootsOnly: il caso è cambiato").toBe(false);

    // ── Atto 1: dall'albero del drawer ────────────────────────────────────────
    await page.goto("/");
    await openProjectBoard(page);

    // Sulla board c'è la card dell'epica; quella dello step non esiste, per
    // contratto — è esattamente l'id che il client non sapeva risolvere.
    await expect(page.locator(`[data-task-card="${epica.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-task-card="${step.id}"]`)).toHaveCount(0);
    await didascalia(page, "Lo step NON ha una card: il feed è roots-only");
    await beat(page, 1800);

    await page.locator(`[data-task-card="${epica.id}"]`).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText(EPICA, { exact: true })).toBeVisible();
    await didascalia(page, "1 · click sullo step nell'albero del drawer");
    await beat(page, 1800);

    // Il click sullo step nell'albero. Prima: il drawer si CHIUDEVA.
    await page.getByTestId(`subtask-open-${step.id}`).click();
    await expect(drawer, "il drawer si è chiuso invece di aprire lo step").toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText(STEP, { exact: true })).toBeVisible({ timeout: 10000 });
    // Il drawer è DAVVERO quello dello step, non l'epica con un titolo simile:
    // il link copiabile è l'identità del task che ha sotto.
    // Il link non è più un'icona a catena nella testata: vive dentro il
    // pannello di condivisione, che è l'unico posto dove si chiede un link.
    await drawer.getByTestId("share-control").click();
    await page.getByTestId("share-copy-link").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      // The id stays at the END: that is what resolves. The slug in front is
      // decoration, so this asserts the contract, not the exact shape.
      .toMatch(new RegExp(`^${BASE}/task/(?:[a-z0-9-]+-)?${step.id}$`));
    await didascalia(page, "Aperto lo STEP (prima il drawer si chiudeva)");
    await beat(page, 2200);

    // ── Atto 2: la URL nuda ───────────────────────────────────────────────────
    // Lo stesso link, aperto da zero (notifica, commento, push del service
    // worker): la board globale si attiva e il drawer dello step apre. Prima
    // `pendingSelect` restava appeso e non apriva mai niente.
    await page.goto(`/task/${step.id}`);
    const deepDrawer = page.getByTestId("task-detail-drawer");
    await expect(deepDrawer, "il deep-link a un sottotask non ha aperto niente").toBeVisible({ timeout: 20000 });
    await expect(deepDrawer.getByText(STEP, { exact: true })).toBeVisible({ timeout: 10000 });
    await didascalia(page, "2 · /task/<id-di-sottotask> apre lo stesso step");
    await beat(page, 2600);
  });
});

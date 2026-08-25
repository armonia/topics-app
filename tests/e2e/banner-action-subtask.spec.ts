/**
 * banner-action-subtask.spec.ts — il TASTO di una notifica preso su un
 * SOTTOTASK fa la sua azione, invece di ripiegare su «apri il task».
 *
 * Il guasto, in una riga: i tasti del banner risolvevano il progetto con
 * `(await boardApi.listAll()).find(t => t.id === id)`, e `listAll` è il feed
 * globale, che è `rootsOnly`. Per QUALSIASI id di sottotask quella find è
 * `undefined` → `projectId` null → `runNotificationAction` ripiega e apre il
 * task. Cioè: proprio i banner degli step — che sono la maggioranza di quelli
 * che chiedono una risposta — non facevano mai la loro azione, e il tasto
 * sembrava premuto per finta.
 *
 * Ora la risoluzione passa da `boardApi.resolve` (GET
 * /api/all-boards/tasks/:taskId), la porta unica «da un id al suo task, a
 * qualunque profondità».
 *
 * Come falsifica: il tasto `requeue` PATCHa lo stato dello step a `todo`
 * (esattamente come trascinare la card in Todo). Senza il fix nessuna
 * chiamata parte e lo stato resta dov'era — l'asserzione sullo stato lato
 * SERVER è il cancello, la spia nella UI è il contorno.
 *
 * È anche la clip di consegna: due stati, non uno screenshot — lo step in
 * Backlog nell'albero del drawer, e lo stesso step in Todo dopo il tasto.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-banner-act-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare il flusso di onboarding";
const STEP = "Riscrivere la mail di benvenuto";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

/** Lo stato di un task letto dalla porta unica (vale a qualunque profondità). */
async function statusOf(request: APIRequestContext, taskId: string): Promise<string | null> {
  const res = await request.get(`${BASE}/api/all-boards/tasks/${taskId}`);
  if (!res.ok()) return null;
  const body = (await res.json()) as { task: { status?: string } | null };
  return body.task?.status ?? null;
}

test.describe("Banner · il tasto su un sottotask esegue davvero", () => {
  test.describe.configure({ timeout: 120_000 });
  // Viewport più largo del default della suite (1280×800) per una ragione sola:
  // questa spec È la clip di consegna, e l'anteprima di un task viene resa a
  // 268px di larghezza — oltre un rapporto altezza/larghezza di 0.70 la card
  // TAGLIA invece di rimpicciolire. 1440×760 → il video esce 800×422 (0.528) e
  // ci sta intero. Nessuna asserzione qui dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-banner-act" }, null, 2));
    const topic = await createTopic(request, "E2E-BannerAct", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // In ordine INVERSO: il figlio prima del padre.
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("«Rimetti in coda» preso sul banner di uno STEP lo rimette in coda davvero", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-26" });
    // Un'epica con un suo step. Lo step ha una descrizione perché l'albero del
    // drawer rende apribile solo un nodo che ha qualcosa da mostrare — serve a
    // farlo VEDERE nella clip, non all'asserzione.
    const epica = await createTask(request, { text: EPICA, status: "in_progress", description: "L'onboarding va rifatto da zero." });
    const step = await createTask(request, { text: STEP, parentTaskId: epica.id, description: "Tono nuovo, stessa struttura." });

    // LA PREMESSA, misurata sul server: il feed che il vecchio risolutore
    // interrogava NON contiene lo step. Se un giorno smettesse di essere
    // `rootsOnly` questo test proverebbe un caso che non esiste più, e va saputo.
    const feed = await (await request.get(`${BASE}/api/all-boards/tasks`)).json() as { tasks: { id: string }[] };
    expect(feed.tasks.some((t) => t.id === epica.id), "l'epica dovrebbe essere nel feed").toBe(true);
    expect(feed.tasks.some((t) => t.id === step.id), "il feed non è più rootsOnly: il caso è cambiato").toBe(false);
    expect(await statusOf(request, step.id), "lo step nasce in backlog").toBe("backlog");

    // Il deep-link apre la board globale sul drawer dell'epica: nell'albero c'è
    // lo step, con il suo glifo di stato. È lo stato PRIMA.
    await page.goto(`/task/${epica.id}`);
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 20000 });
    const stepRow = page.getByTestId(`subtask-open-${step.id}`);
    await expect(stepRow).toBeVisible({ timeout: 10000 });
    const stato = () => stepRow.locator("xpath=preceding-sibling::span[1]");
    await expect(stato()).toHaveAttribute("title", "Backlog", { timeout: 10000 });
    await didascalia(page, "Uno STEP in Backlog: il suo banner ha il tasto «Rimetti in coda»");
    await beat(page, 2200);

    // IL CLICK SUL TASTO DEL BANNER. Il guscio nativo (Rust) legge
    // `actionIdentifier` e chiama esattamente questo global: qui lo chiamiamo
    // noi con lo stesso id che `buildNotifyActions({kind:'parked'})` produce.
    const chiamato = await page.evaluate((taskId) => {
      const g = window as unknown as { __topicsNotificationAction?: (t: string, a: string) => void };
      if (typeof g.__topicsNotificationAction !== "function") return false;
      g.__topicsNotificationAction(taskId, "requeue");
      return true;
    }, step.id);
    expect(chiamato, "il global dei tasti del banner non è montato").toBe(true);

    // IL CANCELLO: lo stato dello step è cambiato sul SERVER. Senza il fix il
    // progetto resta null, nessuna PATCH parte, e questo resta 'backlog'.
    await expect
      .poll(() => statusOf(request, step.id), {
        timeout: 15000,
        message: "il tasto non ha eseguito: il progetto di un sottotask non si è risolto",
      })
      .toBe("todo");

    // E la stessa cosa si vede: ricaricato il drawer, il glifo dello step è Todo.
    await page.goto(`/task/${epica.id}`);
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId(`subtask-open-${step.id}`)).toBeVisible({ timeout: 10000 });
    await expect(stato()).toHaveAttribute("title", "Todo", { timeout: 10000 });
    await didascalia(page, "Il tasto ha eseguito: lo step è in Todo");
    await beat(page, 2600);
  });
});

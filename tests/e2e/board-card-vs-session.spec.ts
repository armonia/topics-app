/**
 * board-card-vs-session.spec.ts — la SCHEDA di un task e la SESSIONE che lo
 * lavora sono due destinazioni diverse, e si vede prima di cliccare.
 *
 * IL CASO. «Apri il task» diceva due cose: la scheda (descrizione, checklist,
 * consegna, thread — dove si DECIDE, ed esiste sempre) e la chat dell'agente
 * (dove si LAVORA, e può non esserci più). Stessa parola, due superfici, e
 * nessun modo di sapere quale si sarebbe aperta. Ora sono due gesti con due
 * nomi, il ritorno esiste in entrambi i versi, e la sessione che non c'è più si
 * DICE invece di aprire il vuoto.
 *
 * SERVE UN VIDEO, non uno screenshot: la cosa da dimostrare è un ANDATA E
 * RITORNO — board → scheda → sessione → scheda — cioè quattro stati sulla
 * stessa finestra. Una schermata ne proverebbe uno.
 *
 * PERCHÉ LA SESSIONE MORTA SI METTE IN SCENA DALL'INDICE DEI TOPIC.
 * `tasks.assigned_topic_id` ha una foreign key su `topics(id)` (migration 026,
 * con `PRAGMA foreign_keys = ON`): un legame PENZOLANTE nel database non si può
 * scrivere, nemmeno dalle rotte di test. Ma la domanda «quella sessione esiste
 * ancora?» il client se la pone sul proprio indice dei topic, non sul DB — ed è
 * lì che il caso è reale: un task lavorato su un'altra macchina, un archivio
 * ripristinato, una riga potata da una manutenzione. Quindi si toglie QUEL topic
 * dalla risposta di `GET /api/topics`: non si finge la UI, si mette in scena il
 * mondo in cui quel topic non c'è. Vedi `client/src/lib/taskSession.ts`.
 *
 * @covers KANBAN-07
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-cardsess-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const STAMP = Date.now();
const TASK_VIVO = `Sessione viva ${STAMP}`;
const TASK_MORTO = `Sessione finita ${STAMP}`;

let projectTopicId: string | null = null;
let topicVivo: string | null = null;
let topicMorto: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

async function createTask(request: Req, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

/** Lega il task al topic dell'agente come fa il dispatcher (servizio vero). */
async function bindTopic(request: Req, id: string, topicId: string, dispatchState: string | null) {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, {
    data: { topicId, dispatchState },
  });
  expect(res.ok()).toBe(true);
}

/**
 * Il mondo in cui `topicMorto` non esiste più: la risposta dell'indice dei topic
 * arriva senza quella voce. Le ALTRE ci sono, e questo è il punto — un indice
 * VUOTO significa «non lo so ancora» e il gesto resta acceso (vedi
 * `lib/taskSession.ts`); solo un indice pieno che non lo contiene è una morte.
 */
async function hideDeadTopic(page: Page) {
  await page.route("**/api/topics", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { topics?: Record<string, unknown> };
    if (body.topics && topicMorto) delete body.topics[topicMorto];
    await route.fulfill({ response: res, json: body });
  });
}

async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Scheda del task e sessione dell'agente", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cardsess" }, null, 2));
    // Il topic del progetto registra il workspace; gli altri due sono le
    // SESSIONI. Standalone di proposito (nessun projectPath): così si aprono
    // come tab di chat a livello App, che è la superficie di questa clip —
    // esattamente ciò che fa il dispatcher sulla board catch-all.
    projectTopicId = (await createTopic(request, "E2E-CardSess", { projectPath: PROJECT_PATH })).id;
    topicVivo = (await createTopic(request, `Sessione viva ${STAMP}`)).id;
    topicMorto = (await createTopic(request, `Sessione finita ${STAMP}`)).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    for (const id of [topicMorto, topicVivo, projectTopicId]) if (id) await deleteTopic(request, id);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("dalla board alla scheda, dalla scheda alla sessione, e ritorno — e la sessione finita lo dice", async ({ page, request }) => {
    const vivo = await createTask(request, TASK_VIVO);
    const morto = await createTask(request, TASK_MORTO);
    await bindTopic(request, vivo.id, topicVivo!, "working");
    await bindTopic(request, morto.id, topicMorto!, null);

    await resetPaneStore(page.request, []);
    await hideDeadTopic(page);
    await page.goto("/");
    await openGlobalBoard(page);

    const cardVivo = page.locator(`[data-task-card="${vivo.id}"]`);
    const cardMorto = page.locator(`[data-task-card="${morto.id}"]`);
    await expect(cardVivo).toBeVisible({ timeout: 15000 });
    await expect(cardMorto).toBeVisible({ timeout: 15000 });

    // (a) PRIMA DEL CLICK la differenza è leggibile: una card offre la sessione,
    //     l'altra dice che è finita e non offre niente da aprire.
    await expect(cardVivo.getByTestId("card-open-session")).toBeVisible();
    await expect(cardVivo.getByTestId("card-session-gone")).toHaveCount(0);
    await expect(cardMorto.getByTestId("card-session-gone")).toBeVisible();
    await expect(
      cardMorto.getByTestId("card-open-session"),
      "una sessione che non c'è più non si apre: il gesto non esiste proprio",
    ).toHaveCount(0);
    await beat(page, 2200);

    // (b) Il click nudo sulla card apre la SCHEDA — mai la sessione.
    await cardVivo.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText(TASK_VIVO);
    await beat(page, 2000);

    // (c) Dalla scheda alla SESSIONE: è l'unico gesto che porta all'altra
    //     superficie, e ci porta davvero.
    await drawer.getByTestId("task-open-session-tab").click();
    const strip = page.getByTestId("chat-task-card-strip");
    await expect(strip, "la chat aperta è la sessione DI questo task, e lo dice").toBeVisible({ timeout: 15000 });
    await expect(strip).toContainText(TASK_VIVO);
    await beat(page, 2400);

    // (d) …e il ritorno: dalla sessione si torna alla scheda, sullo STESSO task.
    await strip.getByTestId("chat-open-task-card").click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText(TASK_VIVO);
    await beat(page, 2400);

    // (e) La scheda di un task la cui sessione è finita: la ragione è scritta,
    //     e il gesto verso il vuoto non c'è.
    await cardMorto.click();
    await expect(drawer).toContainText(TASK_MORTO, { timeout: 15000 });
    await expect(drawer.getByTestId("task-session-gone")).toBeVisible();
    await expect(
      drawer.getByTestId("task-open-session-tab"),
      "il drawer non deve offrire una sessione che non esiste",
    ).toHaveCount(0);
    await beat(page, 2600);
  });
});

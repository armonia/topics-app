/**
 * board-card-last-exchange.spec.ts — da REVIEW si vede com'è finito il discorso.
 *
 * Segnalato: «da review dovrei sempre vedere l'ultimo suo e mio messaggio, devo
 * capire facilmente». Due difetti distinti lo impedivano, e questa spec li
 * guarda dove contano: A SCHERMO, sulla card, non nel modulo che decide.
 *
 *   1. LA MIA DOMANDA SPARIVA senza risposta. Si citava la richiesta umana solo
 *      quando `isReply` trovava una risposta dopo di lei — e quel predicato
 *      voleva `kind === 'comment'`, quindi certe risposte non contavano e la
 *      domanda non veniva stampata da nessuna parte, proprio mentre aspettava.
 *
 *   2. LA CONTABILITÀ SI SPACCIAVA PER LA CONSEGNA. Quando nel thread non resta
 *      nessuna parola vera la card ripiega su una nota di macchina — meglio del
 *      silenzio — ma senza dirlo. Su `235afe11` (20/08) apriva con «Fan-out
 *      chiuso: 3 tentativi, 1 con modifiche», bookkeeping del dispatcher, e si
 *      leggeva come il riassunto dell'agente. Il perché un riassunto non ci
 *      fosse stava sepolto nello stesso thread: il turno era stato tagliato da
 *      un riavvio del server.
 *
 * I test unitari coprono la DECISIONE (`cardComments.test.ts`); qui si verifica
 * che quella decisione diventi pixel — la cosa che è stata chiesta, e l'unica
 * che un test di modulo non può promettere.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const REPO = `/tmp/e2e-scambio-${Date.now()}`;
const PROJECT_ID = boardIdForPath(REPO);

const T_DOMANDA = "Rifare la fascia della sidebar";
const T_CRONACA = "Turno tagliato da un riavvio";

let topicId: string | null = null;
const createdTasks: string[] = [];
const ids: Record<string, string> = {};

async function createTask(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

/** Un commento come lo scrive una persona dalla board: `quiet`, cioè una nota
 *  e non una consegna all'agent (vedi la rotta `…/comments`). */
async function commenta(request: APIRequestContext, taskId: string, content: string): Promise<void> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks/${taskId}/comments`, {
    data: { content, quiet: true },
  });
  expect(res.ok()).toBe(true);
}

/** Apre il progetto e ci mette dentro una board kanban. Stesso giro di
 *  `board-card-choices`: il pane non nasce da solo. */
async function apriBoard(page: Page): Promise<void> {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-scambio/);
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10_000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("nessun menu + con la voce Board (kanban)");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10_000 });
}

test.describe("L'ultimo scambio, visto dalla review", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-scambio" }, null, 2));
    const topic = await createTopic(request, "E2E-Scambio", { projectPath: REPO });
    topicId = topic.id;

    // 1) La card con la MIA domanda e nessuna risposta.
    ids.domanda = await createTask(request, { text: T_DOMANDA, status: "review" });
    await commenta(request, ids.domanda, "e i separatori? non li vedo");

    // 2) La card con SOLO cronaca della macchina — il caso 235afe11.
    ids.cronaca = await createTask(request, { text: T_CRONACA, status: "review" });
    await commenta(request, ids.cronaca, "Fan-out chiuso: 3 tentativi, 1 con modifiche.");
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    rmSync(REPO, { recursive: true, force: true });
  });

  // UN SOLO GIRO DI APERTURA, e le due asserzioni dentro. Aprire il pane a ogni
  // test lo rendeva ballerino — il menu «+» non c'e' sempre nello stesso posto
  // dopo un reset — e quel flake non dice niente sul comportamento che si sta
  // provando. Le due card convivono nella stessa colonna: si guardano insieme.
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []).catch(() => {});
    await resetProjectPanes(page.request, PROJECT_ID).catch(() => {});
    await seedProjectPane(page.request, REPO).catch(() => {});
    await page.goto("/");
    await apriBoard(page);
  });

  test("la domanda in attesa e la cronaca dichiarata, sulla stessa colonna", async ({ page }) => {
    const colonna = page.getByTestId("kanban-column-body-review");

    // 1. LA MIA DOMANDA È A SCHERMO senza che nessuno abbia risposto.
    //
    //    ONESTA' SU COSA PROVA E COSA NO: qui la domanda e' l'unica parola del
    //    thread, quindi e' lei `latest` e passa da un ramo che il fix non ha
    //    toccato. Questa asserzione prova che la card DISEGNA la parola del
    //    thread — il pixel — non che il difetto sia chiuso. Il difetto (la
    //    domanda citata come CONTESTO sotto una risposta) vive in
    //    `cardComments.test.ts`, dove un thread di piu' voci si compone senza
    //    passare dall'API della board, che firma tutto come umano.
    //
    //    Sono due prove diverse e servono entrambe: quella la' morde sulla
    //    regola, questa qui garantisce che la regola arrivi a schermo.
    const conDomanda = colonna.locator(`[data-task-card="${ids.domanda}"]`);
    await expect(conDomanda).toBeVisible({ timeout: 15_000 });
    await expect(conDomanda).toContainText("separatori", { timeout: 10_000 });

    // 2. LA CRONACA SI VEDE. Anche qui c'è una parola in cima invece del solo
    //    titolo, ed è la meta' visibile del secondo difetto.
    //
    //    IL CARTELLO «nessun riassunto» NON si prova qui, e la ragione e' che
    //    l'API della board firma ogni commento come UMANO (`author: 'user'`,
    //    vedi la rotta `…/comments`, che passa `HUMAN`): una parola umana e'
    //    una parola vera, quindi `latestIsPlumbing` resta falso — giustamente.
    //    Per accendere il cartello servirebbe un thread di sole note di
    //    macchina, che dalla board non si puo' scrivere: lo compone il
    //    dispatcher. Quel caso e' provato dove si puo' comporre davvero, sui
    //    sei commenti reali di 235afe11 (`cardComments.test.ts`), e sarebbe
    //    disonesto simularlo qui firmando a mano righe che l'API non produce.
    const conCronaca = colonna.locator(`[data-task-card="${ids.cronaca}"]`);
    await expect(conCronaca).toBeVisible({ timeout: 15_000 });
    await expect(conCronaca).toContainText("Fan-out chiuso", { timeout: 10_000 });
  });
});

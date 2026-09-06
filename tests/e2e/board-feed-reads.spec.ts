/**
 * board-feed-reads.spec.ts — how many times the board READS, and when.
 *
 * Sibling of board.spec.ts, which owns what the board renders. These two cases
 * are about the read itself and share nothing with the rendering ones except
 * the project fixture, so they live apart: board.spec.ts was over the file-size
 * gate with them inside.
 *
 *  - BOARD-19: a burst of WS events costs at most TWO reads of the global feed
 *  - BOARD-20: a read parked during a drag must not undo the drop
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { canonicalTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
// Canonical spelling (`/private/tmp` on macOS): the server resolves the
// topic's projectPath and hashes the STRING into the board id, so a literal
// `/tmp` addressed a board nobody's session was bound to — locally only, the
// Linux runner has a real `/tmp`. See `canonicalTmpDir`.
const PROJECT_PATH = canonicalTmpDir("e2e-board-feed");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** La finestra di coalescenza del feed — la stessa di `useGlobalBoard`. */
const FINESTRA_MS = 400;

/**
 * Un `task:updated` che il client ACCETTA.
 *
 * Il frame deve portare l'oggetto `task` con `id`/`projectId`/`status`
 * (`shared/ws-outbound.ts`), e chi arriva senza viene scartato dalla
 * validazione in ingresso di `useWebSocket` — in silenzio, perché il messaggio
 * di scarto esiste solo in DEV e il banco gira su un bundle di produzione.
 * Questo file mandava frame con `taskId` e basta: non svegliavano nessuno, e i
 * due test qui sotto misuravano una raffica che non era mai partita.
 */
function taskUpdated(taskId: string, status: string) {
  return { type: "task:updated", projectId: PROJECT_ID, task: { id: taskId, projectId: PROJECT_ID, status } };
}

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string },
): Promise<{ id: string; status: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string; status: string };
  createdTasks.push(task.id);
  return task;
}

/** Il "+" della finestra di progetto → Board (vedi board.spec.ts per il giro). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-board-feed/);
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
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Kanban board — letture del feed", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board-feed" }, null, 2));
    const topic = await createTopic(request, "E2E-Board-Feed", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  // Workspace ermetico per OGNI test: si azzerano ENTRAMBI i canali di stato
  // (globale + layout della finestra di progetto), poi si riapre il progetto.
  // Il perché sta per esteso in board.spec.ts.
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("BOARD-19: una raffica di 10 eventi costa al massimo DUE letture del feed globale", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-06" });
    // Misurato sulla macchina viva il 15/08/2026: `GET /api/all-boards/tasks`
    // sono 467 task radice, 1.435.735 byte, 145 ms. Erano TRE i lettori
    // indipendenti che lo richiedevano a ogni evento `task:*` (la pane della
    // board, `useTaskTopicIndex`, `useGlobalBoard`) e uno solo raffreddava la
    // raffica: dieci mosse di agente in due secondi valevano una ventina di
    // letture e altrettanti ridisegni per arrivare a UNO stato.
    //
    // Adesso il feed ha un proprietario solo e la raffica si chiude in una
    // finestra di 400 ms: la prima lettura parte subito (chi ha appena mosso
    // una card non aspetta) e la coda ne fa UNA per tutte le altre.
    const stamp = Date.now();
    const testo = `Raffica ${stamp}`;
    const marcatore = `Raffica letta ${stamp}`;
    const seme = await apiCreateTask(page.request, { text: testo, status: "todo" });

    // Il feed passa dal server vero (nessuno schema copiato a mano qui), ma
    // ogni richiesta si conta e, dal marcatore in poi, la risposta cambia il
    // testo della card: è così che si sa che la lettura di CODA è atterrata,
    // invece di aspettare un tempo a caso.
    let letture = 0;
    let inVolo = 0;
    let lastActivity = Date.now();
    let marcato = false;
    let corpo: { tasks: { id: string; text: string }[] } | null = null;
    await page.route(/\/api\/all-boards\/tasks(\?|$)/, async (route) => {
      letture++;
      inVolo++;
      lastActivity = Date.now();
      if (!corpo) corpo = (await (await route.fetch()).json()) as { tasks: { id: string; text: string }[] };
      const tasks = corpo.tasks.map((t) => (marcato && t.id === seme.id ? { ...t, text: marcatore } : t));
      await route.fulfill({ json: { tasks } });
      inVolo--;
      lastActivity = Date.now();
    });

    /**
     * «Il feed ha smesso di leggere»: niente in volo, e nessuna richiesta nuova
     * per più di una finestra di coalescenza.
     *
     * Serve due volte, e per la stessa ragione: l'apertura della board fa
     * partire la SUA raffica (montaggio + riconnessione della socket), la cui
     * coda atterra ~400 ms dopo. Senza aspettarla, il conteggio della raffica
     * vera si sommava a quella dell'avvio, e — peggio — il verdetto dipendeva
     * da quale lato del `marcato = true` cadeva quella coda: è così che questo
     * test passava, e passava senza misurare niente.
     *
     * Non è un `waitForTimeout`: è una condizione su ciò che si osserva, e
     * scade in rosso se il feed non si ferma mai.
     */
    const stoppedFeed = async () => {
      await expect
        .poll(() => inVolo === 0 && Date.now() - lastActivity > 3 * FINESTRA_MS, {
          timeout: 15_000,
          intervals: [100],
          message: "il feed globale non smette di leggere",
        })
        .toBe(true);
    };

    // L'intercettazione della WebSocket va installata PRIMA del goto, o la
    // connessione iniziale sfugge (vedi helpers/ws-helpers.ts).
    const ws = await interceptWebSocket(page);
    await resetPaneStore(page.request, []);
    await page.goto("/");

    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 10000 });
    await expect(board.getByText(testo)).toBeVisible({ timeout: 10000 });

    // Da qui si misura: le letture dell'avvio non sono la raffica.
    await stoppedFeed();
    letture = 0;
    marcato = true;
    for (let i = 0; i < 10; i++) ws.send(taskUpdated(seme.id, "todo"));

    await expect(board.getByText(marcatore)).toBeVisible({ timeout: 10000 });
    // La coda della raffica arriva DOPO la prima lettura: contare qui, appena
    // il marcatore compare, misurerebbe mezza raffica.
    await stoppedFeed();
    // Il tetto è il punto del test. Il pavimento è ciò che gli impedisce di
    // essere vero per il motivo sbagliato: con i frame che questo test mandava
    // prima — senza il campo `task`, quindi scartati dalla validazione in
    // arrivo (`shared/ws-outbound.ts`) — le letture erano ZERO e «al massimo
    // due» era un'asserzione che non poteva fallire.
    expect(letture).toBeGreaterThanOrEqual(1);
    expect(letture).toBeLessThanOrEqual(2);
  });

  test("BOARD-20: la lettura parcheggiata durante il drag non riporta indietro la card", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-03" });
    // Il difetto, sotto BOARD-17: mentre una card è in mano la board rimanda a
    // dopo ogni rilettura, e quella coda si svuotava in cima a `onDragEnd` —
    // cioè PRIMA della PATCH del drop. La GET partiva e rispondeva con lo stato
    // di partenza, perfettamente corretta e perfettamente vecchia: la card
    // tornava nella colonna da cui l'avevi presa e ci restava per un giro di
    // rete intero. Sembrava un drop non preso, e capitava proprio quando la
    // board è viva — cioè quando un altro client si muove mentre trascini.
    //
    // La scena riproduce le due condizioni insieme: un evento `task:*` estraneo
    // A PUNTATORE ABBASSATO (che è ciò che mette una lettura in coda) e una
    // PATCH lenta (che allarga la finestra in cui la risposta vecchia può
    // vincere). La prova è la NEGAZIONE — la card non ricompare mai nella
    // colonna di partenza — quindi si guarda a raffica, non una volta sola.
    const stamp = Date.now();
    const testo = `Drag lento ${stamp}`;
    const estraneo = `Rumore di fondo ${stamp}`;
    const task = await apiCreateTask(page.request, { text: testo, status: "todo" });
    const altro = await apiCreateTask(page.request, { text: estraneo, status: "backlog" });

    // La PATCH del drop, rallentata. Non è un trucco per far passare il test:
    // è la finestra vera, misurata in millisecondi su una macchina scarica,
    // allargata quanto basta perché il rosso sia leggibile invece che raro.
    await page.route(/\/api\/boards\/[^/]+\/tasks\/[^/?]+$/, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });

    const ws = await interceptWebSocket(page);
    await page.goto("/");
    await openProjectBoard(page);

    const todo = page.getByTestId("kanban-column-body-todo");
    const backlog = page.getByTestId("kanban-column-body-backlog");
    await expect(todo.getByText(testo)).toBeVisible({ timeout: 10000 });

    // Il drag, a mano: serve un punto in cui il puntatore è ancora giù.
    const src = page.locator(`[data-task-card="${task.id}"]`);
    const a = (await src.boundingBox())!;
    const b = (await backlog.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + 12);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + 20, { steps: 4 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    // QUI: la card è in aria, e un altro task si muove. La board mette la
    // rilettura in coda invece di rifare le colonne sotto il puntatore.
    ws.send(taskUpdated(altro.id, "backlog"));
    await page.waitForTimeout(150);
    await page.mouse.up();

    // 1,5 s a 50 ms: se la lettura in coda parte prima della PATCH, la card
    // ricompare in Todo per qualche centinaio di millisecondi. Una sola
    // occhiata, alla fine, non vedrebbe niente.
    const fine = Date.now() + 1500;
    let ricomparsa = 0;
    while (Date.now() < fine) {
      if ((await todo.locator(`[data-task-card="${task.id}"]`).count()) > 0) ricomparsa++;
      await page.waitForTimeout(50);
    }
    expect(ricomparsa, "la card è tornata nella colonna di partenza").toBe(0);

    // E il drop è andato davvero: la negazione da sola sarebbe vera anche se la
    // card fosse sparita del tutto.
    await expect(backlog.locator(`[data-task-card="${task.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      const r = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`);
      return (await r.json()).task.status;
    }, { timeout: 10000 }).toBe("backlog");
  });
});

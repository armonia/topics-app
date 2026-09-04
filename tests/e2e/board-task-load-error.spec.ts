/**
 * board-task-load-error.spec.ts — una lettura fallita si DICE, non si gira a
 * vuoto.
 *
 * Il drawer del task ha una sola lettura (`load()` → GET del dettaglio) e la
 * fa in due momenti: al mount, e in coda a ogni mutazione (priorità, stato,
 * decisione, commento). Quando quella GET cadeva, i due momenti producevano
 * due silenzi diversi:
 *
 *  · al MOUNT restava lo Spinner a tutta altezza, per sempre. Lo spinner
 *    promette che la riga sta arrivando, quindi nessuno chiudeva e riapriva —
 *    l'unica via d'uscita che c'era;
 *  · DOPO UNA MUTAZIONE il server era già cambiato e il drawer continuava a
 *    disegnare la riga di prima senza dirlo: il click sembrava non aver fatto
 *    niente, e chi lo ripeteva mandava una seconda scrittura.
 *
 * Ora il primo caso mostra un blocco d'errore col messaggio del server e un
 * «Riprova» (`task-load-error`), e la testata smette di dire «Carico…»; il
 * secondo mostra un avviso nella zona di decisione (`task-stale-warning`) col
 * suo «Riprova». Due stati, due test.
 *
 * COME SI FA CADERE LA GET. `page.route` che abortisce SOLO il metodo GET su
 * `**\/api/boards/*\/tasks/*`: le PATCH sullo stesso path devono passare, perché
 * il secondo caso è proprio «l'azione è passata, l'aggiornamento no». Il glob
 * `*` non attraversa `/`, quindi `…/tasks/<id>/comments` e le altre sotto-rotte
 * non sono toccate — e nemmeno la lista `…/tasks`, che non ha il segmento in
 * più.
 *
 * COSA PROVA CHE IL DRAWER È CARICATO. `task-brief-scroll`, che esiste in
 * entrambi i layout ed è gated solo su `task`. Non `task-drawer-body`: quello
 * monta solo quando il gruppo del task ha delle pane, e un task mai
 * dispatchato ne ha zero. Non `task-brief-header`: esiste solo in modo largo.
 *
 * Il caso portante gira dentro `clipDiConsegna` (helpers/clip.ts): sotto
 * `E2E_CLIP=1` accende un contesto DEDICATO sul solo tratto utile e misura il
 * .webm. Il setup sta nel `prologo`, su una pagina il cui video si butta.
 *
 * @covers KANBAN-08
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext, type Route } from "@playwright/test";
import {
  createTopic,
  deleteTopic,
  deleteTask,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  waitForProjectPaneType,
} from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

const STAMP = Date.now();
const PROJECT_PATH = `/tmp/e2e-task-load-${STAMP}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const TASK = "Rivedere il contratto del drawer";

/**
 * La GET del dettaglio e solo quella. Le mutazioni (PATCH/POST) sullo stesso
 * path passano: il secondo test è «l'azione è passata», quindi deve passare.
 */
const DETTAGLIO = "**/api/boards/*/tasks/*";
const abortisciSoloLaGet = (route: Route) =>
  route.request().method() === "GET" ? route.abort() : route.continue();

let topicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok(), `POST tasks ${JSON.stringify(body)}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

interface TaskRow {
  status: string;
  priority: number;
}

async function readTask(request: APIRequestContext, taskId: string): Promise<TaskRow> {
  const res = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { task?: TaskRow } & TaskRow;
  return body.task ?? body;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-task-load/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const alreadyOpen = page.getByTestId("kanban-board");
  if (await alreadyOpen.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) return;

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
  if (!opened) throw new Error("nessun menu + con la voce Board");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Board · una lettura fallita del task si dice, non si gira a vuoto", () => {
  test.describe.configure({ timeout: 120_000 });

  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-task-load" }, null, 2));
    const topic = await createTopic(request, "E2E-TaskLoad", { projectPath: PROJECT_PATH });
    topicId = topic.id;

    // `review` senza ramo: nessun dispatcher lo prende, quindi nessun agente a
    // metà scena; e fuori da backlog/todo il chip della priorità mostra il
    // VALORE (non «Priorità auto»), che è ciò che il secondo test legge.
    // Priorità 2 = Media, dichiarata: il test parte da un valore noto.
    taskId = await createTask(request, { text: TASK, status: "review", priority: 2 });

    const riga = await readTask(request, taskId);
    expect(riga.status, "il task parte in review").toBe("review");
    expect(riga.priority, "priorità di partenza = Media").toBe(2);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("LOAD-ERROR-01: la GET del dettaglio cade all'apertura → errore col Riprova, non lo spinner", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-08" });
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    await clipDiConsegna({
      nome: "board-task-load-error",
      // Il contesto è NOSTRO: niente di `use` arriva qui da solo. `locale`
      // perché l'app senza risponde in inglese; 1280×680 = 0,531 di rapporto,
      // perché sopra 0,70 la card taglia la clip dal basso invece di
      // rimpicciolirla.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // FUORI DALLA REGISTRAZIONE: aprire il progetto e montare la board è
      // lavoro di scena, non la scena. Nessuna route qui: il prologo deve
      // vedere l'app sana.
      prologo: async (p) => {
        await p.goto("/");
        await openProjectBoard(p);
        await expect(p.locator(`[data-task-card="${taskId}"]`)).toBeVisible({ timeout: 15000 });
        await waitForProjectPaneType(request, PROJECT_PATH, "kanban");
      },
      scena: async (page) => {
        // La route PRIMA del goto: la pagina nasce con la GET del dettaglio già
        // rotta, la lista della board (`…/tasks`, senza segmento) passa.
        await page.route(DETTAGLIO, abortisciSoloLaGet);
        await page.goto("/");
        const card = page.locator(`[data-task-card="${taskId}"]`);
        await expect(card).toBeVisible({ timeout: 20000 });
        // Review è la quarta colonna: senza questo la scena comincia su
        // Backlog. `toBeVisible` non scorre in orizzontale.
        await card.scrollIntoViewIfNeeded();
        await didascalia(page, "La card sulla board: il server del dettaglio non risponde");
        await beat(page, 1400);

        await card.click();
        const drawer = page.getByTestId("task-detail-drawer");
        await expect(drawer).toBeVisible({ timeout: 10000 });

        // PRIMO STATO: il blocco d'errore, col suo bottone. Non lo spinner
        // (nessun anello che gira nel drawer) e non la riga caricata.
        const errore = drawer.getByTestId("task-load-error");
        await expect(errore).toBeVisible({ timeout: 10000 });
        await expect(errore.getByTestId("task-load-retry")).toBeVisible();
        await expect(drawer.locator(".animate-spin")).toHaveCount(0);
        await expect(drawer.getByTestId("task-brief-scroll")).toHaveCount(0);
        // La testata non promette più «Carico…»: il chip dello stato non ha
        // l'anello. Si legge il segno, non la parola.
        await expect(drawer.getByTestId("task-status-chip").locator(".animate-spin")).toHaveCount(0);
        await didascalia(page, "Il drawer lo dice, e offre Riprova");
        await beat(page, 1800);

        // Il server torna. Il Riprova rifà la stessa `load()`.
        await page.unroute(DETTAGLIO, abortisciSoloLaGet);
        await didascalia(page, "Il server torna: Riprova");
        await beat(page, 1000);
        await errore.getByTestId("task-load-retry").click();

        // SECONDO STATO: la riga caricata, l'errore sparito.
        await expect(drawer.getByTestId("task-brief-scroll")).toBeVisible({ timeout: 10000 });
        await expect(drawer).toContainText(TASK);
        await expect(drawer.getByTestId("task-load-error")).toHaveCount(0);
        await didascalia(page, "Il task è caricato");
        await beat(page, 1600);
      },
    });
  });

  test("LOAD-ERROR-02: l'azione passa, la rilettura no → avviso di riga vecchia col Riprova", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-08" });
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    // Drawer caricato con l'app SANA: nessuna route ancora.
    await page.goto("/");
    await openProjectBoard(page);
    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();
    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-brief-scroll")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-stale-warning")).toHaveCount(0);

    const chip = drawer.getByTestId("task-priority-chip");
    const primaDelClick = (await chip.textContent())?.trim() ?? "";
    expect(primaDelClick, "il chip mostra un valore").not.toBe("");

    // ORA cade la sola GET: la PATCH della priorità passa, la `load()` in coda no.
    await page.route(DETTAGLIO, abortisciSoloLaGet);
    await chip.click();
    // Le voci del menu seguono `PRIORITY_ORDER` = [4,3,2,1,0]; la selezionata è
    // la 2 (Media). Si sceglie quella SOPRA (3): un valore diverso, senza
    // scrivere una parola del menu nel test.
    const opzioni = page.getByRole("listbox").getByRole("option");
    await expect(opzioni).toHaveCount(5);
    await expect(opzioni.nth(2)).toHaveAttribute("aria-selected", "true");
    await opzioni.nth(1).click();

    // L'avviso: l'azione è passata, l'aggiornamento no. Col suo Riprova, e il
    // chip ancora sul valore di prima — che è esattamente la riga vecchia.
    const avviso = drawer.getByTestId("task-stale-warning");
    await expect(avviso).toBeVisible({ timeout: 10000 });
    await expect(avviso.getByTestId("task-stale-retry")).toBeVisible();
    await expect(chip).toHaveText(primaDelClick);

    // SUL SERVER è passata davvero: non una vernice sul client.
    expect((await readTask(request, taskId)).priority, "la PATCH è arrivata").toBe(3);

    // Il server torna: il Riprova rilegge, l'avviso sparisce, il valore nuovo
    // è a schermo (il chip cambia testo; la riga non è più quella vecchia).
    await page.unroute(DETTAGLIO, abortisciSoloLaGet);
    await avviso.getByTestId("task-stale-retry").click();
    await expect(drawer.getByTestId("task-stale-warning")).toHaveCount(0, { timeout: 10000 });
    await expect(chip).not.toHaveText(primaDelClick);
    // E il menu, riaperto, ha la selezione sulla voce cliccata.
    await chip.click();
    await expect(page.getByRole("listbox").getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
  });
});

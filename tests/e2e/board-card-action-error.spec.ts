/**
 * board-card-action-error.spec.ts — il perché un click non ha fatto niente sta
 * SULLA card, non in una barra fuori dallo schermo.
 *
 * Il caso portante è uno solo, ed è quello vero: l'approvazione su un padre in review
 * che ha ancora un sottotask aperto. Il server rifiuta (409, `open_subtasks`),
 * il task resta dov'è, e finché il messaggio finiva nella barra rossa in cima al
 * board pane — con la colonna scrollata, cioè quasi sempre — il bottone sembrava
 * semplicemente morto. Ora la frase è in coda alla card che l'ha presa, in
 * italiano, sopra la checklist che mostra il figlio che tiene aperto il padre.
 *
 * Il comportamento ha DUE stati e uno screenshot ne proverebbe metà: card senza
 * errore → click → striscia rossa. Per questo la clip di consegna gira dentro
 * `clipDiConsegna` (helpers/clip.ts), che sotto `E2E_CLIP=1` accende un contesto
 * DEDICATO sul solo tratto utile, misura il .webm e alza se sfora i 20s del
 * protocollo. Il setup — l'app che parte, il progetto che si apre, la board che
 * si monta — sta nel `prologo`, su una pagina il cui video si butta. Senza
 * `E2E_CLIP` il percorso di codice è lo stesso, semplicemente non registra.
 *
 * Il padre nasce SENZA ramo consegnato: è ciò che fa uscire l'approvazione
 * (`task-choice-accept`) invece di «Landa su main», che è un'altra chiamata e un
 * altro rifiuto.
 *
 * @covers KANBAN-08
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
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
import { canonicalTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

const PROJECT_PATH = canonicalTmpDir("e2e-card-errore");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const PADRE = "Rifare la scheda prodotto";
const FIGLIO = "Migrare le foto sul nuovo bucket";

/** La frase che legge una PERSONA. L'inglese del server non deve mai arrivare qui. */
const FRASE = "Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.";

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
  deliveryBranch: string | null;
  subtaskCount: number;
  subtaskDoneCount: number;
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
  const btn = projectRow(page, /e2e-card-errore/);
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

test.describe("Board · l'errore di un'azione sta sulla card che l'ha presa", () => {
  test.describe.configure({ timeout: 120_000 });

  let padreId = "";
  let childId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-card-errore" }, null, 2));
    const topic = await createTopic(request, "E2E-CardErrore", { projectPath: PROJECT_PATH });
    topicId = topic.id;

    // Il padre CONSEGNATO: in review, senza ramo — è l'unico stato in cui la
    // card offre l'approvazione (`accept`). Con un ramo uscirebbe «Landa su main»,
    // che è un'altra chiamata e un altro rifiuto.
    padreId = await createTask(request, { text: PADRE, status: "review" });
    // Il figlio APERTO. `backlog` di proposito: conta per il cancello
    // (`countOpenChildren`: non-done, non-archiviato) ma nessun dispatcher lo
    // prende, quindi non compare un agente a metà scena.
    childId = await createTask(request, { text: FIGLIO, parentTaskId: padreId, status: "backlog" });

    // I due presupposti, dichiarati: se cadono qui il rosso parla del SETUP, non
    // del bottone.
    const padre = await readTask(request, padreId);
    expect(padre.status, "il padre parte in review").toBe("review");
    expect(padre.deliveryBranch ?? null, "senza ramo, altrimenti la card mostra «Landa su main»").toBeNull();
    expect(padre.subtaskCount - padre.subtaskDoneCount, "un figlio aperto").toBeGreaterThan(0);
  });

  test.afterAll(async ({ request }) => {
    // In ordine INVERSO: il figlio prima del padre.
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("CARD-ERRORE-01: approvare un padre con un sottotask aperto → la striscia rossa sulla CARD", async ({ request }) => {
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    await clipDiConsegna({
      nome: "board-card-action-error",
      // Il contesto è NOSTRO: niente di `use` arriva qui da solo. `locale`
      // perché le asserzioni sono in italiano e senza l'app risponde in
      // inglese; 1280×680 = 0,531 di rapporto, perché sopra 0,70 la card
      // taglia la clip dal basso invece di rimpicciolirla.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // FUORI DALLA REGISTRAZIONE: aprire il progetto e montare la board è
      // lavoro di scena, non la scena. Il layout resta scritto sul server (e nel
      // localStorage del contesto, che la scena condivide), quindi la pagina
      // dopo lo ritrova già aperto e non lo rimonta davanti alla telecamera.
      prologo: async (p) => {
        await p.goto("/");
        await openProjectBoard(p);
        await expect(p.locator(`[data-task-card="${padreId}"]`)).toBeVisible({ timeout: 15000 });
        await waitForProjectPaneType(request, PROJECT_PATH, "kanban");
      },
      scena: async (page) => {
        await page.goto("/");
        const card = page.locator(`[data-task-card="${padreId}"]`);
        await expect(card).toBeVisible({ timeout: 20000 });
        // La colonna Review è la quarta: senza questo la scena comincia su
        // Backlog e la card entra in campo solo quando il click ce la porta —
        // cioè la clip mostrerebbe il secondo stato e non il primo. `toBeVisible`
        // non scorre: per Playwright una card fuori dallo scorrimento
        // orizzontale è visibile lo stesso.
        await card.scrollIntoViewIfNeeded();

        // PRIMO STATO: la card in review, la sua checklist col figlio ancora
        // aperto, e nessun errore addosso.
        await expect(page.getByTestId("kanban-column-body-review").locator(`[data-task-card="${padreId}"]`))
          .toBeVisible({ timeout: 10000 });
        await expect(card).toContainText(FIGLIO);
        await expect(card.getByTestId("card-action-error")).toHaveCount(0);
        await didascalia(page, "Card in review, un sottotask ancora aperto");
        await beat(page, 1400);

        // La PAROLA del bottone non si ricopia qui: viene dalla tabella unica
        // delle azioni (`taskActionWords.ts`), e ricopiarla farebbe fallire
        // questo test il giorno in cui la si cambia in un posto solo. Quello
        // che conta è che sia il bottone dell'approvazione, cioè il testid.
        const approva = card.getByTestId("task-choice-accept");
        await expect(approva).toBeVisible();
        await didascalia(page, "Un click sull'approvazione");
        await beat(page, 1200);
        await approva.click();

        // SECONDO STATO: il rifiuto del server, detto dove è stato preso il
        // click. Dentro la card — il locator è ancorato ad essa, non alla
        // pagina — e in italiano.
        const striscia = card.getByTestId("card-action-error");
        await expect(striscia).toBeVisible({ timeout: 10000 });
        await expect(striscia).toContainText(FRASE);
        await didascalia(page, "Il perché è sulla card, non altrove");
        await beat(page, 1800);

        // E non è comparso ANCHE altrove: una volta sola in tutta la pagina
        // (la barra rossa in cima al pane resta vuota), e mai l'inglese che il
        // server dice agli agenti.
        await expect(page.getByText(FRASE)).toHaveCount(1);
        await expect(page.getByText(/open subtasks/i)).toHaveCount(0);

        // Il click non ha spostato niente: la card è ancora in Review.
        await expect(page.getByTestId("kanban-column-body-review").locator(`[data-task-card="${padreId}"]`))
          .toBeVisible();
      },
    });

    // Il rifiuto è STRUTTURALE, non una vernice sul client: il task non si è
    // mosso e il figlio è ancora aperto. Sta fuori dalla scena — sono letture
    // d'API, non hanno niente da far vedere.
    const padre = await readTask(request, padreId);
    expect(padre.status, "il padre resta in review").toBe("review");
    expect((await readTask(request, childId)).status, "il figlio resta aperto").not.toBe("done");
  });
});

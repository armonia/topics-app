/**
 * board-composer-persistence.spec.ts — il composer della board non evapora.
 *
 * Il box «Descrivi un task per l'agent…» galleggia sopra le colonne della
 * kanban. Veniva SMONTATO in due casi, e con lui se ne andava di colpo quello
 * che ci stavi scrivendo dentro:
 *  - COMPOSER-01: un `focusin` su `window` accendeva «sta scrivendo altrove»
 *    per QUALSIASI campo del documento — la ricerca della board, il composer di
 *    una chat in un'altra pane, un terminale. Nessuno di quei campi gli sta
 *    sopra: il gate ora guarda solo dentro il carosello delle colonne.
 *  - COMPOSER-02: aprire un task lo smontava sempre. Su desktop il drawer è un
 *    fratello IN-FLOW accanto alle colonne — non copre niente — quindi il
 *    composer resta; sotto `lg`, dove il drawer è un overlay a tutto schermo,
 *    si nasconde per CSS ma non muore.
 *
 * L'asserzione forte non è «il testo è ancora lì» (la bozza sta anche sul
 * server e un remount la ripescherebbe, in ritardo e col cursore perso): è che
 * il NODO è lo stesso di prima. Ogni test marchia l'elemento e verifica che il
 * marchio sopravviva — un remount lo cancellerebbe.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type Locator } from "@playwright/test";
import {
  createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask,
} from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
const PROJ = `/tmp/e2e-composer-persist-${STAMP}`;

const PROJ_ID = boardIdForPath(PROJ);

const topicIds: string[] = [];
const createdTasks: string[] = [];
const CARD_TEXT = `Task da aprire ${STAMP}`;

/** Apre la Board generale dal «+» della barra standalone. */
async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

/**
 * Apre la board di PROGETTO (l'unica con il «Aggiungi» in colonna) dal «+»
 * della finestra di progetto. Più barre portano un trigger e il loro ordine nel
 * DOM non è garantito: si prova finché non compare la voce Board.
 */
async function openProjectBoard(page: Page) {
  const section = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute("aria-expanded")) === "false") {
    await section.click();
  }
  const row = projectRow(page, /e2e-composer-persist/);
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

/**
 * Scrive nel composer e ne marchia il nodo. Il marchio è una proprietà del DOM
 * element vivo: React lo perde se ricrea l'elemento, che è esattamente il
 * guasto sotto esame.
 */
async function typeAndMark(page: Page, draft: string): Promise<Locator> {
  const composer = page.getByTestId("board-task-composer");
  await expect(composer).toBeVisible({ timeout: 10000 });
  const ta = composer.locator("textarea");
  await ta.click();
  await ta.fill(draft);
  await composer.evaluate((el) => el.setAttribute("data-e2e-mark", "vivo"));
  return composer;
}

/** Stesso nodo di prima + stesso testo dentro. */
async function expectSurvived(composer: Locator, draft: string) {
  await expect(composer).toHaveAttribute("data-e2e-mark", "vivo");
  await expect(composer.locator("textarea")).toHaveValue(draft);
}

test.describe.serial("Composer della board — non sparisce", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(`${PROJ}/CLAUDE.md`, "# e2e-composer-persist\n");
    const t = await createTopic(request, `composer-persist-${STAMP}`, { projectPath: PROJ });
    topicIds.push(t.id);
    const res = await request.post(`${BASE}/api/boards/${PROJ_ID}/tasks`, {
      data: { text: CARD_TEXT, status: "todo" },
    });
    expect(res.ok()).toBe(true);
    createdTasks.push(((await res.json()) as { id: string }).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJ_ID, id).catch(() => {});
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    rmSync(PROJ, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    // Il layout INTERNO della finestra di progetto è una chiave a sé sul
    // server: senza azzerarlo, la board lasciata lì dal test prima fa sparire
    // la voce «Board» dal «+» (i pane singleton già presenti sono filtrati).
    await resetProjectPanes(page.request, PROJ);
    await seedProjectPane(page.request, PROJ);
    // La bozza vive sul server: senza azzerarla il test dopo riparte col testo
    // del test prima e `toHaveValue` misurerebbe un residuo, non il fix.
    await page.request.delete(`${BASE}/api/ui-state/board-composer-draft`).catch(() => {});
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`${BASE}/api/ui-state/board-composer-draft`).catch(() => {});
  });

  test("COMPOSER-01: il fuoco fuori dalla kanban non porta via il composer", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-30" });
    const draft = `Bozza fuori fuoco ${STAMP}`;
    await page.goto("/");
    await openGlobalBoard(page);
    const composer = await typeAndMark(page, draft);

    // (a) Un campo della board FUORI dalle colonne: la ricerca della toolbar.
    //     Accendeva «sta scrivendo altrove» e smontava il composer — cioè
    //     filtrare i task cancellava il task che stavi scrivendo.
    const search = page.getByLabel("Cerca nei task");
    await search.click();
    await search.fill("zz");
    await expectSurvived(composer, draft);
    await search.fill("");

    // (b) Fuoco FUORI dalla pane per davvero: la palette comandi, che è un
    //     overlay su <body> con il suo campo di ricerca.
    await page.keyboard.press("Meta+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible({ timeout: 5000 });
    await palette.getByRole("textbox").fill("board");
    await expect(composer).toHaveAttribute("data-e2e-mark", "vivo");
    await page.keyboard.press("Escape");
    await expect(palette).not.toBeVisible();

    // Tornato il fuoco, il composer è ancora a schermo con il suo testo: si
    // riprende a scrivere da dove si era rimasti.
    await expect(composer).toBeVisible();
    await expectSurvived(composer, draft);
  });

  test("COMPOSER-02: aprire un task non smonta il composer (desktop)", async ({ page }) => {
    const draft = `Bozza con task aperto ${STAMP}`;
    await page.goto("/");
    await openGlobalBoard(page);
    const composer = await typeAndMark(page, draft);

    await page.getByTestId("kanban-column-todo").getByText(CARD_TEXT).first().click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // Il viewport della suite è 1280px: sopra `lg`, dove il drawer si mette
    // ACCANTO alle colonne. Il composer resta visibile e integro.
    await expect(composer).toBeVisible();
    await expectSurvived(composer, draft);

    // E chiudendo il drawer non è successo niente di irreversibile.
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expectSurvived(composer, draft);
  });

  test("COMPOSER-03: un campo DENTRO una colonna lo nasconde, non lo uccide", async ({ page }) => {
    // Il rovescio del fix: la regola che serviva davvero resta. Il box «nuovo
    // task» di una colonna si apre proprio sotto il composer, quindi il
    // composer si toglie di mezzo — ma per CSS, restando vivo con il suo testo.
    const draft = `Bozza da non perdere ${STAMP}`;
    await page.goto("/");
    await openProjectBoard(page);
    const composer = await typeAndMark(page, draft);

    const backlog = page.getByTestId("kanban-column-backlog");
    await backlog.getByRole("button", { name: "Aggiungi" }).click();
    await backlog.locator("textarea").fill("scrivo in colonna");
    await expect(composer).not.toBeVisible();
    await expect(composer).toHaveAttribute("data-e2e-mark", "vivo");

    // Chiuso il box della colonna, il composer torna su con quello che c'era.
    await backlog.locator("textarea").press("Escape");
    await expect(composer).toBeVisible();
    await expectSurvived(composer, draft);
  });
});

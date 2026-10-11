/**
 * board-column-volume.spec.ts — una colonna di archivio non è un albero React
 * di archivio.
 *
 * MISURATO sulla macchina viva il 15/08/2026: 467 task radice, di cui 449
 * `done`. La colonna Done disegnava una `Card` per ciascuno — memo, chip,
 * anteprima, il nodo che dnd-kit registra come bersaglio — e la board pagava
 * quel sottoalbero a ogni render, cioè a ogni evento `task:*`, a ogni battito
 * di 4 s dell'uso live, e nel mezzo di ogni trascinamento. Nessuno guardava
 * quelle card: Done è una cronologia, si legge dall'alto.
 *
 * Il contratto qui:
 *
 *  1. **Done si sfoglia.** Trecento task chiusi non sono trecento card vive.
 *     Il numero in testa alla colonna resta il TOTALE — è la storia, non deve
 *     rimpicciolirsi perché non la si disegna tutta.
 *  2. **The tail comes up.** The show-more row is there, says how many are
 *     left, and reaching it by scrolling adds ONE page by itself (LIST-PAGE-01):
 *     nothing is hidden for good, and nothing arrives in bulk.
 *  3. **Le colonne di LAVORO non si toccano.** Backlog, Todo e In Progress si
 *     disegnano intere anche a trenta card, perché lì si trascina: una card non
 *     disegnata è un bersaglio di drop che non esiste, e un gesto che muore in
 *     silenzio è il difetto peggiore di tutti.
 *
 * La regola pura (quale colonna, quante card) è in `client/src/lib/boardOrder.ts`
 * e provata in `boardOrder.test.ts`; questa spec prova che la board la applichi
 * su un volume vero.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-colvolume-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** Il volume vero, arrotondato per difetto: 449 sono i `done` misurati oggi. */
const DONE_SEEDED = 300;
/** Abbastanza da superare qualunque tetto, in una colonna che non ne ha. */
const TODO_SEEDED = 30;
/** `COLUMN_PAGE` in `client/src/lib/boardOrder.ts`. Se cambia lì, cambia qui. */
const COLUMN_PAGE = 25;

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

/** Un task, e se serve portato subito nel suo stato finale (`done` non si crea). */
async function seedTask(request: Req, text: string, status: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text, status: status === "done" ? "todo" : status },
  });
  expect(res.ok(), `POST ${text}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  if (status === "done") {
    const patch = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data: { status: "done" } });
    expect(patch.ok(), `PATCH done ${text}`).toBe(true);
  }
  return id;
}

/** A ondate: trecento andate e ritorno in fila costerebbero più del test. */
async function seedMany(request: Req, count: number, status: string, prefix: string): Promise<void> {
  const WAVE = 20;
  for (let i = 0; i < count; i += WAVE) {
    await Promise.all(
      Array.from({ length: Math.min(WAVE, count - i) }, (_, k) => seedTask(request, `${prefix} ${i + k}`, status)),
    );
  }
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-colvolume/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/** Il "+" della finestra di progetto → Board (vedi board.spec.ts per il perché del giro). */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
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
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20000 });
}

const cardsIn = (page: Page, status: string) =>
  page.getByTestId(`kanban-column-body-${status}`).locator("[data-task-card]");

/** Waits `n` painted frames: room for a chain of pages to show itself. */
const afterFrames = (page: Page, n: number) =>
  page.evaluate((n) => new Promise((r) => {
    let frames = 0;
    const tick = (): void => { if (++frames >= n) r(null); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), n);

test.describe("Kanban — il volume di una colonna", () => {
  test.describe.configure({ timeout: 240_000 });
  // 1600: a 1280 le cinque colonne non ci stanno e Done finisce fuori dallo
  // scroll orizzontale. Qui si CONTANO i nodi, che esistono comunque, ma una
  // colonna raggiungibile rende leggibile anche il "mostra altri".
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-colvolume" }, null, 2));
    const topic = await createTopic(request, "E2E-ColVolume", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    await seedMany(request, DONE_SEEDED, "done", "Chiuso");
    await seedMany(request, TODO_SEEDED, "todo", "Da fare");
  });

  test.afterAll(async ({ request }) => {
    // Trecentotrenta cancellazioni: a ondate, come la semina.
    for (let i = 0; i < createdTasks.length; i += 20) {
      await Promise.all(createdTasks.slice(i, i + 20).map((id) => deleteTask(request, PROJECT_ID, id)));
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("COLVOL-01: trecento task chiusi non sono trecento card vive", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-29" });
    await page.goto("/");
    await openProjectBoard(page);

    const done = page.getByTestId("kanban-column-body-done");
    await expect(done.locator("[data-task-card]").first()).toBeVisible({ timeout: 20000 });

    const vive = await cardsIn(page, "done").count();
    console.log(`[colvolume] Done: ${vive} card disegnate su ${DONE_SEEDED} chiuse`);
    expect(vive, "la colonna Done disegna una pagina, non l'archivio").toBe(COLUMN_PAGE);
    // «Ben sotto» detto due volte, così il numero esatto non è l'unica rete: se
    // un giorno la pagina cambia misura, questa resta la promessa.
    expect(vive).toBeLessThan(DONE_SEEDED / 4);

    // Il contatore in testa risponde a «quanti ce ne sono», non a «quanti se ne
    // vedono»: sfogliare non deve accorciare la storia.
    const testa = page.getByTestId("kanban-column-count-done");
    expect(Number(await testa.innerText())).toBeGreaterThanOrEqual(DONE_SEEDED);
  });

  test("COLVOL-02: la coda si tira su, una pagina per volta", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LIST-PAGE-01" });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeVisible({ timeout: 20000 });

    const altri = page.getByTestId("kanban-column-more-done");
    await expect(altri).toBeVisible();
    // Il numero è nel bottone: una colonna tagliata in silenzio sembra una
    // colonna senza storia.
    await expect(altri).toContainText(String(DONE_SEEDED - COLUMN_PAGE));
    expect(await cardsIn(page, "done").count(), "nothing loads before the reader gets there").toBe(COLUMN_PAGE);

    // Scrolling down the column, the next page arrives by itself when the row
    // comes into view: no click. Done is the last column and starts past the
    // right edge (x 1917 at 1600 px on WebKit), so the board is scrolled
    // sideways first, as a reader would. The wheel stops as soon as a page lands.
    const column = page.getByTestId("kanban-column-body-done");
    await column.scrollIntoViewIfNeeded();
    const body = (await column.boundingBox())!;
    expect(body.x + body.width, "the Done column is on screen").toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    for (let i = 0; i < 60 && (await cardsIn(page, "done").count()) === COLUMN_PAGE; i++) {
      await page.mouse.wheel(0, 400);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    }
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await expect(altri).toContainText(String(DONE_SEEDED - COLUMN_PAGE * 2));

    // ONE page: the row moved down with the new cards and waits for the reader.
    // Trusting the old "in view" chained page after page before the observer
    // could say the row had gone.
    await page.evaluate(() => new Promise((r) => {
      let frames = 0;
      const tick = (): void => { if (++frames >= 10) r(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
    expect(await cardsIn(page, "done").count(), "one page per reach, not a chain").toBe(COLUMN_PAGE * 2);
  });

  test("COLVOL-03: le colonne di LAVORO restano intere, e la card in fondo si trascina", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "todo").first()).toBeVisible({ timeout: 20000 });

    // Nessun tetto dove si trascina: TODO_SEEDED è sopra la pagina di Done
    // apposta, così il test distingue «intera» da «una pagina».
    await expect.poll(() => cardsIn(page, "todo").count(), { timeout: 10000 }).toBe(TODO_SEEDED);
    await expect(page.getByTestId("kanban-column-more-todo")).toHaveCount(0);

    // E la prova che «intera» significa ANCHE trascinabile: l'ultima card della
    // colonna, quella che un tetto avrebbe tolto per prima, cambia colonna.
    const ultima = cardsIn(page, "todo").last();
    const id = await ultima.getAttribute("data-task-card");
    await ultima.scrollIntoViewIfNeeded();
    const a = (await ultima.boundingBox())!;
    const b = (await page.getByTestId("kanban-column-body-backlog").boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + 12);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + 20, { steps: 4 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect.poll(async () => {
      const r = await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`);
      return (await r.json()).task.status;
    }, { timeout: 10000 }).toBe("backlog");
  });

  test("COLVOL-04: passare da griglia a lista non carica pagine da sole", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LIST-PAGE-01" });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeVisible({ timeout: 20000 });
    const toggle = page.getByTestId("board-layout-toggle");
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await cardsIn(page, "done").count()).toBe(COLUMN_PAGE);

    // The switch takes the scroll away from the column body. An observer left on it saw the
    // show-more row in view forever and chained every page of the archive, with nobody scrolling.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await afterFrames(page, 120);
    expect(await cardsIn(page, "done").count(), "no page without a reader").toBe(COLUMN_PAGE);

    // And the list still pages: the row brought into view adds one page, then waits.
    await page.getByTestId("kanban-column-more-done").scrollIntoViewIfNeeded();
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await afterFrames(page, 10);
    expect(await cardsIn(page, "done").count(), "one page per reach, not a chain").toBe(COLUMN_PAGE * 2);
  });

  test("COLVOL-05: a una finestra alta la colonna fuori schermo aspetta chi ci arriva", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LIST-PAGE-01" });
    // Tall enough that Done's show-more row sits inside its own column, while Done starts past the
    // right edge: the column clips the row, the board clips the column, and only the first is its root.
    await page.setViewportSize({ width: 1600, height: 1800 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeAttached({ timeout: 20000 });
    const body = page.getByTestId("kanban-column-body-done");
    expect((await body.boundingBox())!.x, "Done starts off screen").toBeGreaterThanOrEqual(page.viewportSize()!.width);
    await afterFrames(page, 120);
    expect(await cardsIn(page, "done").count(), "nothing loads before the reader gets there").toBe(COLUMN_PAGE);

    // The reader brings Done on screen: its row is in view there, and one page comes.
    await body.scrollIntoViewIfNeeded();
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await afterFrames(page, 10);
    expect(await cardsIn(page, "done").count(), "one page per reach, not a chain").toBe(COLUMN_PAGE * 2);
  });

  test("COLVOL-06: a una finestra alta, da griglia a lista, Done aspetta chi arriva alla sua riga", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LIST-PAGE-01" });
    // In the grid the row sits near the end of its own column, the root then, with Done past the right
    // edge. The switch moves the scroll to the columns' row and leaves the old root holding the row near:
    // the top of Done coming on screen loaded a page with the row 1728 px further down.
    await page.setViewportSize({ width: 1600, height: 1800 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeAttached({ timeout: 20000 });
    const toggle = page.getByTestId("board-layout-toggle");
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const rowPastColumn = () => page.evaluate(() => {
      const row = document.querySelector('[data-testid="kanban-column-more-done"]')!.getBoundingClientRect();
      return Math.round(row.top - document.querySelector('[data-testid="kanban-column-body-done"]')!.getBoundingClientRect().bottom);
    });
    expect(await rowPastColumn(), "in the grid the row is near the end of its column").toBeLessThanOrEqual(240);
    await afterFrames(page, 120);
    expect(await cardsIn(page, "done").count()).toBe(COLUMN_PAGE);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await afterFrames(page, 120);
    expect(await cardsIn(page, "done").count()).toBe(COLUMN_PAGE);

    // Only the top of Done comes on screen.
    const rowBelowView = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="kanban-columns-row"]') as HTMLElement;
      const top = document.querySelector('[data-testid="kanban-column-body-done"]')!.getBoundingClientRect().top;
      list.scrollBy({ top: top - (list.getBoundingClientRect().bottom - 60), behavior: "instant" });
      return Math.round(document.querySelector('[data-testid="kanban-column-more-done"]')!.getBoundingClientRect().top - list.getBoundingClientRect().bottom);
    });
    expect(rowBelowView, "the row is far below what is on screen").toBeGreaterThan(240);
    await afterFrames(page, 120);
    expect(await cardsIn(page, "done").count(), "the top of the column is not its row").toBe(COLUMN_PAGE);

    await page.getByTestId("kanban-column-more-done").scrollIntoViewIfNeeded();
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await afterFrames(page, 10);
    expect(await cardsIn(page, "done").count(), "one page per reach, not a chain").toBe(COLUMN_PAGE * 2);
  });

  test("COLVOL-08: a 390x844, cambiata vista e tornata, Done ritrova le pagine che aveva caricato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LIST-PAGE-01" });
    // The view that changes is the board's own: the archive toggle (and the project/all one) sends the
    // board back to its skeleton for a fresh read, which unmounts the columns. Done then restarted from its
    // first page, and the reader who had scrolled to 50 cards found 25 and scrolled through them again.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeAttached({ timeout: 20000 });
    expect(await cardsIn(page, "done").count()).toBe(COLUMN_PAGE);

    await page.getByTestId("kanban-column-body-done").scrollIntoViewIfNeeded();
    await page.getByTestId("kanban-column-more-done").scrollIntoViewIfNeeded();
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await afterFrames(page, 10);

    // Away (the archive) and back: the board remounts its columns on each read.
    const archive = page.getByTestId("board-archived-toggle");
    await archive.click();
    await expect(archive).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("board-archived-banner")).toBeVisible({ timeout: 10000 });
    await archive.click();
    await expect(archive).toHaveAttribute("aria-pressed", "false");
    await expect(cardsIn(page, "done").first()).toBeAttached({ timeout: 20000 });
    await afterFrames(page, 60);
    expect(await cardsIn(page, "done").count(), "the pages already loaded survive the remount").toBe(COLUMN_PAGE * 2);
    expect(await cardsIn(page, "done").count(), "and nothing more is loaded for a reader who has not got there").toBe(COLUMN_PAGE * 2);

    // The list still pages from where it was: reaching the row adds ONE page.
    await page.getByTestId("kanban-column-body-done").scrollIntoViewIfNeeded();
    await page.getByTestId("kanban-column-more-done").scrollIntoViewIfNeeded();
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 3);
    await afterFrames(page, 10);
    expect(await cardsIn(page, "done").count(), "one page per reach, not a chain").toBe(COLUMN_PAGE * 3);
  });

  test("COLVOL-07: tornata da lista a griglia, la colonna carica ancora prima che la riga entri in vista", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LIST-PAGE-01" });
    // Back in the grid the row sits far down its own column again, and nothing the old observers watched
    // changed: they kept the list's scroller as root, where the 240 px ahead never counts inside the column.
    // Done then loaded only once its row was on screen, and the reader waited at every page.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeAttached({ timeout: 20000 });
    const toggle = page.getByTestId("board-layout-toggle");
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await afterFrames(page, 30);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await afterFrames(page, 30);
    expect(await cardsIn(page, "done").count()).toBe(COLUMN_PAGE);

    // Done on screen, its row 120 px below what the column shows: inside the lookahead, not yet in view.
    await page.getByTestId("kanban-column-body-done").scrollIntoViewIfNeeded();
    const gap = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="kanban-column-body-done"]') as HTMLElement;
      const row = document.querySelector('[data-testid="kanban-column-more-done"]') as HTMLElement;
      body.scrollBy({ top: row.getBoundingClientRect().top - body.getBoundingClientRect().bottom - 120, behavior: "instant" });
      return Math.round(row.getBoundingClientRect().top - body.getBoundingClientRect().bottom);
    });
    expect(gap, "the row is below the column's visible bottom").toBeGreaterThan(0);
    expect(gap, "and within the 240 px ahead").toBeLessThan(240);
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await afterFrames(page, 10);
    expect(await cardsIn(page, "done").count(), "one page per reach, not a chain").toBe(COLUMN_PAGE * 2);
  });
});

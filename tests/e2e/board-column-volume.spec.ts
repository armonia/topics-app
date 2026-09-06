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
 *  2. **La coda si tira su.** «Mostra altri» esiste, dice quante ne restano, e
 *     una pressione ne aggiunge una pagina: niente è nascosto per sempre.
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
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

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
    rmSync(PROJECT_PATH, { recursive: true, force: true });
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
    await page.goto("/");
    await openProjectBoard(page);
    await expect(cardsIn(page, "done").first()).toBeVisible({ timeout: 20000 });

    const altri = page.getByTestId("kanban-column-more-done");
    await expect(altri).toBeVisible();
    // Il numero è nel bottone: una colonna tagliata in silenzio sembra una
    // colonna senza storia.
    await expect(altri).toContainText(String(DONE_SEEDED - COLUMN_PAGE));

    await altri.click();
    await expect.poll(() => cardsIn(page, "done").count(), { timeout: 10000 }).toBe(COLUMN_PAGE * 2);
    await expect(altri).toContainText(String(DONE_SEEDED - COLUMN_PAGE * 2));
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
});

/**
 * board-done-flash.spec.ts — chiudere un task si VEDE.
 *
 * Due regole, una sola scena:
 *
 *  1. **Done è una cronologia.** L'ultimo chiuso sta in cima. Prima la colonna
 *     era ordinata per `kanbanOrder`, che a un task chiuso non dice niente:
 *     approvare dalla review non ne scrive nessuno, quindi la card conservava la
 *     posizione della colonna da cui veniva e atterrava in un punto qualsiasi.
 *  2. **La card che ci arriva lampeggia.** Accettare chiudeva il drawer e non
 *     succedeva nient'altro di visibile: nessun segnale che il click avesse
 *     fatto qualcosa.
 *
 * Il lampo è transitorio (2,4 s) per costruzione — è un evento, non uno stato —
 * quindi il test lo controlla in tre momenti: assente prima, presente subito
 * dopo l'approvazione, e di nuovo assente quando è passato.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-doneflash-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

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

async function apiPatch(
  request: import("@playwright/test").APIRequestContext,
  taskId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, { data });
  expect(res.ok()).toBe(true);
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-doneflash/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/** Open the project board pane via the project window's "+" menu (vedi board.spec.ts). */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
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

/**
 * Gli id delle card della colonna Done, dall'alto in basso.
 *
 * Gli ID, non i titoli: la prima riga di testo di una card è il chip dell'id
 * generato dal server («rapid-quartz»), non il titolo — leggerla confrontava
 * due alfabeti diversi e il rosso non parlava dell'ordine.
 */
async function doneOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId("kanban-column-done")
    .locator("[data-task-card]")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.taskCard ?? ""));
}

test.describe("Done: ordine e lampo", () => {
  test.describe.configure({ timeout: 60_000 });
  // Finestra più larga del default della suite (1280): a quella larghezza le
  // cinque colonne non ci stanno e Done finisce FUORI SCHERMO — la card ci
  // arriva e lampeggia, ma nel DOM, dove nessuno la guarda. La richiesta era
  // «chiudo un task e lo vedo», quindi il test deve girare su una finestra in
  // cui Done è sullo schermo, e verificarlo (vedi l'asserzione sul boundingBox).
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-doneflash" }, null, 2));
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const topic = await createTopic(request, "E2E-DoneFlash", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("DONEFLASH-01: l'ultimo chiuso sta in cima, qualunque fosse la sua posizione", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-34" });
    const stamp = Date.now();
    const primo = `Chiuso per primo ${stamp}`;
    const secondo = `Chiuso per secondo ${stamp}`;
    const terzo = `Chiuso per terzo ${stamp}`;

    // `kanbanOrder` CONTRO la cronologia: il primo chiuso è anche quello che
    // starebbe in cima con il vecchio ordinamento. Se l'ordine fosse ancora
    // quello, il test lo vedrebbe — non è una prova che non può fallire.
    const ids: string[] = [];
    for (const text of [primo, secondo, terzo]) {
      const t = await apiCreateTask(page.request, { text, status: "todo" });
      await apiPatch(page.request, t.id, { status: "done" });
      ids.push(t.id);
      // `completed_at` ha la risoluzione del millisecondo: tre PATCH di fila
      // possono cadere nello stesso istante e lo spareggio passerebbe all'id,
      // che qui non significa niente.
      await page.waitForTimeout(30);
    }
    const [idPrimo, idSecondo, idTerzo] = ids;

    await page.goto("/");
    await openProjectBoard(page);
    await expect(page.getByTestId("kanban-column-done").getByText(terzo)).toBeVisible({ timeout: 10000 });

    // Solo le TRE di questo test: la colonna è condivisa con gli altri test del
    // file, e un elenco esatto sarebbe rosso per l'ordine di esecuzione.
    const order = await doneOrder(page);
    expect(order.filter((id) => ids.includes(id))).toEqual([idTerzo, idSecondo, idPrimo]);
  });

  test("DONEFLASH-02: approvare porta la card in CIMA a Done e la fa lampeggiare", async ({ page }) => {
    const stamp = Date.now();
    const vecchio = `Chiuso ieri ${stamp}`;
    const approvato = `Da approvare ${stamp}`;

    const old = await apiCreateTask(page.request, { text: vecchio, status: "todo" });
    await apiPatch(page.request, old.id, { status: "done" });
    const task = await apiCreateTask(page.request, { text: approvato, status: "in_progress" });
    await apiPatch(page.request, task.id, { status: "review" });

    await page.goto("/");
    await openProjectBoard(page);

    const doneCol = page.getByTestId("kanban-column-done");
    const reviewCol = page.getByTestId("kanban-column-review");
    await expect(reviewCol.getByText(approvato)).toBeVisible({ timeout: 10000 });
    // Il lampo è una TRANSIZIONE, non la freschezza di una data: la card già
    // chiusa non lampeggia solo perché la board si è appena caricata.
    await expect(doneCol.locator("[data-just-done]")).toHaveCount(0);

    await reviewCol.getByRole("button", { name: "Approva", exact: true }).click();

    // Si vede arrivare. PRIMA di ogni altra asserzione: il lampo dura 2,4 s per
    // costruzione, quindi va guardato subito dopo il click — le verifiche
    // durevoli (posizione, sparizione) possono aspettare, questa no.
    // La classe porta l'animazione; l'attributo è il gancio del test, così non
    // si asserisce su un nome di classe di Tailwind.
    const card = doneCol.locator(`[data-task-card][data-just-done]`);
    await expect(card).toContainText(approvato);
    await expect(card).toHaveClass(/task-flash-done/);
    // E il lampo è DIPINTO, non solo dichiarato: la classe da sola passerebbe
    // anche con un keyframe scritto male o con un nome che non esiste in
    // index.css. `box-shadow` calcolato durante l'animazione è il valore
    // interpolato vero, e ci deve stare dentro il verde di Done.
    //
    // La tinta si legge dalla custom property invece di scriverla qui a mano:
    // da quando il lampo ha un colore per colonna, `--task-flash` ha DUE valori
    // per tinta (uno per tema, come i glifi di colonna) e un letterale solo
    // sarebbe rosso nell'altro tema senza che niente sia rotto.
    const painted = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { shadow: cs.boxShadow, rgb: cs.getPropertyValue("--task-flash").trim().split(/\s+/).join(", ") };
    });
    expect(["52, 211, 153", "5, 150, 105"]).toContain(painted.rgb); // emerald-400 / emerald-600
    expect(painted.shadow).toContain(painted.rgb);
    // La card vecchia resta ferma e spenta: lampeggia solo chi ha attraversato.
    await expect(doneCol.locator("[data-just-done]")).toHaveCount(1);

    // Dove atterra: in cima. Non `toEqual` sull'intera colonna: i test
    // condividono il progetto e Done raccoglie anche i chiusi di prima — un
    // elenco esatto sarebbe rosso per l'ordine di esecuzione, non per la regola.
    const order = await doneOrder(page);
    expect(order[0]).toBe(task.id);
    expect(order.indexOf(old.id)).toBeGreaterThan(0);

    // E si vede DAVVERO: dentro la finestra, non solo nel DOM. `toBeVisible` di
    // Playwright dice «ha un rettangolo e non è nascosta» — passa anche per una
    // colonna scrollata fuori dallo schermo, che è esattamente il modo in cui
    // questa prova poteva essere verde senza provare niente: misurato a 1600px
    // il bordo destro della card cadeva a 2195, quasi 600 fuori dalla finestra.
    // `toPass` perché la board porta Done in vista con uno scorrimento morbido.
    // Locator per ID, non `card`: quello ha `[data-just-done]` addosso e sparirebbe
    // sotto i piedi all'asserzione quando il lampo si spegne.
    const landed = doneCol.locator(`[data-task-card="${task.id}"]`);
    const vp = page.viewportSize()!;
    await expect(async () => {
      const box = await landed.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
    }).toPass({ timeout: 5000 });

    // Poi si spegne da solo: è un evento, non uno stato appiccicato alla card.
    await expect(doneCol.locator("[data-just-done]")).toHaveCount(0, { timeout: 6000 });
    await expect(doneCol.getByText(approvato)).toBeVisible();
  });
});

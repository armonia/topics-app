/**
 * board-created-flash.spec.ts — un task appena creato si VEDE.
 *
 * Il gemello di `board-done-flash` all'altro capo della vita di un task, e nasce
 * dallo stesso buco: scrivevi nel composer, quello si svuotava, e non succedeva
 * nient'altro di visibile. Un task nuovo prende `kanban_order = max + 1`, cioè
 * atterra in FONDO alla sua colonna — sotto il bordo del corpo scrollabile se la
 * colonna è piena, e per giunta in una colonna che sulla riga orizzontale può
 * essere del tutto fuori schermo. Nato, e invisibile.
 *
 * Due segnali, e apposta con due regole DIVERSE — è questo che le due prove qui
 * sotto separano:
 *
 *  1. **Il lampo non ha un autore privilegiato.** Risponde a «è nato un task»,
 *     quindi vale anche per una creazione remota (agent, MCP, un altro device):
 *     sono proprio quelle che altrimenti comparirebbero in silenzio.
 *  2. **Lo scorrimento sì.** Muove la board sotto gli occhi di chi guarda: farlo
 *     per il task di qualcun altro vuol dire strappargli via la colonna che
 *     stava leggendo. Segue solo le creazioni fatte da QUESTO client.
 *
 * Il lampo è transitorio (2,4 s) per costruzione — è un evento, non uno stato —
 * quindi si guarda subito dopo il gesto, e la sua scadenza fa anche da orologio
 * condition-based per l'asserzione «la board NON si è mossa» (dopo 2,4 s uno
 * scorrimento morbido sarebbe finito da un pezzo).
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type Locator } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-createflash-${Date.now()}`;

/** BYTE-IDENTICAL to server/services/tasks.ts:projectIdForPath (parity-tested there). */
function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

/**
 * La creazione REMOTA: la stessa POST che fanno l'agent e l'MCP. Non c'è nessun
 * gesto in questa pagina — è esattamente il caso che il lampo deve coprire e lo
 * scorrimento no.
 */
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

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-createflash/);
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

/** La riga delle colonne: il contenitore che scorre in ORIZZONTALE. */
function columnsRow(page: Page): Locator {
  return page.getByTestId("kanban-column-backlog").locator("xpath=..");
}

/**
 * Porta la riga delle colonne tutta a destra — su Done — e aspetta che si fermi.
 *
 * Serve a mettere Todo (dove atterrano i task nuovi) FUORI dal campo visivo:
 * è la condizione in cui le due regole si distinguono davvero. Il contenitore ha
 * `scroll-smooth` e `snap-mandatory`, quindi la posizione va letta finché non si
 * assesta invece che subito dopo la scrittura.
 */
async function scrollColumnsToEnd(page: Page, offscreen: Locator) {
  const row = columnsRow(page);
  // La SCRITTURA sta dentro il `toPass`, non prima. Scritta una volta sola
  // falliva a intermittenza: `scrollLeft = scrollWidth` su una riga il cui
  // layout non è ancora fermo (le colonne stanno ancora prendendo la loro
  // larghezza, il drawer/la pane si stanno assestando) scorre fino a un massimo
  // che un istante dopo non è più il massimo, e Todo resta in vista. Riscrivere
  // finché la condizione non regge è l'unica forma che non dipende da QUANDO
  // arriva l'assestamento — e la condizione è quella che il test usa davvero,
  // non una posizione in pixel.
  await expect(async () => {
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    expect(await row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await fits(offscreen, row, "x")).toBe(false);
  }).toPass({ timeout: 10000 });
}

/**
 * Il rettangolo di un elemento sta DENTRO quello di un altro, su UN asse solo.
 *
 * Un asse per volta, e non è pignoleria: i due scorrimenti sono due meccanismi
 * separati su due contenitori separati, e un controllo che guarda entrambi gli
 * assi insieme li confonde. Misurato falsificando: neutralizzato il SOLO
 * scorrimento verticale, la card finiva sotto il bordo del corpo colonna — e
 * quindi anche sotto quello della riga, che lo contiene — e il rosso accusava
 * l'asse X, che stava funzionando benissimo. Una diagnosi sbagliata in un test
 * è peggio di nessuna diagnosi: manda a riscrivere il pezzo giusto.
 *
 * `- 1` / `+ 1`: i rettangoli sono frazionari, un bordo a filo non è un rosso.
 */
async function fits(inner: Locator, outer: Locator, axis: "x" | "y"): Promise<boolean> {
  const [i, o] = [await inner.boundingBox(), await outer.boundingBox()];
  if (!i || !o) return false;
  const [innerStart, innerSize] = axis === "x" ? [i.x, i.width] : [i.y, i.height];
  const [outerStart, outerSize] = axis === "x" ? [o.x, o.width] : [o.y, o.height];
  return innerStart >= outerStart - 1 && innerStart + innerSize <= outerStart + outerSize + 1;
}

test.describe("Task appena creato: lampo e scorrimento", () => {
  test.describe.configure({ timeout: 90_000 });
  // Finestra STRETTA di proposito: a questa larghezza le cinque colonne non ci
  // stanno, quindi la riga scorre davvero e «Todo è fuori schermo» è uno stato
  // raggiungibile. Su una finestra larga la prova sullo scorrimento orizzontale
  // sarebbe verde senza dimostrare niente — non ci sarebbe niente da scorrere.
  test.use({ viewport: { width: 1000, height: 720 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-createflash" }, null, 2));
    const topic = await createTopic(request, "E2E-CreateFlash", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    // Todo PIENA: il task nuovo prende `kanban_order = max + 1` e finisce in
    // fondo, cioè sotto il bordo inferiore del corpo scrollabile. È la metà
    // verticale della prova — senza queste, la card nascerebbe già in vista e lo
    // scorrimento sull'asse Y non avrebbe niente da dimostrare.
    for (let i = 0; i < 14; i++) {
      await apiCreateTask(request, { text: `Zavorra ${i + 1}`, status: "todo" });
    }
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

  test("CREATEFLASH-01: una creazione REMOTA lampeggia, ma non ti sposta la board", async ({ page }) => {
    const remoto = `Creato da un agent ${Date.now()}`;

    await page.goto("/");
    await openProjectBoard(page);
    const todoCol = page.getByTestId("kanban-column-todo");
    const row = columnsRow(page);
    await expect(todoCol).toBeAttached({ timeout: 10000 });

    // Nessuna card lampeggia solo perché la board si è appena caricata: il lampo
    // è un EVENTO. Le 14 di zavorra sono state create prima che questa pagina
    // esistesse e devono essere spente.
    await expect(page.locator("[data-just-created]")).toHaveCount(0);

    await scrollColumnsToEnd(page, todoCol);
    // Il presupposto della prova, verificato e non sperato: Todo è fuori.
    expect(await fits(todoCol, row, "x")).toBe(false);

    await apiCreateTask(page.request, { text: remoto, status: "todo" });

    // Si accende. Il locator è per attributo, non per nome di classe Tailwind.
    const flashing = page.locator("[data-task-card][data-just-created]");
    await expect(flashing).toContainText(remoto, { timeout: 10000 });
    // E il lampo è DIPINTO, non solo dichiarato: la classe da sola passerebbe
    // anche con un keyframe scritto male o con un nome che in index.css non
    // esiste. `box-shadow` calcolato durante l'animazione è il valore
    // interpolato vero, e l'azzurro (56 189 248) è quello del keyframe —
    // DIVERSO dal verde di Done, che su questa board significa già altro.
    const shadow = await flashing.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).toContain("56, 189, 248");
    await expect(flashing).toHaveClass(/task-created-flash/);
    expect(shadow).not.toContain("52, 211, 153");

    // E la board è rimasta dov'era. L'attesa è la scadenza del lampo stesso —
    // condition-based, e più lunga di qualsiasi scorrimento morbido: se la board
    // avesse inseguito il task di un altro, a quel punto Todo sarebbe in vista.
    await expect(page.locator("[data-just-created]")).toHaveCount(0, { timeout: 8000 });
    expect(await fits(todoCol, row, "x")).toBe(false);
    // La card c'è, è solo là dove è nata: il patto è «non ti sposto», non
    // «non te lo creo».
    await expect(todoCol.getByText(remoto)).toBeAttached();
  });

  test("CREATEFLASH-02: l'ho scritto io → la board me lo porta a schermo (X e Y)", async ({ page }) => {
    const mio = `Scritto nel composer ${Date.now()}`;

    await page.goto("/");
    await openProjectBoard(page);
    const todoCol = page.getByTestId("kanban-column-todo");
    const todoBody = page.getByTestId("kanban-column-body-todo");
    const row = columnsRow(page);
    await expect(todoCol).toBeAttached({ timeout: 10000 });
    await expect(todoCol.locator("[data-task-card]")).not.toHaveCount(0, { timeout: 10000 });

    // Le DUE distanze da coprire, entrambe verificate prima del gesto: la
    // colonna è fuori dalla riga (asse X) e il suo corpo è scrollato in cima con
    // altra roba sotto (asse Y). Senza questo controllo la prova sarebbe verde
    // anche in una board dove non c'era niente da scorrere.
    await scrollColumnsToEnd(page, todoCol);
    expect(await fits(todoCol, row, "x")).toBe(false);
    const overflow = await todoBody.evaluate((el) => ({ top: el.scrollTop, hidden: el.scrollHeight - el.clientHeight }));
    expect(overflow.top).toBe(0);
    expect(overflow.hidden).toBeGreaterThan(0);

    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(mio);
    await composer.press("Enter");

    // Il composer si svuota: la POST è passata.
    await expect(composer).toHaveValue("", { timeout: 15000 });

    // Il lampo dice QUALE card è nata — subito, prima delle asserzioni durevoli:
    // dura 2,4 s per costruzione.
    const flashing = page.locator("[data-task-card][data-just-created]");
    await expect(flashing).toContainText(mio, { timeout: 10000 });

    // …e la board ce l'ha portata sotto gli occhi. Locator per id, non `flashing`:
    // quello ha `[data-just-created]` addosso e sparirebbe sotto i piedi
    // all'asserzione quando il lampo si spegne.
    const cardId = await flashing.getAttribute("data-task-card");
    expect(cardId).toBeTruthy();
    createdTasks.push(cardId!);
    const landed = page.locator(`[data-task-card="${cardId}"]`);

    // `toPass` perché lo scorrimento è morbido su ENTRAMBI gli assi: la
    // condizione è lo stato finale, non il fotogramma subito dopo il click.
    // Le due asserzioni sono separate apposta — provano due scorrimenti diversi,
    // su due contenitori diversi, e un rosso deve dire quale dei due manca:
    //  · dentro la RIGA delle colonne  → l'orizzontale ha riportato indietro Todo
    //  · dentro il CORPO della colonna → il verticale è sceso fino in fondo
    // Il messaggio non è decorazione: `toPass` riporta solo l'ULTIMO fallimento
    // interno, quindi senza etichetta un rosso qui direbbe «false invece di
    // true» e basta — e i due scorrimenti sono due meccanismi diversi, su due
    // contenitori diversi, che si rompono separatamente.
    await expect(async () => {
      expect(await fits(landed, row, "x"), "asse X: la riga delle colonne non ha riportato Todo in vista").toBe(true);
      expect(await fits(landed, todoBody, "y"), "asse Y: il corpo della colonna non e' sceso fino alla card").toBe(true);
    }).toPass({ timeout: 8000 });

    // E si vede DAVVERO, nella finestra: `toBeVisible` di Playwright dice «ha un
    // rettangolo e non è nascosta» e passa anche per una colonna scrollata fuori
    // dallo schermo — è esattamente il modo in cui questa prova poteva essere
    // verde senza provare niente.
    const vp = page.viewportSize()!;
    const box = await landed.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);

    // Poi il lampo si spegne da solo: è un evento, non uno stato appiccicato
    // alla card. La card resta dov'è, in vista.
    await expect(page.locator("[data-just-created]")).toHaveCount(0, { timeout: 8000 });
    expect(await fits(landed, todoBody, "y")).toBe(true);
  });
});

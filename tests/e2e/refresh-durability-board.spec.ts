/**
 * @covers DURAB-BOARD-01
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTask,
  deleteTopic,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  waitForPaneStoreQuiet,
} from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { initGitRepo } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";

hermetic(test);

/**
 * LA MATRICE DELLA DURABILITA', SECONDA META': board, drawer, colonna di
 * progetto, editor.
 *
 * PERCHE' UN SECONDO FILE. `refresh-durability.spec.ts` ha aperto la matrice
 * sulla chat (testo del composer, allegati, scroll) e nel farlo ha gia' chiuso
 * un difetto vero. Le superfici qui sotto ricordano le stesse cose in TRE
 * magazzini diversi, e questa e' l'unica ragione per cui il contratto non si
 * legge da nessuna parte:
 *
 *   · localStorage   filtri della board, pannelli del drawer, `editor-word-wrap`
 *   · ui-state (SERVER)  la bozza del composer dei task
 *   · sessionStorage  sezioni, larghezza e altezze della colonna di progetto
 *
 * I tre non si comportano allo stesso modo, e la differenza non e' scritta in
 * nessun posto che non sia il ramo `catch {}` accanto alla `setItem`. Un valore
 * in sessionStorage sopravvive a `page.reload()` esattamente come uno in
 * localStorage: il ricaricamento da solo non li distingue, e chi guarda solo
 * quello conclude che siano la stessa cosa. Si separano su una SECONDA finestra,
 * ed e' la ragione per cui le righe 6 e 7 qui sotto esistono in coppia: la
 * prima da' il verde che fa credere sistemato, la seconda misura cosa succede
 * davvero quando la stessa preferenza viene chiesta da un'altra scheda.
 *
 * LA FORMA E' QUELLA DELLA MATRICE. Si mette lo stato PASSANDO DALLA UI (un
 * valore scritto a mano in localStorage prova il ramo di lettura e non quello
 * di scrittura), si ricarica, si asserisce. Le righe che dicono RESTA sono un
 * contratto; quelle che dicono PERDE sono un contratto uguale e contrario.
 */

const STAMP = Date.now();
const BASE = E2E_BASE;

/** Il progetto-fixture: serve alla colonna (righe 6 e 7) e all'editor (righe 8 e 9). */
const PROJ = `/tmp/e2e-refresh-board-${STAMP}`;
const PROJ_ID = projectIdForPath(PROJ);

/** Due card: una passa il filtro, l'altra no. E' l'unico modo di provare che il
 *  filtro e' APPLICATO e non solo che il campo ha ancora del testo dentro. */
const CARD_DENTRO = `Zeta filtro ${STAMP}`;
const CARD_FUORI = `Omega escluso ${STAMP}`;
/** Il termine da cercare: presente solo nella prima. */
const AGO = `Zeta`;

/** La card delle righe 2, 3 e 4: ha descrizione, un sottotask e un'anteprima,
 *  cioe' le tre sezioni richiudibili, piu' le due maniglie del guscio. */
const CARD_DRAWER = `Pannelli del drawer ${STAMP}`;

/** PNG 2x2 vero: l'allowlist dell'anteprima vuole un file che esista sotto la
 *  HOME DEL SERVER, e il browser deve poterlo decodificare. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
  "base64",
);

const topicIds: string[] = [];
const createdTasks: string[] = [];
let previewPath = "";

async function seedTask(
  request: APIRequestContext,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${PROJ_ID}/tasks`, { data: { text, ...extra } });
  expect(res.ok(), `POST tasks -> ${res.status()}`).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task.id;
}

/** La Board GENERALE dal «+» della barra standalone: la chiave dei filtri e'
 *  `board:filters-all`, e la board vede le card di ogni progetto. */
async function apriBoardGenerale(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

/** Apre il drawer di una card dalla board. */
async function apriDrawer(page: Page, testo: string): Promise<Locator> {
  await page.getByTestId("kanban-board").getByText(testo, { exact: true }).first().click({ timeout: 15000 });
  const drawer = page.getByTestId("task-detail-drawer");
  await expect(drawer).toBeVisible({ timeout: 10000 });
  return drawer;
}

/** Apre la finestra del progetto-fixture e restituisce il suo riquadro. */
async function apriProgetto(page: Page): Promise<Locator> {
  const sezione = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await sezione.count()) > 0 && (await sezione.getAttribute("aria-expanded")) === "false") {
    await sezione.click();
  }
  const riga = projectRow(page, /e2e-refresh-board/);
  await expect(riga).toBeVisible({ timeout: 15000 });
  await riga.click();
  const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
  await expect(win).toHaveCount(1, { timeout: 15000 });
  await expect(win.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 10000 });
  return win;
}

/**
 * Porta una sezione della colonna nello stato voluto e verifica che ci sia
 * RIMASTA.
 *
 * Un `if (stato != voluto) click()` letto una volta sola non basta: lo stato
 * arriva da `sessionStorage` e si assesta dopo l'idratazione, quindi la lettura
 * puo' precedere il valore vero e il clic porta nella direzione sbagliata. La
 * stessa trappola e' documentata in `project-sidebar-auto-height.spec.ts`.
 */
async function portaSezione(header: Locator, aperta: boolean) {
  const atteso = aperta ? "true" : "false";
  for (let i = 0; i < 3; i++) {
    if ((await header.getAttribute("aria-expanded")) === atteso) return;
    await header.scrollIntoViewIfNeeded();
    // A SINISTRA, sull'etichetta: al centro della riga di Git c'e' il comando
    // del ramo, che apre il suo menu e ferma la propagazione.
    await header.click({ position: { x: 24, y: 12 }, timeout: 8000 });
    if (await expect(header).toHaveAttribute("aria-expanded", atteso, { timeout: 3000 }).then(() => true, () => false)) {
      return;
    }
  }
  await expect(header, `la sezione non resta su «${atteso}»`).toHaveAttribute("aria-expanded", atteso, { timeout: 5000 });
}

/** La larghezza corrente della colonna, dal rettangolo vero. */
async function larghezzaColonna(win: Locator): Promise<number> {
  const box = await win.locator('[data-testid="project-sidebar"]').boundingBox();
  if (!box) throw new Error("la colonna di progetto non ha un rettangolo");
  return Math.round(box.width);
}

test.describe("Durabilita' al ricaricamento: board, drawer, colonna, editor", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(`${PROJ}/package.json`, JSON.stringify({ name: "e2e-refresh-board" }, null, 2));
    // Un file LUNGO su una riga sola: e' il caso in cui «a capo automatico»
    // vuol dire qualcosa. Un file di due righe corte renderebbe il comando vero
    // e l'asserzione finta.
    //
    // Alla RADICE del progetto e non dentro `src/`: una cartella da espandere e'
    // un passaggio in piu' che puo' fallire per conto suo, e non e' cio' che
    // questa riga sta misurando.
    writeFileSync(`${PROJ}/lungo.ts`, `export const riga = "${"x".repeat(400)}";\n`);
    initGitRepo(PROJ, "init");

    // L'allowlist di `previewImage` guarda la HOME DEL SERVER, che qui e'
    // isolata: un'immagine scritta altrove viene scartata IN SILENZIO e il test
    // misurerebbe una card senza anteprima passando lo stesso.
    const mediaDir = `${E2E_HOME}/.topics/media`;
    mkdirSync(mediaDir, { recursive: true });
    previewPath = `${mediaDir}/e2e-refresh-board-${STAMP}.png`;
    writeFileSync(previewPath, TINY_PNG);

    const topic = await createTopic(request, `refresh-board-${STAMP}`, { projectPath: PROJ });
    topicIds.push(topic.id);

    await seedTask(request, CARD_DENTRO, { status: "todo" });
    await seedTask(request, CARD_FUORI, { status: "todo" });
    const padre = await seedTask(request, CARD_DRAWER, {
      status: "todo",
      description: "## Il piano\n\nUna descrizione vera, abbastanza lunga da valere una sezione richiudibile.",
    });
    // Il nome NON puo' iniziare per «Sottotask»: la maniglia della sezione si
    // chiama cosi', e un locator per nome accessibile ne troverebbe due.
    await seedTask(request, `Figlio della card ${STAMP}`, { status: "todo", parentTaskId: padre });
    // L'anteprima si mette con una PATCH, non alla creazione: la POST non ha
    // `previewImage` fra i campi accettati e la scarterebbe IN SILENZIO. La
    // sezione «Consegna» non comparirebbe e il test misurerebbe un drawer con
    // due sezioni invece di tre.
    const patch = await request.patch(`${BASE}/api/boards/${PROJ_ID}/tasks/${padre}`, {
      data: { previewImage: previewPath },
    });
    expect(patch.ok(), `PATCH previewImage -> ${patch.status()}`).toBe(true);
    const dopoPatch = (await (await request.get(`${BASE}/api/boards/${PROJ_ID}/tasks/${padre}`)).json()) as {
      task?: { previewImage?: string | null };
    };
    expect(dopoPatch.task?.previewImage, "anteprima scartata dall'allowlist della HOME del server").toBe(previewPath);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJ_ID, id).catch(() => {});
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    rmSync(PROJ, { recursive: true, force: true });
    if (previewPath) rmSync(previewPath, { force: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJ);
    await waitForPaneStoreQuiet(page.request);
  });

  // ── RIGA 1 ────────────────────────────────────────────────────────────────
  test("RIGA 1: il filtro di testo della board RESTA, e resta APPLICATO", async ({ page }) => {
    await goToApp(page);
    await apriBoardGenerale(page);
    const board = page.getByTestId("kanban-board");
    await expect(board.getByText(CARD_DENTRO, { exact: true })).toBeVisible({ timeout: 15000 });

    const cerca = page.getByLabel("Cerca nei task");
    await cerca.fill(AGO);
    // Il filtro morde: la card che non lo passa sparisce.
    await expect(board.getByText(CARD_FUORI, { exact: true })).toHaveCount(0);
    await expect(board.getByText(CARD_DENTRO, { exact: true })).toBeVisible();

    // La scrittura passa da un effetto su `filters`: si aspetta che la chiave
    // esista davvero, non un tempo.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("board:filters-all") ?? ""))
      .toContain(AGO);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20000 });

    await expect(page.getByLabel("Cerca nei task")).toHaveValue(AGO);
    // E soprattutto: applicato. Un campo che ha ancora il testo dentro mentre
    // le colonne mostrano tutto sarebbe la peggiore delle due uscite, perche'
    // sembra a posto.
    await expect(
      page.getByTestId("kanban-board").getByText(CARD_FUORI, { exact: true }),
      "il testo del filtro e' tornato ma non filtra: la board dice il falso su cosa sta mostrando",
    ).toHaveCount(0);
    await expect(page.getByTestId("kanban-board").getByText(CARD_DENTRO, { exact: true })).toBeVisible();
  });

  // ── RIGA 2 ────────────────────────────────────────────────────────────────
  test("RIGA 2: i pannelli chiusi del drawer (descrizione, sottotask, consegna) RESTANO chiusi", async ({ page }) => {
    await goToApp(page);
    await apriBoardGenerale(page);
    let drawer = await apriDrawer(page, CARD_DRAWER);

    const manDesc = drawer.getByRole("button", { name: /^Descrizione$/ });
    const manSub = drawer.getByRole("button", { name: /^Sottotask/ });
    const manCons = drawer.getByRole("button", { name: /^Consegna$/ });
    // Tutte e tre nascono APERTE (la chiave assente vale «aperta»): il test
    // parte dallo stato di default e chiude, altrimenti misurerebbe il residuo
    // di un altro file.
    await expect(manDesc.locator("svg.lucide-chevron-down")).toHaveCount(1);
    await expect(manSub.locator("svg.lucide-chevron-down")).toHaveCount(1);
    await expect(manCons.locator("svg.lucide-chevron-down")).toHaveCount(1);

    await manDesc.click();
    await manSub.click();
    await manCons.click();
    await expect(drawer.getByTestId("task-desc-summary")).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => [
        localStorage.getItem("board:taskDescOpen"),
        localStorage.getItem("board:taskSubtasksOpen"),
        localStorage.getItem("board:taskPreviewOpen"),
      ].join("|")))
      .toBe("0|0|0");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20000 });
    drawer = await apriDrawer(page, CARD_DRAWER);

    // CHIUSO != VUOTO: la prova che la descrizione e' chiusa (e non assente) e'
    // l'accenno con la misura, lo stesso appiglio di `board-drawer-truth`.
    await expect(
      drawer.getByTestId("task-desc-summary"),
      "la descrizione si e' riaperta da sola: la scelta di chiuderla non e' sopravvissuta",
    ).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^Descrizione$/ }).locator("svg.lucide-chevron-right")).toHaveCount(1);
    await expect(drawer.getByRole("button", { name: /^Sottotask/ }).locator("svg.lucide-chevron-right")).toHaveCount(1);
    await expect(drawer.getByRole("button", { name: /^Consegna$/ }).locator("svg.lucide-chevron-right")).toHaveCount(1);
  });

  // ── RIGA 3 ────────────────────────────────────────────────────────────────
  test("RIGA 3: il drawer largo (board:taskDetailWide) RESTA largo", async ({ page }) => {
    await goToApp(page);
    await apriBoardGenerale(page);
    let drawer = await apriDrawer(page, CARD_DRAWER);

    const largo = drawer.getByTestId("task-detail-wide-toggle");
    await expect(largo).toHaveAttribute("aria-pressed", "false");
    const strettoPx = (await drawer.boundingBox())!.width;
    await largo.click();
    await expect(largo).toHaveAttribute("aria-pressed", "true");
    // Non solo l'attributo: il drawer e' DAVVERO piu' largo. Un `aria-pressed`
    // che cambia senza che cambi la geometria sarebbe uno stato senza effetto.
    await expect.poll(async () => (await drawer.boundingBox())!.width).toBeGreaterThan(strettoPx + 40);

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("board:taskDetailWide")))
      .toBe("1");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20000 });
    drawer = await apriDrawer(page, CARD_DRAWER);

    await expect(
      drawer.getByTestId("task-detail-wide-toggle"),
      "il drawer e' tornato stretto: la larghezza scelta non e' sopravvissuta",
    ).toHaveAttribute("aria-pressed", "true");
    expect((await drawer.boundingBox())!.width).toBeGreaterThan(strettoPx + 40);
  });

  // ── RIGA 4 ────────────────────────────────────────────────────────────────
  test("RIGA 4: lo Spazio di lavoro chiuso (board:taskWorkspaceOpen) RESTA chiuso", async ({ page }) => {
    await goToApp(page);
    await apriBoardGenerale(page);
    let drawer = await apriDrawer(page, CARD_DRAWER);

    // La maniglia e' DISABILITATA finche' il gruppo del task non ha pane: senza
    // una tab dentro non c'e' niente da chiudere, e chiudere una sezione vuota
    // non proverebbe niente. Se ne apre una vera.
    await drawer.getByTestId("task-workspace-add-tab").click();
    const maniglia = drawer.getByTestId("task-workspace-toggle");
    await expect(maniglia).toBeEnabled({ timeout: 20000 });
    await expect(drawer.getByTestId("task-drawer-body")).toBeVisible({ timeout: 20000 });

    await maniglia.click();
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("board:taskWorkspaceOpen")))
      .toBe("0");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20000 });
    drawer = await apriDrawer(page, CARD_DRAWER);

    await expect(drawer.getByTestId("task-workspace-toggle")).toBeEnabled({ timeout: 20000 });
    await expect(
      drawer.getByTestId("task-drawer-body"),
      "lo Spazio di lavoro si e' riaperto da solo dopo il ricaricamento",
    ).toHaveCount(0);
  });

  // ── RIGA 5 ────────────────────────────────────────────────────────────────
  test("RIGA 5: la bozza del composer dei task RESTA (e sta sul SERVER, non nel browser)", async ({ page }) => {
    // La bozza vive in `ui-state`: senza azzerarla il test riparte dal residuo
    // di un altro file e `toHaveValue` misurerebbe quello.
    await page.request.delete(`${BASE}/api/ui-state/board-composer-draft`).catch(() => {});
    const bozza = `Bozza che deve sopravvivere al ricaricamento ${STAMP}`;

    await goToApp(page);
    await apriBoardGenerale(page);
    const composer = page.getByTestId("board-task-composer");
    await expect(composer).toBeVisible({ timeout: 15000 });
    const ta = composer.locator("textarea");
    await ta.click();
    await ta.fill(bozza);

    // La scrittura e' debounced (800 ms) e va sul SERVER: si aspetta che la
    // rotta la restituisca, non un tempo.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${BASE}/api/ui-state/board-composer-draft`);
          if (!res.ok()) return "";
          const body = (await res.json().catch(() => null)) as { value?: { text?: string } } | null;
          return body?.value?.text ?? "";
        },
        { timeout: 15000 },
      )
      .toContain(bozza);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20000 });

    await expect(
      page.getByTestId("board-task-composer").locator("textarea"),
      "il testo di un task a meta' e' sparito col ricaricamento",
    ).toHaveValue(bozza, { timeout: 15000 });

    await page.request.delete(`${BASE}/api/ui-state/board-composer-draft`).catch(() => {});
  });

  // ── RIGA 6 ────────────────────────────────────────────────────────────────
  test("RIGA 6: sezioni e larghezza della colonna di progetto RESTANO nella STESSA scheda", async ({ page }) => {
    await seedProjectPane(page.request, PROJ);
    await goToApp(page);
    const win = await apriProgetto(page);

    // Uno stato che NON e' il default: File chiusa (nasce aperta), Processi
    // aperta (nasce chiusa).
    await portaSezione(win.getByTestId("project-sidebar-files"), false);
    await portaSezione(win.getByTestId("project-sidebar-processes"), true);

    // …e una larghezza scelta a mano, ben lontana dai 224px di partenza.
    const partenza = await larghezzaColonna(win);
    const maniglia = win.getByTestId("project-sidebar-resizer");
    const box = (await maniglia.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => larghezzaColonna(win)).toBeGreaterThan(partenza + 60);
    const scelta = await larghezzaColonna(win);

    await page.reload({ waitUntil: "domcontentloaded" });
    const win2 = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win2.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 20000 });

    await expect(win2.getByTestId("project-sidebar-files")).toHaveAttribute("aria-expanded", "false");
    await expect(win2.getByTestId("project-sidebar-processes")).toHaveAttribute("aria-expanded", "true");
    // Tolleranza di un pixel: la misura viene dal rettangolo disegnato, non dal
    // numero salvato.
    await expect.poll(() => larghezzaColonna(win2)).toBeGreaterThan(scelta - 2);
    expect(await larghezzaColonna(win2)).toBeLessThan(scelta + 2);
  });

  // ── RIGA 7 ────────────────────────────────────────────────────────────────
  test("RIGA 7: una SECONDA scheda eredita la colonna di progetto, non riparte dal default", async ({ page, context }) => {
    // Il rovescio della riga 6, e la ragione per cui la riga 6 da sola inganna.
    // `page.reload()` NON distingue sessionStorage da localStorage: li conserva
    // entrambi, quindi una riga che si ferma al reload da' il verde a un dato
    // che muore con la scheda. Una scheda NUOVA li separa.
    //
    // Questa riga nasce ROSSA il 20/08/2026 e documentava un difetto: apertura,
    // larghezza e altezze della colonna stavano solo in `sessionStorage`
    // (ProjectSidebar.tsx:287, :348, :372), senza nessuna ragione scritta.
    // Misurato allora: scheda 1 a 314px con File chiusa, scheda 2 dello STESSO
    // contesto a 224px (il default) con File riaperta. L'equivalente nella
    // sidebar principale (`sidebar-collapsed-groups`) stava in `localStorage`
    // da sempre: era una disparita' per caso fra due stati della stessa natura.
    // Ora la scrittura va in `localStorage` e la lettura ricade una volta sola
    // sulla vecchia casa, cosi' una finestra gia' aperta non perde niente.
    await seedProjectPane(page.request, PROJ);
    await goToApp(page);
    const win = await apriProgetto(page);

    await portaSezione(win.getByTestId("project-sidebar-files"), false);
    const partenza = await larghezzaColonna(win);
    const maniglia = win.getByTestId("project-sidebar-resizer");
    const box = (await maniglia.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => larghezzaColonna(win)).toBeGreaterThan(partenza + 60);
    const scelta = await larghezzaColonna(win);

    // Una seconda scheda dello STESSO contesto: stesso profilo, stesso
    // localStorage, stessi cookie. Cambia solo la scheda.
    const seconda = await context.newPage();
    await seconda.setViewportSize({ width: 1400, height: 900 });
    await seconda.goto("/");
    await seconda.locator('[role="main"]').waitFor({ state: "visible", timeout: 20000 });
    const win2 = seconda.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win2.locator('[data-testid="project-sidebar"]')).toBeVisible({ timeout: 20000 });

    const larghezza2 = Math.round((await win2.locator('[data-testid="project-sidebar"]').boundingBox())!.width);
    const fileAperta = await win2.getByTestId("project-sidebar-files").getAttribute("aria-expanded");
    console.log(`[RIGA 7] scheda 1: ${scelta}px, File aperta=false. Scheda 2: ${larghezza2}px, File aperta=${fileAperta}`);

    expect(
      larghezza2,
      `la seconda scheda apre la colonna a ${larghezza2}px invece dei ${scelta}px scelti: la larghezza per progetto non esce dalla scheda che l'ha decisa`,
    ).toBeGreaterThan(scelta - 2);
    expect(
      fileAperta,
      "la seconda scheda riapre la sezione File che era stata chiusa: la scelta non esce dalla scheda che l'ha fatta",
    ).toBe("false");

    await seconda.close();
  });

  // ── RIGA 8 ────────────────────────────────────────────────────────────────
  test("RIGA 8: l'a capo automatico dell'editor (editor-word-wrap) RESTA", async ({ page }) => {
    await seedProjectPane(page.request, PROJ);
    await goToApp(page);
    const win = await apriProgetto(page);

    // Si apre un file dall'albero della colonna: questo percorso monta un
    // FilePane nell'area principale, che e' il gemello di EditorTabs e legge la
    // stessa chiave.
    const albero = win.locator('[data-testid="file-tree"]').first();
    const file = albero.getByRole("treeitem", { name: /lungo\.ts/ });
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    const wrap = page.locator('[data-testid="editor-wrap-toggle"]:visible').first();
    await expect(wrap).toBeVisible({ timeout: 20000 });
    await expect(wrap).toHaveAttribute("aria-pressed", "false");
    await wrap.click();
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("editor-word-wrap"))).toBe("1");

    await page.reload({ waitUntil: "domcontentloaded" });
    const dopo = page.locator('[data-testid="editor-wrap-toggle"]:visible').first();
    await expect(
      dopo,
      "il file e' tornato aperto ma senza a capo automatico: la scelta non e' sopravvissuta",
    ).toBeVisible({ timeout: 25000 });
    await expect(dopo).toHaveAttribute("aria-pressed", "true");

    // Si rimette il default: la chiave e' GLOBALE (non per progetto ne' per
    // file), quindi lasciarla accesa cambierebbe il punto di partenza di
    // chiunque giri dopo in questa suite.
    await page.evaluate(() => localStorage.setItem("editor-word-wrap", "0"));
  });

  // ── RIGA 9 ────────────────────────────────────────────────────────────────
  test("RIGA 9: il file aperto nell'editor RESTA aperto", async ({ page }) => {
    await seedProjectPane(page.request, PROJ);
    await goToApp(page);
    const win = await apriProgetto(page);

    const albero = win.locator('[data-testid="file-tree"]').first();
    const file = albero.getByRole("treeitem", { name: /lungo\.ts/ });
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    const briciole = page.locator('[data-testid="breadcrumb-nav"]:visible');
    await expect(briciole).toContainText("lungo.ts", { timeout: 20000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="breadcrumb-nav"]:visible'),
      "il file su cui si stava lavorando non e' tornato aperto dopo il ricaricamento",
    ).toContainText("lungo.ts", { timeout: 25000 });
  });
});

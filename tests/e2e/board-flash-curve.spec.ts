/**
 * board-flash-curve.spec.ts — il LAMPO di una card, misurato.
 *
 * Tre cose che le altre due spec del lampo (`board-done-flash`,
 * `board-created-flash`) non possono provare, e per lo stesso motivo: girano
 * sotto `reducedMotion: "reduce"` come tutta la suite, quindi vedono l'anello
 * fermo del fallback e mai un fotogramma dell'animazione. Qui il contesto si
 * apre a mano con `no-preference` — la stessa uscita che usa
 * `reduced-motion-chrome-controls.spec.ts`, e per la stessa ragione.
 *
 *  1. **STA DENTRO LA COLONNA.** Il corpo di una colonna è `overflow-y-auto`,
 *     cioè un contenitore di scorrimento: taglia al suo padding box su
 *     entrambi gli assi. L'alone del lampo dipinge FUORI dal bordo della card,
 *     e con `0 0 18px 2px` arrivava a 11px contro gli 8 di padding: gli ultimi
 *     3 li tagliava, e il taglio si vedeva come una riga netta ai lati. Qui si
 *     misura la stanza vera — padding box contro rettangolo della card — sui
 *     tre lati che possono tagliare.
 *  2. **SALE, TIENE, SFUMA.** La curva di prima era accesa dal PRIMO fotogramma
 *     («0%, 45%» a piena tinta) e poi scendeva. La misura si prende sul tempo
 *     dell'animazione, non a cronometro: si mette in pausa e le si sposta
 *     `currentTime` sugli istanti che definiscono la forma. Esatta, quindi non
 *     ballerina su una macchina carica — e il fotogramma a t=0 è quello che
 *     separa le due curve senza ambiguità.
 *  3. **IL COLORE È QUELLO DELLA COLONNA D'ARRIVO.** Non più solo verde per
 *     Done e azzurro per una card nata: ogni attraversata lampeggia, e la tinta
 *     è quella della colonna in cui la card è appena entrata.
 *
 * È anche la clip di consegna: una card che attraversa tre colonne, e il menu
 * compatto di una card in corso.
 */
import { test, expect, type Browser, type Page, type APIRequestContext } from "@playwright/test";
import { projectRow } from "./helpers/project-row";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const API = `${E2E_BASE}/api`;
const PROJECT_PATH = `/tmp/e2e-flash-${Date.now()}`;
const VIDEO_DIR = "test-results/flash-evidence";
const VIEWPORT = { width: 1600, height: 900 };

/**
 * Quanto dipinge il lampo FUORI dal bordo della card: 2px di spread più metà
 * della sfumata (`0 0 12px 0`), cioè 6. È la stessa misura che `pt-1.5` dà in
 * cima al corpo colonna (Card.tsx), ed è il numero che questa spec difende:
 * crescere l'alone senza crescere la stanza rimette il taglio.
 */
const ALONE_PX = 6;
/** Uguale a `.task-flash` in index.css e a COLUMN_FLASH_MS in lib/columnFlash. */
const DURATA_MS = 2400;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

async function move(request: APIRequestContext, taskId: string, status: string): Promise<void> {
  const res = await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`, { data: { status } });
  expect(res.ok()).toBe(true);
}

async function openProjectBoard(page: Page): Promise<void> {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-flash/);
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });

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
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
}

/**
 * L'alpha dell'anello del lampo agli istanti chiesti, letta FERMANDO
 * l'animazione e spostandole `currentTime`.
 *
 * A cronometro non si può: fra il `requestAnimationFrame` e la lettura ci sono
 * il carico della macchina e il giro del protocollo, e la curva che ne uscirebbe
 * sarebbe quella del runner. Qui il tempo è quello dell'animazione, quindi la
 * misura è esatta e la stessa su una macchina scarica e su una in ginocchio.
 * Alla fine l'animazione riparte da dov'era, così la clip non resta ferma.
 */
async function profiloAlpha(page: Page, taskId: string, istanti: number[]): Promise<{ durata: number; alpha: number[] }> {
  return page.locator(`[data-task-card="${taskId}"]`).evaluate((el, istanti) => {
    const anim = el.getAnimations().find((a) => (a as CSSAnimation).animationName === "taskFlash");
    if (!anim) throw new Error("nessuna animazione `taskFlash` sulla card: il lampo non sta girando");
    const durata = Number(anim.effect?.getTiming().duration ?? 0);
    const era = anim.currentTime;
    anim.pause();
    const alpha: number[] = [];
    for (const t of istanti) {
      anim.currentTime = t;
      // `getComputedStyle` forza il ricalcolo, che rilegge l'animazione al
      // tempo appena scritto: è il valore INTERPOLATO vero, non il keyframe.
      const m = getComputedStyle(el).boxShadow.match(/rgba?\(([^)]*)\)/);
      const parti = m ? m[1].split(",").map((s) => s.trim()) : [];
      alpha.push(parti.length === 4 ? parseFloat(parti[3]) : 1);
    }
    anim.currentTime = era;
    anim.play();
    return { durata, alpha };
  }, istanti);
}

/** La tinta viva del lampo su questa card: il terzetto rgb di `--task-flash`. */
async function tinta(page: Page, taskId: string): Promise<string> {
  return page.locator(`[data-task-card="${taskId}"]`).evaluate(
    (el) => getComputedStyle(el).getPropertyValue("--task-flash").trim().split(/\s+/).join(", "),
  );
}

/**
 * Il contesto che questa spec si apre da sé.
 *
 * `reducedMotion: "no-preference"` è l'intero motivo del file: la suite gira in
 * `reduce` (playwright.config.ts) e in quella modalità il lampo È un anello
 * fermo, quindi non c'è nessuna curva da misurare. `recordVideo` perché la clip
 * è la consegna.
 */
function apriContesto(browser: Browser) {
  return browser.newContext({
    baseURL: E2E_BASE,
    viewport: VIEWPORT,
    locale: "it-IT",
    reducedMotion: "no-preference",
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  });
}

test.describe("Il lampo di una card", () => {
  // Il budget è largo perché questo test PAGA L'AVVIO A FREDDO: apre il primo
  // contesto della sua run, quindi la prima navigazione tira su servizi che poi
  // restano caldi (browser service, ponte PTY, provider, WS del gateway).
  // Misurato: 2,0 minuti al primo giro contro 21 secondi al secondo, lo stesso
  // test e le stesse asserzioni. Con 120s il primo giro andava in timeout e la
  // spec risultava «flaky» per una ragione che non riguarda ciò che misura.
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-flash" }, null, 2));
    const topic = await createTopic(request, "E2E-Flash", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("FLASH-01: sta nella colonna, sale e tiene, e prende il colore dove arriva", async ({ browser, request }) => {
    await resetPaneStore(request, []);
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    const viaggiatrice = await createTask(request, { text: "Rifare la scheda prodotto", status: "todo" });
    const inCorso = await createTask(request, { text: "Migrare le foto sul bucket", status: "in_progress" });
    await createTask(request, { text: "Scegliere il fornitore", status: "todo" });
    expect((await request.post(`${API}/test/tasks/${inCorso}/dispatch-state`, { data: { state: "working" } })).ok()).toBe(true);

    const ctx = await apriContesto(browser);
    const page = await ctx.newPage();
    const video = page.video();
    try {
      await page.goto("/");
      await openProjectBoard(page);
      const card = (id: string) => page.locator(`[data-task-card="${id}"]`);
      await expect(card(viaggiatrice)).toBeVisible({ timeout: 15_000 });

      // ── 1. La stanza ────────────────────────────────────────────────────────
      // Il padding box, non il rettangolo del contenitore: è lì che un
      // contenitore di scorrimento taglia, ed è lì che una barra di scorrimento
      // che occupa spazio sposterebbe il confine.
      const stanza = await page.getByTestId("kanban-column-body-todo").evaluate((body) => {
        const r = body.getBoundingClientRect();
        const prima = body.querySelector("[data-task-card]")!.getBoundingClientRect();
        return {
          scrollTop: body.scrollTop,
          sinistra: prima.left - (r.left + body.clientLeft),
          destra: (r.left + body.clientLeft + body.clientWidth) - prima.right,
          sopra: prima.top - (r.top + body.clientTop),
        };
      });
      // In cima si misura solo a colonna non scorsa: più giù il confine lo
      // decide lo scorrimento, non il padding.
      expect(stanza.scrollTop).toBe(0);
      expect(stanza.sinistra).toBeGreaterThanOrEqual(ALONE_PX);
      expect(stanza.destra).toBeGreaterThanOrEqual(ALONE_PX);
      expect(stanza.sopra).toBeGreaterThanOrEqual(ALONE_PX);

      // ── 2. Le azioni di «in corso», raccolte ────────────────────────────────
      // Due azioni rare su una card che non chiede niente: un tasto, non due
      // bottoni pieni. Il pannello è in un portal, quindi si cerca dalla pagina.
      //
      // PRIMA delle misure del lampo, e non per comodità: il chip `working`
      // senza un turno vivo dietro è, per il server, un orfano da recuperare, e
      // il giro di `reconcile` (10s) se lo riprende. Le misure qui sotto durano
      // di più. Il `poll` resta comunque, perché anche il caricamento della
      // board può bastare a consumarlo.
      const menuBtn = card(inCorso).getByTestId("task-choices-menu");
      await expect.poll(async () => {
        await request.post(`${API}/test/tasks/${inCorso}/dispatch-state`, { data: { state: "working" } });
        // La board si aggiorna sui broadcast, e la route di test non ne emette:
        // una PATCH innocua sullo stesso task ne emette uno col chip fresco.
        await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${inCorso}`, { data: { priority: 2 } });
        return await menuBtn.count();
      }, { timeout: 30_000, intervals: [400, 800, 1500] }).toBeGreaterThan(0);
      await expect(menuBtn).toBeVisible({ timeout: 15_000 });
      await expect(card(inCorso).getByTestId("task-choices")).toHaveCount(0);
      await menuBtn.click();
      const menu = page.getByTestId("task-choices-panel");
      await expect(menu.getByTestId("task-choice-stop")).toHaveText("Ferma");
      await expect(menu.getByTestId("task-choice-deliver-now")).toHaveText("Consegna quello che hai");
      // Il menu aperto è l'unica cosa di questa spec che non si vede nella clip
      // (succede al principio, e la clip si guarda in coda): resta come
      // schermata, accanto al video, nella stessa cartella di evidenza.
      await page.screenshot({ path: `${VIDEO_DIR}/menu-in-corso.png` });
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);

      // ── 3. La forma della curva ─────────────────────────────────────────────
      await move(request, viaggiatrice, "in_progress");
      await expect(card(viaggiatrice)).toHaveClass(/task-flash-in_progress/, { timeout: 10_000 });
      expect(["56, 189, 248", "2, 132, 199"]).toContain(await tinta(page, viaggiatrice)); // sky-400 / sky-600

      // 0 → 192ms salita, 192 → 1080 tenuta, 1080 → 2400 discesa.
      const { durata, alpha } = await profiloAlpha(page, viaggiatrice, [0, 96, 192, 1080, 1300, 2399]);
      expect(durata).toBe(DURATA_MS);
      const [aZero, aMetaSalita, aCima, aFineTenuta, aInizioDiscesa, aFine] = alpha;
      // SALITA. È il fotogramma che la vecchia curva non aveva: partiva accesa.
      expect(aZero).toBeLessThan(0.05);
      expect(aMetaSalita).toBeGreaterThan(0.15);
      expect(aMetaSalita).toBeLessThan(0.85);
      expect(aCima).toBeGreaterThan(0.85);
      // TENUTA: piena fino a metà della vita del lampo, non per due fotogrammi.
      expect(aFineTenuta).toBeGreaterThan(0.85);
      // DISCESA MORBIDA: a 220ms dall'inizio del calo se n'è andato meno di un
      // decimo. Con una `ease-out` — quella di prima — a quel punto ne era già
      // sparito un terzo.
      expect(aInizioDiscesa).toBeGreaterThan(0.75);
      expect(aInizioDiscesa).toBeLessThan(aFineTenuta);
      // E arriva a zero: è un evento, non uno stato appiccicato alla card.
      expect(aFine).toBeLessThan(0.05);

      // ── 4. Il colore della colonna d'arrivo ─────────────────────────────────
      // Ogni attraversata, non solo quella verso Done. In coda a tutto anche
      // perché è la parte che si GUARDA: la clip finisce con la card che entra
      // in review e poi in done, ciascuna col colore della sua colonna.
      for (const [colonna, atteso] of [
        ["review", ["251, 113, 133", "244, 63, 94"]],   // rose-400 / rose-500
        ["done", ["52, 211, 153", "5, 150, 105"]],      // emerald-400 / emerald-600
      ] as const) {
        await expect(card(viaggiatrice)).not.toHaveClass(/task-flash-/, { timeout: 10_000 });
        await move(request, viaggiatrice, colonna);
        await expect(card(viaggiatrice)).toHaveClass(new RegExp(`task-flash-${colonna}`), { timeout: 10_000 });
        expect(atteso).toContain(await tinta(page, viaggiatrice));
      }
      // L'ultimo lampo si guarda finire, invece di morire con la finestra.
      await expect(card(viaggiatrice)).not.toHaveClass(/task-flash-/, { timeout: 10_000 });
    } finally {
      await ctx.close();
    }
    // Il path esce sul log perché la clip è l'evidenza di consegna, e cercarla
    // fra gli artifact di una suite intera è una caccia.
    if (video) console.log(`[flash-curve] clip: ${await video.path()}`);
  });
});

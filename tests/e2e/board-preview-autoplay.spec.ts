/**
 * board-preview-autoplay.spec.ts — un video di card si muove SOLO mentre lo
 * guardi.
 *
 * Il difetto: il ramo `card` di `PreviewMedia` rendeva `<video autoPlay loop
 * preload="metadata">`. Ogni card con un `.webm` di consegna teneva quindi un
 * ciclo di decodifica aperto per sempre, comprese tutte quelle mai entrate nel
 * viewport, in una colonna che non era virtualizzata: N clip in loop simultanee
 * per una sola che qualcuno stia effettivamente guardando. Il ramo `<img>`
 * accanto diceva gia' la cosa giusta con `loading="lazy"`; a un `<video>`
 * quell'attributo non esiste, quindi il gate va scritto — un
 * IntersectionObserver sul wrapper, e `preload="none"` come stato di partenza.
 *
 * Cosa si misura qui, e perche' cosi':
 *
 *  1. **Chi e' in vista si muove, chi non lo e' sta fermo.** Non «esattamente
 *     una clip in moto»: quante ne stiano davanti agli occhi dipende da quanto
 *     e' alta la finestra, e un numero fisso misurerebbe il viewport invece
 *     della regola. Si guarda card per card il rettangolo VERO contro il corpo
 *     della colonna, con una fascia di tolleranza attorno al margine
 *     dell'observer: dentro deve suonare, molto fuori deve tacere.
 *  2. **Una clip mai entrata in vista non ha scaricato niente.**
 *     `readyState === 0` e' la prova che `preload="none"` non e' decorativo:
 *     e' il byte che non e' passato.
 *  3. **Nessuna delle due meta' e' vuota.** Almeno una in moto e almeno una
 *     ferma, o il test passerebbe anche con la funzione spenta del tutto.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-preview-autoplay-${Date.now()}`;
// Allowlist di /api/media: `${OPENCLAW_DIR}/media/`, e OPENCLAW_DIR del server
// di test sta dentro la sua DATA_DIR (helpers/test-server.ts).
const MEDIA_DIR = join(E2E_DATA_DIR, ".openclaw", "media", "preview-autoplay");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/**
 * Una clip VP8 vera, 32x32, tre secondi, 899 byte, generata con ffmpeg e messa
 * qui in chiaro: il test deve poter chiamare `play()` e vedere `paused` andare
 * a `false`, e con un file non decodificabile la promessa viene rifiutata e il
 * video resta fermo — cioe' il test passerebbe per il motivo sbagliato.
 * Inline e non un fixture su disco perche' non dipenda da ffmpeg sulla
 * macchina che esegue la suite.
 */
const CLIP_B64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAANTEU2bdLpNu4tTq4QVSalmU6yBoU27i1Or" +
  "hBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggM97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrX" +
  "sYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAp3AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WILM1vviaQ" +
  "d3ucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgSC6gSCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pz" +
  "c59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WILM1vviaQd3tnyKBFo4dFTkNPREVSRIeTTGF2YzYz" +
  "LjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDMuMDAwMDAwMDAwAB9DtnVBhueBAKO/gQAAgBADAJ0BKiAA" +
  "IAAARwiFhYiFhIgCAgJ1qgP4A/oCCFkMvQD+/W7z//lbsfdj7v/5W7//ZKiuUJH/2PIAo5WBAMgAsQEADhHYABgAGFgv9AAI" +
  "cACjlYEBkACxAQAOEdgAGAAYWC/0AAhwAKOVgQJYALEBAA4R2AAYABhYL/QACHAAo5WBAyAAsQEADhHYABgAGFgv9AAIcACj" +
  "lYED6ACxAQAOEdgAGAAYWC/0AAhwAKOVgQSwALEBAA4R2AAYABhYL/QACHAAo5WBBXgAsQEADhAQFGAAYWC/0AAhwACjlYEG" +
  "QACxAQAOEdgAGAAYWC/0AAhwAKOVgQcIALEBAA4R2AAYABhYL/QACHAAo5WBB9AAsQEADhHYABgAGFgv9AAIcACjlYEImACx" +
  "AQAOEdgAGAAYWC/0AAhwAKOVgQlgALEBAA4R2AAYABhYL/QACHAAo5WBCigAsQEADhHYABgAGFgv9AAIcACjlYEK8ACxAQAO" +
  "EdgAGAAYWC/0AAhwABxTu2uRu4+zgQC3iveBAfGCAbHwgQM=";
/** Sei card: abbastanza da farne uscire piu' di una dal viewport, poche da
 *  restare tutte dentro la pagina della colonna (vedi `COLUMN_PAGE`). */
const CARDS = 6;

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

type Req = import("@playwright/test").APIRequestContext;

async function seedReviewTask(request: Req, text: string, previewImage: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "review" } });
  expect(res.ok(), `POST ${text}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  const patch = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, {
    data: { previewImage, status: "review" },
  });
  expect(patch.ok(), `PATCH previewImage per ${text}`).toBe(true);
  // Il semino ATTECCHISCE, o si ferma qui: l'allowlist di `previewImage`
  // scarta in silenzio un percorso fuori da `${OPENCLAW_DIR}/media/`, e il
  // test misurerebbe sei card senza video.
  const back = (await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`)).json()) as {
    task?: { previewImage?: string | null };
  };
  expect(back.task?.previewImage, "previewImage scartata dall'allowlist").toBe(previewImage);
  return id;
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-preview-autoplay/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

/** Il "+" della finestra di progetto → Board (vedi board.spec.ts per il giro). */
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
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

interface ClipState {
  /** Distanza del riquadro dal corpo della colonna: 0 = dentro, >0 = quanto sotto. */
  fuoriDi: number;
  paused: boolean;
  readyState: number;
  preload: string;
}

/** Lo stato VERO di ogni clip della colonna Review, misurato nel DOM. */
async function clipStates(page: Page): Promise<ClipState[]> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-testid="kanban-column-body-review"]');
    if (!body) return [];
    const box = body.getBoundingClientRect();
    return Array.from(body.querySelectorAll("video")).map((v) => {
      const r = v.getBoundingClientRect();
      const sopra = Math.max(0, box.top - r.bottom);
      const sotto = Math.max(0, r.top - box.bottom);
      return {
        fuoriDi: Math.max(sopra, sotto),
        paused: v.paused,
        readyState: v.readyState,
        preload: v.preload,
      };
    });
  });
}

test.describe("Kanban — l'anteprima video si muove solo in vista", () => {
  test.describe.configure({ timeout: 120_000 });
  // Finestra BASSA di proposito: con sei anteprime alte ~0,7 volte la colonna
  // ne restano fuori almeno tre, che e' la meta' del test che prima non
  // esisteva. Larga abbastanza perche' Review sia raggiungibile.
  test.use({ viewport: { width: 1600, height: 700 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-preview-autoplay" }, null, 2));
    mkdirSync(MEDIA_DIR, { recursive: true });
    const topic = await createTopic(request, "E2E-PreviewAutoplay", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    for (let i = 0; i < CARDS; i++) {
      const file = join(MEDIA_DIR, `clip-${i}.webm`);
      writeFileSync(file, Buffer.from(CLIP_B64, "base64"));
      await seedReviewTask(request, `Consegna con clip ${i}`, file);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(MEDIA_DIR, { recursive: true, force: true });
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("PREVIEWPLAY-01: in vista si muove, fuori sta ferma, e cio' che non hai mai visto non e' stato scaricato", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    const review = page.getByTestId("kanban-column-body-review");
    await expect(review.locator("video")).toHaveCount(CARDS, { timeout: 20000 });

    // L'avvio non e' istantaneo: `play()` e' una promessa, e il primo frame
    // arriva dalla rete. Si aspetta la CONDIZIONE, non un tempo.
    await expect.poll(async () => (await clipStates(page)).filter((c) => !c.paused).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    const stati = await clipStates(page);
    console.log("[preview-autoplay]", JSON.stringify(stati));
    expect(stati.length).toBe(CARDS);

    // (1) La regola, card per card. La fascia fra 0 e 400px non si giudica:
    // l'observer ha 200px di `rootMargin` e il confine esatto e' suo, non del
    // test. Sopra i 400 la clip e' lontana e deve tacere.
    const inVista = stati.filter((c) => c.fuoriDi === 0);
    const lontane = stati.filter((c) => c.fuoriDi > 400);
    expect(inVista.length, "nessuna anteprima in vista da misurare").toBeGreaterThan(0);
    expect(lontane.length, "nessuna anteprima fuori vista: finestra troppo alta?").toBeGreaterThan(0);
    for (const c of inVista) expect(c.paused, `in vista e ferma: ${JSON.stringify(c)}`).toBe(false);
    for (const c of lontane) expect(c.paused, `lontana e in moto: ${JSON.stringify(c)}`).toBe(true);

    // (2) `preload="none"` non e' decorativo: la clip mai raggiunta non ha
    // scaricato nemmeno l'intestazione.
    for (const c of lontane) {
      expect(c.preload, `preload di una clip lontana: ${JSON.stringify(c)}`).toBe("none");
      expect(c.readyState, `byte scaricati da una clip mai vista: ${JSON.stringify(c)}`).toBe(0);
    }
  });

  test("PREVIEWPLAY-02: scorrendo la colonna il moto SEGUE lo sguardo", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);
    const review = page.getByTestId("kanban-column-body-review");
    await expect(review.locator("video")).toHaveCount(CARDS, { timeout: 20000 });
    await expect.poll(async () => (await clipStates(page)).filter((c) => !c.paused).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    // La prima clip esce dallo schermo: il gate deve METTERE IN PAUSA, non solo
    // evitare di partire. Senza questa meta' bastava un `autoPlay` ritardato.
    await review.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => {
      const stati = await clipStates(page);
      const prima = stati[0];
      return prima ? prima.fuoriDi > 400 && prima.paused : false;
    }, { timeout: 15000 }).toBe(true);

    // …e l'ultima, che era lontana, adesso si muove.
    await expect.poll(async () => {
      const stati = await clipStates(page);
      const ultima = stati[stati.length - 1];
      return ultima ? ultima.fuoriDi === 0 && !ultima.paused : false;
    }, { timeout: 15000 }).toBe(true);
  });
});

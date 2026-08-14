/**
 * board-composer-dictation.spec.ts — il microfono nel campo del task.
 *
 * La board non aveva voce: per dare un lavoro a un agent bisognava scriverlo.
 * Adesso il campo detta, e il tasto risponde a DUE gesti che non si coprono a
 * vicenda. Il tap lascia il microfono acceso (si detta un paragrafo, e tenere
 * premuto per un minuto non è un gesto). La pressione tenuta dura quanto il
 * dito (dal telefono si butta dentro una frase, e il tap costa due tocchi con
 * in mezzo una pausa in cui ti dimentichi di stare registrando).
 *
 * Qui si misura il giro intero: gesto, microfono aperto davvero, audio spedito
 * a `/api/stt`, e la frase che ATTERRA NEL CAMPO. La trascrizione è finta di
 * proposito (il test non deve dipendere da una chiave e da una rete), ma
 * l'audio no: il test verifica che la richiesta portasse un file vero, con
 * dentro dei byte, altrimenti "ha funzionato" vorrebbe dire solo che il
 * bottone si accende.
 *
 * Ed è la clip di consegna: due gesti e tre stati (acceso, spento, testo che
 * compare) non stanno in uno screenshot.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
// Il presidio della suite pretende che ogni spec si DICHIARI ermetica: senza
// questa riga il file gira su dati che un'altra spec puo' cancellargli sotto.
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-composer-dictation-${Date.now()}`;

const PRIMA = "Rivedere le spaziature della barra laterale";
const SECONDA = "e controllare il contrasto dei chip";

/**
 * Il microfono finto di Chromium: senza questo `getUserMedia` resta appeso a un
 * permesso che in headless nessuno concede. Produce un tono, non parlato, e va
 * benissimo: la trascrizione qui è intercettata, quello che conta è che il
 * registratore abbia prodotto dei byte veri.
 */
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  permissions: ["microphone"],
});

let projectTopicId: string | null = null;

/** Quanti byte di audio ha visto il server, richiesta per richiesta. */
const audioBytes: number[] = [];

async function stubStt(page: Page, transcripts: string[]) {
  let call = 0;
  await page.route("**/api/stt/capabilities", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, provider: "e2e", model: "stub", providers: [], language: null }),
    }),
  );
  await page.route("**/api/stt", async route => {
    // Il corpo è multipart: non serve smontarlo, serve sapere che dentro ci sia
    // un file e che non sia vuoto. Un registratore che non apre il microfono
    // manda comunque la richiesta, solo senza niente dentro.
    const body = route.request().postDataBuffer();
    audioBytes.push(body ? body.length : 0);
    const transcript = transcripts[Math.min(call, transcripts.length - 1)];
    call += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript, provider: "e2e", model: "stub" }),
    });
  });
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-composer-dictation/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

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
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  // E POI SI CLICCA. Il ciclo qui sopra cerca il «+» giusto e si ferma appena
  // la voce «Board» è a schermo: aprire il menu non apre la board. Mancava
  // questa riga, ed è il motivo per cui questa spec non era mai passata — era
  // stata scritta e mai eseguita (il global-setup rifiuta di partire senza un
  // bundle fresco, e il build non era entrato in quel turno).
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). A suite normale vale zero. */
const beat = (page: Page, ms = 1000) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

/** Preme il tasto e lo TIENE per `ms`, poi molla: il gesto del walkie-talkie. */
/**
 * Il gesto, con la durata MISURATA NELLA PAGINA.
 *
 * Il gesto decide tap-o-tenuto dal tempo fra `pointerdown` e `pointerup`
 * (`HOLD_TO_TALK_MS`, 350). Guidando il mouse da fuori, quel tempo lo decide il
 * round trip di Playwright, non il test: su un avvio freddo un tap da 80ms
 * arrivava alla pagina come un TENUTO, il microfono si spegneva al rilascio e
 * l'asserzione «resta acceso» leggeva `false`. Era la flake di questa spec, e
 * non era del prodotto.
 *
 * Qui i due eventi partono dallo stesso `evaluate`: fra loro c'è solo un
 * `setTimeout`, quindi la durata è quella chiesta a qualunque velocità giri la
 * macchina. Sono `pointer*` e non `mouse*` perché è ciò che il gesto ascolta.
 */
async function holdMic(page: Page, ms: number) {
  const mic = page.getByTestId("task-composer-dictation");
  await expect(mic).toBeVisible();
  await mic.evaluate((el, durata) => new Promise<void>((res) => {
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    setTimeout(() => { el.dispatchEvent(new PointerEvent("pointerup", opts)); res(); }, durata);
  }), ms);
}

test.describe("Board: dettare il task invece di scriverlo", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-composer-dictation" }, null, 2));
    const topic = await createTopic(request, "E2E-ComposerDictation", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    audioBytes.length = 0;
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
    await stubStt(page, [PRIMA, SECONDA]);
  });

  test("tenendo premuto parlo, e mollando la frase è nel campo", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    // Il composer si apre al fuoco: da chiuso è una pillola sottile, e il
    // microfono vive nella riga che compare solo lì.
    const field = page.getByTestId("board-task-composer").locator("textarea");
    await field.click();
    const mic = page.getByTestId("task-composer-dictation");
    await expect(mic).toBeVisible({ timeout: 10000 });
    await expect(mic).toHaveAttribute("data-listening", "false");
    await beat(page);

    // TENUTO: si accende alla pressione, non dopo una soglia. È la differenza
    // che su iOS decide se il permesso del microfono arriva o no.
    await holdMic(page, 1500);

    await expect(field).toHaveValue(PRIMA, { timeout: 15000 });
    await expect(mic).toHaveAttribute("data-listening", "false");
    expect(audioBytes).toHaveLength(1);
    // Il contenitore vuoto sta sotto il chilobyte: qui dentro c'è audio vero.
    expect(audioBytes[0]).toBeGreaterThan(2000);
    await beat(page, 1500);
  });

  test("un tocco lo lascia acceso, il tocco dopo lo chiude", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    const field = page.getByTestId("board-task-composer").locator("textarea");
    await field.click();
    const mic = page.getByTestId("task-composer-dictation");
    await expect(mic).toBeVisible({ timeout: 10000 });

    // Tap: sotto la soglia. Il microfono deve RESTARE aperto dopo il rilascio,
    // che è tutta la differenza con il gesto di prima.
    await holdMic(page, 80);
    await expect(mic).toHaveAttribute("data-listening", "true", { timeout: 10000 });
    await beat(page, 1500);
    // E resta acceso senza che nessuno lo tenga.
    await page.waitForTimeout(1200);
    await expect(mic).toHaveAttribute("data-listening", "true");

    await holdMic(page, 80);
    await expect(field).toHaveValue(PRIMA, { timeout: 15000 });
    await expect(mic).toHaveAttribute("data-listening", "false");
    await beat(page, 1200);

    // Seconda dettatura: continua DOPO la prima, non le si infila davanti.
    await holdMic(page, 1200);
    await expect(field).toHaveValue(`${PRIMA} ${SECONDA}`, { timeout: 15000 });
    expect(audioBytes).toHaveLength(2);
    await beat(page, 1500);
  });
});

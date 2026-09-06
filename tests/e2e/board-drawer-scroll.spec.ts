/**
 * board-drawer-scroll.spec.ts — il guscio del drawer del task.
 *
 * L'INVARIANTE, in una riga: dalla topbar al composer esiste ESATTAMENTE un
 * contenitore di scroll verticale, e Approva / Rimanda indietro / Landa non escono mai
 * dallo schermo.
 *
 * Perché serviva un test e non un'occhiata: il drawer era una pila di sezioni
 * in cui nessuno possedeva l'altezza — niente `overflow-y` in tutta la catena —
 * quindi ogni sezione si metteva un tetto addosso (`max-h-[40%]` sui sottotask,
 * `[38vh]` su Tentativi, `[42vh]` su Modifiche, `[50vh]` sull'anteprima). Quei
 * tetti reggono finché reggono: sommate abbastanza sezioni aperte e un'anteprima
 * alta, la colonna deborda e l'`overflow-hidden` della board taglia. Il primo
 * pezzo tagliato è l'ULTIMO figlio, cioè proprio i bottoni della decisione. È un
 * fallimento che dipende dall'altezza della finestra e da quante sezioni sono
 * aperte, quindi non si vede aprendo "un" task: si vede solo misurando il caso
 * peggiore, che è quello che questo file costruisce.
 *
 * Il caso peggiore, seminato apposta: anteprima 2200×6010 (una schermata lunga,
 * la forma che gli agenti consegnano più spesso), 30 commenti, 8 sottotask,
 * TUTTE le sezioni aperte, viewport 1280×720.
 *
 * Il secondo test riguarda le due colonne in modo largo: la sessione a sinistra
 * col task, il tiling a destra. Lì l'invariante dei bottoni si RIUSA — un modo
 * di impaginare che perde la decisione non è un modo di impaginare.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-drawer-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

// ── Un PNG VERO, della forma che rompe ───────────────────────────────────────
// Non un 1×1 finto: il difetto è nella GEOMETRIA (un'immagine alta 6010px in un
// riquadro senza tetto in px si prende mezzo drawer), quindi il test deve
// misurare un'immagine che il browser decodifica davvero con quelle dimensioni.
// Scala di grigi 8 bit, una banda per riga: comprime a pochi KB e resta
// visibilmente "lunga" nel video di consegna.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function tallPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (width + 1);
    raw[off] = 0; // filter: none
    // Bande orizzontali: nel video si vede QUALE fetta dell'immagine è a schermo.
    raw.fill(y % 400 < 200 ? 0x33 : 0xcc, off + 1, off + 1 + width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let projectTopicId: string | null = null;
let sessionTopicId: string | null = null;
let liveTopicId: string | null = null;
let steerTopicId: string | null = null;
const createdTasks: string[] = [];

async function api(request: import("@playwright/test").APIRequestContext, method: "get" | "post" | "patch", path: string, data?: unknown) {
  const res = await request[method](`${BASE}${path}`, data === undefined ? {} : { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()}`).toBe(true);
  return res.json();
}

/** Il task del caso peggiore: anteprima alta, 30 commenti, 8 sottotask, in review. */
async function seedWorstCaseTask(request: import("@playwright/test").APIRequestContext, previewPath: string) {
  const text = `Drawer worst case ${Date.now()}`;
  const task = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, {
    text,
    description: Array.from({ length: 12 }, (_, i) => `Riga ${i + 1} della descrizione, abbastanza lunga da occupare spazio verticale vero.`).join("\n\n"),
  })) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  for (let i = 0; i < 8; i++) {
    const sub = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, {
      text: `Sottotask ${i + 1}`, parentTaskId: task.id,
    })) as { id: string };
    createdTasks.push(`${PROJECT_ID}:${sub.id}`);
  }
  for (let i = 0; i < 30; i++) {
    await api(request, "post", `/api/boards/${PROJECT_ID}/tasks/${task.id}/comments`, {
      content: `Commento ${i + 1}: una nota di lavoro lunga quanto basta a riempire il thread.`,
    });
  }
  await api(request, "patch", `/api/boards/${PROJECT_ID}/tasks/${task.id}`, { previewImage: previewPath });
  // Il semino ATTECCHISCE, o si ferma qui. La rotta filtra `previewImage`
  // contro l'allowlist e, se il path non passa, risponde 200 lasciando il campo
  // a null: senza questo controllo il test misurerebbe un drawer senza
  // anteprima e passerebbe dicendo il contrario.
  const seeded = (await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`)).json()) as { task?: { previewImage?: string | null } };
  expect(seeded.task?.previewImage, "previewImage scartata dall'allowlist").toBe(previewPath);
  // In review PER ULTIMO: è lo stato che fa comparire Approva/Rimanda indietro, cioè i
  // bottoni che questo file esiste per tenere dentro lo schermo.
  await api(request, "patch", `/api/boards/${PROJECT_ID}/tasks/${task.id}`, { status: "review" });
  return { id: task.id, text };
}

/**
 * A LIGHT task in review, bound to a topic that already holds agent steps: the
 * case the Session tab exists to show.
 *
 * Status FIRST, binding second: a PATCH on the task goes through the path that
 * clears `assigned_topic_id`, so binding first would measure a task that lost
 * its agent on the way.
 */
async function seedDispatchedTask(request: import("@playwright/test").APIRequestContext, topicId: string, step: string, status: "review" | "todo" = "review") {
  const text = `Drawer sessione ${Date.now()}`;
  const task = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, { text })) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  await api(request, "patch", `/api/boards/${PROJECT_ID}/tasks/${task.id}`, { status });
  const bind = await request.post(`${BASE}/api/test/tasks/${task.id}/bind-topic`, { data: { topicId } });
  expect(bind.ok(), `bind-topic → ${bind.status()}`).toBe(true);
  // One agent step in the topic's session (`role: assistant`): it is what the
  // pane has to show, and without it the tab would only prove it exists.
  const msg = await request.post(`${BASE}/api/topics/${topicId}/system-message`, { data: { content: step } });
  expect(msg.ok(), `system-message → ${msg.status()}`).toBe(true);
  return { id: task.id, text };
}

/** Apre il drawer cliccando la card per TESTO (come board.spec.ts). */
async function openTaskDrawer(page: Page, text: string, column = "review") {
  await page.getByTestId(`kanban-column-${column}`).getByText(text).click({ timeout: 15000 });
  await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-drawer/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

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
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Apre ogni accordion CHIUSO del drawer: il caso peggiore è "tutto aperto". */
async function expandEverySection(page: Page) {
  const drawer = page.getByTestId("task-detail-drawer");
  for (const label of [/^Consegna$/, /^Descrizione$/, /^Sottotask/, /^Spazio di lavoro$/]) {
    const btn = drawer.getByRole("button", { name: label });
    if ((await btn.count()) === 0) continue;
    // A DISABLED accordion does not open, and that is not a fault: now that the
    // session is not a pane, a dispatched card with no tab, no plan and no
    // attachment has an empty workspace, and the handle says so by going dim.
    if (!(await btn.first().isEnabled())) continue;
    // L'accordion è aperto quando il suo chevron guarda in giù: qui basta
    // controllare che il corpo ci sia, e se non c'è cliccare una volta sola.
    const open = await btn.first().locator("svg.lucide-chevron-down").count();
    if (open === 0) await btn.first().click();
  }
}

/**
 * Quanti antenati SCROLLABILI ci sono fra un nodo e la root del drawer.
 * È la misura dell'invariante: uno, non zero (niente scorrerebbe) e non due
 * (scroll dentro scroll — la forma che i tetti in `vh` imitavano).
 */
async function scrollableAncestors(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const start = document.querySelector(`[data-testid="${id}"]`);
    const root = document.querySelector('[data-testid="task-detail-drawer"]');
    if (!start || !root) return -1;
    let n = 0;
    let el: HTMLElement | null = start.parentElement;
    while (el && el !== root) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") n++;
      el = el.parentElement;
    }
    return n;
  }, testId);
}

test.describe("Drawer del task — un solo scroll", () => {
  test.describe.configure({ timeout: 90_000 });

  let previewPath = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-drawer" }, null, 2));
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
    );
    // Sotto `<E2E_HOME>/.topics/media/`, non nel progetto e non nella MIA home:
    // l'allowlist che accetta un `previewImage` (server/utils.ts:isPathAllowed)
    // guarda la HOME DEL SERVER, che qui è isolata. Un'anteprima scritta altrove
    // viene scartata in silenzio e il test misurerebbe un drawer SENZA
    // anteprima — cioè non il caso peggiore, cioè niente.
    const mediaDir = `${E2E_HOME}/.topics/media`;
    mkdirSync(mediaDir, { recursive: true });
    previewPath = `${mediaDir}/e2e-drawer-2200x6010-${Date.now()}.png`;
    writeFileSync(previewPath, tallPng(2200, 6010));
    const topic = await createTopic(request, "E2E-Drawer", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    if (sessionTopicId) await deleteTopic(request, sessionTopicId);
    if (liveTopicId) await deleteTopic(request, liveTopicId);
    if (steerTopicId) await deleteTopic(request, steerTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
    if (previewPath) rmSync(previewPath, { force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("DRAWER-01: un solo contenitore di scroll, e Approva resta dentro il viewport", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-35" });
    await page.setViewportSize({ width: 1280, height: 720 });
    const task = await seedWorstCaseTask(page.request, previewPath);

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);

    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);

    const scroller = drawer.getByTestId("task-brief-scroll");
    await expect(scroller).toBeVisible();

    // (1) UN solo antenato scrollabile fra il blocco meta e la root del drawer.
    expect(await scrollableAncestors(page, "task-detail-subtasks")).toBe(1);

    // (2) I bottoni della decisione sono DENTRO il drawer, non tagliati sotto.
    const approva = drawer.getByRole("button", { name: /^Approva/ });
    await expect(approva).toBeVisible();
    const boxOf = async (loc: ReturnType<typeof drawer.getByRole>) => {
      const b = await loc.boundingBox();
      if (!b) throw new Error("elemento senza box");
      return b;
    };
    const drawerBox = await boxOf(drawer.locator("xpath=."));
    let approveBox = await boxOf(approva);
    expect(approveBox.y + approveBox.height).toBeLessThanOrEqual(drawerBox.y + drawerBox.height + 1);

    // (3) Il brief SCORRE davvero, e scorrendo fino in fondo l'ultima sezione
    //     entra in vista — cioè lo scroll è quello vero, non un residuo.
    const metrics = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(300);

    // (4) …e dopo lo scroll i bottoni sono ANCORA lì. È il punto: scorrere il
    //     brief non porta via la decisione, perché la decisione non è nel brief.
    approveBox = await boxOf(approva);
    expect(approveBox.y + approveBox.height).toBeLessThanOrEqual(drawerBox.y + drawerBox.height + 1);
    await expect(approva).toBeVisible();

    // (5) L'anteprima è una FETTA del drawer, non il drawer: tetto in px, e in
    //     ogni caso sotto il 30% dell'altezza (il vecchio `max-h-[50vh]` su
    //     un'immagine 2200×6010 si prendeva mezzo pannello).
    const img = drawer.getByTestId("task-detail-preview").locator("img");
    await expect(img).toBeVisible();
    const imgBox = await boxOf(img);
    expect(imgBox.height).toBeLessThanOrEqual(240);
    expect(imgBox.height).toBeLessThanOrEqual(0.3 * drawerBox.height);

    // (6) Lo Spazio di lavoro NON è collassato: il GroupLayout è fuori dallo
    //     scroll proprio perché lì dentro perderebbe l'altezza definita.
    //
    //     La soglia misura l'INTENTO, non un numero tondo. Prima diceva 200px,
    //     che era il valore comodo il giorno in cui il test è nato: lo spazio di
    //     lavoro è `flex-1` accanto al brief e si divide con lui ciò che la zona
    //     di decisione lascia, quindi ogni bottone che una decisione guadagna
    //     gli toglie mezzo pixel. A forza di righe nuove in fondo al drawer è
    //     sceso a 186px e il test è diventato rosso senza che niente si fosse
    //     rotto: 186px su una finestra da 720 non è un pannello collassato, è un
    //     pannello un po' più stretto.
    //
    //     Collassato vuol dire una cosa sola: dentro non ci sta nient'altro che
    //     la barra delle tab. Quella riga è alta 40px (`chrome-row-h10`), quindi
    //     il doppio è il confine: sotto, il GroupLayout ha perso l'altezza
    //     definita che stare fuori dallo scroll gli deve garantire; sopra, sotto
    //     la barra c'è una pane vera che si guarda.
    const body = drawer.getByTestId("task-drawer-body");
    await expect(body).toBeVisible();
    expect((await boxOf(body)).height).toBeGreaterThan(80);
  });

  test("DRAWER-02: la maniglia della Consegna nasconde l'anteprima e non muove i bottoni", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const task = await seedWorstCaseTask(page.request, previewPath);

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);

    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);

    const preview = drawer.getByTestId("task-detail-preview");
    await expect(preview.locator("img")).toBeVisible();

    // Chiudere la DESCRIZIONE non tocca l'anteprima: erano sorelle nello stesso
    // riquadro ma fuori dallo stesso ramo, ed è il difetto che ha dato origine
    // alla sezione propria.
    const before = await preview.locator("img").boundingBox();
    await drawer.getByRole("button", { name: /^Descrizione$/ }).click();
    await page.waitForTimeout(200);
    await expect(preview.locator("img")).toBeVisible();

    // La maniglia della Consegna, invece, la nasconde davvero.
    await drawer.getByRole("button", { name: /^Consegna$/ }).click();
    await expect(preview.locator("img")).toHaveCount(0);

    // E i bottoni della decisione non si sono mossi di riga: stanno fuori dallo
    // scroll, quindi non dipendono da cosa è aperto sopra.
    const approva = drawer.getByRole("button", { name: /^Approva/ });
    await expect(approva).toBeVisible();
    expect(before).not.toBeNull();
  });

  test("DRAWER-03: in modo largo la sessione sta a sinistra e il tiling a destra", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const task = await seedWorstCaseTask(page.request, previewPath);

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);

    const drawer = page.getByTestId("task-detail-drawer");

    // Modo stretto: nessuna seconda colonna, la sessione è una pane del gruppo,
    // e nessuna fascia del brief — il titolo sta impilato dentro l'unica colonna.
    await expect(drawer.getByTestId("task-drawer-right")).toHaveCount(0);
    await expect(drawer.getByTestId("task-brief-header")).toHaveCount(0);

    await drawer.getByTitle(/Allarga il drawer/).click();
    const right = drawer.getByTestId("task-drawer-right");
    await expect(right).toBeVisible({ timeout: 5000 });

    // LA CONSEGNA È IL TITOLO: in modo largo sale in una fascia SOPRA entrambe
    // le colonne, a tutta larghezza. In una colonna da 22rem un titolo di due
    // righe e mezza era la prima cosa che si perdeva, proprio mentre le due
    // colonne esistono per farti vedere di più.
    const header = drawer.getByTestId("task-brief-header");
    await expect(header).toBeVisible({ timeout: 5000 });
    const drawerW = (await drawer.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    expect(headerBox.width).toBeGreaterThanOrEqual(drawerW.width - 2);
    // …e sta SOPRA le due colonne, non dentro una delle due.
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual((await right.boundingBox())!.y + 1);
    // Il tetto è quello che le impedisce di mangiarsi le superfici di lavoro.
    expect(headerBox.height).toBeLessThanOrEqual(drawerW.height * 0.6);

    // Due colonne sorelle: sinistra stretta e non comprimibile, destra larga.
    const session = drawer.getByTestId("task-session-column");
    await expect(session).toBeVisible();
    const sessionBox = (await session.boundingBox())!;
    const rightBox = (await right.boundingBox())!;
    expect(sessionBox.width).toBeGreaterThanOrEqual(320);
    expect(sessionBox.width).toBeLessThanOrEqual(400);
    expect(rightBox.width).toBeGreaterThanOrEqual(400);
    // Sorelle, non annidate: la destra comincia dove finisce la sinistra.
    expect(rightBox.x).toBeGreaterThanOrEqual(sessionBox.x + sessionBox.width - 2);

    // La colonna destra non è mai un rettangolo vuoto (l'orfano da `thread:`
    // tolto dal gruppo è il modo in cui questa struttura si rompe per prima).
    expect(await right.evaluate((el) => el.childElementCount)).toBeGreaterThan(0);

    // …e l'invariante dei bottoni vale anche qui.
    const approva = drawer.getByRole("button", { name: /^Approva/ });
    await expect(approva).toBeVisible();
    const drawerBox = (await drawer.boundingBox())!;
    const approveBox = (await approva.boundingBox())!;
    expect(approveBox.y + approveBox.height).toBeLessThanOrEqual(drawerBox.y + drawerBox.height + 1);

    // Ritorno a stretto: la seconda colonna sparisce dal DOM, non si nasconde.
    await drawer.getByTitle(/Riduci il drawer/).click();
    await expect(drawer.getByTestId("task-drawer-right")).toHaveCount(0);
  });
  /**
   * DRAWER-03 — l'invariante NUOVA: l'output e la sessione stanno insieme.
   *
   * Finché la sessione era una pane del gruppo, aprire quello che il task ha
   * prodotto (una tab, il piano, un allegato) la NASCONDEVA: si guardava
   * l'output senza il thread che lo spiega, o il thread senza l'output di cui
   * parla. Non era un difetto visibile in uno screenshot — le due cose erano
   * entrambe "a posto", una alla volta.
   *
   * Adesso sono due sezioni sorelle in colonna sola: l'output sopra, la
   * sessione sotto attaccata al composer. Il test misura proprio quello che
   * prima era impossibile: le due zone alte insieme, e la sessione FUORI dal
   * gruppo di tab (dentro sarebbe la vecchia struttura con un'etichetta nuova).
   */
  test("DRAWER-03b: aperto l'output, la sessione resta sotto gli occhi", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const task = await seedWorstCaseTask(page.request, previewPath);

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);

    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);

    const session = drawer.getByTestId("task-session-column");
    const body = drawer.getByTestId("task-drawer-body");
    await expect(session).toBeVisible();
    await expect(body).toBeVisible();

    const sessionBox = (await session.boundingBox())!;
    const bodyBox = (await body.boundingBox())!;
    // Alte tutte e due: aperto non vuol dire "c'è la barra delle tab".
    expect(bodyBox.height).toBeGreaterThan(80);
    expect(sessionBox.height).toBeGreaterThan(80);
    // Sorelle e non annidate: la sessione comincia dove finisce l'output, ed è
    // lei quella attaccata al composer.
    expect(sessionBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height - 2);
    // The CONVERSATION left the tabs: the column with the composer is not a pane.
    expect(await body.getByTestId("task-session-column").count()).toBe(0);

    // With the workspace closed the CONVERSATION stays: it is the one zone of
    // the drawer that does not close, and it is the point of the whole layout.
    // The handle hides what you look AT (browser tabs, plan, attachments),
    // never the conversation nor the composer.
    await drawer.getByTestId("task-workspace-toggle").click();
    await expect(body).toHaveCount(0);
    await expect(session).toBeVisible();
    expect((await session.boundingBox())!.height).toBeGreaterThan(80);
  });

  /**
   * DRAWER-04 - the agent's steps are IN THE CONVERSATION, and there is no
   * second surface holding them.
   *
   * They lived in a tab of their own for one release, and before that in a
   * collapsed sliver above every thread row. Both shapes made the reader do the
   * same join by hand: what the agent DID on one side, what it SAID on the
   * other, and the wall clock as the only thing relating them. One list now,
   * and this measures both halves of that sentence - the step is inside the
   * column you write in, and the tab that used to hold it does not exist.
   */
  test("DRAWER-04: il passo dell'agente sta nella conversazione, e la scheda Sessione non c'e' piu'", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const topic = await createTopic(page.request, `E2E-Drawer-Session-${Date.now()}`);
    sessionTopicId = topic.id;
    const step = `Passaggio dell'agente ${Date.now()}`;
    const task = await seedDispatchedTask(page.request, topic.id, step);

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text);

    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);

    // The step is in the column with the composer, not behind a tab.
    const session = drawer.getByTestId("task-session-column");
    await expect(session).toBeVisible();
    await expect(session.getByText(step)).toBeVisible({ timeout: 15000 });

    // And the tab is GONE. The id was the persistence key of the old pane, so
    // this is also the assertion that no saved layout resurrects it.
    await expect(drawer.getByTestId(`pane-tab-session:${task.id}`)).toHaveCount(0);
    await expect(drawer.getByTestId("task-session-pane")).toHaveCount(0);
  });

  /**
   * DRAWER-05 — a live turn arrives on the WIRE, and the conversation is ONE
   * list: the agent's step, the reader's steer with where it got to, the
   * comment the agent wrote drawn ONCE, and a question answerable on the spot.
   *
   * The drawer used to ask for 200 rows of history every 3 seconds to notice a
   * token. It now reads the same store the chat reduces every frame into, and
   * to be fed at all it has to DECLARE its topic: per-token deltas are routed
   * on the subscribed set, and a drawer is not a pane.
   *
   * So there are three things to measure, and the negative one is the point:
   *  · the window really sends a `subscribe` frame carrying this topic;
   *  · the streamed text is in the session BEFORE `stream:end` arrives;
   *  · zero history reads while the turn runs. The counter is armed AFTER the
   *    mount on purpose: mount, wake-up and `stream:end` are the three reads
   *    that survive, and none of them falls inside the window measured here.
   */
  test("DRAWER-05: il turno vivo, lo steer in coda e la parola dell'agente disegnata una volta sola", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const topic = await createTopic(page.request, `E2E-Drawer-Live-${Date.now()}`);
    liveTopicId = topic.id;
    const seeded = `Passo seminato ${Date.now()}`;
    // `todo`, and the global auto-dispatch off for the length of the test.
    // "Queued" is a state of a card that still OWES a turn (KANBAN-74 lists
    // `in_progress` and `todo`), and `todo` is the one a test can hold still:
    // on `in_progress` the comment route resumes the agent for real, so the
    // chip would be racing the envelope that its own resume writes - a race
    // whose two outcomes are both correct, which is the definition of a test
    // that will flake.
    const settings = (await api(page.request, "get", "/api/all-boards/settings")) as { autoDispatch: boolean };
    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: false });
    await api(page.request, "post", "/api/test/dispatch-hold", { ms: 180_000 });
    const task = await seedDispatchedTask(page.request, topic.id, seeded, "todo");

    const list = await page.request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await list.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = Object.values(topics.topics).find((t) => t.id === topic.id)?.sessionKey;
    expect(sessionKey, "the bound topic must carry a sessionKey").toBeTruthy();

    // The socket, proxied: what the page SENDS is readable (the subscribe
    // frame), and frames can be pushed back as the server would push them.
    const sent: string[] = [];
    let inject: ((data: string) => void) | null = null;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => { sent.push(String(m)); server.send(m); });
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });
    const send = (frame: Record<string, unknown>) =>
      inject!(JSON.stringify({ sessionKey, topicId: topic.id, ...frame }));

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text, "todo");
    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);
    // No tab to click: the steps are in the column you write in.
    const pane = drawer.getByTestId("task-session-column");
    // The mount read has happened: the seeded step is on screen. Everything
    // after this line is what the wire alone can do.
    await expect(pane.getByText(seeded)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);

    // The declaration: this window asked to hear about the drawer's topic.
    const declares = (frame: string) => {
      const f = JSON.parse(frame) as { type?: string; topicIds?: string[] };
      return f.type === "subscribe" && (f.topicIds ?? []).includes(topic.id);
    };
    await expect.poll(() => sent.some(declares), { timeout: 10_000 }).toBe(true);

    // From here on, every history read is a regression.
    let historyReads = 0;
    await page.route("**/api/history/**", async (route) => { historyReads++; await route.fallback(); });

    const MSG = `live-drawer-${Date.now()}`;
    // Twelve pieces, not three: each one is waited for on screen, so the turn
    // takes as long as a real one takes to type and the clip shows a session
    // growing instead of a single jump.
    const PIECES = [
      "Sto leggendo il file. ",
      "La riga incriminata ",
      "e' la 214, ",
      "e non e' quella ",
      "che il rapporto indicava. ",
      "Il valore ci arriva ",
      "gia' arrotondato, ",
      "quindi la differenza ",
      "nasce prima, ",
      "in chi lo scrive. ",
      "Ho lasciato il confronto ",
      "in fondo al file.",
    ];
    send({ type: "stream:start", messageId: MSG });
    let written = "";
    for (const piece of PIECES) {
      send({ type: "stream:content_chunk", messageId: MSG, content: piece });
      written += piece;
      // The wait IS the assertion: the text is in the session while the turn is
      // still open, so the pacing comes from the page and not from a clock.
      await expect(pane).toContainText(written.trim(), { timeout: 10_000 });
    }
    expect(historyReads, "no history read while following a live turn").toBe(0);

    // The turn ends, and the drawer asks for the history again: that read is
    // NOT asserted here, and the reason is worth writing down. `loadHistory`
    // drops a re-fetch that lands within 5 seconds of the previous one, so at
    // this timescale the request never reaches the network and a counter here
    // would be measuring the dedup instead of the drawer. What the drawer does
    // with a `stream:end` (its own session only, never a neighbour's) is held
    // by the unit gate on the source, `Board/TaskDetail.test.ts`.
    send({ type: "stream:end", messageId: MSG, completed: true, latencyMs: 900 });
    await expect(pane).toContainText(written.trim());
    expect(historyReads, "the turn ended, and still no poll behind it").toBe(0);

    // ── WHERE WHAT YOU WROTE GOT TO ───────────────────────────────────────
    // The steer goes in through the composer, like a person's does. The card
    // is `in_progress` and no envelope has gone out since, so the bubble says
    // "queued" - a state DERIVED from the envelopes at every read, which is
    // why nothing had to write it into the thread.
    const steer = `Guarda anche il caso vuoto ${Date.now()}`;
    const composer = drawer.locator("textarea").last();
    await composer.fill(steer);
    await composer.press("Enter");
    await expect(pane.getByText(steer)).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("task-comment-queued").last()).toBeVisible({ timeout: 15_000 });

    // ── THE RESUME CARRIES IT, AND THE ENVELOPE DOES NOT SHOW ─────────────
    // The dispatcher's resume is a `user` row naming the comment ids it
    // delivered. Seeded here with the shape the server writes (T1 proves the
    // server writes it); what is measured is the projection: the row does not
    // appear, and the chip on the human bubble flips to "delivered".
    const withComments = (await (await page.request.get(
      `${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`,
    )).json()) as { comments?: Array<{ id: string; content: string }> };
    const steerId = withComments.comments?.find((c) => c.content.includes(steer))?.id;
    expect(steerId, "lo steer deve essere una riga del filo").toBeTruthy();
    const ENVELOPE = "Riprendi il lavoro sulla card.";
    await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "user",
      content: ENVELOPE,
      blocks: [{ kind: "dispatched-envelope", commentIds: [steerId] }],
    });

    // ── THE AGENT'S WORD, DRAWN ONCE ──────────────────────────────────────
    // An assistant row that called `comment_task`, and the comment that came
    // out of it, anchored by `messageId`. Two lists said this twice; here the
    // comment sits right under its step and the mirrored tool row is gone.
    const spoken = `Ho chiuso il caso vuoto ${Date.now()}`;
    const COMMENT_TOOL_ID = `tc-comment-${Date.now()}`;
    const step2 = (await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "assistant",
      content: "Chiuso.",
      blocks: [
        { kind: "text", text: "Chiuso." },
        { kind: "tool", toolCall: { id: COMMENT_TOOL_ID, name: "mcp__topics__comment_task", args: { content: spoken }, status: "success" } },
      ],
    })) as { message: { id: string } };
    await api(page.request, "post", `/api/test/tasks/${task.id}/anchored-comment`, {
      content: spoken, author: "agent", messageId: step2.message.id,
    });

    // ── A QUESTION NOBODY ROUTED IS ANSWERED HERE ─────────────────────────
    // Same tool family, no comment anchored to it: the row stays, and with it
    // the form. Before the conversation was one list this question was
    // answerable in the chat and dead in the card.
    const ASK_ID = `tc-ask-${Date.now()}`;
    await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "assistant",
      content: "",
      blocks: [{
        kind: "tool",
        toolCall: {
          id: ASK_ID,
          name: "mcp__topics__ask_user_question",
          args: {},
          status: "waiting_for_input",
          userInputSchema: {
            kind: "questions",
            questions: [{ question: "Tengo il caso vuoto fuori dallo scope?", options: [{ label: "Si" }, { label: "No" }] }],
          },
        },
      }],
    });

    // Nothing above went over the socket: those rows are in the transcript, and
    // the drawer reads it back at the END OF A TURN. So the end of the turn is
    // what gets asked for, again, until the projection has caught up. Asking
    // (rather than sleeping) is the point: `loadHistory` drops a re-read that
    // lands within 5 seconds of the last one, so a fixed wait here would be
    // measuring the dedup.
    const again = pane;
    await expect.poll(
      async () => {
        send({ type: "stream:end", messageId: MSG, completed: true, latencyMs: 900 });
        return again.getByTestId("task-comment-delivered").count();
      },
      { timeout: 40_000, intervals: [1_000, 2_000, 3_000, 3_000, 3_000] },
    ).toBeGreaterThan(0);

    // The envelope is not on screen, and the chip says it arrived.
    await expect(again.getByTestId("task-comment-delivered").last()).toBeVisible({ timeout: 20_000 });
    await expect(again.getByTestId("dispatch-envelope-row")).toHaveCount(0);
    await expect(again.getByText(ENVELOPE)).toHaveCount(0);

    // The agent's words: ONCE, right under the step they came out of, and the
    // mirrored tool row is not drawn. Counted on the text of the column rather
    // than on matching elements, because a bubble nests: two nodes carrying one
    // sentence is one drawing, and it is the DRAWINGS that must not be two.
    await expect(again.getByTestId(`tool-call-row-${COMMENT_TOOL_ID}`)).toHaveCount(0);
    const drawn = await again.evaluate((el, arg: { id: string; needle: string }) => {
      const step = el.querySelector(`[data-message-id="${arg.id}"]`);
      const leaf = [...el.querySelectorAll("*")].find((n) => n.children.length === 0 && (n.textContent ?? "").includes(arg.needle));
      return {
        times: (el.textContent ?? "").split(arg.needle).length - 1,
        order: step && leaf
          ? (step.compareDocumentPosition(leaf) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before")
          : "missing",
      };
    }, { id: step2.message.id, needle: spoken });
    expect(drawn.times, "la parola dell'agente e' disegnata una volta sola").toBe(1);
    expect(drawn.order, "il commento ancorato segue il suo passo").toBe("after");

    // …and the unrouted question is answerable right here.
    await expect(again.getByTestId(`tool-input-form-${ASK_ID}`)).toBeVisible({ timeout: 20_000 });

    // THE PICTURE OF THE THING, at the size the reviewer looks at it: the wide
    // mode, both columns, and the one list holding the agent's step, the human
    // bubble with its chip and the question waiting to be answered. Attached to
    // the run rather than written into the repo.
    await page.setViewportSize({ width: 1600, height: 900 });
    const widen = drawer.getByTitle(/Allarga il drawer/);
    if (await widen.count()) await widen.click();
    await expect(drawer.getByTestId("task-drawer-right")).toBeVisible({ timeout: 10_000 });
    await testInfo.attach("conversazione-unica-1600x900", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Back to whatever it was, not to `true`: the switch is GLOBAL and the DB
    // is shared, so a test that hands it back changed is a test that breaks the
    // next one (BOARD-01 reads it).
    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: settings.autoDispatch });
  });

  /**
   * DRAWER-06 - a steer written mid-turn shows up as a CHIP, not as a note.
   *
   * The dispatcher used to write two service rows to say where your message had
   * got to: one while the agent was working, one when the flush found the card
   * out of the queue. Both were STATE, and state is now carried by the chip
   * under the bubble: "queued" until the envelope goes out, "delivered" once it
   * does. The note said the same thing in the past tense, forever, next to the
   * words that already said it.
   *
   * THE BOUNDARY, declared: that the dispatcher no longer writes those rows is
   * held by its unit test (no `service` row while it buffers, and the envelope
   * carrying the `commentIds`). What is measured HERE is the surface, with the
   * same staging as DRAWER-05 - a card that still owes a turn, reconcile held:
   * no app row appears in the thread, and what says where the steer got to is
   * the chip, which changes when the envelope lands.
   */
  test("DRAWER-06: lo steer a turno vivo non produce nessuna nota, solo il chip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const topic = await createTopic(page.request, `E2E-Drawer-Steer-${Date.now()}`);
    steerTopicId = topic.id;
    const settings = (await api(page.request, "get", "/api/all-boards/settings")) as { autoDispatch: boolean };
    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: false });
    await api(page.request, "post", "/api/test/dispatch-hold", { ms: 120_000 });
    const seeded = `Passo seminato ${Date.now()}`;
    const task = await seedDispatchedTask(page.request, topic.id, seeded, "todo");

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, task.text, "todo");
    const drawer = page.getByTestId("task-detail-drawer");
    await expandEverySection(page);
    const pane = drawer.getByTestId("task-session-column");
    await expect(pane.getByText(seeded)).toBeVisible({ timeout: 15_000 });
    const notesBefore = await pane.getByTestId("task-app-note").count();

    const steer = `Guarda anche il caso vuoto ${Date.now()}`;
    const composer = drawer.locator("textarea").last();
    await composer.fill(steer);
    await composer.press("Enter");

    // The bubble is yours and the chip is under it: not one extra row.
    await expect(pane.getByText(steer)).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("task-comment-queued").last()).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId("task-app-note")).toHaveCount(notesBefore);
    await expect(pane.getByText(/Feedback ricevuto/)).toHaveCount(0);

    // And when the envelope goes out it is the SAME chip that changes word: one
    // row that updates, not two rows that both stay.
    const withComments = (await (await page.request.get(
      `${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`,
    )).json()) as { comments?: Array<{ id: string; content: string }> };
    const steerId = withComments.comments?.find((c) => c.content.includes(steer))?.id;
    expect(steerId, "the steer must be a row of the thread").toBeTruthy();
    await api(page.request, "post", `/api/test/topics/${topic.id}/session-row`, {
      role: "user",
      content: "Riprendi il lavoro sulla card.",
      blocks: [{ kind: "dispatched-envelope", commentIds: [steerId] }],
    });
    // The envelope row is in the transcript, which the drawer reads back at
    // MOUNT: one reload, instead of a wait on the clock.
    await page.reload();
    // The board is already open in the group (the "+" filters out the singleton
    // panes already there): wait for it to remount, do not reopen it.
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    await openTaskDrawer(page, task.text, "todo");
    const reopened = page.getByTestId("task-detail-drawer");
    await expect(reopened.getByTestId("task-comment-delivered").last()).toBeVisible({ timeout: 20_000 });
    await expect(reopened.getByTestId("dispatch-envelope-row")).toHaveCount(0);
    await expect(reopened.getByTestId("task-app-note")).toHaveCount(notesBefore);

    await api(page.request, "patch", "/api/all-boards/settings", { autoDispatch: settings.autoDispatch });
  });

});

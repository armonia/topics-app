/**
 * board-drawer-truth.spec.ts — il drawer non dice cose false sulla card.
 *
 * Due segnalazioni del 12/08, stessa forma: il drawer mostra qualcosa che non
 * corrisponde alla realtà della card.
 *
 *   1. CHIUSO ≠ VUOTO — la descrizione sta in un accordion e la scelta di
 *      chiuderlo è ricordata in `localStorage` (`board:taskDescOpen`) per OGNI
 *      card. Chiusa una volta, una descrizione da 2.578 caratteri (il piano
 *      completo di `d4fcce17`) si legge come «non c'è una descrizione utile».
 *      Il difetto non è l'accordion, è che chiuso non si distingueva da vuoto.
 *      Il test parte dallo stato in cui si trova Attilio adesso — la chiave a
 *      `'0'` — perché è lì che il difetto vive.
 *
 *   2. UNO STATO SCRITTO COME MESSAGGIO — la bonifica delle anteprime false ha
 *      lasciato «⚠️ Anteprima RITIRATA…» nel thread di 23 card. Un messaggio non
 *      invecchia: dove l'anteprima è tornata, la nota continua a dire il
 *      contrario. Qui si prova il verso giusto E il verso sbagliato — senza
 *      anteprima la nota RESTA (è ancora vera), con l'anteprima sparisce dalla
 *      vista. Sparisce dalla VISTA: la riga nel DB non si tocca, ed è per
 *      questo che il test la ririchiede all'API dopo averla vista sparire.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-drawer-truth-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/**
 * La descrizione VERA del caso: 2.578 caratteri, la misura del rilievo. Non
 * «una descrizione lunga» a occhio — è il numero che compare nella maniglia, e
 * un test che ne usasse un altro proverebbe un caso che non è successo.
 */
const DESC_FIRST_LINE = "Due segnalazioni di Attilio del 12/08, stessa superficie e stessa forma.";
function longDescription(): string {
  const head = `## Il piano\n\n${DESC_FIRST_LINE}\n\n`;
  const filler = "Cosa verificare PRIMA di scrivere codice: la misura, non l'impressione. ";
  let out = head;
  while (out.length < 2578) out += filler;
  return out.slice(0, 2578);
}

// Il testo VERO scritto dalla bonifica (scripts/check-preview-evidence.ts).
const NOTA_RITIRO =
  "⚠️ Anteprima RITIRATA: era byte per byte identica a quella di altre 12 card " +
  "(md5 `e2fefb66`), cioè non era evidenza di questo lavoro. " +
  "La consegna resta in review: allega tu l'anteprima giusta con `update_task(preview_image=…)`.";

/** PNG 2×2 vero: serve un'immagine che il browser decodifichi, non un byte finto. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
  "base64",
);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function api(request: import("@playwright/test").APIRequestContext, method: "post" | "patch", path: string, data: unknown) {
  const res = await request[method](`${BASE}${path}`, { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()}`).toBe(true);
  return res.json();
}

async function seedTask(
  request: import("@playwright/test").APIRequestContext,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const task = (await api(request, "post", `/api/boards/${PROJECT_ID}/tasks`, { text, ...extra })) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task.id;
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-drawer-truth/);
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

async function openTaskDrawer(page: Page, text: string) {
  await page.getByTestId("kanban-board").getByText(text, { exact: true }).first().click({ timeout: 15000 });
  await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
}

test.describe("Drawer del task — quello che mostra è quello che c'è", () => {
  test.describe.configure({ timeout: 90_000 });

  let previewPath = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-drawer-truth" }, null, 2));
    // L'allowlist di `previewImage` guarda la HOME DEL SERVER, che qui è isolata:
    // un'immagine scritta altrove viene scartata in SILENZIO e il test misurerebbe
    // una card senza anteprima passando lo stesso.
    const mediaDir = `${E2E_HOME}/.topics/media`;
    mkdirSync(mediaDir, { recursive: true });
    previewPath = `${mediaDir}/e2e-drawer-truth-${Date.now()}.png`;
    writeFileSync(previewPath, TINY_PNG);
    const topic = await createTopic(request, "E2E-DrawerTruth", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
    if (previewPath) rmSync(previewPath, { force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("TRUTH-01: con l'accordion chiuso una descrizione da 2.578 caratteri non sembra assente", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-36" });
    await page.setViewportSize({ width: 1280, height: 800 });
    const desc = longDescription();
    expect(desc.length, "il caso è quello misurato: 2.578 caratteri").toBe(2578);
    const text = `Descrizione ricca ${Date.now()}`;
    await seedTask(page.request, text, { description: desc, status: "todo" });

    // LO STATO IN CUI SI TROVA ATTILIO ADESSO: la chiave a '0'. È il punto del
    // rilievo — non «apri il drawer e guarda», ma «l'hai chiusa una volta e da
    // allora ogni card sembra vuota».
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("board:taskDescOpen", "0"));
    await page.reload();
    await openProjectBoard(page);
    await openTaskDrawer(page, text);
    await didascalia(page, "Descrizione CHIUSA (board:taskDescOpen = '0')");

    const drawer = page.getByTestId("task-detail-drawer");
    // Chiusa davvero: il corpo markdown non c'è.
    const handle = drawer.getByRole("button", { name: /^Descrizione$/ });
    await expect(handle).toBeVisible();
    await expect(handle.locator("svg.lucide-chevron-right")).toHaveCount(1);

    // IL FATTO: da chiusa la sezione porta la MISURA e la prima riga vera.
    const summary = drawer.getByTestId("task-desc-summary");
    await expect(summary).toBeVisible();
    const testo = (await summary.innerText()).trim();
    console.log(`[TRUTH-01] accenno da chiuso: ${JSON.stringify(testo)}`);
    expect(testo).toContain("2.578 caratteri");
    expect(testo).toContain("Il piano"); // la prima riga di prosa, senza i `##`
    expect(testo).not.toContain("##");
    await beat(page);

    // E la maniglia apre ancora: l'accenno non ha rubato il gesto.
    await handle.click();
    await expect(drawer.getByTestId("task-desc-summary")).toHaveCount(0);
    await expect(drawer.getByText(DESC_FIRST_LINE)).toBeVisible();
    await didascalia(page, "Un click: la descrizione intera");
    await beat(page);
  });

  test("TRUTH-02: la nota «Anteprima RITIRATA» sparisce dalla vista quando l'anteprima torna, e resta nel DB", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const text = `Anteprima ritirata ${Date.now()}`;
    const taskId = await seedTask(page.request, text, { status: "todo" });
    await api(page.request, "post", `/api/boards/${PROJECT_ID}/tasks/${taskId}/comments`, { content: NOTA_RITIRO });

    await page.goto("/");
    await openProjectBoard(page);
    await openTaskDrawer(page, text);
    const drawer = page.getByTestId("task-detail-drawer");

    // (1) SENZA anteprima la nota è ancora VERA: si vede. Nascondere anche
    //     questa sarebbe l'errore opposto, e costa quanto l'altro.
    await expect(drawer.getByText(/Anteprima RITIRATA/)).toBeVisible({ timeout: 10000 });
    await didascalia(page, "Nessuna anteprima: la nota vale, e si vede");
    await beat(page);

    // (2) Arriva l'anteprima: la nota afferma il contrario di quello che la
    //     card mostra due dita più su, quindi il thread smette di renderla.
    await api(page.request, "patch", `/api/boards/${PROJECT_ID}/tasks/${taskId}`, { previewImage: previewPath });
    const seeded = (await (await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`)).json()) as {
      task?: { previewImage?: string | null };
      comments?: Array<{ content: string }>;
    };
    expect(seeded.task?.previewImage, "previewImage scartata dall'allowlist").toBe(previewPath);

    await expect(drawer.getByTestId("task-detail-preview")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText(/Anteprima RITIRATA/)).toHaveCount(0);
    await didascalia(page, "Anteprima tornata: la nota superata non si mostra più");
    await beat(page);

    // (3) NESSUNA riga cancellata: si è cambiato cosa si MOSTRA, non cosa è
    //     successo. Il thread lato server ha ancora la nota, parola per parola.
    const dopo = (await (await page.request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`)).json()) as {
      comments?: Array<{ content: string }>;
    };
    const superstite = (dopo.comments ?? []).filter((c) => c.content.startsWith("⚠️ Anteprima RITIRATA"));
    console.log(`[TRUTH-02] note nel DB dopo il nascondimento: ${superstite.length}`);
    expect(superstite).toHaveLength(1);
    expect(superstite[0]!.content).toBe(NOTA_RITIRO);
  });
});

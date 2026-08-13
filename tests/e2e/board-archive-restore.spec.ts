/**
 * board-archive-restore.spec.ts — l'archivio della board ha un ritorno.
 *
 * Archiviare un task era una porta a senso unico: `list()` inchiodava
 * `archived = 0`, quindi una card che usciva dalla board non era più
 * raggiungibile da nessuna superficie. Ora l'archivio è una VISTA della stessa
 * board — interruttore in testata, stesse colonne, popolate da `?archived=1` —
 * e dal menu della card si torna indietro.
 *
 * Serve un VIDEO perché la cosa da dimostrare è un GIRO, non uno stato: la card
 * c'è → sparisce → ricompare altrove (nell'archivio, nella sua colonna, con la
 * striscia ambra) → sparisce di lì → è di nuovo sulla board viva. Uno
 * screenshot ne proverebbe un fotogramma qualsiasi, e nessuno dei cinque da
 * solo dice che il giro si chiude.
 *
 * Due card, non una, e la seconda non è decorazione: è il controllo che rende
 * FALSIFICABILE ogni passo. «La card è nell'archivio» lo direbbe anche una
 * vista che mostra tutto; qui la card viva SPARISCE dall'archivio e la
 * archiviata SPARISCE dalla board, quindi le due liste sono davvero disgiunte.
 * Il conto nella striscia («Archivio: N task») è la stessa misura letta dal
 * prodotto invece che dal test.
 *
 * Zero scorciatoie: niente rotte di test, niente stato seminato a mano oltre ai
 * due task. Archiviazione, filtro, ripristino e menu sono tutto codice di
 * produzione, guidato dai gesti veri (tasto destro sulla card). La lettura del
 * DB in coda non sostituisce le asserzioni sul DOM: le CONFRONTA, perché una
 * board che disegna la card giusta sopra una riga ancora archiviata sarebbe
 * verde qui e rotta al prossimo reload.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
// Il path porta il PID: sotto sharding due processi Playwright partono nello
// stesso millisecondo e `Date.now()` da solo li farebbe atterrare sulla stessa
// board — cioè sullo stesso archivio, che è proprio l'insieme che questa spec
// conta.
const PROJECT_PATH = `/tmp/e2e-archrestore-${process.pid}-${Date.now()}`;

/** BYTE-IDENTICAL a server/services/tasks.ts:projectIdForPath. */
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

/** Quella che fa il giro. */
const VIAGGIA = "Rifare il footer";
/** Quella che NON si muove: senza di lei «l'archivio mostra la card» lo
 *  direbbe anche una lista che non filtra niente. */
const RESTA = "Tradurre la homepage";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo" } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

/** La board letta dall'API, per confrontare il DOM col DB. */
async function listTasks(request: any, opts?: { archived?: boolean }): Promise<Array<{ id: string; text: string }>> {
  const qs = opts?.archived ? "?archived=1" : "";
  const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks${qs}`);
  expect(res.ok()).toBe(true);
  return (await res.json()).tasks as Array<{ id: string; text: string }>;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-archrestore/);
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
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1). Zero a suite normale. */
const beat = (page: Page, ms = 900) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Archivio della board · andata e ritorno", () => {
  test.describe.configure({ timeout: 90_000 });
  // Più bassa del default (1280×800) per la clip: il giro si legge dalle
  // colonne, e meno pixel verticali vuoti significa card più grandi una volta
  // che il video finisce a 268px di larghezza. 1120×620 = 0.554 di rapporto,
  // sotto lo 0.70 oltre il quale l'anteprima RITAGLIA invece di rimpicciolire.
  test.use({ viewport: { width: 1120, height: 620 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-archrestore" }, null, 2));
    const topic = await createTopic(request, "E2E-ArchiveRestore", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("archivia, ritrova nell'archivio, ripristina: la card torna nella sua colonna", async ({ page, request }) => {
    const viaggia = await createTask(request, VIAGGIA);
    const resta = await createTask(request, RESTA);

    await page.goto("/");
    await openProjectBoard(page);

    const todo = page.getByTestId("kanban-column-todo");
    const cardViaggia = page.locator(`[data-task-card="${viaggia.id}"]`);
    const cardResta = page.locator(`[data-task-card="${resta.id}"]`);
    const banner = page.getByTestId("board-archived-banner");
    const toggle = page.getByTestId("board-archived-toggle");

    // ── 1. La board viva: due card in Todo, e nessuna striscia d'archivio ────
    await expect(todo.locator(`[data-task-card="${viaggia.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(todo.locator(`[data-task-card="${resta.id}"]`)).toBeVisible();
    await expect(todo.locator(`[data-task-card="${viaggia.id}"]`)).toContainText(VIAGGIA);
    await expect(banner).toHaveCount(0);
    // L'interruttore parte SPENTO: l'archivio è una scelta, non il default.
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await beat(page, 1400);

    // ── 2. Tasto destro → «Archivia»: la card esce dalla board ──────────────
    await cardViaggia.click({ button: "right" });
    const archivia = page.getByRole("menuitem", { name: "Archivia" });
    await expect(archivia).toBeVisible({ timeout: 5000 });
    // Sulla board viva il ritorno non ha senso e infatti non c'è: una card che
    // offrisse entrambe le voci direbbe che il menu non sa dove si trova.
    await expect(page.getByRole("menuitem", { name: "Ripristina" })).toHaveCount(0);
    await beat(page, 1200);
    await archivia.click();

    await expect(cardViaggia).toHaveCount(0, { timeout: 10000 });
    // …e la board non si è svuotata: la vicina è ancora lì. Senza questa riga
    // «la card è sparita» lo direbbe anche una board che ha smesso di caricare.
    await expect(todo.locator(`[data-task-card="${resta.id}"]`)).toBeVisible();
    await beat(page, 1300);

    // ── 3. L'interruttore: la stessa board, popolata dall'archivio ──────────
    await toggle.click();
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Il conto è il prodotto che misura se stesso: uno solo, quello archiviato.
    await expect(banner).toContainText("Archivio: 1 task");
    // La card è tornata a farsi vedere, e NELLA SUA COLONNA — l'archivio non è
    // un elenco piatto: sono le stesse cinque colonne con dentro altre righe.
    await expect(todo.locator(`[data-task-card="${viaggia.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(todo.locator(`[data-task-card="${viaggia.id}"]`)).toContainText(VIAGGIA);
    // E la viva NON c'è: `?archived=1` è «solo l'archivio», non «anche».
    await expect(cardResta).toHaveCount(0);
    await beat(page, 1600);

    // ── 4. Tasto destro nell'archivio → «Ripristina» ────────────────────────
    await cardViaggia.click({ button: "right" });
    const ripristina = page.getByRole("menuitem", { name: "Ripristina" });
    await expect(ripristina).toBeVisible({ timeout: 5000 });
    // La voce distruttiva ha lasciato il posto: qui archiviare di nuovo ciò che
    // è già archiviato sarebbe un bottone senza effetto.
    await expect(page.getByRole("menuitem", { name: "Archivia" })).toHaveCount(0);
    await beat(page, 1200);
    await ripristina.click();

    // La card lascia l'archivio sotto gli occhi di chi guarda, conto compreso.
    await expect(cardViaggia).toHaveCount(0, { timeout: 10000 });
    await expect(banner).toContainText("Archivio: 0 task");
    await beat(page, 1200);

    // ── 5. Ritorno alla board viva: la card è di nuovo al suo posto ─────────
    await banner.getByRole("button", { name: "Torna alla board" }).click();
    await expect(banner).toHaveCount(0, { timeout: 10000 });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(todo.locator(`[data-task-card="${viaggia.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(todo.locator(`[data-task-card="${viaggia.id}"]`)).toContainText(VIAGGIA);
    await expect(todo.locator(`[data-task-card="${resta.id}"]`)).toBeVisible();
    await beat(page, 1800);

    // ── 6. E il DB dice la stessa cosa ──────────────────────────────────────
    // Il DOM può disegnare una card sopra una riga ancora archiviata: sarebbe
    // verde qui e rotto al primo reload. Le due liste, lette dall'API, non
    // lasciano scampo — la viva contiene entrambe, l'archivio è vuoto.
    const vive = await listTasks(request);
    expect(vive.map((t) => t.id).sort()).toEqual([viaggia.id, resta.id].sort());
    expect(await listTasks(request, { archived: true })).toEqual([]);
  });
});

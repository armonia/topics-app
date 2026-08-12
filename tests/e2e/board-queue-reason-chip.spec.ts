/**
 * board-queue-reason-chip.spec.ts — «in coda» non dice perché.
 *
 * Il caso che rompeva: quattro card ferme nella stessa colonna per quattro
 * motivi diversi — aspetta uno slot, aspetta un'altra card, è rinviata a
 * un'ora, ha finito i tentativi — mostravano tutte la stessa parola, «in
 * coda». Chi guardava non sapeva se aspettare, decidere qualcosa, o se quella
 * card non sarebbe partita mai.
 *
 * Qui le quattro stanno affiancate e dicono cose diverse. Ed è anche la prova
 * della barra n.3: «aspetta uno slot» (tono `queued`, la fila scorre) e «non
 * partirà finché non decidi tu» (tono `stalled`) si distinguono senza leggere,
 * dal colore.
 *
 * Due stati che le API pubbliche non sanno costruire — la finestra d'attesa e
 * il budget dei tentativi esaurito — arrivano dal verbo di setup della suite
 * (`POST /api/test/tasks/:id/dispatch-gate`), che passa dal servizio vero.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { beat, didascalia } from "./helpers/evidence";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-coda-${Date.now()}`;

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

const BLOCCANTE = "Migrare le foto sul nuovo bucket";
const AL_LAVORO = "Riscrivere la home del catalogo";
const DAVANTI_1 = "Sistemare il carrello su mobile";
const DAVANTI_2 = "Tradurre le email transazionali";
const IN_CODA = "Rifare la scheda prodotto";
const BLOCCATA = "Pubblicare la scheda nuova";
const RINVIATA = "Ricontrollare i permessi del bucket";
const ESAURITA = "Riscrivere l'import dei listini";

let projectTopicId: string | null = null;
let capIniziale: { maxAgents: number; maxAgentsAuto: boolean } | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

/** Il verbo di setup: porta una card in uno dei modi in cui il dispatcher la tiene ferma. */
async function dispatchGate(request: any, taskId: string, body: Record<string, unknown>): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${taskId}/dispatch-gate`, { data: body });
  expect(res.ok(), await res.text()).toBe(true);
}

async function setAutoDispatch(request: any, on: boolean): Promise<void> {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/settings`, { data: { autoDispatch: on } });
  expect(res.ok()).toBe(true);
}

/**
 * Il tetto degli agenti, machine-wide. Portarlo a 1 e tenerne uno occupato è
 * ciò che rende «aspetta uno slot» una scena VERA e non una posa: con
 * l'interruttore acceso e un posto solo già preso, il dispatcher non può
 * reclamare — quindi le card in coda restano in coda perché è la verità, non
 * perché il test è veloce.
 */
async function setGlobalCap(request: any, max: number): Promise<void> {
  const res = await request.patch(`${BASE}/api/all-boards/settings`, {
    data: { maxAgents: max, maxAgentsAuto: false },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Un agente al lavoro, come lo lascia il dispatcher: occupa lo slot. */
async function bindTopic(request: any, taskId: string, topicId: string, dispatchState: string): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${taskId}/bind-topic`, { data: { topicId, dispatchState } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-coda/);
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

const chipOf = (page: Page, taskId: string) =>
  page.locator(`[data-task-card="${taskId}"]`).getByTestId("queue-reason-chip");

test.describe("Il chip della coda porta la sua ragione", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-coda" }, null, 2));
    const topic = await createTopic(request, "E2E-Coda", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.get(`${BASE}/api/all-boards/settings`);
    capIniziale = (await res.json()) as { maxAgents: number; maxAgentsAuto: boolean };
  });

  test.afterAll(async ({ request }) => {
    // Interruttore e tetto tornano com'erano: sono GLOBALI, e lasciarli mossi
    // cambierebbe il mondo sotto le spec che girano dopo (`board.spec.ts`
    // asserisce «the test env starts manual»).
    await setAutoDispatch(request, false).catch(() => {});
    if (capIniziale) {
      await request.patch(`${BASE}/api/all-boards/settings`, {
        data: { maxAgents: capIniziale.maxAgents, maxAgentsAuto: capIniziale.maxAgentsAuto },
      }).catch(() => {});
    }
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("quattro card ferme nella stessa colonna, quattro ragioni diverse", async ({ page, request }) => {
    // Il bloccante resta aperto: è il motivo della card che lo aspetta.
    const bloccante = await createTask(request, { text: BLOCCANTE, status: "in_progress" });
    // L'agente che occuperà l'unico slot, più avanti nel test.
    const alLavoro = await createTask(request, { text: AL_LAVORO, status: "in_progress" });

    // Due card idonee DAVANTI, per priorità: il «2 davanti» dev'essere un fatto
    // dell'ordine di coda, non del millisecondo in cui sono nate.
    await createTask(request, { text: DAVANTI_1, status: "todo", priority: 4 });
    await createTask(request, { text: DAVANTI_2, status: "todo", priority: 3 });

    const inCoda = await createTask(request, { text: IN_CODA, status: "todo" });
    const bloccata = await createTask(request, { text: BLOCCATA, status: "todo", blockedByTaskId: bloccante.id });
    const rinviata = await createTask(request, { text: RINVIATA, status: "todo" });
    const esaurita = await createTask(request, { text: ESAURITA, status: "todo" });

    // Gli stati che nessuna API pubblica costruisce.
    await dispatchGate(request, rinviata.id, { deferMinutes: 45, deferReason: "aspetto l'esito della UAT su CI" });
    await dispatchGate(request, esaurita.id, { attempts: 9 });

    await page.goto("/");
    await openProjectBoard(page);
    await expect(page.locator(`[data-task-card="${inCoda.id}"]`)).toBeVisible({ timeout: 10000 });

    // A interruttore SPENTO ogni card conserva la sua ragione: lo spegnimento è
    // una proprietà della board e sostituisce solo la risposta «in coda».
    await expect(chipOf(page, inCoda.id)).toHaveAttribute("data-kind", "dispatch_off", { timeout: 10000 });
    await expect(chipOf(page, bloccata.id)).toHaveAttribute("data-kind", "blocked");
    await expect(chipOf(page, rinviata.id)).toHaveAttribute("data-kind", "deferred");
    await expect(chipOf(page, esaurita.id)).toHaveAttribute("data-kind", "attempts");
    await didascalia(page, "Prima: tutte «in coda». Ora ognuna dice PERCHÉ");
    await beat(page, 2600);

    // Acceso l'interruttore, la card idonea smette di dire «dispatch spento» e
    // dice dove sta nella fila. Le altre tre non cambiano di una virgola: la
    // loro ragione non dipende dall'interruttore.
    //
    // Lo slot è occupato per davvero (tetto a 1, un agente al lavoro): il
    // dispatcher NON può reclamare queste card, quindi «aspetta uno slot» è la
    // verità e non una finestra di pochi secondi prima che parta un agente.
    await setGlobalCap(request, 1);
    await bindTopic(request, alLavoro.id, projectTopicId!, "working");
    await setAutoDispatch(request, true);
    await expect(chipOf(page, inCoda.id)).toHaveAttribute("data-kind", "slot", { timeout: 15000 });
    await expect(chipOf(page, inCoda.id)).toHaveText("in coda · 2 davanti");
    await expect(chipOf(page, bloccata.id)).toHaveAttribute("data-kind", "blocked");
    await expect(chipOf(page, rinviata.id)).toHaveAttribute("data-kind", "deferred");
    await expect(chipOf(page, esaurita.id)).toHaveAttribute("data-kind", "attempts");

    // Barra n.3: «aspetta uno slot» e «non partirà finché non decidi tu» non
    // sono più la stessa parola, e la differenza si vede senza leggere.
    await expect(chipOf(page, inCoda.id)).toHaveAttribute("data-tone", "queued");
    await expect(chipOf(page, bloccata.id)).toHaveAttribute("data-tone", "waiting");
    await expect(chipOf(page, esaurita.id)).toHaveAttribute("data-tone", "stalled");
    await didascalia(page, "Acceso il dispatch: «in coda · 2 davanti» ≠ «tentativi finiti»");
    await beat(page, 2600);

    // Le frasi, tutte diverse — è la barra n.1.
    const testi = await page.getByTestId("queue-reason-chip").allInnerTexts();
    expect(new Set(testi).size).toBe(testi.length);
    expect(testi.length).toBeGreaterThanOrEqual(4);

    await didascalia(page, "Sei card ferme, sei ragioni diverse");
    await beat(page, 2500);

    // I DUE VERSI DELL'ATTESA, sulla stessa schermata e senza una parola in
    // comune. Prima erano entrambi «in attesa»: «io aspetto un altro» e «altri
    // aspettano me», che sono fatti opposti — chiudere la seconda ne sblocca
    // altri. L'unico indizio era il numero davanti, e la spiegazione stava in
    // un tooltip, cioè in niente su un telefono.
    const cardBloccante = page.locator(`[data-task-card="${bloccante.id}"]`);
    await expect(cardBloccante.getByTestId("card-waiting-on-this")).toHaveText(/1 la aspetta/);
    const cardBloccata = page.locator(`[data-task-card="${bloccata.id}"]`);
    await expect(cardBloccata.getByTestId("card-blocked-by")).toContainText(`aspetta: ${BLOCCANTE}`);
    await expect(cardBloccante.getByTestId("card-waiting-on-this")).not.toContainText("in attesa");
    await expect(cardBloccata.getByTestId("card-blocked-by")).not.toContainText("in attesa");
    await didascalia(page, "«1 la aspetta» ≠ «aspetta: …»  —  due versi, zero parole in comune");
    await beat(page, 2600);

    // Uno scatto della colonna, allegato al task come file: il video è la prova
    // del comportamento, questo serve a leggere le sei frasi con calma.
    const colonna = page.locator('[data-testid^="kanban-column-body-"]').first();
    if (await colonna.count()) {
      await colonna.screenshot({ path: "test-results/queue-reason-todo.png" });
    }
  });

  test("le etichette di visibilità restano un'altra cosa, e non si mescolano", async ({ page, request }) => {
    // Barra n.4. `visibile`/`invisibile`/`decisione` dicono CHI chiude la card
    // e si derivano alla consegna; la ragione della coda dice perché non è
    // ancora partita. Confonderle è il difetto che questa card chiude, quindi
    // qui si pinna che convivono senza sovrascriversi.
    const t = await createTask(request, { text: "Card con etichetta e ragione", status: "todo" });
    const res = await request.put(`${BASE}/api/boards/${PROJECT_ID}/tasks/${t.id}/labels`, {
      data: { labels: ["visibile"] },
    });
    expect(res.ok(), await res.text()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);
    const card = page.locator(`[data-task-card="${t.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("queue-reason-chip")).toBeVisible();
    await expect(card.getByText("visibile", { exact: true })).toBeVisible();
  });
});

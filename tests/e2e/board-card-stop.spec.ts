/**
 * board-card-stop.spec.ts — «Ferma» dal menu della card: interrompere un agente
 * SENZA archiviare il task.
 *
 * Il caso: il menu della card aveva una sola voce che tocca un agente vivo,
 * «Archivia», e su un task in corso chiede conferma con «Archivia e ferma». Per
 * dire «aspetta, guarda dove stai andando» bisognava quindi buttare la card
 * fuori dalla board — un gesto solo per due intenzioni diverse, con quella
 * distruttiva obbligatoria. Lo stop c'era già lato server (`POST …/stop`) ma
 * l'unico bottone stava dentro il drawer.
 *
 * Serve un VIDEO perché la cosa da dimostrare sono DUE STATI della stessa card:
 * «al lavoro» → tasto destro → «Ferma» → la card è ANCORA lì, in Backlog, con
 * la chip «fermato». Uno screenshot proverebbe metà del comportamento (e la
 * metà sbagliata: quella dove non si vede che la card non è sparita).
 *
 * Due popolazioni, stesso menu: `chromium` col tasto destro e
 * `chromium-touch-wide` col dito (il long-press apre LO STESSO menu, non un
 * secondo — Card.tsx). La parità dei gesti è il quinto punto della barra.
 *
 * L'unica scorciatoia è la semina dell'agente (`POST /api/test/tasks/:id/bind-topic`,
 * armata solo con TOPICS_E2E=1): `assigned_topic_id` + `dispatch_state` le
 * scrive solo il dispatcher lanciando un agente Claude vero, che qui non può
 * girare. Tutto il resto — menu, route di stop, park, chip — è codice di
 * produzione. Che il turno venga davvero TAGLIATO (`abortTurn` su ogni sessione
 * ancora viva, tentativi compresi) è asserito dove è osservabile:
 * `server/routes/tasks.test.ts`.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { longPress } from "./helpers/long-press";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-cardstop-${Date.now()}`;

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

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

const patch = async (request: any, id: string, data: Record<string, unknown>) => {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data });
  expect(res.ok()).toBe(true);
};

const getTask = async (request: any, id: string) => {
  const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`);
  expect(res.ok()).toBe(true);
  return (await res.json()).task as { status: string; dispatchState: string | null; dispatchAttempts: number; assignedTopicId: string | null };
};

/** Mette l'agente dentro il turno come ce lo mette il dispatcher (topic + chip). */
const bindTopic = async (request: any, id: string, topicId: string, dispatchState: string) => {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, { data: { topicId, dispatchState } });
  expect(res.ok()).toBe(true);
};

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-cardstop/);
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
const beat = (page: Page, ms = 1200) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Fermare un task senza archiviarlo", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cardstop" }, null, 2));
    const topic = await createTopic(request, "E2E-CardStop", { projectPath: PROJECT_PATH });
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

  /**
   * Il corpo condiviso dai due gesti: la card è al lavoro, si apre il menu (col
   * mouse o col dito), si sceglie «Ferma», e si guarda cosa RESTA.
   */
  const stopFlow = async (page: Page, request: any, openMenu: (sel: string) => Promise<void>) => {
    const task = await createTask(request, "Riscrivere la pagina dei prezzi");
    await patch(request, task.id, { status: "in_progress" });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // L'agente entra nel turno SOLO ORA, a board già aperta, e da qui si va di
    // corsa: un `working` seminato è un agente finto — nessuna sessione viva
    // dietro — e il recupero orfani del server, che passa ogni 10s, lo rimette
    // in coda. Giustamente: è il suo mestiere. Legarlo prima di aprire la board
    // significherebbe spendere quella finestra in caricamenti.
    //
    // Il `patch` che segue non cambia niente di sostanziale: serve a far
    // BANDIRE l'aggiornamento (la rotta di test scrive dal servizio e non
    // trasmette, quindi la card non lo vedrebbe fino a un reload).
    await bindTopic(request, task.id, projectTopicId!, "working");
    await patch(request, task.id, { description: "Un turno in corso." });
    await expect(card.getByTestId("dispatch-chip")).toHaveAttribute("data-state", "working", { timeout: 10000 });
    await beat(page, 700);

    await openMenu(`[data-task-card="${task.id}"]`);
    const ferma = page.getByRole("menuitem", { name: "Ferma" });
    await expect(ferma).toBeVisible({ timeout: 5000 });
    // L'altra voce è ancora lì: «Ferma» non sostituisce l'archiviazione, le
    // toglie l'obbligo (quarto punto della barra).
    await expect(page.getByRole("menuitem", { name: "Archivia" })).toBeVisible();
    // Solo per la clip: il ritaglio si MISURA (card, menu aperto, e più sotto
    // dove la card ATTERRA dopo lo stop) invece di indovinarlo — a 268px una
    // board intera non si legge, e il rettangolo che conta è quello che tiene
    // dentro tutti e tre. Si legge a mano da /tmp/e2e-cardstop-crop.json quando
    // si monta la clip di consegna.
    const shot = process.env.E2E_EVIDENCE === "1"
      ? { card: await card.boundingBox(), menu: await page.getByRole("menu").first().boundingBox(), viewport: page.viewportSize() }
      : null;
    await beat(page, 1500);
    await ferma.click();

    // 1) LA CARD RESTA. Non archiviata, non sparita: sulla board, con la chip
    //    che dice chi l'ha fermata — 'stopped', non 'failed' (non ha fallito
    //    niente) e non il vuoto di prima (una card muta in Backlog).
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("dispatch-chip")).toHaveAttribute("data-state", "stopped", { timeout: 10000 });
    if (shot) writeFileSync("/tmp/e2e-cardstop-crop.json", JSON.stringify({ ...shot, cardAfter: await card.boundingBox() }));
    await beat(page, 2500);

    // 2) E il DB dice la stessa cosa, compreso il conto dei tentativi: fermare
    //    non è fallire, quindi non costa un tentativo al rilancio.
    const after = await getTask(request, task.id);
    expect(after.status).toBe("backlog");
    expect(after.dispatchState).toBe("stopped");
    expect(after.assignedTopicId).toBeNull();
    expect(after.dispatchAttempts).toBe(0);
  };

  test("tasto destro → «Ferma»: il turno si interrompe e la card resta sulla board", async ({ page, request, isMobile }) => {
    test.skip(!!isMobile, "serve il mouse: col dito non esiste un tasto destro (gira nel progetto chromium)");
    await stopFlow(page, request, async (sel) => { await page.locator(sel).click({ button: "right" }); });
  });

  test("col dito: il long-press apre lo STESSO menu, e «Ferma» fa la stessa cosa", async ({ page, request, isMobile }) => {
    test.skip(!isMobile, "serve il dito (progetto chromium-touch-wide)");
    await stopFlow(page, request, async (sel) => { await longPress(page, sel); });
  });
});

/**
 * board-subtask-work-chip.spec.ts — un sottotask «in corso» senza agente suo
 * dice CHI lo lavora, e cambia quando smette di lavorarlo qualcuno.
 *
 * Il caso: una card `in_progress` senza `assigned_topic_id` e senza chip di
 * dispatch è ambigua. O la lavora un antenato dentro il proprio turno — il
 * flusso voluto, e la norma schiacciante (243 step chiusi così in un giorno) —
 * oppure è rimasta lì e non la lavora nessuno. Il recupero orfani non vede né
 * l'una né l'altra: filtra sul chip di dispatch, che in questa forma non c'è.
 * Il segnale è DERIVATO dalla catena dei padri, senza nessuna colonna nuova.
 *
 * È anche la clip di consegna, e serve un VIDEO perché la cosa da dimostrare
 * sono DUE STATI sulla stessa riga: il padre lavora → «nel turno del padre»; il
 * padre molla il turno → «nessuno la lavora», in rosso, senza ricaricare niente.
 * Uno screenshot proverebbe metà del comportamento.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-subwork-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare la scheda prodotto";
const STEP = "Migrare le foto sul nuovo bucket";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

const patch = async (request: any, id: string, data: Record<string, unknown>) => {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data });
  expect(res.ok()).toBe(true);
};

/**
 * Mette il padre dentro un turno come ce lo mette il dispatcher: topic legato e
 * `dispatch_state`. Sono le due colonne che scrive solo lui — la rotta di test
 * passa dal servizio vero, non da una UPDATE a mano.
 */
const bindTopic = async (request: any, id: string, topicId: string | null, dispatchState: string | null) => {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, {
    data: { topicId, dispatchState },
  });
  expect(res.ok()).toBe(true);
};

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-subwork/);
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
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Sottotask senza agente suo · chi lo lavora", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-subwork" }, null, 2));
    const topic = await createTopic(request, "E2E-SubWork", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // In ordine INVERSO: il figlio prima del padre.
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

  test("il padre lo lavora nel suo turno; quando molla, la riga passa a «nessuno la lavora»", async ({ page, request }) => {
    // Il padre al lavoro con il suo agente, e uno step della sua checklist:
    // figlio, in corso, MAI dispacciato — niente topic, niente chip. È la forma
    // ambigua, quella che finora non diceva niente.
    const epica = await createTask(request, { text: EPICA });
    // La descrizione rende la riga APRIBILE nell'albero (`openable`): serve al
    // terzo passo della clip, non al segnale.
    const step = await createTask(request, { text: STEP, parentTaskId: epica.id, description: "Bucket nuovo, path invariati." });
    await patch(request, epica.id, { status: "in_progress" });
    await bindTopic(request, epica.id, projectTopicId!, "working");
    await patch(request, step.id, { status: "in_progress" });

    await page.goto("/");
    await openProjectBoard(page);

    // Lo step NON è una card: le colonne mostrano solo le radici. Si vede
    // aprendo il padre — ed è lì che il segnale deve stare.
    const card = page.locator(`[data-task-card="${epica.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[data-task-card]")).toHaveCount(1);

    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // (a) Il padre tiene il turno: la riga dello step lo dice, in silenzio.
    //
    // Si asserisce SUBITO, prima di ogni pausa: il padre qui è un agente finto
    // — topic legato e chip `working` senza nessuna sessione viva dietro — e il
    // recupero del server fa il suo mestiere parcheggiandolo. Con `slowMo` (la
    // modalità clip) quella finestra si allarga fino a superarlo, e il test
    // diventava rosso su un comportamento CORRETTO del server.
    const row = drawer.getByTestId(`subtask-work-${step.id}`);
    await expect(row).toHaveAttribute("data-kind", "parent-turn", { timeout: 10000 });
    await expect(row).toHaveAttribute("title", new RegExp(EPICA));
    await beat(page, 2400);

    // Il padre molla il turno — il caso misurato sul DB vivo: torna in backlog
    // e il chip di dispatch si spegne. Nessuno tocca lo step, che resta byte per
    // byte quello di prima: è la CATENA a cambiare, non la riga.
    await patch(request, epica.id, { status: "backlog" });
    await bindTopic(request, epica.id, projectTopicId!, null);

    // (b) Stessa riga, stesso step: ora dice che non la lavora nessuno. Il
    // segnale è derivato, quindi cambia da sé — nessun reload, nessuna scrittura
    // sullo step.
    await expect(row).toHaveAttribute("data-kind", "unattended", { timeout: 15000 });
    await expect(row).toContainText("nessuno la lavora");

    // Solo per la clip di consegna: la card della board la rimpicciolisce a
    // 268px, e a quella larghezza un chip da 10px sparisce. Qui si annota DOVE
    // guardare, così il ritaglio è misurato invece che indovinato.
    if (process.env.E2E_EVIDENCE === "1") {
      const [d, r] = [await drawer.boundingBox(), await row.boundingBox()];
      if (d && r) writeFileSync("/tmp/e2e-subwork-crop.json", JSON.stringify({ drawer: d, row: r }));
    }
    await beat(page, 2600);

    // E aprendo lo step, il chip in riga nel suo drawer dice la stessa cosa.
    await drawer.getByTestId(`subtask-open-${step.id}`).click();
    const chip = page.getByTestId("task-subtask-work-chip");
    await expect(chip).toHaveAttribute("data-kind", "unattended", { timeout: 10000 });
    await beat(page, 2400);
  });
});

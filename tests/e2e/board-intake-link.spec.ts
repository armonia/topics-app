/**
 * board-intake-link.spec.ts — l'intake che collega.
 *
 * Il giro completo, come lo fa una persona: c'è una card aperta su un tema, si
 * scrive un feedback nuovo sullo stesso tema nel composer, compare una
 * PROPOSTA (non un'attribuzione), la si accetta, e il collegamento si vede su
 * ENTRAMBE le card — quella nuova dice "aspetta:", quella vecchia dice "1
 * in attesa". È anche la clip di consegna: il comportamento non si dimostra con
 * uno screenshot.
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
const PROJECT_PATH = `/tmp/e2e-intake-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const CARD_APERTA = "Feedback grafici sulla landing: spaziature e contrasto dei chip";
const FEEDBACK_NUOVO = "Altri feedback grafici sulla landing: il contrasto dei chip e le spaziature del blocco finale";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-intake/);
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

/**
 * Pausa che serve SOLO alla clip di consegna (E2E_EVIDENCE=1): il giro dura
 * quattro secondi, e una proposta che compare e sparisce in mezzo secondo non
 * si legge. A suite normale vale zero — l'evidenza non deve costare tempo a
 * ogni run.
 */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Intake che collega", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-intake" }, null, 2));
    writeFileSync(
      `${PROJECT_PATH}/favicon.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const topic = await createTopic(request, "E2E-Intake", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
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

  test("un feedback nuovo si aggancia dove il lavoro è già in corso", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-37" });
    // Una card sul tema, in corso: è lo scenario della richiesta (una lista di
    // feedback grafici già aperta, e ne arrivano altri).
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: CARD_APERTA, status: "in_progress" },
    });
    expect(res.ok()).toBe(true);
    const aperta = (await res.json()) as { id: string };
    createdTasks.push(`${PROJECT_ID}:${aperta.id}`);

    await page.goto("/");
    await openProjectBoard(page);
    await expect(page.locator(`[data-task-card="${aperta.id}"]`)).toBeVisible({ timeout: 10000 });

    // Si scrive il feedback nuovo nel composer.
    const composer = page.getByTestId("board-task-composer").locator("textarea");
    await composer.click();
    await composer.fill(FEEDBACK_NUOVO);

    // Compare la PROPOSTA — e la board è ancora quella di prima: nessuna card
    // nuova, nessun collegamento. Proporre non attribuisce.
    const intake = page.getByTestId("composer-intake");
    await expect(intake).toBeVisible({ timeout: 10000 });
    await expect(intake).toContainText(CARD_APERTA);
    await expect(page.getByTestId("composer-intake-chain")).toBeVisible();
    await expect(page.getByTestId("composer-intake-subtask")).toBeVisible();
    await expect(page.locator("[data-task-card]")).toHaveCount(1);
    await beat(page, 2200);

    // Si accetta la catena: da qui in poi il testo è un seguito di quella card.
    await page.getByTestId("composer-intake-chain").click();
    await expect(intake).toContainText("Parte quando chiude");
    await beat(page, 1600);

    await page.getByTestId("composer-send").click();

    // Il collegamento si vede su ENTRAMBE le card.
    const nuova = page.locator("[data-task-card]").filter({ hasText: /Altri feedback grafici/ });
    await expect(nuova).toBeVisible({ timeout: 10000 });
    await expect(nuova).toContainText(/aspetta:/);
    const vecchia = page.locator(`[data-task-card="${aperta.id}"]`);
    await expect(vecchia.getByTestId("card-waiting-on-this")).toContainText("1 la aspetta");
    await beat(page, 2200);

    // E il perché sta scritto nel thread, da entrambi i lati.
    const both = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${aperta.id}`);
    const thread = (await both.json()) as { comments: { content: string }[] };
    expect(thread.comments.some((c) => /in attesa di questa card/.test(c.content))).toBe(true);

    // Il task incatenato RESTA FERMO: non parte finché l'altra non chiude.
    const list = await (await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks`)).json() as
      { tasks: { id: string; text: string; blockedByTaskId: string | null; assignedTopicId: string | null }[] };
    const linked = list.tasks.find((t) => t.text.startsWith("Altri feedback"))!;
    createdTasks.push(`${PROJECT_ID}:${linked.id}`);
    expect(linked.blockedByTaskId).toBe(aperta.id);
    expect(linked.assignedTopicId).toBeNull();

    // Aprire la card nuova mostra il thread con la spiegazione: niente
    // attribuzione muta, il motivo è leggibile dove si decide.
    await nuova.click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
    // Maiuscola O minuscola: la frase è a inizio periodo da quando il gate sul
    // trattino lungo (c3cfd89e, 12/08) ha spezzato «accettata da te — non parte
    // finché» in due frasi. Il regex era rimasto minuscolo e la spec era rossa
    // da allora, per una lettera: quello che deve reggere è la PROMESSA, non
    // come inizia il periodo che la contiene.
    await expect(page.getByTestId("task-detail-drawer")).toContainText(/[Nn]on parte finché/);
    await beat(page, 2600);
  });
});

/**
 * board-reopened-chip.spec.ts — una card che ESCE da Done lo dice sulla board.
 *
 * L'11/08 Attilio: «avevo visto il task fatto nella tab kanban, ora non lo vedo
 * più — forse si stanno perdendo le cose fatte?». Misurato: non si perdeva
 * niente, ma in sei ore undici card erano uscite da `done`, quasi tutte per mano
 * di agenti. Il motivo c'era sempre — nel thread della card. Dalla colonna si
 * vedeva solo un buco dove c'era una cosa fatta.
 *
 * Due fatti, entrambi qui dentro:
 *  · il SEGNO — la card riaperta porta il chip «riaperta» (e la banda nel
 *    drawer) con chi e quando, letti dall'API della board, non dai commenti;
 *  · il PERMESSO — una card chiusa da un'APPROVAZIONE UMANA non la riapre un
 *    agente: la porta che usa (`/api/sessions/:key/tasks/:id`) risponde 409 e la
 *    card non si muove.
 *
 * È anche la clip di consegna: Done → l'agente prova e rimbalza → l'umano la
 * riapre e il chip compare → torna in Done e il chip si spegne.
 *
 * La clip che finisce in anteprima è la registrazione MENO i primi ~2,6s: il
 * video parte alla creazione del contesto, quindi il primo fotogramma è la
 * pagina ancora bianca (misurato: media 255,0, deviazione 0,0 — un rettangolo
 * bianco). La card mostra quel fotogramma finché non parte il loop, ed è ciò
 * che l'umano ha visto chiedendo «cos'è st'immagine?». Taglio:
 *   ffmpeg -ss 2.6 -i video.webm -c:v libvpx-vp9 -crf 34 -b:v 0 -an clip.webm
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-reopened-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const TASK = "Rifare le miniature della scheda";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function patchAsHuman(request: any, taskId: string, data: Record<string, unknown>): Promise<void> {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, { data });
  expect(res.ok()).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-reopened/);
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

/**
 * Didascalia sulla clip — SOLO sotto E2E_EVIDENCE (convenzione di casa, vedi
 * `board-subtask-deeplink.spec.ts`). L'anteprima di un task si rende a 268px:
 * un chip da 11px lì non si legge, un titolo grande sopravvive alla riduzione e
 * la clip dice da sé cosa sta provando. `pointer-events:none`: non intercetta
 * nessun click.
 *
 * 64px e non 44: la catena di riduzione è due volte, non una. Il video esce a
 * 800px da un viewport di 1440 (×0.556) e la card lo rende a 268 (×0.335):
 * 44px arrivano a 8px sulla card, cioè illeggibili — misurato su questa stessa
 * clip, che l'umano ha guardato e ha chiesto «cos'è st'immagine?». 64px
 * arrivano a ~12px, la misura del testo di una card.
 */
async function didascalia(page: Page, testo: string) {
  if (process.env.E2E_EVIDENCE !== "1") return;
  await page.evaluate((t) => {
    let el = document.getElementById("__e2e_caption__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption__";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
        "background:rgba(10,10,12,.92);color:#fff;font:700 64px/1.2 system-ui,sans-serif;" +
        "padding:16px 24px;letter-spacing:-.01em;border-top:4px solid #8b5cf6;",
      );
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, testo);
}

test.describe("Chip «riaperta» · una card che esce da Done lo dice", () => {
  test.describe.configure({ timeout: 90_000 });
  // Più largo del default della suite (1280×800) per una ragione sola: questa
  // spec È la clip di consegna, e l'anteprima di un task si rende a 268px —
  // oltre un rapporto altezza/larghezza di 0.70 la card TAGLIA invece di
  // rimpicciolire. 1440×760 → video 800×422 (0.528), ci sta intero. Nessuna
  // asserzione qui dipende dalla larghezza.
  test.use({ viewport: { width: 1440, height: 760 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-reopened" }, null, 2));
    const topic = await createTopic(request, "E2E-Reopened", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
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

  test("l'agent rimbalza sulla card approvata; quando l'umano la riapre la board lo dice", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-42" });
    // Consegna + APPROVAZIONE UMANA: è la decisione di Attilio, ed è ciò che il
    // cancello protegge.
    const task = await createTask(request, { text: TASK, status: "in_progress" });
    await patchAsHuman(request, task.id, { status: "review" });
    const approve = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}/review`, {
      data: { decision: "approve" },
    });
    expect(approve.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(page.getByTestId("kanban-column-done").locator(`[data-task-card="${task.id}"]`)).toBeVisible({ timeout: 10000 });
    await didascalia(page, "In Done: nessun chip");
    await expect(card.getByTestId("card-reopened")).toHaveCount(0);
    await beat(page, 2200);

    // La porta VERA dell'agent (quella che l'11/08 ha spostato undici card):
    // 409, e la card non si muove di un pixel.
    const sessionKey = `topic:${projectTopicId!.slice(0, 8)}`;
    const agentTry = await request.patch(
      `${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${task.id}`,
      { data: { status: "in_progress" } },
    );
    expect(agentTry.status()).toBe(409);
    expect((await agentTry.json()).code).toBe("reopen_needs_human");
    await expect(page.getByTestId("kanban-column-done").locator(`[data-task-card="${task.id}"]`)).toBeVisible();
    await didascalia(page, "L'agent prova a riaprirla → 409");
    await expect(card.getByTestId("card-reopened")).toHaveCount(0);
    await beat(page, 2200);

    // L'umano invece riapre — legittimo, ma la board lo DICE: chip sulla card…
    await patchAsHuman(request, task.id, { status: "in_progress" });
    const chip = card.getByTestId("card-reopened");
    await expect(chip).toContainText("riaperta", { timeout: 10000 });
    // Il tooltip NON nomina più la colonna di partenza: da quando il segno si
    // accende anche uscendo da `review` (`reopenedChip`, client/src/lib/board.ts)
    // «Era in Done» sarebbe falso su tre uscite su quattro. Il fatto che il
    // tooltip deve portare è rimasto lo stesso, ed è quello che si prova qui:
    // che aveva consegnato, CHI l'ha riaperta e QUANDO.
    await expect(chip).toHaveAttribute("title", /Aveva consegnato: riaperta da te il \d/);
    await didascalia(page, "L'umano riapre → chip «riaperta»");
    await beat(page, 2200);

    // …e banda nel drawer, con chi e quando (il motivo resta nel thread).
    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    // La banda dice CHI e QUANDO, non solo che è successo: «Riaperta da te il …».
    await expect(page.getByTestId("task-reopened-notice")).toContainText(/Riaperta da te il \d/);
    await didascalia(page, "Nel drawer: chi e quando");
    await beat(page, 2200);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5000 });

    // Torna in Done: il ciclo è chiuso, il segno si spegne.
    await patchAsHuman(request, task.id, { status: "done" });
    await didascalia(page, "Torna in Done: il chip sparisce");
    await expect(card.getByTestId("card-reopened")).toHaveCount(0, { timeout: 10000 });
    await beat(page, 2200);
  });
});

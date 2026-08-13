/**
 * board-review-unfinished.spec.ts — una review portata dal SISTEMA non offre le
 * scelte di una consegna.
 *
 * Il caso, misurato il 13/08 su due card vere: 5472e584 aveva consegnato,
 * c0849d9d era finita in review col turno esaurito, e sulla board erano
 * indistinguibili. Non nell'aspetto: nelle SCELTE. Tutte e due portavano «Landa
 * su main» verde in testa alla card, cioè l'azione che chiude offerta come
 * consigliata su una card sotto cui poteva non esserci niente.
 *
 * Qui le due card stanno nella STESSA colonna, una sotto l'altra, seminate per
 * essere identiche in tutto il resto: stesso progetto, stesso agente, stesso
 * ramo consegnato. L'unica differenza è chi le ha portate in review, ed è
 * l'unica cosa che questa spec misura.
 *
 * È anche la clip di consegna: si vedono le due card affiancate e poi il drawer
 * della non consegnata, dove il verde non è più «Approva».
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { beat, didascalia } from "./helpers/evidence";
import { clipDiConsegna } from "./helpers/clip";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;
const REPO = `/tmp/e2e-nonconsegnata-${Date.now()}`;

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
const PROJECT_ID = boardIdForPath(REPO);

const T_CONSEGNATA = "Rifare la scheda prodotto";
const T_REAPER = "Migrare le foto sul bucket";

let topicId: string | null = null;
const createdTasks: string[] = [];
const taskIds: Record<string, string> = {};

async function createTask(request: APIRequestContext, text: string): Promise<string> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo" } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

/** Il ramo consegnato: due colonne che scrive solo il dispatcher (route di test). */
async function seedBranch(request: APIRequestContext, taskId: string, branch: string): Promise<void> {
  const res = await request.post(`${API}/test/tasks/${taskId}/landing`, {
    data: { branch, commit: "0f1cf4160f1cf4160f1cf4160f1cf4160f1cf416" },
  });
  expect(res.ok()).toBe(true);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-nonconsegnata/);
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

test.describe("Review portata dal sistema: scelte diverse da una consegna", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-nonconsegnata" }, null, 2));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: REPO, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: REPO, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: REPO, stdio: "pipe" });

    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-nonconsegnata-${Date.now()}`, path: REPO } });
    expect(proj.ok()).toBe(true);

    // Un agente solo per tutte e due: quello che cambia non è chi ci ha lavorato.
    const topic = await createTopic(request, "E2E-NonConsegnata", { projectPath: REPO });
    topicId = topic.id;

    // A. LA CONSEGNA VERA: l'agente l'ha messa lui in review, col suo ramo.
    taskIds.consegnata = await createTask(request, T_CONSEGNATA);
    expect((await request.post(`${API}/test/tasks/${taskIds.consegnata}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
    expect((await request.patch(`${API}/boards/${PROJECT_ID}/tasks/${taskIds.consegnata}`, { data: { status: "review" } })).ok()).toBe(true);
    await seedBranch(request, taskIds.consegnata, "topics/scheda-prodotto");

    // B. LA CARD DEL REAPER: stesso agente, stesso ramo committato, ma in review
    //    ce l'ha portata il dispatcher a tentativi finiti.
    taskIds.reaper = await createTask(request, T_REAPER);
    expect((await request.post(`${API}/test/tasks/${taskIds.reaper}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
    await seedBranch(request, taskIds.reaper, "topics/migrare-foto");
    const sys = await request.post(`${API}/test/tasks/${taskIds.reaper}/system-delivery`, {
      data: { cause: "retries_exhausted", reason: "Turni esauriti: nessuna consegna dall'agent." },
    });
    expect(sys.ok()).toBe(true);
    // Se questa cade il rosso parla del SETUP, non della UI: senza `system` la
    // card sarebbe una consegna normale e la spec misurerebbe un'altra cosa.
    const dopo = (await sys.json()) as { task: { deliveredBy: string; deliveryBranch: string | null } };
    expect(dopo.task.deliveredBy).toBe("system");
    expect(dopo.task.deliveryBranch).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    rmSync(REPO, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("due card nella stessa colonna, e solo una offre di landare col verde", async ({ request }) => {
    await resetProjectPanes(request, REPO);
    await seedProjectPane(request, REPO);

    await clipDiConsegna({
      nome: "board-review-unfinished",
      // 1280×680 = 0,531 di rapporto: sopra 0,70 la card taglia la clip dal
      // basso invece di rimpicciolirla. `locale` perché le asserzioni sono in
      // italiano e senza l'app risponde in inglese.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // Fuori dalla registrazione: aprire il progetto e montare la board è
      // lavoro di scena, non la scena.
      prologo: async (p) => {
        await p.goto("/");
        await openProjectBoard(p);
        await expect(p.locator(`[data-task-card="${taskIds.reaper}"]`)).toBeVisible({ timeout: 15000 });
      },
      scena: async (page) => {
        await page.goto("/");
        const card = (id: string) => page.locator(`[data-task-card="${id}"]`);
        const choice = (id: string, choiceId: string) => card(id).getByTestId(`task-choice-${choiceId}`);
        const consegnata = card(taskIds.consegnata);
        const reaper = card(taskIds.reaper);
        await expect(consegnata).toBeVisible({ timeout: 20000 });
        await expect(reaper).toBeVisible({ timeout: 20000 });

        // ── 1. La consegna vera: «Landa su main», primo e verde ──────────────
        await didascalia(page, "Consegna dell'agent: «Landa su main», verde");
        await expect(choice(taskIds.consegnata, "land")).toBeVisible();
        await expect(choice(taskIds.consegnata, "land")).toHaveText(/Landa su main/);
        await expect(choice(taskIds.consegnata, "land")).toHaveClass(/emerald/);
        await expect(consegnata.getByTestId("card-system-delivered")).toHaveCount(0);
        await beat(page, 1600);

        // ── 2. La card del reaper: il chip lo dice, e il verde è un'altra ────
        await didascalia(page, "Stessa colonna, portata dal sistema: chip «non consegnato»");
        const chip = reaper.getByTestId("card-system-delivered");
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText(/non consegnato/);
        // Il verde è «Rimandalo avanti», non «Landa su main».
        await expect(choice(taskIds.reaper, "send-back")).toHaveText(/Rimandalo avanti/);
        await expect(choice(taskIds.reaper, "send-back")).toHaveClass(/emerald/);
        // Landare resta possibile, ma non è più né il primo né il verde, e non
        // si chiama più come una consegna.
        await expect(choice(taskIds.reaper, "land")).toHaveText(/Landa comunque/);
        await expect(choice(taskIds.reaper, "land")).not.toHaveClass(/emerald/);
        await expect(choice(taskIds.reaper, "accept")).toHaveText(/Approva comunque/);
        await expect(choice(taskIds.reaper, "accept")).not.toHaveClass(/emerald/);
        await beat(page, 1800);

        // ── 3. Il drawer: il bottone che ha causato l'incidente ──────────────
        await didascalia(page, "Nel drawer il verde è «Rimandalo avanti», non «Approva»");
        // Il titolo, non il centro della card: in review la card è alta e piena
        // di controlli suoi (le scelte, la casella di risposta).
        await reaper.getByText(T_REAPER).first().click();
        const drawer = page.getByTestId("task-detail-drawer");
        await expect(drawer).toBeVisible({ timeout: 10000 });
        const approva = drawer.getByTestId("task-approve");
        const avanti = drawer.getByTestId("task-send-back");
        await expect(approva).toBeVisible({ timeout: 10000 });
        await expect(avanti).toHaveText(/Rimandalo avanti/);
        await expect(avanti).toHaveClass(/emerald/);
        await expect(approva).toHaveText(/Approva comunque/);
        await expect(approva).not.toHaveClass(/emerald/);
        await expect(drawer.getByTestId("task-land")).toHaveText(/Landa comunque/);
        await beat(page, 1800);
      },
    });
  });
});

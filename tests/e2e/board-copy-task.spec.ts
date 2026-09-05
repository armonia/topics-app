/**
 * board-copy-task.spec.ts — «Copia task»: il contenuto della card negli appunti.
 *
 * Nel drawer c'era solo «Copia link», che copia un URL: utile a RITROVARE il
 * task, inutile a chi il task deve incollarlo altrove (una chat, un'altra
 * board). Ora accanto c'è il bottone che copia il TESTO — titolo, riga vuota,
 * descrizione — e la stessa voce sta nel menù col tasto destro sulla card.
 *
 * È anche la clip di consegna, e il comportamento ha più di uno stato: icona
 * copia → spunta verde → di nuovo icona. Uno screenshot non lo direbbe.
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
const PROJECT_PATH = `/tmp/e2e-copytask-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const TITOLO = "Rifare la scheda prodotto";
const DESCRIZIONE = "Foto nuove, prezzo in alto, recensioni sotto la piega.";
const ATTESO = `${TITOLO}\n\n${DESCRIZIONE}`;

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-copytask/);
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

/** Gli appunti letti dalla pagina. Richiede il permesso concesso al context. */
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("Copia task · il contenuto della card negli appunti", () => {
  test.describe.configure({ timeout: 90_000 });
  // Finestra più bassa del default (1280×800) per un motivo solo: la clip di
  // consegna finisce nella card della board, che sopra 0.70 di altezza/larghezza
  // TAGLIA invece di rimpicciolire. 1280×680 → 0.531, e il drawer ci sta tutto.
  test.use({ viewport: { width: 1280, height: 680 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-copytask" }, null, 2));
    const topic = await createTopic(request, "E2E-CopyTask", { projectPath: PROJECT_PATH });
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

  // I permessi di clipboard (che servono alla LETTURA del test, non al bottone)
  // li concede già `playwright.config.ts` a tutta la suite.
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("dal drawer copia titolo + descrizione, e la spunta dice che è successo", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-32" });
    const task = await createTask(request, { text: TITOLO, description: DESCRIZIONE, status: "todo" });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await beat(page, 1600);
    await card.click();

    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    // Da agosto 2026 «Copia il task» non è più un'icona nella testata: sta nel
    // menu ⋯, col suo nome scritto. La testata ne teneva sette senza parole, e
    // questo è uno dei due gesti che nessuno fa MENTRE decide su una scheda.
    await drawer.getByTestId("task-options-menu").click();
    const copia = page.getByTestId("task-copy-text");
    await expect(copia).toBeVisible({ timeout: 5000 });
    await beat(page, 1800);

    await copia.click();
    expect(await clipboard(page)).toBe(ATTESO);
    await beat(page, 1500);

    // E il LINK: non è più il gemello a catena qui accanto, è dentro il
    // pannello di condivisione — un posto solo per «dammi il link».
    await drawer.getByTestId("share-control").click();
    const link = page.getByTestId("share-copy-link");
    await expect(link).toBeVisible({ timeout: 5000 });

    // IL PANNELLO NON DEVE ESSERE RITAGLIATO. Share non era rotta, era tagliata:
    // un `absolute` dentro una testata `overflow-hidden`, quindi si vedeva alta
    // 41px (ffca1289). `toBeVisible` da solo NON lo prende - un elemento alto
    // 41px con dentro tre voci e' visibile per Playwright ed e' inservibile per
    // una persona. Serve misurare l'altezza VERA e il ritaglio del contenitore.
    const pannello = page.getByTestId("share-panel");
    const box = await pannello.boundingBox();
    expect(box, "il pannello di condivisione deve avere una geometria").not.toBeNull();
    expect(box!.height, "un pannello alto 41px e' il difetto originale").toBeGreaterThan(80);
    // E dev'essere DENTRO la finestra: un pannello che esce dal bordo e' tagliato
    // dallo schermo invece che da un overflow, con lo stesso esito per chi guarda.
    const vp = page.viewportSize()!;
    expect(box!.y + box!.height, "il pannello deve stare dentro la finestra").toBeLessThanOrEqual(vp.height + 1);
    expect(box!.x, "…e non sbordare a sinistra").toBeGreaterThanOrEqual(-1);
    await link.click();
    // The link carries a readable SLUG in front of the id, and the id stays at
    // the END: that is what resolves, the slug is decoration the reader throws
    // away. So the assertion follows the CONTRACT — ends with the uuid — instead
    // of the exact shape, and does not break again when the slug changes.
    expect(await clipboard(page)).toMatch(new RegExp(`/task/(?:[a-z0-9-]+-)?${task.id}$`));
    // La spunta è la sola cosa che l'utente vede: c'è, e poi se ne va da sola.
    await expect(link.locator("svg.text-green-500")).toBeVisible({ timeout: 2000 });
    await beat(page, 1500);
  });

  test("il tasto destro sulla card copia lo stesso testo, senza aprire il drawer", async ({ page, request }) => {
    const task = await createTask(request, { text: TITOLO, description: DESCRIZIONE, status: "todo" });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    const fullTask = page.waitForResponse((response) =>
      response.request().method() === "GET" && response.url().endsWith(`/tasks/${task.id}`),
    );
    await card.click({ button: "right" });
    await fullTask;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const voce = page.getByRole("menuitem", { name: "Copia task" });
    await expect(voce).toBeVisible({ timeout: 5000 });
    await beat(page, 1600);
    await voce.click();

    expect(await clipboard(page)).toBe(ATTESO);
    await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0);
    await beat(page, 1400);
  });

  test("card copy warns while the full description is still loading", async ({ page, request }) => {
    const task = await createTask(request, { text: TITOLO, description: DESCRIZIONE, status: "todo" });
    let releasePrefetch: (() => void) | null = null;

    await page.route(new RegExp(`/api/boards/.*/tasks/${task.id}$`), async (route) => {
      await new Promise<void>((resolve) => { releasePrefetch = resolve; });
      await route.continue();
    });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await card.click({ button: "right" });
    await expect.poll(() => releasePrefetch !== null).toBe(true);
    await page.getByRole("menuitem", { name: "Copia task" }).click();
    await expect(page.getByTestId("toast").filter({ hasText: "Non è stato possibile copiare" })).toBeVisible();

    const fullTask = page.waitForResponse((response) =>
      response.request().method() === "GET" && response.url().endsWith(`/tasks/${task.id}`),
    );
    releasePrefetch!();
    await fullTask;
  });

  test("copy actions report an unavailable clipboard", async ({ page, request }) => {
    const task = await createTask(request, { text: TITOLO, description: null, status: "todo" });

    await page.goto("/");
    await openProjectBoard(page);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copia task" }).click();
    const failedToasts = page.getByTestId("toast").filter({ hasText: "Non è stato possibile copiare" });
    await expect(failedToasts.first()).toBeVisible();

    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await drawer.getByTestId("share-control").click();
    const link = page.getByTestId("share-copy-link");
    await expect(link).toBeVisible({ timeout: 5000 });
    await link.click();
    await expect(failedToasts.nth(1)).toBeVisible();
  });
});

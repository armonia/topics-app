/**
 * task-open-in-workspace.spec.ts — E2E for "Apri nel workspace".
 *
 * Il risultato di un task si apre come TAB del browser di Topics nella finestra
 * del progetto (non nel browser esterno del OS). Il bottone del drawer dispatcha
 * `topics:open-project` (apre/porta in primo piano la finestra) + `browser:open-
 * and-navigate` (che la useProjectLayout traduce in un pane RemoteBrowserPanel).
 *
 * Assert deterministico: al click, i due eventi partono con il detail giusto
 * (projectPath del task, url = output_url, contextId presente). L'apertura del
 * pane è comportamento Topics già esistente (stesso path di `/browser`); il video
 * registrato dalla suite mostra il pane che compare nel workspace.
 *
 * @covers BROWSER-CHAT-04
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-wsopen-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string },
): Promise<{ id: string; status: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string; status: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

/** Open the e2e project window by clicking its sidebar row (project-tabs pattern). */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-wsopen/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

/**
 * Monta la finestra del progetto, poi apre la BOARD GENERALE come tab a sé.
 *
 * È la configurazione dell'auto-open: due superfici distinte — il drawer sta
 * sulla board globale, il workspace è la finestra del progetto già montata. La
 * finestra va aperta PRIMA, o `isProjectWindowMounted` è falso e non si apre
 * niente (che è proprio il recinto di WSOPEN-01).
 */
async function openGlobalBoardBesideProject(page: Page) {
  await openTestProject(page);
  await page.getByTestId("sidebar-board-generale").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Open the project board pane via the project window's "+" menu. */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  for (let i = count - 1; i >= 0; i--) {
    await triggers.nth(i).click();
    const found = await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
    if (found) break;
    await page.keyboard.press("Escape");
    if (i === 0) throw new Error("no + menu with a Board (kanban) entry found");
  }
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Apri nel workspace", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-wsopen" }, null, 2));
    const topic = await createTopic(request, "E2E-WSOpen", { projectPath: PROJECT_PATH });
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
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  test("WSOPEN-01: il bottone apre l'output come tab nel workspace del progetto", async ({ page }) => {
    const text = `Task con output ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    // A reachable local URL so, if a pane opens, it loads a real page (the test
    // server itself) instead of erroring on a dead port.
    const outputUrl = `${BASE}/`;
    const patch = await page.request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, { data: { outputUrl } });
    expect(patch.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);

    // Open the drawer from the card.
    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // Da agosto 2026 il gesto vive nel menu ⋯ e si chiama «Apri il task nel
    // progetto»: non «apri il risultato», perché i risultati di una card sono
    // tanti e cambiano mentre l'agent lavora.
    await drawer.getByTestId("task-options-menu").click();
    const openBtn = page.getByTestId("task-open-in-workspace");
    await expect(openBtn).toBeVisible({ timeout: 5000 });

    // Capture the workspace-open events the button dispatches.
    await page.evaluate(() => {
      (window as unknown as { __wsOpen: unknown[] }).__wsOpen = [];
      const rec = (type: string) => (e: Event) =>
        (window as unknown as { __wsOpen: unknown[] }).__wsOpen.push({ type, detail: (e as CustomEvent).detail });
      window.addEventListener("topics:open-project", rec("open-project"));
      window.addEventListener("browser:open-and-navigate", rec("open-and-navigate"));
    });

    await openBtn.click();

    // UN evento solo: la navigazione. L'apertura della finestra non parte più
    // (vedi sotto), quindi aspettare "almeno due" aspetterebbe per sempre.
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __wsOpen: unknown[] }).__wsOpen.length), { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);

    const evts = (await page.evaluate(() => (window as unknown as { __wsOpen: unknown[] }).__wsOpen)) as {
      type: string;
      detail: { projectPath?: string; url?: string; contextId?: string };
    }[];

    const nav = evts.find((e) => e.type === "open-and-navigate");
    expect(nav, "browser:open-and-navigate deve partire").toBeTruthy();
    expect(nav!.detail.url).toBe(outputUrl);
    expect(nav!.detail.projectPath).toBe(PROJECT_PATH);
    expect(typeof nav!.detail.contextId).toBe("string");
    expect(nav!.detail.contextId!.length).toBeGreaterThan(0);

    // La finestra del progetto è GIÀ montata (la board sta dentro di lei):
    // `topics:open-project` NON deve partire. Prima partiva a ogni click e
    // rialzava una finestra che era già lì; ora il registro delle finestre
    // montate lo evita, e l'apertura resta l'ultima risorsa per la finestra
    // chiusa. Vedi state/pane/adapters/browserOriginStore.
    const openProj = evts.find((e) => e.type === "open-project");
    expect(openProj, "la finestra c'è già: niente apertura forzata").toBeFalsy();
  });

  test("WSOPEN-02: il bottone promuove TUTTE le tab del task, ognuna col suo nome", async ({ page }) => {
    const text = `Task con manifesto ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    // Il manifesto come lo scrive il server quando l'agente chiama
    // open_browser_pane({url, name}): una tab per nome, etichetta pinnata.
    const tabs = {
      tabs: [
        { contextId: `task-${task.id.slice(0, 8)}-napp`, url: `${BASE}/`, title: "App", seq: 0, titleSource: "agent" },
        { contextId: `task-${task.id.slice(0, 8)}-nreport`, url: `${BASE}/?report`, title: "Report", seq: 1, titleSource: "agent" },
      ],
      activeContextId: `task-${task.id.slice(0, 8)}-napp`,
      nextSeq: 2,
    };
    const put = await page.request.put(`${BASE}/api/ui-state/task-browser-tabs:${task.id}`, { data: tabs });
    expect(put.ok()).toBe(true);

    await page.goto("/");
    await openProjectBoard(page);

    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // Le due tab del manifesto sono le tab del drawer, con i NOMI dell'agente.
    await expect(drawer.getByRole("tab", { name: "App" })).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByRole("tab", { name: "Report" })).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __wsOpen: unknown[] }).__wsOpen = [];
      window.addEventListener("browser:open-and-navigate", (e) =>
        (window as unknown as { __wsOpen: unknown[] }).__wsOpen.push((e as CustomEvent).detail));
    });

    await drawer.getByTestId("task-options-menu").click();
    await page.getByTestId("task-open-in-workspace").click();

    // DUE navigate, uno per tab: il risultato non è più «Output» al singolare.
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __wsOpen: unknown[] }).__wsOpen.length), { timeout: 5000 })
      .toBe(2);

    const navs = (await page.evaluate(() => (window as unknown as { __wsOpen: unknown[] }).__wsOpen)) as {
      url?: string; contextId?: string;
    }[];
    expect(navs.map((n) => n.url).sort()).toEqual([`${BASE}/`, `${BASE}/?report`]);
    // Ogni tab va nella sua pane, sotto il GEMELLO del suo contextId: due viste
    // della stessa consegna senza contendersi la stessa webview nativa.
    expect(navs.map((n) => n.contextId).sort()).toEqual([
      `task-${task.id.slice(0, 8)}-napp_ws`,
      `task-${task.id.slice(0, 8)}-nreport_ws`,
    ]);
  });

  /**
   * WSOPEN-03 — l'auto-open, e il fatto che si RICHIUDE.
   *
   * Dalla board GENERALE il drawer e il workspace sono due superfici diverse:
   * lì il risultato può comparire nella finestra del progetto senza click, e
   * togliere un gesto a chi rivede. Ma un'apertura automatica che non si
   * richiude è solo accumulo — dopo cinque card riviste il workspace è pieno di
   * roba che nessuno ha chiesto. Il patto è quindi in due metà, e questo test
   * misura ENTRAMBE: si apre da solo → si chiude da solo.
   *
   * Dentro la finestra del progetto la board è una sua pane, e lì l'auto-open è
   * spento apposta (`autoOpenInWorkspace={global}`): è la stessa superficie, e
   * si prenderebbe lo spazio del drawer che stai leggendo.
   */
  test("WSOPEN-03: dalla board generale il manifesto si apre da solo, e uscendo si richiude", async ({ page }) => {
    const text = `Task auto-open ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    const appCtx = `task-${task.id.slice(0, 8)}-napp`;
    const reportCtx = `task-${task.id.slice(0, 8)}-nreport`;
    const put = await page.request.put(`${BASE}/api/ui-state/task-browser-tabs:${task.id}`, {
      data: {
        tabs: [
          { contextId: appCtx, url: `${BASE}/`, title: "App", seq: 0, titleSource: "agent" },
          { contextId: reportCtx, url: `${BASE}/?report`, title: "Report", seq: 1, titleSource: "agent" },
        ],
        activeContextId: appCtx,
        nextSeq: 2,
      },
    });
    expect(put.ok()).toBe(true);

    await page.goto("/");
    await openGlobalBoardBesideProject(page);

    // In ascolto PRIMA del click: l'auto-open parte al mount del drawer, quindi
    // un listener messo dopo non vedrebbe niente e il test passerebbe a vuoto.
    await page.evaluate(() => {
      const w = window as unknown as { __wsAuto: unknown[]; __wsClosed: string[] };
      w.__wsAuto = [];
      w.__wsClosed = [];
      window.addEventListener("browser:open-and-navigate", (e) => w.__wsAuto.push((e as CustomEvent).detail));
      window.addEventListener("topics:open-project", (e) => w.__wsAuto.push({ forced: true, ...(e as CustomEvent).detail }));
      window.addEventListener("browser:request-close", (e) => w.__wsClosed.push((e as CustomEvent).detail?.contextId));
    });

    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // NESSUN click sul bottone: le due pane compaiono da sole.
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __wsAuto: unknown[] }).__wsAuto.length), { timeout: 5000 })
      .toBe(2);
    const autos = (await page.evaluate(() => (window as unknown as { __wsAuto: unknown[] }).__wsAuto)) as {
      contextId?: string; forced?: boolean;
    }[];
    expect(autos.map((a) => a.contextId).sort()).toEqual([`${appCtx}_ws`, `${reportCtx}_ws`]);
    // E la finestra del progetto non viene ri-aperta né rialzata: c'è già.
    expect(autos.some((a) => a.forced)).toBe(false);

    // L'evento non è la prova: la prova è la PANE. Andando nella finestra del
    // progetto le due pane ci sono davvero, una per tab del manifesto, ognuna
    // sotto il gemello del suo contextId.
    const appPane = page.locator(`[data-pane-id="browser:${appCtx}_ws"]`);
    const reportPane = page.locator(`[data-pane-id="browser:${reportCtx}_ws"]`);
    await openTestProject(page);
    await expect(appPane).toHaveCount(1, { timeout: 10000 });
    await expect(reportPane).toHaveCount(1);

    // Uscita dal task: quello che si è aperto DA SOLO si richiude da solo, e
    // passa dalla porta normale (`browser:request-close`, la stessa di
    // `window.close()`), non da una scorciatoia distruttiva.
    await page.getByTestId("sidebar-board-generale").click();
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await drawer.getByRole("button", { name: /Chiudi il dettaglio del task|Close the task detail/ }).click();
    await expect(drawer).toBeHidden({ timeout: 10000 });

    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __wsClosed: string[] }).__wsClosed.slice().sort()), { timeout: 5000 })
      .toEqual([`${appCtx}_ws`, `${reportCtx}_ws`]);
    // …e sparite per davvero dal workspace, non solo «richieste».
    await openTestProject(page);
    await expect(appPane).toHaveCount(0, { timeout: 10000 });
    await expect(reportPane).toHaveCount(0);
  });
});

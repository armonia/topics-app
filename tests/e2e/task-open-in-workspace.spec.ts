/**
 * task-open-in-workspace.spec.ts — E2E for "Apri nel workspace".
 *
 * Il risultato di un task si apre come TAB del browser di Topics nella finestra
 * del progetto (non nel browser esterno del OS). Il bottone del drawer dispatcha
 * `browser:open-and-navigate`, aprendo la finestra solo se non è già montata.
 * Leggere o chiudere il task non apre, richiude o modifica le tab del progetto.
 *
 * Assert deterministico: al click, la navigazione parte con il detail giusto
 * (projectPath del task, url = output_url, contextId presente). L'apertura del
 * pane è comportamento Topics già esistente (stesso path di `/browser`); il video
 * registrato dalla suite mostra il pane che compare nel workspace.
 *
 * @covers KANBAN-55
 * @covers BROWSER-CHAT-04
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

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
 * Le due superfici sono distinte: il drawer sta sulla board globale, il
 * workspace è la finestra del progetto già montata. Leggere il task non deve
 * aprire tab in quella finestra, né chiudere quelle che l'utente ha aperto.
 */
async function openGlobalBoardBesideProject(page: Page) {
  await openTestProject(page);
  await page.getByTestId("sidebar-board-generale").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/**
 * Open the project board pane via the project window's "+" menu.
 *
 * UN TRIGGER NEL DOM NON E' UN TRIGGER CLICCABILE. Questa copia privata girava
 * con un `click()` nudo, quindi al primo `+` non cliccabile si fermava per 15 s
 * — il timeout di default — invece di provare il successivo. Verde su questa
 * macchina, rossa in CI tre giri di fila l'11/09 (WSOPEN-02 e WSOPEN-03,
 * «locator resolved to <button …> · attempting click action · scrolling into
 * view if needed» e poi niente): li' la finestra del progetto monta un numero
 * diverso di pane, e `.nth(i)` puo' cadere su uno coperto o ancora in
 * animazione.
 *
 * La stessa funzione in `helpers/board-topbar.ts` era gia' stata indurita cosi'
 * — salta gli invisibili, tollera il click fallito, tira dritto — e questa
 * copia era rimasta indietro. Non si puo' semplicemente importare quella: apre
 * la sezione Progetti, prende `PROJECTS[0]` e alla fine attiva «Tutti i
 * progetti», e questo file vuole il SUO progetto senza quel filtro.
 */
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
    removeTmpDir(PROJECT_PATH);
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

    // The conversation opens first. The manifest is still available through
    // the explicit workspace view, with the agent's original tab names.
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    await drawer.getByTestId("task-workspace-toggle").click();
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

  test("WSOPEN-03: leggere e chiudere il task non apre né chiude le tab condivise del progetto", async ({ page }) => {
    const text = `Task senza aperture implicite ${Date.now()}`;
    const task = await apiCreateTask(page.request, { text, status: "in_progress" });
    const appCtx = `task-${task.id.slice(0, 8)}-napp`;
    const reportCtx = `task-${task.id.slice(0, 8)}-nreport`;
    const manifest = {
      tabs: [
        { contextId: appCtx, url: `${BASE}/`, title: "App", seq: 0, titleSource: "agent" },
        { contextId: reportCtx, url: `${BASE}/?report`, title: "Report", seq: 1, titleSource: "agent" },
      ],
      activeContextId: appCtx,
      nextSeq: 2,
    };
    const manifestUrl = `${BASE}/api/ui-state/task-browser-tabs:${task.id}`;
    const put = await page.request.put(manifestUrl, { data: manifest });
    expect(put.ok()).toBe(true);

    await page.goto("/");
    await openGlobalBoardBesideProject(page);

    // Listen before mount so an automatic promotion cannot escape the count.
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

    // The tab count proves the manifest has arrived, without mounting browser
    // surfaces just to read a task. No project navigation has been dispatched.
    await expect(drawer.getByTestId("task-workspace-toggle")).toContainText("2");
    await expect(drawer.getByTestId("task-workspace-toggle")).toHaveAttribute("data-open", "0");
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    await expect(drawer.getByTestId("task-session-column")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __wsAuto: unknown[] }).__wsAuto)).toEqual([]);
    const appPane = page.locator(`[data-pane-id="browser:${appCtx}_ws"]`);
    const reportPane = page.locator(`[data-pane-id="browser:${reportCtx}_ws"]`);
    await expect(appPane).toHaveCount(0);
    await expect(reportPane).toHaveCount(0);

    // A deliberate promotion still works. These panes now belong to the
    // user's project workspace and must survive closing and rereading the task.
    await drawer.getByTestId("task-options-menu").click();
    await page.getByTestId("task-open-in-workspace").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __wsAuto: unknown[] }).__wsAuto.length)).toBe(2);
    const opened = (await page.evaluate(() => (window as unknown as { __wsAuto: unknown[] }).__wsAuto)) as { contextId?: string; forced?: boolean }[];
    expect(opened.map((entry) => entry.contextId).sort()).toEqual([`${appCtx}_ws`, `${reportCtx}_ws`]);
    expect(opened.some((entry) => entry.forced)).toBe(false);
    await openTestProject(page);
    await expect(appPane).toHaveCount(1, { timeout: 10000 });
    await expect(reportPane).toHaveCount(1);

    await page.getByTestId("sidebar-board-generale").click();
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await drawer.getByRole("button", { name: /Chiudi il dettaglio del task|Close the task detail/ }).click();
    await expect(drawer).toBeHidden({ timeout: 10000 });

    await page.getByTestId("kanban-column-in_progress").getByText(text).click();
    await expect(drawer.getByTestId("task-workspace-toggle")).toContainText("2");
    await expect(drawer.getByTestId("task-drawer-body")).toHaveCount(0);
    await drawer.getByRole("button", { name: /Chiudi il dettaglio del task|Close the task detail/ }).click();
    await expect(drawer).toBeHidden();

    // Reopening did not navigate the existing panes, and neither close asked
    // another window to destroy them. Verify the actual panes and task manifest.
    await openTestProject(page);
    await expect(appPane).toHaveCount(1);
    await expect(reportPane).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __wsClosed: string[] }).__wsClosed)).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __wsAuto: unknown[] }).__wsAuto)).toEqual(opened);
    const saved = await page.request.get(manifestUrl);
    expect(saved.ok()).toBe(true);
    expect((await saved.json()).value).toEqual(manifest);
  });
});

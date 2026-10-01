/**
 * LE ALTRE SCHERMATE DEL TELEFONO: LA LISTA PASSA SOTTO LA FILA, IL RESTO RESTA SOPRA.
 *
 * `mobile-list-under-chrome.spec.ts` dice la regola per la sidebar. Qui la stessa
 * regola per le schermate che prima si fermavano al bordo della fila perche' la
 * radice dell'app le riservava la banda (`paddingBottom: --mobile-chrome-h`):
 * lo scroller finiva sopra i tasti, l'ultima card restava tagliata a meta' sul
 * bordo e nulla passava mai dietro di loro.
 *
 * MOBILE-SCREEN-01  chat: il trascritto scorre sotto il composer (e' un overlay
 *                   dichiarato), il composer sta TUTTO sopra i tasti ed e' usabile
 * MOBILE-SCREEN-02  board: le colonne arrivano al vetro, in fondo l'ultima card
 *                   sta sopra il composer, e il composer sta sopra i tasti
 * MOBILE-SCREEN-03  profilo e dashboard: lo scroller arriva al vetro, in fondo
 *                   l'ultimo elemento e' sopra i tasti
 * MOBILE-SCREEN-04  un task aperto dalla board: il suo composer sta sopra i tasti
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BARRA = '[data-testid="mobile-chrome-bar"]';
const SHOTS = process.env.LIST_SHOTS_DIR;
const TAG = process.env.LIST_TAG ?? "x";
const PROJECT_ID = projectIdForPath(`${canonicalTmpRoot()}/e2e-screens-under-${Date.now()}`);

let topicId = "";
const taskIds: string[] = [];

test.beforeAll(async ({ request }) => {
  topicId = (await createTopic(request, `Schermate sotto la chrome ${Date.now()}`)).id;
  for (let i = 0; i < 40; i++) {
    await request.post(`${E2E_BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `#${i + 1} ` + "riga di prova ".repeat((i % 5) + 1) },
      ignoreHTTPSErrors: true,
    });
  }
  for (let i = 0; i < 14; i++) {
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text: `Task sotto la chrome ${i}`, status: "backlog" } });
    expect(res.ok()).toBe(true);
    taskIds.push(((await res.json()) as { id: string }).id);
  }
  await resetPaneStore(request, [topicId]);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  for (const id of taskIds) await deleteTask(request, PROJECT_ID, id);
  await deleteTopic(request, topicId);
});

async function apri(page: Page) {
  await page.goto(E2E_BASE);
  await expect(page.locator(BARRA)).toBeVisible();
}

/** Il rettangolo che interessa, in coordinate di viewport. */
async function rect(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  }, selector);
}

async function barTop(page: Page) {
  return (await rect(page, BARRA))!.top;
}

/** Scorre uno scroller fino in fondo e restituisce il bordo basso dell'ultimo figlio. */
async function aFondo(page: Page, selector: string, lastSelector?: string) {
  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = s.scrollHeight;
  }, selector);
  await page.waitForTimeout(250);
  return page.evaluate(([sel, last]) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    const el = last ? Array.from(s.querySelectorAll<HTMLElement>(last)).pop()! : (s.lastElementChild as HTMLElement);
    return { lastBottom: el.getBoundingClientRect().bottom, overflow: s.scrollHeight - s.clientHeight };
  }, [selector, lastSelector ?? ""] as const);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${TAG}-${name}.png` });
}

test("MOBILE-SCREEN-01 — chat: il composer sta sopra i tasti e il trascritto non lo copre", async ({ page }) => {
  await apri(page);
  await page.getByText(/Schermate sotto la chrome/).first().tap();
  await expect(page.getByTestId("chat-message-list")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  const barra = await barTop(page);
  const ta = (await rect(page, "textarea"))!;
  const lista = (await rect(page, '[data-testid="chat-message-list"]'))!;
  console.log("CHAT", JSON.stringify({ barra, ta, lista }));
  await shot(page, "chat");
  // Il composer (e quindi la textarea) e' intero sopra la fila…
  expect(ta.bottom).toBeLessThanOrEqual(barra);
  // …il trascritto finisce al piu' dove comincia la fila.
  expect(lista.bottom).toBeLessThanOrEqual(barra + 1);
  // In fondo l'ultimo messaggio sta sopra il bordo alto della textarea.
  const fondo = await aFondo(page, '[data-testid="chat-message-list"]', "[data-index]");
  console.log("CHAT-FONDO", JSON.stringify(fondo));
  expect(fondo.lastBottom).toBeLessThanOrEqual(ta.top);
  // Usabile: la textarea prende il fuoco e il testo entra.
  await page.locator("textarea").first().tap();
  await page.keyboard.type("ciao");
  await expect(page.locator("textarea").first()).toHaveValue(/ciao/);
});

test("MOBILE-SCREEN-02 — board: le colonne passano sotto i tasti, il composer resta sopra", async ({ page }) => {
  await apri(page);
  await page.locator('[data-testid="mobile-chrome-board"]').tap();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  const corpo = '[data-testid="kanban-column-body-backlog"]';
  await expect.poll(async () => page.locator(`${corpo} [data-task-card]`).count(), { timeout: 15_000 }).toBeGreaterThan(5);
  await page.waitForTimeout(600);
  const barra = await barTop(page);
  const vh = await page.evaluate(() => window.innerHeight);
  const riga = (await rect(page, '[data-testid="kanban-columns-row"]'))!;
  const col = (await rect(page, corpo))!;
  const comp = (await rect(page, '[data-testid="board-task-composer"]'))!;
  console.log("BOARD", JSON.stringify({ vh, barra, riga, col, comp }));
  await shot(page, "board-riposo");
  // Le colonne arrivano sotto la fila (la sovrappongono): passano dietro i tasti.
  expect(col.bottom).toBeGreaterThan(barra + 20);
  // Il composer e' tutto sopra i tasti.
  expect(comp.bottom).toBeLessThanOrEqual(barra);
  const fondo = await aFondo(page, corpo, '[data-task-card]');
  console.log("BOARD-FONDO", JSON.stringify(fondo));
  await shot(page, "board-fondo");
  // In fondo l'ultima card sta sopra il composer: non resta sotto a niente.
  expect(fondo.overflow).toBeGreaterThan(0);
  expect(fondo.lastBottom).toBeLessThanOrEqual(comp.top + 1);
});

test("MOBILE-SCREEN-03 — profilo e dashboard: lo scroller arriva al vetro, l'ultimo elemento sta sopra i tasti", async ({ page }) => {
  await apri(page);
  const schermate = [
    { nome: "profile", apri: () => page.locator('[data-testid="mobile-chrome-profile"]').tap(), pane: '[data-testid="profile-pane"]', scroller: '[data-testid="profile-pane"] > div:last-child' },
    {
      nome: "dashboard",
      apri: () => page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }))),
      pane: '[data-testid="dashboard-pane"]',
      scroller: '[data-testid="dashboard-pane"]',
    },
  ];
  for (const s of schermate) {
    await s.apri();
    await expect(page.locator(s.pane)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const barra = await barTop(page);
    const vh = await page.evaluate(() => window.innerHeight);
    // Contenuto corto nel banco di prova: si allunga lo scroller con un blocco
    // alto in coda, cosi' lo spaziatore (che viene DOPO) ha qualcosa da spingere.
    await page.evaluate((sel) => {
      const filler = document.createElement("div");
      filler.setAttribute("data-filler", "");
      filler.style.cssText = "height:1800px;flex:none";
      document.querySelector(sel)!.appendChild(filler);
    }, s.scroller);
    const r = (await rect(page, s.scroller))!;
    const fondo = await aFondo(page, s.scroller, "[data-filler]");
    expect(fondo.overflow).toBeGreaterThan(0);
    console.log("SCREEN", s.nome, JSON.stringify({ vh, barra, r, fondo }));
    await shot(page, s.nome);
    expect(r.bottom).toBeGreaterThanOrEqual(vh - 1);
    expect(fondo.lastBottom).toBeLessThanOrEqual(barra + 1);
  }
});

test("MOBILE-SCREEN-02b — board in vista elenco: l'ultima card sta sopra il composer", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("topics.board.layout", "list"));
  await apri(page);
  await page.locator('[data-testid="mobile-chrome-board"]').tap();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator("[data-task-card]").count(), { timeout: 15_000 }).toBeGreaterThan(5);
  await page.waitForTimeout(600);
  const barra = await barTop(page);
  const comp = (await rect(page, '[data-testid="board-task-composer"]'))!;
  const riga = (await rect(page, '[data-testid="kanban-columns-row"]'))!;
  const fondo = await aFondo(page, '[data-testid="kanban-columns-row"]', "[data-task-card]");
  console.log("BOARD-LIST", JSON.stringify({ barra, comp, riga, fondo }));
  await shot(page, "board-elenco-fondo");
  expect(riga.bottom).toBeGreaterThan(barra + 20);
  expect(comp.bottom).toBeLessThanOrEqual(barra);
  expect(fondo.lastBottom).toBeLessThanOrEqual(comp.top + 1);
});

test("MOBILE-SCREEN-04 — un task aperto dalla board: il suo composer sta sopra i tasti", async ({ page }) => {
  await apri(page);
  await page.locator('[data-testid="mobile-chrome-board"]').tap();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator("[data-task-card]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.locator("[data-task-card]").first().tap();
  const drawer = '[data-testid="task-detail-drawer"]';
  await expect(page.locator(drawer)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  const barra = await barTop(page);
  const ta = (await rect(page, `${drawer} textarea`))!;
  console.log("TASK", JSON.stringify({ barra, ta, drawer: await rect(page, drawer) }));
  await shot(page, "task");
  expect(ta.bottom).toBeLessThanOrEqual(barra);
});

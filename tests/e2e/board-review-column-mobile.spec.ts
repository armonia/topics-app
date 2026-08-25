/**
 * board-review-column-mobile.spec.ts — la colonna Review sta dentro lo schermo.
 *
 * Da telefono la board è un carosello: ogni colonna è una slide, e quella su cui
 * si decide (Review) vale una slide INTERA. «Intera» ha un limite: la larghezza
 * visibile della riga. Se la colonna la supera, il bordo destro cade fuori dalla
 * finestra e una parte della card di approvazione non si raggiunge scorrendo in
 * verticale — bisogna scoprire che la riga scorre anche in orizzontale.
 *
 * Il pavimento (`basis-full`) esiste dal 12/08 (002640f6). Questo file è il
 * cancello che dice se il pavimento è anche un TETTO: un flex item senza
 * `min-w-0` ha `min-width: auto`, e il contenuto di una card di review (path,
 * hash, chip, bottoni delle scelte) può spingere quel minimo oltre il basis.
 * Si MISURA il rettangolo, non si guarda.
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
const PROJECT_PATH = `/tmp/e2e-revcol-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string; priority?: number; description?: string },
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-revcol/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Il rettangolo della colonna contro quello della riga che la contiene. */
type ColumnGeometry = {
  rowClientWidth: number;
  rowScrollWidth: number;
  rowPaddingX: number;
  colWidth: number;
  colScrollWidth: number;
  /** Quanto la colonna eccede la larghezza utile della riga (0 = sta dentro). */
  overflowPx: number;
  computed: { flexBasis: string; minWidth: string; maxWidth: string; width: string };
  /** Il figlio del corpo colonna col contenuto più largo, se qualcosa sfora. */
  widestChild: { cls: string; scrollWidth: number } | null;
};

async function measureColumn(page: Page, status: string): Promise<ColumnGeometry> {
  const col = page.getByTestId(`kanban-column-${status}`);
  await expect(col).toBeVisible({ timeout: 10000 });
  // Due frame: la colonna esiste già, ma card, chip e anteprime stanno ancora
  // prendendo posto e i rettangoli vanno letti a layout FERMO.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  return col.evaluate((el) => {
    const row = el.parentElement as HTMLElement;
    const rowStyle = getComputedStyle(row);
    const padX = parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight);
    const usable = row.clientWidth - padX;
    const cs = getComputedStyle(el);
    const body = el.querySelector('[data-testid^="kanban-column-body-"]');
    let widest: { cls: string; scrollWidth: number } | null = null;
    if (body) {
      for (const child of Array.from(body.children) as HTMLElement[]) {
        if (!widest || child.scrollWidth > widest.scrollWidth) {
          widest = { cls: child.className.toString().slice(0, 60), scrollWidth: child.scrollWidth };
        }
      }
    }
    return {
      rowClientWidth: row.clientWidth,
      rowScrollWidth: row.scrollWidth,
      rowPaddingX: padX,
      colWidth: el.getBoundingClientRect().width,
      colScrollWidth: el.scrollWidth,
      overflowPx: Math.max(0, Math.round((el.getBoundingClientRect().width - usable) * 100) / 100),
      computed: { flexBasis: cs.flexBasis, minWidth: cs.minWidth, maxWidth: cs.maxWidth, width: cs.width },
      widestChild: widest,
    };
  });
}

/**
 * Porta la colonna Review a filo del bordo SINISTRO della riga. Serve alle
 * schermate: Review è la quarta colonna, a scorrimento zero non è nemmeno
 * inquadrata — e una prova che non contiene il soggetto non prova niente.
 * A filo a sinistra, il bordo destro della colonna cade dentro o fuori dallo
 * schermo, ed è esattamente la differenza da mostrare.
 */
async function frameReviewColumn(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="kanban-column-review"]') as HTMLElement | null;
    const row = el?.parentElement;
    if (!el || !row) return;
    row.scrollLeft = el.offsetLeft - parseFloat(getComputedStyle(row).paddingLeft);
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** La striscia di schermo che contiene la testata della colonna e la prima card. */
async function stripClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const top = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="kanban-column-review"]');
    return el ? el.getBoundingClientRect().top : 0;
  });
  return { x: 0, y: Math.max(0, top - 8), width: 390, height: 260 };
}

test.describe("Board mobile — la colonna Review sta nello schermo", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-revcol" }, null, 2));
    const topic = await createTopic(request, "E2E-RevCol", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    // Tre card in Review, dalla più innocua alla più ostile: il pavimento della
    // colonna non deve dipendere da cosa c'è dentro.
    await apiCreateTask(request, { text: "Card corta", status: "review" });
    await apiCreateTask(request, {
      // Un token che il browser NON può spezzare: è esattamente il contenuto che
      // alza il min-content di un flex item senza `min-w-0`.
      // The prefix is deliberately NOT a real home path: this repo is public and
      // `tests/unit/no-home-paths-tracked.test.ts` fails on `/Users/<name>`. Only
      // the length and the absence of break opportunities matter here.
      text: "/opt/agents/.topics/worktrees/topics-app/slender-shell/client/src/components/Board/KanbanBoardPane.tsx",
      status: "review",
      priority: 3,
      description: "8f3c1d9a7b25e6f04c8d1e2a3b4c5d6e7f8091a2 — riga di consegna con un hash lungo e un path assoluto senza spazi.",
    });
    await apiCreateTask(request, {
      text: "Approvazione con descrizione lunga",
      status: "review",
      priority: 4,
      description: "Una descrizione di consegna abbastanza lunga da riempire l'anteprima testuale della card e da spingere la colonna a chiedere spazio, con parole normali e separate.",
    });
  });

  test.afterAll(async ({ request }) => {
    for (const tid of createdTasks) await deleteTask(request, PROJECT_ID, tid);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  for (const vp of [{ w: 390, h: 844 }, { w: 360, h: 800 }]) {
    test(`REVCOL-${vp.w}: la colonna Review non esce dalla riga a ${vp.w}px`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "KANBAN-28" });
      // Il percorso sidebar → progetto → pane kanban vuole larghezza desktop:
      // si apre lì e si stringe al telefono prima di misurare.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await openProjectBoard(page);

      await page.setViewportSize({ width: vp.w, height: vp.h });

      const review = await measureColumn(page, "review");
      const todo = await measureColumn(page, "todo");

      // Il controllo: una colonna di lavoro sta dentro. Se sfora anche quella,
      // il difetto non è di Review ed è un'altra storia.
      expect(
        todo.overflowPx,
        `colonna Todo fuori dalla riga: ${JSON.stringify(todo)}`,
      ).toBe(0);

      expect(
        review.overflowPx,
        `colonna Review fuori dalla riga a ${vp.w}px: ${JSON.stringify(review)}`,
      ).toBe(0);
    });
  }

  test("REVCOL-leva: rimettere `min-width: auto` fa tornare lo sfondamento", async ({ page }) => {
    // Il test che dice se la correzione è la CAUSA o una coincidenza: si rimette
    // a mano il solo `min-width: auto` che `min-w-0` toglie, e la colonna deve
    // tornare a sfondare. Se restasse dentro, il merito sarebbe di qualcos'altro
    // e i due test qui sopra passerebbero per il motivo sbagliato.
    // Le due schermate escono da qui, dallo stesso caricamento e con lo stesso
    // contenuto: è l'unico modo perché il «prima» e il «dopo» siano confrontabili.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const dopo = await measureColumn(page, "review");
    expect(dopo.overflowPx).toBe(0);
    await frameReviewColumn(page);
    await page.screenshot({ path: "test-results/revcol-dopo-390.png", clip: await stripClip(page) });

    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="kanban-column-review"]') as HTMLElement | null;
      if (el) el.style.minWidth = "auto";
    });
    const prima = await measureColumn(page, "review");
    await frameReviewColumn(page);
    await page.screenshot({ path: "test-results/revcol-prima-390.png", clip: await stripClip(page) });

    expect(
      prima.overflowPx,
      "con min-width:auto la colonna deve tornare a uscire dalla riga: se non esce, `min-w-0` non era la leva",
    ).toBeGreaterThan(20);
    expect(prima.colWidth).toBeGreaterThan(dopo.colWidth);
  });

  test("REVCOL-desktop: a 1280px Review resta la colonna larga di sempre", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const review = await measureColumn(page, "review");
    const todo = await measureColumn(page, "todo");
    // Review è la superficie di approvazione: più larga delle colonne di lavoro,
    // su desktop, e questo il ritocco mobile non lo tocca.
    expect(review.colWidth).toBeGreaterThan(todo.colWidth);
    expect(review.overflowPx).toBe(0);
  });
});

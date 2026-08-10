/**
 * board-column-elastic-width.spec.ts — Acceptance for the Kanban column width
 * RANGE.
 *
 * Le colonne erano larghezze fisse (`w-72`, review `22rem`/`lg:32rem`) con
 * `shrink-0`: su un board largo l'avanzo restava un gutter morto a destra.
 * Ora la larghezza è un intervallo (Card.tsx, `widthCls`):
 *   - pavimento  = `basis` (le vecchie larghezze fisse), tenuto da `shrink-0`
 *   - crescita   = `grow`, che spende lo spazio in eccesso
 *   - soffitto   = `max-w`, il limite di leggibilità di una singola card
 *
 * Il contratto si misura sui rettangoli veri (getBoundingClientRect), non a
 * occhio, e vale a QUALSIASI larghezza — per questo i tre casi girano sullo
 * stesso predicato invece che su tre numeri copiati a mano:
 *   1. nessuna colonna sotto il suo pavimento (il carosello snap non si sfalda);
 *   2. nessuna colonna sopra il suo soffitto (la card non diventa illeggibile);
 *   3. se la riga NON eccede, o riempie il contenitore o è tutta al soffitto —
 *      cioè non esiste un avanzo che si poteva ancora distribuire.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-column-elastic-${Date.now()}`;

let projectTopicId: string | null = null;

const REM = 16;
// Gli stessi numeri di Card.tsx. Se là cambiano, questo test deve fallire e
// costringere a decidere di nuovo il soffitto di leggibilità — non seguirli in
// silenzio leggendo la classe dal DOM.
const FLOOR = { working: 18 * REM, reviewSm: 22 * REM, reviewLg: 32 * REM };
const CEIL = { working: 26 * REM, reviewSm: 34 * REM, reviewLg: 44 * REM };
const LG = 1024;

function bounds(status: string, viewportWidth: number) {
  if (status !== "review") return { floor: FLOOR.working, ceil: CEIL.working };
  return viewportWidth >= LG
    ? { floor: FLOOR.reviewLg, ceil: CEIL.reviewLg }
    : { floor: FLOOR.reviewSm, ceil: CEIL.reviewSm };
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-column-elastic/);
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

type Metrics = {
  clientWidth: number;
  scrollWidth: number;
  gap: number;
  paddingX: number;
  columns: { status: string; width: number }[];
};

/**
 * La riga delle colonne è il PADRE della prima colonna: presa così invece che
 * per classi, sopravvive a un ritocco di Tailwind sul contenitore.
 */
async function rowMetrics(page: Page): Promise<Metrics> {
  const firstColumn = page.getByTestId("kanban-column-backlog");
  await expect(firstColumn).toBeVisible({ timeout: 10000 });
  return firstColumn.evaluate((col) => {
    const row = col.parentElement as HTMLElement;
    const cs = getComputedStyle(row);
    const cols = Array.from(row.querySelectorAll<HTMLElement>('[data-testid^="kanban-column-"]'))
      .filter((el) => el.parentElement === row)
      .map((el) => ({
        status: (el.dataset.testid || el.getAttribute("data-testid") || "").replace("kanban-column-", ""),
        width: el.getBoundingClientRect().width,
      }));
    return {
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      gap: parseFloat(cs.columnGap) || 0,
      paddingX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
      columns: cols,
    };
  });
}

/** Il contratto, uguale a ogni larghezza. */
function assertWidthContract(m: Metrics, viewportWidth: number) {
  expect(m.columns.length, "il board deve avere le sue colonne").toBeGreaterThan(0);

  let allAtCeiling = true;
  for (const c of m.columns) {
    const { floor, ceil } = bounds(c.status, viewportWidth);
    expect(
      Math.round(c.width),
      `colonna ${c.status}: mai sotto il pavimento (${floor}px) — il carosello snap ci conta`,
    ).toBeGreaterThanOrEqual(floor - 1);
    expect(
      Math.round(c.width),
      `colonna ${c.status}: mai sopra il soffitto di leggibilità (${ceil}px)`,
    ).toBeLessThanOrEqual(ceil + 1);
    if (c.width < ceil - 1) allAtCeiling = false;
  }

  const overflowing = m.scrollWidth > m.clientWidth + 1;
  if (overflowing) return; // niente avanzo da distribuire: si scrolla, ed è giusto

  const used = m.columns.reduce((s, c) => s + c.width, 0) + m.gap * (m.columns.length - 1) + m.paddingX;
  const leftover = m.clientWidth - used;
  if (allAtCeiling) return; // l'avanzo resta per scelta: allargare ancora peggiora la lettura

  expect(
    leftover,
    "se la riga ci sta e nessuna colonna è al soffitto, l'avanzo va speso: niente gutter morto",
  ).toBeLessThanOrEqual(2);
}

test.describe("Kanban — larghezza elastica delle colonne", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-column-elastic" }, null, 2));
    const topic = await createTopic(request, "E2E-ColumnElastic", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("COLUMN-WIDTH-01: il contratto pavimento/crescita/soffitto tiene a ogni larghezza", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    // La stessa clip mostra la crescita: si allarga il viewport a gradini e le
    // colonne si espandono finché non toccano il soffitto.
    for (const width of [1100, 1280, 1600, 2000, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const m = await rowMetrics(page);
      assertWidthContract(m, width);
    }
  });

  test("COLUMN-WIDTH-02: largo → le colonne crescono, e il soffitto è davvero cablato", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await page.waitForTimeout(250);

    const m = await rowMetrics(page);
    assertWidthContract(m, 2560);

    // La crescita è il punto del task: su un board largo la colonna di lavoro
    // deve valere PIÙ del vecchio `w-72` fisso.
    for (const c of m.columns.filter((x) => x.status !== "review")) {
      expect(
        Math.round(c.width),
        `colonna ${c.status}: su un board largo deve essersi allargata oltre il vecchio fisso (${FLOOR.working}px)`,
      ).toBeGreaterThan(FLOOR.working);
    }

    // Il soffitto non si dimostra allargando la finestra (il pane del progetto
    // non arriva necessariamente così largo): si legge sulla proprietà calcolata,
    // che è ciò che ferma la crescita.
    const caps = await page.getByTestId("kanban-board").evaluate((board) =>
      Array.from(board.querySelectorAll<HTMLElement>('[data-testid^="kanban-column-"]'))
        // `kanban-column-body-*` (il corpo scrollabile) condivide il prefisso: è
        // dentro la colonna, non è la colonna, e non porta nessun tetto.
        .filter((el) => !(el.getAttribute("data-testid") || "").startsWith("kanban-column-body-"))
        .map((el) => ({
          status: (el.getAttribute("data-testid") || "").replace("kanban-column-", ""),
          maxWidth: getComputedStyle(el).maxWidth,
        })),
    );
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      const { ceil } = bounds(c.status, 2560);
      expect(c.maxWidth, `colonna ${c.status}: il soffitto di leggibilità deve essere ${ceil}px`).toBe(`${ceil}px`);
    }
  });

  test("COLUMN-WIDTH-03: stretto → il pavimento regge e la riga torna carosello", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await page.waitForTimeout(250);

    const m = await rowMetrics(page);
    assertWidthContract(m, 900);
    expect(
      m.scrollWidth,
      "a 900px le colonne non ci stanno: la riga deve eccedere e restare scrollabile (snap), non comprimersi",
    ).toBeGreaterThan(m.clientWidth + 1);
    const working = m.columns.filter((c) => c.status !== "review");
    for (const c of working) {
      expect(Math.round(c.width), `colonna ${c.status} al pavimento quando la riga eccede`).toBe(FLOOR.working);
    }
  });
});

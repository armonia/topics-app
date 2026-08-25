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

// Sotto `sm` il pavimento di review non è un numero: è la larghezza VISIBILE
// della riga (Card.tsx, `basis-full`). Vedi COLUMN-WIDTH-04.
const SM = 640;

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
  columns: { status: string; width: number; maxWidth: string }[];
};

/**
 * La riga delle colonne è il PADRE della prima colonna: presa così invece che
 * per classi, sopravvive a un ritocco di Tailwind sul contenitore.
 *
 * UNA COLONNA È UN FIGLIO DIRETTO DI QUELLA RIGA, non «un testid che comincia
 * per `kanban-column-`». Sotto quel prefisso vivono anche pezzi che stanno
 * DENTRO la colonna — il corpo scrollabile (`kanban-column-body-*`), il
 * contatore in testa (`kanban-column-count-*`), la coda «altre N»
 * (`kanban-column-more-*`) — e nessuno di quelli porta la larghezza della
 * colonna. Prenderli per prefisso vuol dire misurare uno `<span>` e chiamarlo
 * colonna, con uno stato inventato («count-backlog») su cui il pavimento e il
 * soffitto non vogliono dire niente. Il legame di parentela non si sporca
 * quando la colonna cresce di pezzi, quindi è lui il criterio — e sta in UN
 * posto solo, con dentro anche il soffitto calcolato: due letture separate
 * erano due selettori da tenere d'accordo, e uno dei due è andato alla deriva.
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
        maxWidth: getComputedStyle(el).maxWidth,
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

/**
 * The same metrics, read once the layout has STOPPED: re-read until two
 * consecutive samples agree.
 *
 * Every `setViewportSize` here used to be followed by a fixed 250 ms sleep. What
 * decides when the row is final is a ResizeObserver, and that is on nobody's
 * clock: on a loaded machine 250 ms samples the row mid-reflow (a red that moves
 * between runs), on an idle one it throws away a quarter second for a row that
 * settled in 30 ms. The real condition is "the row stopped moving", and this is
 * it.
 */
async function settledRowMetrics(page: Page): Promise<Metrics> {
  let previous = "";
  let settled: Metrics | null = null;
  await expect
    .poll(
      async () => {
        const m = await rowMetrics(page);
        const shot = JSON.stringify(m);
        const same = shot === previous;
        previous = shot;
        if (same) settled = m;
        return same;
      },
      { timeout: 10_000, message: "la riga di colonne non ha mai smesso di muoversi" },
    )
    .toBe(true);
  return settled!;
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
      assertWidthContract(await settledRowMetrics(page), width);
    }
  });

  test("COLUMN-WIDTH-02: largo → le colonne crescono, e il soffitto è davvero cablato", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const m = await settledRowMetrics(page);
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
    // che è ciò che ferma la crescita. Le colonne sono le stesse misurate qui
    // sopra — un secondo selettore per la stessa cosa è il modo in cui i due
    // finiscono per non parlare più della stessa cosa.
    expect(m.columns.length).toBeGreaterThan(0);
    for (const c of m.columns) {
      const { ceil } = bounds(c.status, 2560);
      expect(c.maxWidth, `colonna ${c.status}: il soffitto di leggibilità deve essere ${ceil}px`).toBe(`${ceil}px`);
    }
  });

  test("COLUMN-WIDTH-03: stretto → il pavimento regge e la riga torna carosello", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const m = await settledRowMetrics(page);
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

  test("COLUMN-WIDTH-04: sul telefono la colonna Review vale UNA SCHERMATA, non 22rem", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    // Tre telefoni veri, uno più stretto del vecchio pavimento fisso (22rem =
    // 352px): è lì che il numero cablato smetteva di essere una larghezza e
    // diventava un taglio.
    for (const width of [430, 390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const m = await settledRowMetrics(page);
      const review = m.columns.find((c) => c.status === "review")!;
      const visibile = m.clientWidth - m.paddingX;
      expect(
        Math.round(review.width),
        `a ${width}px la review deve valere la riga visibile (${Math.round(visibile)}px): da mobile è UNA slide intera`,
      ).toBe(Math.round(visibile));
      expect(
        Math.round(review.width),
        `a ${width}px la review non può essere più larga della finestra`,
      ).toBeLessThanOrEqual(width);
      // Le colonne di lavoro NON cambiano: restano il carosello con lo sbircio.
      for (const c of m.columns.filter((x) => x.status !== "review")) {
        expect(Math.round(c.width), `colonna ${c.status} resta al suo pavimento`).toBe(FLOOR.working);
      }
      // Da `sm` in su nulla si muove: il pavimento torna il numero di prima.
      expect(width, "questi tre casi devono stare sotto sm, o non provano niente").toBeLessThan(SM);
    }

    // La riprova del confine: appena sopra `sm` la review torna 22rem esatti.
    await page.setViewportSize({ width: 700, height: 844 });
    const sopra = await settledRowMetrics(page);
    expect(
      Math.round(sopra.columns.find((c) => c.status === "review")!.width),
      "sopra sm il pavimento torna quello di sempre (22rem)",
    ).toBe(FLOOR.reviewSm);
  });
});

/**
 * board-task-id-chip.spec.ts — il riferimento al task è un SEGNO, non una parola.
 *
 * Prima: l'eyebrow della card stampava lo slug per esteso ("brave-otter") in un
 * chip `shrink-0`. Non si comprimeva mai, quindi si prendeva ~70px della riga e
 * costringeva il nome del progetto a troncare per fargli posto: «un chip con lo
 * slug del task che sta un pochino davanti» (Attilio, 12/08).
 *
 * Ora è il glifo `#` a 14px — la misura standard di ogni icona di riga
 * (`ROW_GLYPH`) — con lo slug e l'UUID nel `title`. Il click continua a COPIARE
 * l'id pieno: per questo il segno è `#` e non l'icona del link, che prometterebbe
 * una navigazione che non c'è.
 *
 * Questa spec è la barra, non un contorno: misura sul DOM vero
 * (getBoundingClientRect + hit-test) che
 *   · il segno non sborda dalla riga che lo contiene,
 *   · è centrato verticalmente con gli altri chip della riga,
 *   · il bersaglio del dito resta ≥44px anche se il disegno ne occupa 14,
 *   · e che il chip pesa ora una frazione della riga (≤28px contro i ~70 di prima).
 *
 * Produce anche le due schermate della consegna, con `CHIP_SHOT=1`.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-idchip-${Date.now()}`;

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
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** Il minimo che un dito deve poter colpire, in px CSS (HIG Apple / Material). */
const TAP_MIN = 44;
/** Quanto può occupare il segno sulla riga: il glifo (14) più il suo respiro. */
const CHIP_MAX_W = 28;

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

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-idchip/);
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

/**
 * La geometria della riga, misurata: il rettangolo del chip, quello della riga
 * che lo contiene, e il bersaglio EFFETTIVO del dito — che non è il rettangolo
 * del bottone ma l'area in cui il hit-test restituisce ancora il bottone (il
 * `::after` invisibile che allarga la presa senza toccare il layout).
 */
type ChipGeometry = {
  chip: { x: number; y: number; w: number; h: number; cy: number };
  row: { top: number; bottom: number; left: number; right: number; cy: number };
  /** Il rettangolo dichiarato dal `::after` di `tap-expand` (0 se non c'è). */
  pseudo: { w: number; h: number };
  /** Il hit-test vero a `PROBE` px dal centro, nelle quattro direzioni. */
  reach: { left: boolean; right: boolean; up: boolean; down: boolean };
  coarse: boolean;
};

/**
 * A che distanza dal centro si va a bussare. Un pelo dentro il bordo dei 44px
 * (22 per lato): sul bordo esatto il campionamento a coordinate intere di
 * `elementsFromPoint` cade dentro o fuori a seconda del mezzo pixel a cui il
 * layout ha messo il glifo, e misurerebbe l'arrotondamento invece dell'area.
 * Il numero ESATTO lo dà `pseudo`; questa sonda dice che quell'area è davvero
 * sensibile al tocco e non solo dichiarata.
 */
const PROBE = TAP_MIN / 2 - 1;

async function measureChip(page: Page, taskId: string): Promise<ChipGeometry> {
  const card = page.locator(`[data-task-card="${taskId}"]`).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  const chip = card.getByTestId("task-id-chip");
  await expect(chip).toBeVisible({ timeout: 10000 });

  return chip.evaluate((el, probe) => {
    const r = el.getBoundingClientRect();
    const rowEl = el.parentElement!.parentElement!; // riga eyebrow (flex-wrap)
    const rr = rowEl.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const reaches = (dx: number, dy: number) =>
      document.elementsFromPoint(cx + dx, cy + dy).includes(el);
    const after = getComputedStyle(el, "::after");
    return {
      chip: { x: r.x, y: r.y, w: r.width, h: r.height, cy },
      row: { top: rr.top, bottom: rr.bottom, left: rr.left, right: rr.right, cy: rr.y + rr.height / 2 },
      pseudo: { w: parseFloat(after.width) || 0, h: parseFloat(after.height) || 0 },
      reach: {
        left: reaches(-probe, 0),
        right: reaches(probe, 0),
        up: reaches(0, -probe),
        down: reaches(0, probe),
      },
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  }, PROBE);
}

/**
 * La card più in BASSO fra quelle seminate — cioè una card qualunque, non la
 * prima della colonna.
 *
 * Misurato: l'area proiettata da `tap-expand` è alta 44 e centrata sul glifo,
 * ma la lista delle card è un contenitore che scorre, e un contenitore che
 * scorre RITAGLIA. Sulla card in cima alla colonna la metà superiore
 * dell'area finisce oltre il bordo del contenitore e il hit-test la restituisce
 * all'intestazione della colonna: 44px pieni lassù non esistono per nessun
 * bersaglio, qualunque sia il disegno. Su ogni altra card — cioè il caso
 * normale — l'area è tutta lì, ed è quella che questo test misura.
 */
async function lowerCardId(page: Page, ids: string[]): Promise<string> {
  const tops = await Promise.all(ids.map(async (id) => {
    const box = await page.locator(`[data-task-card="${id}"]`).first().boundingBox();
    return { id, top: box?.y ?? -Infinity };
  }));
  return tops.sort((a, b) => b.top - a.top)[0].id;
}

test.describe("Board card — il riferimento al task è un segno, non una parola", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-idchip" }, null, 2));
    const topic = await createTopic(request, "E2E-IdChip", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    await apiCreateTask(request, {
      text: "Rivedere l'eyebrow della card e il riferimento al task",
      status: "todo",
      priority: 2,
    });
    // La seconda card serve al test del dito: vedi `lowerCardId`.
    await apiCreateTask(request, {
      text: "Seconda card, per misurare il bersaglio lontano dal bordo della colonna",
      status: "todo",
      priority: 2,
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await openProjectBoard(page);
  });

  test("IDCHIP-01: il segno sta nella riga, centrato, e non la occupa", async ({ page }) => {
    const g = await measureChip(page, createdTasks[0]);

    expect(g.chip.w, `il segno deve pesare ≤${CHIP_MAX_W}px sulla riga`).toBeLessThanOrEqual(CHIP_MAX_W);
    // Dentro la riga su tutti e quattro i lati: 0.5px di tolleranza è il
    // sub-pixel del layout, non un permesso a sbordare.
    expect(g.chip.y).toBeGreaterThanOrEqual(g.row.top - 0.5);
    expect(g.chip.y + g.chip.h).toBeLessThanOrEqual(g.row.bottom + 0.5);
    expect(g.chip.x).toBeGreaterThanOrEqual(g.row.left - 0.5);
    expect(g.chip.x + g.chip.w).toBeLessThanOrEqual(g.row.right + 0.5);
    // Allineamento verticale col resto della riga.
    expect(Math.abs(g.chip.cy - g.row.cy)).toBeLessThanOrEqual(1);
  });

  test("IDCHIP-02: col mouse l'area sensibile resta quella del glifo", async ({ page }) => {
    // Il rovescio del patto: su puntatore fine `tap-expand` non proietta
    // niente, quindi il segno non ruba i clic al nome del progetto accanto né
    // al titolo sotto (che aprono la card). Senza questa metà, allargare il
    // bersaglio sarebbe un peggioramento travestito da accessibilità.
    const g = await measureChip(page, createdTasks[0]);
    expect(g.coarse, "il contesto desktop deve avere puntatore fine").toBe(false);
    expect(g.pseudo.w, "col mouse nessuna area proiettata").toBe(0);
    expect(g.reach, "a 21px dal centro il bottone non deve più rispondere")
      .toEqual({ left: false, right: false, up: false, down: false });
  });

  test("IDCHIP-03: il click copia l'UUID pieno e lo conferma", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const taskId = createdTasks[0];
    const card = page.locator(`[data-task-card="${taskId}"]`).first();
    const chip = card.getByTestId("task-id-chip");

    // Lo slug non è perso: vive nel title, insieme all'id pieno.
    await expect(chip).toHaveAttribute("title", new RegExp(taskId.replace(/-/g, "\\-")));

    await chip.click();
    await expect(chip).toHaveAttribute("data-copied", "true");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(taskId);
    // Il click sul segno non apre la card: `stopPropagation` regge.
    await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0);
  });

  test("IDCHIP-04: schermata della riga per la consegna", async ({ page }, testInfo) => {
    test.skip(process.env.CHIP_SHOT !== "1", "manca CHIP_SHOT=1: non è un AC, produce su richiesta lo scatto di consegna");
    const card = page.locator(`[data-task-card="${createdTasks[0]}"]`).first();
    await expect(card).toBeVisible();
    await card.screenshot({ path: `${testInfo.project.outputDir}/../chip-${process.env.CHIP_SHOT_NAME || "shot"}.png` });
  });

  // Il dito: stesso board, contesto con touch — è lì che `tap-expand` esiste.
  test.describe("col dito", () => {
    test.use({ hasTouch: true });

    test("IDCHIP-05: il bersaglio del dito è ≥44px pur restando un glifo da 14", async ({ page }) => {
      const g = await measureChip(page, await lowerCardId(page, createdTasks));
      // Se il contesto non è a puntatore grossolano la regola non è nemmeno
      // attiva e il test misurerebbe il vuoto: si ferma qui invece di passare.
      expect(g.coarse, "il contesto touch deve avere puntatore grossolano").toBe(true);
      expect(g.chip.w, "il DISEGNO resta piccolo").toBeLessThanOrEqual(CHIP_MAX_W);
      expect(g.pseudo.w, "larghezza del bersaglio").toBeGreaterThanOrEqual(TAP_MIN);
      expect(g.pseudo.h, "altezza del bersaglio").toBeGreaterThanOrEqual(TAP_MIN);
      // Dichiarata E sensibile: il hit-test risponde in tutte le direzioni.
      expect(g.reach).toEqual({ left: true, right: true, up: true, down: true });
    });
  });
});

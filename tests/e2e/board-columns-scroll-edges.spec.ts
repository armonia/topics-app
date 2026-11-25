/**
 * board-columns-scroll-edges.spec.ts — the sideways-scrolling columns row keeps
 * a band for its scrollbar and the same room at both ends.
 *
 * @covers KANBAN-122
 *
 * Two defects reported by the owner on the desktop shell (WKWebView, macOS
 * overlay scrollbars): the horizontal scrollbar of the columns row was drawn
 * OVER the foot of the columns, and while scrolling the columns were cut against
 * the window edge with almost no room (and the room at the END of the scroll was
 * lost, because WebKit does not always count the padding-end of a flex scroll
 * container in the scrollable area).
 *
 * Seeded: two projects with a card in EVERY status, so the row overflows at
 * 1280 (five columns, Review the widest). Measured on the engine of the shell
 * (the `webkit` project) and on Chromium:
 *
 *  1. At rest the first column starts at least 8 px inside the row.
 *  2. Scrolled to the very end the last column ends at least 12 px inside the
 *     row's right edge: the end padding is INSIDE the scrollable area.
 *  3. No column paints in the band the scrollbar owns: every column ends at
 *     least 14 px above the row's bottom edge.
 *  4. The same three, in the row inside a project lane (grouped by project).
 *  5. While columns are hidden past an edge, that edge (and only that one) is
 *     faded by a mask; the fade is static, no transition.
 *
 * Screenshots for the delivery review go to ~/.topics/media/board-tabella
 * (`scroll-edges-after-{start,end}` and `-lane-` for the lane row; with
 * `SCROLL_EDGES_STAGE=before` the same names say `before`, taken ahead of the fix
 * for the review's side-by-side).
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Locator, type Page } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
const PATH_A = `${canonicalTmpRoot()}/e2e-edges-alfa-${STAMP}`;
const PATH_B = `${canonicalTmpRoot()}/e2e-edges-zeta-${STAMP}`;
const ID_A = boardIdForPath(PATH_A);
const ID_B = boardIdForPath(PATH_B);
const MEDIA_DIR = join(homedir(), ".topics", "media", "board-tabella");
const STAGE = process.env.SCROLL_EDGES_STAGE === "before" ? "before" : "after";
const STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;

/** The bars, in px: room at each end, and the band under the columns that the scrollbar owns. */
const START_ROOM = 8;
const END_ROOM = 12;
const SCROLLBAR_BAND = 14;

type Req = import("@playwright/test").APIRequestContext;
const createdTasks: { board: string; id: string }[] = [];
const topics: string[] = [];
const firstTodo: Record<string, string> = {};

async function createTask(request: Req, board: string, text: string, status: string) {
  // Born in Todo (the API refuses a card created straight into Done), then moved to where the case needs it.
  const res = await request.post(`${BASE}/api/boards/${board}/tasks`, { data: { text, status: "todo" } });
  expect(res.ok(), `POST ${text}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push({ board, id });
  if (status !== "todo") {
    const moved = await request.patch(`${BASE}/api/boards/${board}/tasks/${id}`, { data: { status } });
    expect(moved.ok(), `PATCH ${text} -> ${status}`).toBe(true);
  }
  if (status === "todo") firstTodo[board] ??= id;
}

async function openBoard(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    const viewKeys = ["layout", "groupBy", "thenBy", "density", "columns", "collapsedProjects"].map((k) => `topics.board.${k}`);
    // Keep the config's preset and showDone: only the per-board view choices start clean.
    for (const k of Object.keys(localStorage)) if (viewKeys.some((v) => k === v || k.startsWith(`${v}:`))) localStorage.removeItem(k);
  });
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`[data-task-card="${firstTodo[ID_A]}"]`)).toBeVisible({ timeout: 15000 });
}

async function groupByProject(page: Page) {
  await page.getByTestId("board-group-by").click();
  await page.getByRole("option", { name: "Progetto", exact: true }).click();
  await expect(page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`)).toBeVisible();
}

const engine = () => test.info().project.name;

async function shoot(page: Page, prefix: string, where: "start" | "end") {
  mkdirSync(MEDIA_DIR, { recursive: true });
  // The webkit pair is THE pair (the shell's engine); another engine gets its own suffix.
  const suffix = engine() === "webkit" ? "" : `-${engine()}`;
  await page.screenshot({ path: join(MEDIA_DIR, `scroll-edges-${STAGE}-${prefix}${where}${suffix}.png`) });
}

interface Geometry {
  rowLeft: number; rowRight: number; rowBottom: number;
  scrollLeft: number; maxScroll: number;
  /** offsetHeight - clientHeight: the layout space a non-overlay scrollbar takes. */
  barThickness: number;
  padRight: number; padBottom: number;
  columns: number;
  firstLeft: number; lastRight: number; lowestBottom: number;
  /** Which edges still have columns past them (the attributes `useScrollEdges` writes) and the mask that fades them. */
  edgeStart: boolean; edgeEnd: boolean; fades: boolean; animates: boolean;
}

/** What the row and its columns measure NOW. A column is `kanban-column-<status>`, not its body, count or "more". */
const geometry = (row: Locator) => row.evaluate((el): Geometry => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const cols = Array.from(el.querySelectorAll<HTMLElement>('[data-testid^="kanban-column-"]'))
    .filter((c) => /^kanban-column-(backlog|todo|in_progress|review|done)$/.test(c.dataset.testid ?? ""))
    .map((c) => c.getBoundingClientRect());
  return {
    rowLeft: r.left, rowRight: r.right, rowBottom: r.bottom,
    scrollLeft: el.scrollLeft, maxScroll: el.scrollWidth - el.clientWidth,
    barThickness: (el as HTMLElement).offsetHeight - el.clientHeight,
    padRight: parseFloat(cs.paddingRight), padBottom: parseFloat(cs.paddingBottom),
    columns: cols.length,
    firstLeft: Math.min(...cols.map((c) => c.left)),
    lastRight: Math.max(...cols.map((c) => c.right)),
    lowestBottom: Math.max(...cols.map((c) => c.bottom)),
    edgeStart: el.hasAttribute("data-edge-start"), edgeEnd: el.hasAttribute("data-edge-end"),
    animates: cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0),
    fades: !["", "none"].includes(cs.maskImage || (cs as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage || ""),
  };
});

/** Scroll the row all the way to one end, instantly (the row smooths its own scrolling), and wait for it to settle. */
async function scrollTo(row: Locator, where: "start" | "end") {
  await row.evaluate((el, w) => el.scrollTo({ left: w === "end" ? el.scrollWidth : 0, behavior: "instant" }), where);
  await expect.poll(async () => {
    const g = await geometry(row);
    return where === "end" ? g.maxScroll - g.scrollLeft : g.scrollLeft;
  }, { timeout: 5000 }).toBeLessThanOrEqual(1);
  // The edges follow the scroll event, which the engine delivers on its next frame: give it that frame
  // (a row that never settles is reported by `judge` with the state it is in, not by a timeout here).
  await expect.poll(async () => {
    const g = await geometry(row);
    return where === "end" ? g.edgeStart && !g.edgeEnd : !g.edgeStart && g.edgeEnd;
  }, { timeout: 1500 }).toBe(true).catch(() => undefined);
}

/** The three bars on one row; every violation is collected so a red run reports all the numbers at once. */
async function judge(row: Locator, label: string, page: Page, shots: "" | "lane-" | null) {
  const failures: string[] = [];
  await scrollTo(row, "start");
  const start = await geometry(row);
  expect(start.maxScroll, `${label}: the row must overflow for this to mean anything`).toBeGreaterThan(100);
  expect(start.columns, `${label}: all five status columns`).toBe(STATUSES.length);
  if (shots !== null) await shoot(page, shots, "start");
  await scrollTo(row, "end");
  const end = await geometry(row);
  if (shots !== null) await shoot(page, shots, "end");

  const startRoom = start.firstLeft - start.rowLeft;
  const endRoom = end.rowRight - end.lastRight;
  const band = Math.min(start.rowBottom - start.lowestBottom, end.rowBottom - end.lowestBottom);
  if (startRoom < START_ROOM) failures.push(`first column ${startRoom.toFixed(1)}px from the row's left (need >= ${START_ROOM})`);
  if (endRoom < END_ROOM) failures.push(`last column ${endRoom.toFixed(1)}px from the row's right at the end of the scroll (need >= ${END_ROOM})`);
  if (band < SCROLLBAR_BAND) failures.push(`lowest column ${band.toFixed(1)}px above the row's bottom (need >= ${SCROLLBAR_BAND})`);
  // The soft edge: only the side that still has columns past it fades; no transition on the way.
  if (start.animates || end.animates) failures.push("the row has a transition: the fade must be static");
  if (!(start.edgeEnd && !start.edgeStart && start.fades)) failures.push(`at rest the right edge should fade and the left not: ${JSON.stringify({ s: start.edgeStart, e: start.edgeEnd, fades: start.fades })}`);
  if (!(end.edgeStart && !end.edgeEnd && end.fades)) failures.push(`at the end the left edge should fade and the right not: ${JSON.stringify({ s: end.edgeStart, e: end.edgeEnd, fades: end.fades })}`);

  const numbers = `${engine()} ${label}: startRoom=${startRoom.toFixed(1)} endRoom=${endRoom.toFixed(1)} band=${band.toFixed(1)} `
    + `padRight=${start.padRight} padBottom=${start.padBottom} barLayout=${start.barThickness} maxScroll=${start.maxScroll.toFixed(0)}`;
  test.info().annotations.push({ type: "measure", description: numbers });
  console.log(`[scroll-edges] ${numbers}`);
  expect(failures, `${numbers}\n${failures.join("\n")}`).toEqual([]);
}

test.describe("Board — colonne: bordi e banda della scrollbar", () => {
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(() => { test.info().annotations.push({ type: "spec", description: "KANBAN-122" }); });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async ({ request }) => {
    for (const [path, name] of [[PATH_A, "e2e-edges-alfa"], [PATH_B, "e2e-edges-zeta"]] as const) {
      mkdirSync(path, { recursive: true });
      writeFileSync(`${path}/package.json`, JSON.stringify({ name }, null, 2));
      topics.push((await createTopic(request, name, { projectPath: path })).id);
    }
    for (const board of [ID_A, ID_B]) {
      for (const status of STATUSES) await createTask(request, board, `Card ${status} ${board.slice(0, 6)} ${STAMP}`, status);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const t of [...createdTasks].reverse()) await deleteTask(request, t.board, t.id);
    for (const id of [...topics].reverse()) await deleteTopic(request, id);
    removeTmpDir(PATH_A);
    removeTmpDir(PATH_B);
  });

  test("the flat columns row keeps room at both ends and a band for its scrollbar", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openBoard(page);
    // The 1440 pair for the review; the bars are measured at 1280 below as well.
    await judge(page.getByTestId("kanban-columns-row"), "flat 1440", page, "");
    await page.setViewportSize({ width: 1280, height: 800 });
    await judge(page.getByTestId("kanban-columns-row"), "flat 1280", page, null);
  });

  test("the row inside a project lane keeps the same room and the same band", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await openBoard(page);
    await groupByProject(page);
    const laneRow = page.locator(`[data-testid="board-lane"][data-project-id="${ID_A}"]`).getByTestId("board-lane-columns-row");
    await expect(laneRow).toBeVisible();
    await judge(laneRow, "lane 1440", page, "lane-");
    await page.setViewportSize({ width: 1280, height: 800 });
    await judge(laneRow, "lane 1280", page, null);
  });
});

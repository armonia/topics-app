/**
 * board-task-load-error.spec.ts: a read that failed is SAID, not spun on.
 *
 * The task drawer has a single read (`load()`, the GET of the detail) and runs
 * it at two moments: on mount, and after every mutation (priority, status,
 * decision, comment). When that GET fell over, the two moments produced two
 * different silences:
 *
 *  · on MOUNT the full-height spinner stayed there forever. A spinner promises
 *    the row is on its way, so nobody closed and reopened, which was the only
 *    way out there was;
 *  · AFTER A MUTATION the server had already changed and the drawer kept
 *    drawing the previous row without saying so: the click looked like it had
 *    done nothing, and whoever repeated it sent a second write.
 *
 * Now the first case shows an error block with the server message and a Retry
 * (`task-load-error`), and the header stops saying "Loading"; the second shows
 * a warning in the decision area (`task-stale-warning`) with its own Retry.
 * Two states, two tests.
 *
 * HOW THE GET IS MADE TO FALL. A `page.route` that aborts ONLY the GET method
 * on `**\/api/boards/*\/tasks/*`: PATCH on the same path must go through,
 * because the second case is exactly "the action landed, the refresh did not".
 * The `*` glob does not cross `/`, so `.../tasks/<id>/comments` and the other
 * sub-routes are untouched, and so is the `.../tasks` list, which has no extra
 * segment.
 *
 * WHAT PROVES THE DRAWER IS LOADED. `task-brief-scroll`, which exists in both
 * layouts and is gated on `task` alone. Not `task-drawer-body`: that mounts
 * only when the task group has panes, and a task never dispatched has none.
 * Not `task-brief-header`: it exists only in the wide layout.
 *
 * The main case runs inside `clipDiConsegna` (helpers/clip.ts): under
 * `E2E_CLIP=1` it opens a DEDICATED context on the useful stretch only and
 * measures the .webm. Setup lives in the `prologo`, on a page whose video is
 * thrown away.
 *
 * @covers KANBAN-08
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page, type APIRequestContext, type Route } from "@playwright/test";
import {
  createTopic,
  deleteTopic,
  deleteTask,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  waitForProjectPaneType,
} from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

const STAMP = Date.now();
const PROJECT_PATH = `/tmp/e2e-task-load-${STAMP}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const TASK = "Rivedere il contratto del drawer";

/**
 * The detail GET and only that one. Mutations (PATCH/POST) on the same path go
 * through: the second test is "the action landed", so it has to land.
 */
const DETAIL = "**/api/boards/*/tasks/*";
const abortOnlyTheGet = (route: Route) =>
  route.request().method() === "GET" ? route.abort() : route.continue();

let topicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok(), `POST tasks ${JSON.stringify(body)}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

interface TaskRow {
  status: string;
  priority: number;
}

async function readTask(request: APIRequestContext, taskId: string): Promise<TaskRow> {
  const res = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { task?: TaskRow } & TaskRow;
  return body.task ?? body;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-task-load/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const alreadyOpen = page.getByTestId("kanban-board");
  if (await alreadyOpen.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) return;

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
  if (!opened) throw new Error("nessun menu + con la voce Board");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Board · una lettura fallita del task si dice, non si gira a vuoto", () => {
  test.describe.configure({ timeout: 120_000 });

  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-task-load" }, null, 2));
    const topic = await createTopic(request, "E2E-TaskLoad", { projectPath: PROJECT_PATH });
    topicId = topic.id;

    // `review` with no branch: no dispatcher picks it up, so no agent shows up
    // mid-scene; and outside backlog/todo the priority chip shows the VALUE
    // (not "auto priority"), which is what the second test reads. Priority 2 =
    // Medium, stated: the test starts from a known value.
    taskId = await createTask(request, { text: TASK, status: "review", priority: 2 });

    const row = await readTask(request, taskId);
    expect(row.status, "il task parte in review").toBe("review");
    expect(row.priority, "priorità di partenza = Media").toBe(2);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (topicId) await deleteTopic(request, topicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("LOAD-ERROR-01: la GET del dettaglio cade all'apertura → errore col Riprova, non lo spinner", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-08" });
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    await clipDiConsegna({
      nome: "board-task-load-error",
      // The context is OURS: nothing from `use` reaches here on its own.
      // `locale` because without it the app answers in English; 1280x680 =
      // 0.531 ratio, because above 0.70 the card crops the clip from the
      // bottom instead of shrinking it.
      context: {
        baseURL: BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      // OUTSIDE THE RECORDING: opening the project and mounting the board is
      // stagehand work, not the scene. No route here: the prologue has to see
      // a healthy app.
      prologo: async (p) => {
        await p.goto("/");
        await openProjectBoard(p);
        await expect(p.locator(`[data-task-card="${taskId}"]`)).toBeVisible({ timeout: 15000 });
        await waitForProjectPaneType(request, PROJECT_PATH, "kanban");
      },
      scena: async (page) => {
        // The route BEFORE the goto: the page is born with the detail GET
        // already broken, while the board list (`.../tasks`, no extra
        // segment) goes through.
        await page.route(DETAIL, abortOnlyTheGet);
        await page.goto("/");
        const card = page.locator(`[data-task-card="${taskId}"]`);
        await expect(card).toBeVisible({ timeout: 20000 });
        // Review is the fourth column: without this the scene starts on
        // Backlog. `toBeVisible` does not scroll horizontally.
        await card.scrollIntoViewIfNeeded();
        await didascalia(page, "La card sulla board: il server del dettaglio non risponde");
        await beat(page, 1400);

        await card.click();
        const drawer = page.getByTestId("task-detail-drawer");
        await expect(drawer).toBeVisible({ timeout: 10000 });

        // FIRST STATE: the error block with its button. Not the spinner (no
        // ring turning inside the drawer) and not the loaded row.
        const errorBox = drawer.getByTestId("task-load-error");
        await expect(errorBox).toBeVisible({ timeout: 10000 });
        await expect(errorBox.getByTestId("task-load-retry")).toBeVisible();
        await expect(drawer.locator(".animate-spin")).toHaveCount(0);
        await expect(drawer.getByTestId("task-brief-scroll")).toHaveCount(0);
        // The header no longer promises "Loading": the status chip has no
        // ring. We read the sign, not the word.
        await expect(drawer.getByTestId("task-status-chip").locator(".animate-spin")).toHaveCount(0);
        await didascalia(page, "Il drawer lo dice, e offre Riprova");
        await beat(page, 1800);

        // The server comes back. Retry runs the same `load()` again.
        await page.unroute(DETAIL, abortOnlyTheGet);
        await didascalia(page, "Il server torna: Riprova");
        await beat(page, 1000);
        await errorBox.getByTestId("task-load-retry").click();

        // SECOND STATE: the row loaded, the error gone.
        await expect(drawer.getByTestId("task-brief-scroll")).toBeVisible({ timeout: 10000 });
        await expect(drawer).toContainText(TASK);
        await expect(drawer.getByTestId("task-load-error")).toHaveCount(0);
        await didascalia(page, "Il task è caricato");
        await beat(page, 1600);
      },
    });
  });

  test("LOAD-ERROR-02: l'azione passa, la rilettura no → avviso di riga vecchia col Riprova", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-08" });
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    // Drawer loaded against a HEALTHY app: no route yet.
    await page.goto("/");
    await openProjectBoard(page);
    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();
    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-brief-scroll")).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByTestId("task-stale-warning")).toHaveCount(0);

    const chip = drawer.getByTestId("task-priority-chip");
    const primaDelClick = (await chip.textContent())?.trim() ?? "";
    expect(primaDelClick, "il chip mostra un valore").not.toBe("");

    // NOW only the GET falls: the priority PATCH lands, the `load()` behind
    // it does not.
    await page.route(DETAIL, abortOnlyTheGet);
    await chip.click();
    // The menu items follow `PRIORITY_ORDER` = [4,3,2,1,0]; the selected one
    // is 2 (Medium). We pick the one ABOVE (3): a different value, without
    // writing a single menu word into the test.
    const options = page.getByRole("listbox").getByRole("option");
    await expect(options).toHaveCount(5);
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await options.nth(1).click();

    // The warning: the action landed, the refresh did not. With its Retry,
    // and the chip still on the previous value, which is exactly the stale
    // row.
    const warning = drawer.getByTestId("task-stale-warning");
    await expect(warning).toBeVisible({ timeout: 10000 });
    await expect(warning.getByTestId("task-stale-retry")).toBeVisible();
    await expect(chip).toHaveText(primaDelClick);

    // ON THE SERVER it really landed: not paint on the client.
    expect((await readTask(request, taskId)).priority, "la PATCH è arrivata").toBe(3);

    // The server comes back: Retry re-reads, the warning disappears, the new
    // value is on screen (the chip changes text; the row is no longer the
    // stale one).
    await page.unroute(DETAIL, abortOnlyTheGet);
    await warning.getByTestId("task-stale-retry").click();
    await expect(drawer.getByTestId("task-stale-warning")).toHaveCount(0, { timeout: 10000 });
    await expect(chip).not.toHaveText(primaDelClick);
    // And the menu, reopened, has the selection on the item that was clicked.
    await chip.click();
    await expect(page.getByRole("listbox").getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
  });
});

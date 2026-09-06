/**
 * board-blocked-chip.spec.ts — «aspetta: …» shows up even when the blocker is   allow-italian: quoted UI string
 * not in the board's list.
 *
 * The case that used to break: the card drew the chip by hunting for the
 * blocker among the fetched tasks — one project, `rootsOnly`, not archived. A
 * blocker outside that cut (here: a SUBTASK, which by contract is never a card)
 * was not found, the chip disappeared, and the card looked free to start while
 * the dispatcher was holding it still. The blocker is now resolved by the
 * server (`task.blockedBy`) and the chip is born from the LINK.
 *
 * It is also the delivery clip: card → drawer → picker → the blocker closes and
 * the chip goes out. A behaviour, not a screenshot.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { canonicalTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = canonicalTmpDir("e2e-blocked");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare la scheda prodotto";
const STEP = "Migrare le foto sul nuovo bucket";
const DIPENDENTE = "Pubblicare la scheda nuova";
// A SHORT card, on purpose: the shorter it is, the closer its geometric centre
// gets to whatever sits at the bottom of the body.
const SHORT_BLOCKER = "Chiudere il contratto";
const SHORT_BLOCKED = "Spedire l'ordine";

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
  const btn = projectRow(page, /e2e-blocked/);
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

/** A pause that serves ONLY the delivery clip (E2E_EVIDENCE=1). Zero on a normal suite. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Chip «aspetta: …» · bloccante fuori dalla lista", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-blocked" }, null, 2));
    const topic = await createTopic(request, "E2E-Blocked", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // In REVERSE order: the child before the parent, the blocked before the blocker.
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("il chip c'è anche se il bloccante è un sottotask, e si spegne quando chiude", async ({ page, request }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-26" });
    // An epic with a step of its own: the step is NEVER a card (the board
    // fetches rootsOnly), so the client does not hold it. That is the case that
    // used to break.
    const epica = await createTask(request, { text: EPICA, status: "in_progress" });
    const step = await createTask(request, { text: STEP, parentTaskId: epica.id });
    const dipendente = await createTask(request, { text: DIPENDENTE, status: "todo", blockedByTaskId: step.id });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${dipendente.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    // The board carries TWO cards (the epic and the dependent one): the blocker
    // is not among the fetched tasks, and yet the chip names it — i.e. it does
    // not come from there.
    await expect(page.locator("[data-task-card]")).toHaveCount(2);
    await expect(card.getByTestId("card-blocked-by")).toContainText(`aspetta: ${STEP}`);
    await beat(page, 2200);

    // In the drawer the chip sits IN LINE, not buried in the ⋯ menu, and it
    // opens the picker.
    //
    // What gets clicked is the TITLE, and it stays that way because this test
    // is about the chip: the centre of a blocked card has a test of its own,
    // the second one in this file, and that is where it is measured.
    await card.getByText(DIPENDENTE).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    const chip = drawer.getByTestId("task-blocked-by-chip");
    await expect(chip).toContainText(`aspetta: ${STEP}`);
    await beat(page, 2000);
    await chip.click();
    await expect(page.getByTestId("task-blocker-picker")).toBeVisible({ timeout: 5000 });
    await beat(page, 2000);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5000 });

    // The step closes: the blocker no longer blocks and the chip goes out on its
    // own (the same predicate as the dispatch gate, which now starts the task).
    const done = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${step.id}`, {
      data: { status: "done" },
    });
    expect(done.ok()).toBe(true);
    await expect(card.getByTestId("card-blocked-by")).toHaveCount(0, { timeout: 10000 });
    await beat(page, 2200);
  });

  /**
   * THE CENTRE OF A BLOCKED CARD OPENS THE CARD.
   *
   * The two ways out of the wait used to be a row of buttons in the card's
   * body, inside a container that stops propagation, and they were the LAST
   * thing on the card: on a short card that row IS the centre, so clicking the
   * card in the middle did not open the drawer, it pressed «sblocca» and sent a   allow-italian: quoted UI string
   * PATCH that changed the dispatch gate with no confirmation. The test above
   * had to dodge it by clicking the title.
   *
   * The choices now live in the compact ⋯ key at the end of the chip row, so
   * the target is small and off the centre. What is measured is both halves of
   * the fact: the drawer opens, and NOTHING is written on the tasks.
   */
  test("il centro di una card bloccata apre la scheda e non scrive niente", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-26" });
    const blocker = await createTask(request, { text: SHORT_BLOCKER, status: "todo" });
    const blocked = await createTask(request, {
      text: SHORT_BLOCKED, status: "todo", blockedByTaskId: blocker.id,
    });

    // Every write on the tasks, whoever sends it: a GET is the board reading
    // itself, anything else is a gesture, and this gesture must have none.
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && /\/api\/boards\/[^/]+\/tasks/.test(r.url())) {
        writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
      }
    });

    await page.goto("/");
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${blocked.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByTestId("card-blocked-by")).toContainText(`aspetta: ${SHORT_BLOCKER}`);
    // The shape of the fix: no row of buttons on the card, one compact key.
    await expect(card.getByTestId("task-choices")).toHaveCount(0);
    await expect(card.getByTestId("task-choices-menu")).toBeVisible();
    await beat(page, 1600);

    // `card.click()` with no position: Playwright lands on the geometric
    // centre. That is the whole point of the test.
    await card.click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    expect(writes, `il click ha scritto sui task: ${writes.join(", ")}`).toEqual([]);
    // Still blocked after the click: the chip is the state, not the drawing.
    await expect(drawer.getByTestId("task-blocked-by-chip")).toContainText(`aspetta: ${SHORT_BLOCKER}`);
    // For extenso the row is still there, in the drawer: nothing was lost, it
    // moved to the surface you reach on purpose.
    await expect(drawer.getByTestId("task-choice-unblock")).toBeVisible();
    await beat(page, 2000);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5000 });
  });
});

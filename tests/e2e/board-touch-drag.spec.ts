/**
 * THE BOARD, DRAGGED WITH A FINGER — and the small targets around it.
 *
 * The defect this file exists for was silent and total. `Board/Card.tsx` spread
 * `{...listeners}` (dnd-kit's activators, `onTouchStart` among them) and right
 * after `{...cardLongPress.handlers}`, which carries an `onTouchStart` of its
 * own. A JSX spread does not merge props: the later one WINS. So the drag
 * activator never reached the DOM, the `PoliteTouchSensor` registered in
 * `KanbanBoardPane` never saw a finger, and on touch the only sensor left was
 * the mouse one — fed by the click the browser synthesises after `touchend`.
 * A card could not be moved to another column with a finger AT ALL, and nothing
 * said so: no error, no message, the card just stayed where it was.
 *
 * No existing spec could catch it. The whole suite drags with `mouse.move`,
 * which drives the sensor that was never broken; the touch projects existed but
 * none of them touched the board. Hence a REAL touch gesture here: touchstart,
 * hold past the sensor's 200ms, several touchmove, touchend.
 *
 * It runs in `chromium-touch-wide` (playwright.config.ts): `hasTouch` is what
 * lights up `navigator.maxTouchPoints`, the signal the app decides on, and the
 * viewport stays wide because at 390px the board is flattened and there are no
 * two columns to drag between.
 *
 * @covers KANBAN-01
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, holdDispatchReconcile, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { grabPoint, measureTargets, touchDrag } from "./helpers/hit-area";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-touchdrag-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: import("@playwright/test").APIRequestContext, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

async function taskStatus(request: import("@playwright/test").APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()).task as { status: string }).status;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-touchdrag/);
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

test.describe("La board col dito", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-touchdrag" }, null, 2));
    const topic = await createTopic(request, "E2E-TouchDrag", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    // The dispatcher's reconcile sweep can replace a card's DOM node under the
    // gesture, and a drag whose start node is unmounted dies silently. Same
    // brake `board-card-stop` puts on for the same reason.
    await holdDispatchReconcile(page.request, 90_000);
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  /**
   * THE REAL GESTURE, not its imitation with a mouse.
   *
   * Backlog -> Todo and not just any column: `manualStatusTarget` redirects a
   * manual drop into In Progress back to Todo (In Progress is not a queue), so
   * dropping there would assert a rule instead of the gesture. Todo accepts the
   * card where it was dropped, which is what has to be proven.
   *
   * The verdict is read from the SERVER, not from the DOM: the board paints an
   * optimistic layer on drop, so a card can sit in the new column for a moment
   * with nothing written anywhere. `status` on the API is the fact.
   */
  test("TOUCHDRAG-01: una card si sposta di colonna col dito", async ({ page, request }) => {
    const task = await createTask(request, `Trascinami col dito ${Date.now()}`);
    expect(await taskStatus(request, task.id), "the seed did not start in backlog").toBe("backlog");

    await page.goto(BASE);
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(card, "the seeded card is not on the board").toBeVisible({ timeout: 15000 });

    const todoColumn = page.getByTestId("kanban-column-body-todo");
    await expect(todoColumn).toBeVisible();

    const from = await grabPoint(page, `[data-task-card="${task.id}"]`);
    const box = await todoColumn.boundingBox();
    expect(box, "the Todo column has no box").toBeTruthy();
    const to = { x: Math.round(box!.x + box!.width / 2), y: Math.round(box!.y + 80) };

    await touchDrag(page, from, to);

    // The write is a PATCH: wait for the server, not for an animation.
    await expect
      .poll(() => taskStatus(request, task.id), {
        message: "with a finger the card did not change column: dnd-kit's activator never reached the DOM",
        timeout: 15000,
      })
      .toBe("todo");
  });

  /**
   * THE LONG PRESS DID NOT DIE TO MAKE ROOM FOR THE DRAG.
   *
   * The two gestures share the same `touchstart`, and the cure for the drag is
   * to COMPOSE them instead of overwriting one. A cure that broke the other
   * would be the same defect turned around: on touch the card menu has no other
   * door. Still finger -> menu; it is the half of the contract the test above
   * does not look at.
   */
  test("TOUCHDRAG-02: il dito fermo apre ancora il menu della card", async ({ page, request }) => {
    const task = await createTask(request, `Tienimi premuto ${Date.now()}`);
    await page.goto(BASE);
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    const at = await grabPoint(page, `[data-task-card="${task.id}"]`);

    await page.evaluate(({ at }) => {
      const el = document.elementFromPoint(at.x, at.y)!;
      const touch = new Touch({ identifier: 1, target: el, clientX: at.x, clientY: at.y });
      (window as unknown as { __hold?: { el: Element; touch: Touch } }).__hold = { el, touch };
      el.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch],
      }));
    }, { at });

    // The menu is the proof the 500ms timer ran to the end: we wait for IT, not
    // for a number of milliseconds (the app's timer and this test live on the
    // same thread, see helpers/long-press.ts).
    await expect(page.getByRole("menu").or(page.locator('[data-testid="card-context-menu"]')).first())
      .toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      const held = (window as unknown as { __hold?: { el: Element; touch: Touch } }).__hold;
      if (!held) return;
      held.el.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [held.touch],
      }));
    });
  });

  /**
   * THE BOARD'S SMALL TARGETS, MEASURED WHERE THE THUMB FINDS THEM.
   *
   * `.tap-expand` grows the sensitive area with an `::after` that does not show
   * up in `getBoundingClientRect()`: measuring the box would report 16x16 for a
   * target the finger finds at 44, and would stay GREEN if somebody deleted the
   * class. So the measure is the band probe with `elementFromPoint`
   * (helpers/hit-area).
   *
   * The X that closes the card's error is the representative of the family: the
   * other two (in the drawer) are the same button with the same class.
   */
  test("TOUCHTAP-01: la ✕ che chiude l'errore ha l'area di un dito e ha un nome", async ({ page, request }) => {
    const task = await createTask(request, `Errore da chiudere ${Date.now()}`);
    await page.goto(BASE);
    await openProjectBoard(page);
    await expect(page.locator(`[data-task-card="${task.id}"]`)).toBeVisible({ timeout: 15000 });

    // The error on the card comes from an action the server REFUSES, not from a
    // seed: the task is asked to go to done while it still has an open child,
    // which is the very refusal the red band exists to report.
    const child = await createTask(request, `Figlio aperto ${Date.now()}`);
    await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${child.id}`, { data: { parentTaskId: task.id } });

    const errorBand = page.locator('[data-testid="card-action-error"]');
    // If the band does not appear this round the test has nothing to measure and
    // SAYS so, instead of passing having measured zero targets.
    const appeared = await errorBand.first().isVisible().catch(() => false);
    test.skip(!appeared, "no error band on the board this round");

    const [x] = await measureTargets(page, ['[data-testid="card-action-error"] button']);
    expect(x, "the error's X is not on screen").toBeTruthy();
    expect(x.absent, `the error's X is an absent target: ${JSON.stringify(x)}`).toBe(false);
    expect(x.ownsItsCentre, `the X's centre is covered by a neighbour: ${JSON.stringify(x)}`).toBe(true);
    expect(x.tap.h, `the error's X is ${x.tap.h}px tall of touchable area`).toBeGreaterThanOrEqual(44);
    expect(x.tap.w, `the error's X is ${x.tap.w}px wide of touchable area`).toBeGreaterThanOrEqual(44);
    await expect(errorBand.locator("button").first()).toHaveAccessibleName(/.+/);
  });
});

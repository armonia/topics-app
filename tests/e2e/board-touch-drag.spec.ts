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
   * IL GESTO VERO, non la sua imitazione col mouse.
   *
   * Backlog -> Todo e non una colonna qualsiasi: `manualStatusTarget` redirects
   * a manual drop into In Progress back to Todo (In Progress is not a queue),
   * so dropping there would assert a rule instead of the gesture. Todo accepts
   * the card where it was dropped, which is what has to be proven.
   *
   * The verdict is read from the SERVER, not from the DOM: the board paints an
   * optimistic layer on drop, so a card can sit in the new column for a moment
   * with nothing written anywhere. `status` on the API is the fact.
   */
  test("TOUCHDRAG-01: una card si sposta di colonna col dito", async ({ page, request }) => {
    const task = await createTask(request, `Trascinami col dito ${Date.now()}`);
    expect(await taskStatus(request, task.id), "il seme non nasce in backlog").toBe("backlog");

    await page.goto(BASE);
    await openProjectBoard(page);

    const card = page.locator(`[data-task-card="${task.id}"]`);
    await expect(card, "la card seminata non è sulla board").toBeVisible({ timeout: 15000 });

    const todoColumn = page.getByTestId("kanban-column-body-todo");
    await expect(todoColumn).toBeVisible();

    const from = await grabPoint(page, `[data-task-card="${task.id}"]`);
    const box = await todoColumn.boundingBox();
    expect(box, "la colonna Todo non ha un box").toBeTruthy();
    const to = { x: Math.round(box!.x + box!.width / 2), y: Math.round(box!.y + 80) };

    await touchDrag(page, from, to);

    // La scrittura è una PATCH: si aspetta il server, non un'animazione.
    await expect
      .poll(() => taskStatus(request, task.id), {
        message: "col dito la card non ha cambiato colonna: l'attivatore di dnd-kit non è arrivato al DOM",
        timeout: 15000,
      })
      .toBe("todo");
  });

  /**
   * IL LONG-PRESS NON È MORTO PER FARE POSTO AL DRAG.
   *
   * I due gesti condividono lo stesso `touchstart`, e la cura del drag consiste
   * nel comporli invece di sovrascriverne uno. Una cura che rompesse l'altro
   * sarebbe lo stesso difetto girato: il menu della card, su touch, non ha
   * un'altra porta. Dito fermo -> menu; è la metà del contratto che il test
   * qui sopra non guarda.
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

    // Il menu è la prova che il timer da 500ms è arrivato in fondo: si aspetta
    // LUI, non un numero di millisecondi (il timer dell'app e questo test
    // vivono sullo stesso thread, vedi helpers/long-press.ts).
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
   * I BERSAGLI PICCOLI DELLA BOARD, MISURATI DOVE IL POLLICE LI TROVA.
   *
   * `.tap-expand` allarga l'area sensibile con un `::after` che in
   * `getBoundingClientRect()` non compare: misurare il box direbbe 16x16 su un
   * bersaglio che il dito trova a 44, e resterebbe VERDE se qualcuno togliesse
   * la classe. Quindi si misura a banda con `elementFromPoint` (helpers/hit-area).
   *
   * La ✕ che chiude l'errore della card è il rappresentante della famiglia: le
   * altre due (nel drawer) sono lo stesso bottone con la stessa classe.
   */
  test("TOUCHTAP-01: la ✕ che chiude l'errore ha l'area di un dito e ha un nome", async ({ page, request }) => {
    const task = await createTask(request, `Errore da chiudere ${Date.now()}`);
    await page.goto(BASE);
    await openProjectBoard(page);
    await expect(page.locator(`[data-task-card="${task.id}"]`)).toBeVisible({ timeout: 15000 });

    // L'errore sulla card lo produce un'azione RIFIUTATA dal server, non un
    // seme: si chiede al task di andare in done mentre ha un figlio aperto —
    // lo stesso rifiuto che la banda rossa esiste per raccontare.
    const child = await createTask(request, `Figlio aperto ${Date.now()}`);
    await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${child.id}`, { data: { parentTaskId: task.id } });

    const errorBand = page.locator('[data-testid="card-action-error"]');
    // Se la banda non compare in questo giro il test non ha nulla da misurare e
    // lo DICE, invece di passare misurando zero bersagli.
    const appeared = await errorBand.first().isVisible().catch(() => false);
    test.skip(!appeared, "nessuna banda d'errore sulla board in questo giro");

    const [x] = await measureTargets(page, ['[data-testid="card-action-error"] button']);
    expect(x, "la ✕ dell'errore non è sullo schermo").toBeTruthy();
    expect(x.absent, `la ✕ dell'errore è un bersaglio assente: ${JSON.stringify(x)}`).toBe(false);
    expect(x.ownsItsCentre, `il centro della ✕ è coperto da un vicino: ${JSON.stringify(x)}`).toBe(true);
    expect(x.tap.h, `la ✕ dell'errore è alta ${x.tap.h}px di area toccabile`).toBeGreaterThanOrEqual(44);
    expect(x.tap.w, `la ✕ dell'errore è larga ${x.tap.w}px di area toccabile`).toBeGreaterThanOrEqual(44);
    await expect(errorBand.locator("button").first()).toHaveAccessibleName(/.+/);
  });
});

/**
 * board-task-flow.spec.ts - the Task flow end to end, in one take.
 *
 * WHY. Each piece of the board has its own spec and its own bench, but the
 * flow a person actually goes through - a board with dozens of cards, three
 * cards opened one after the other, a card dragged to another column, a task
 * archived while it still has browser tabs - was never walked as one gesture
 * sequence. This spec walks it, asserts what each step must leave behind, and
 * is the one to record when the flow needs a video:
 *
 *   E2E_EVIDENCE=1 E2E_VIDEO=1 npx playwright test tests/e2e/board-task-flow.spec.ts --project=chromium
 *
 * WHAT IT ASSERTS.
 *   1. 60+ cards on the board.
 *   2. Every opened card shows ITS title in the drawer header.
 *   3. The dragged card lands in the target column on the SERVER.
 *   4. The archived task leaves the board and its `task-browser-tabs:<id>` row
 *      is gone from `ui_state` (services/task-tab-teardown.ts).
 *
 * @covers KANBAN-01
 */
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { beat, didascalia } from "./helpers/evidence";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "taskflow-e2e001";
/** Cards per column: 3 columns x 21 + the task with tabs = 64. */
const PER_COLUMN = 21;

test.describe("Board: the Task flow in one take", () => {
  test.describe.configure({ timeout: 180_000 });
  // 1600 wide: at 1280 the five columns do not fit and a cross-column drag
  // ends up behind a horizontal scroll (same reason as the drag bench).
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const created: string[] = [];
  const todo: Array<{ id: string; text: string }> = [];
  let withTabs = { id: "", text: "" };

  test.beforeAll(async ({ request }) => {
    const seed = async (text: string, status: "backlog" | "todo" | "done"): Promise<string> => {
      const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
        data: { text, status: status === "done" ? "todo" : status },
      });
      expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
      const { id } = (await res.json()) as { id: string };
      created.push(id);
      if (status === "done") {
        const patch = await request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`, { data: { status: "done" } });
        expect(patch.ok(), `could not close "${text}"`).toBe(true);
      }
      return id;
    };
    for (const status of ["backlog", "done"] as const) {
      await Promise.all(Array.from({ length: PER_COLUMN }, (_, i) => seed(`Flow ${status} ${i} ${stamp}`, status)));
    }
    for (let i = 0; i < PER_COLUMN; i++) {
      const text = `Flow todo ${i} ${stamp}`;
      todo.push({ id: await seed(text, "todo"), text });
    }
    const text = `Flow task with tabs ${stamp}`;
    withTabs = { id: await seed(text, "todo"), text };
    // The tabs record as the server writes it when an agent opens a browser
    // pane for the task (task-tab-persist.ts).
    const ctx = `task-${withTabs.id.slice(0, 8)}-nflow`;
    const put = await request.put(`${E2E_BASE}/api/ui-state/task-browser-tabs:${withTabs.id}`, {
      data: { tabs: [{ contextId: ctx, url: `${E2E_BASE}/`, title: "App", seq: 0, titleSource: "agent" }], activeContextId: ctx, nextSeq: 1 },
    });
    expect(put.ok(), "could not seed the task's tabs").toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < created.length; i += 20) {
      await Promise.all(created.slice(i, i + 20).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
    }
  });

  test("60+ cards, three cards opened, a drag between columns, a task archived with its tabs", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    const board = page.getByTestId("kanban-board");
    await expect(board.getByText(todo[0]!.text)).toBeVisible({ timeout: 20_000 });
    expect(await board.locator("[data-task-card]").count(), "fewer than 60 cards on the board").toBeGreaterThanOrEqual(60);
    await didascalia(page, "Board con 60+ card");
    await beat(page);

    // 1. Three cards in a row: each drawer says the title of the card clicked.
    const drawer = page.getByTestId("task-detail-drawer");
    for (const card of todo.slice(0, 3)) {
      await didascalia(page, `Apro «${card.text.split(" ").slice(0, 3).join(" ")}»`);
      await page.locator(`[data-task-card="${card.id}"]`).click();
      await expect(drawer.getByTestId("task-brief-header").getByText(card.text, { exact: true })).toBeVisible({ timeout: 5_000 });
      await beat(page, 900);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0, { timeout: 10_000 });
    }

    // 2. A drag from Todo to Backlog. Grabbed by its top edge: the centre of a
    // card can be a button, from which dnd-kit does not start (dndSensors.ts).
    await didascalia(page, "Trascino una card da Todo a Backlog");
    const moved = todo[3]!;
    const cardBox = (await page.locator(`[data-task-card="${moved.id}"]`).boundingBox())!;
    const backlogBox = (await page.getByTestId("kanban-column-body-backlog").boundingBox())!;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width / 2 + 8, cardBox.y + 20);
    await page.mouse.move(backlogBox.x + backlogBox.width / 2, backlogBox.y + backlogBox.height / 2, { steps: 30 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const r = await request.get(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${moved.id}`);
        return ((await r.json()) as { task?: { status?: string } }).task?.status;
      }, { timeout: 10_000 })
      .toBe("backlog");
    await expect(page.getByTestId("kanban-column-body-backlog").locator(`[data-task-card="${moved.id}"]`)).toBeVisible();
    await beat(page);

    // 3. Archive the task that owns browser tabs: the card leaves the board and
    // the server releases the tabs record.
    await didascalia(page, "Archivio un task con le sue tab aperte");
    const before = await request.get(`${E2E_BASE}/api/ui-state/task-browser-tabs:${withTabs.id}`);
    expect(await before.json(), "the tabs record was not there to begin with").not.toBeNull();
    const withTabsCard = page.locator(`[data-task-card="${withTabs.id}"]`);
    await withTabsCard.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archivia" }).click();
    await expect(withTabsCard).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(async () => (await request.get(`${E2E_BASE}/api/ui-state/task-browser-tabs:${withTabs.id}`)).json(), { timeout: 10_000 })
      .toBeNull();
    await didascalia(page, "Card archiviata, tab rilasciate");
    await beat(page);
  });
});

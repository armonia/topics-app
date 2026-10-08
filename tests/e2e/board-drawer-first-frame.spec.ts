/**
 * board-drawer-first-frame.spec.ts - a card opens with its title already there.
 *
 * WHY. Clicking a card used to open a drawer holding a spinner until
 * `GET /api/boards/:p/tasks/:id` came back with the whole thread, the children
 * and the rest: the title, the one thing that tells you the right card opened,
 * arrived with everything else. The board already HAS the row. On a quiet
 * localhost that read is a few milliseconds; on a busy server, a phone or a
 * tunnel it is the whole wait, and `check:ink` measures exactly this gesture.
 *
 * HOW. The read of the task is held back for three seconds by the test itself
 * (a `page.route` on that one URL), so the drawer is provably still waiting
 * for it: the title must be readable inside that window, next to the spinner,
 * and the real row must replace the board's copy when the read lands.
 *
 * @covers KANBAN-01
 */
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "drawerfirst-e2e001";
/** How long the task read is held back. */
const HELD_MS = 3_000;

test.describe("Board drawer: the title is on the first frame", () => {
  test.describe.configure({ timeout: 60_000 });

  const stamp = Date.now();
  let taskId = "";
  const title = `Drawer first frame ${stamp}`;

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text: title, status: "todo" } });
    expect(res.ok(), "the board API refused to seed the card").toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, BOARD_ID, taskId).catch(() => {});
  });

  test("the drawer shows the card's title while the task read is still in flight", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await resetPaneStore(page.request, ["__board__"]);
    let held = 0;
    await page.route(`**/api/boards/${BOARD_ID}/tasks/${taskId}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      held++;
      await new Promise((r) => setTimeout(r, HELD_MS));
      await route.continue();
    });

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    const board = page.getByTestId("kanban-board");
    await expect(board.getByText(title)).toBeVisible({ timeout: 20_000 });

    await page.locator(`[data-task-card="${taskId}"]`).click();
    const drawer = page.getByTestId("task-detail-drawer");
    const header = drawer.getByTestId("task-brief-header");
    // Well inside the held read: the title comes from the board's own row.
    await expect(header.getByText(title, { exact: true })).toBeVisible({ timeout: 1_000 });
    expect(held, "the task read was not the one being held").toBe(1);
    // The read is still pending: the thread area keeps its spinner.
    await expect(drawer.getByTestId("task-conversation-toggle")).toHaveCount(0);

    // When the read lands the drawer is the real one, same title, no jump.
    await expect(drawer.getByTestId("task-conversation-toggle")).toBeVisible({ timeout: HELD_MS + 5_000 });
    await expect(header.getByText(title, { exact: true })).toBeVisible();
  });
});

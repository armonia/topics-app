/**
 * board-card-updated-ago.spec.ts - the «Nm fa» of a quiet card on a busy board.
 *
 * WHY. Every card closes its foot row with `fmtUpdatedAt(task.updatedAt)`
 * («ora», «3m fa», «2h fa»), computed from `Date.now()` during render, and the
 * card has no clock of its own. Before `cloud-quality-pass` T2 a `task:updated`
 * frame of ANY card re-rendered EVERY card (a new `SortableContext` value), so
 * on a board with an agent at work the label of the quiet cards moved forward
 * with the frames. After T2 a card renders only when its own props change: the
 * label of a quiet card stays at whatever it said when it last rendered, on a
 * board that keeps receiving frames.
 *
 * WHAT IT DOES. Two backlog cards, both «ora». The page clock jumps three
 * minutes ahead (`page.clock.setSystemTime`: no timer fires, only `Date.now()`
 * moves), then the OTHER card gets a frame. The quiet card must say «Nm fa».
 *
 * Found by the independent check V2 of `cloud-quality-pass`: green with the
 * bundle before T2, red after it (`TOPICS_E2E_BUNDLE_DIR`).
 *
 * @covers KANBAN-01
 */
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "updatedago-e2e001";

test.describe("Board: a quiet card's «Nm fa» on a board that gets frames", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const created: string[] = [];

  test.afterAll(async ({ request }) => {
    await Promise.all(created.map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
  });

  test("a frame of another card leaves the quiet card's age up to date", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    const seed = async (text: string): Promise<string> => {
      const res = await page.request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text, status: "backlog" } });
      expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
      const { id } = (await res.json()) as { id: string };
      created.push(id);
      return id;
    };
    const quiet = await seed(`Ago quiet ${stamp}`);
    const busy = await seed(`Ago busy ${stamp}`);

    // Installed before the app loads, so `Date.now()` in the page is the
    // clock's; it keeps flowing in real time until `setSystemTime` moves it.
    await page.clock.install({ time: Date.now() });
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();

    const age = page.locator(`[data-task-card="${quiet}"] span[title^="Ultimo aggiornamento"]`);
    await expect(age).toHaveText("ora", { timeout: 20_000 });

    await page.clock.setSystemTime(Date.now() + 3 * 60_000);
    // The jump alone wakes nobody: the label is still the one of the last render.
    await expect(age).toHaveText("ora");

    // The board gets a frame, for the OTHER card.
    const res = await page.request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${busy}`, { data: { text: `Ago busy ${stamp} v2` } });
    expect(res.ok()).toBe(true);
    await expect(page.locator(`[data-task-card="${busy}"]`).getByText(`Ago busy ${stamp} v2`, { exact: true })).toBeVisible({ timeout: 10_000 });

    await expect(age, "the quiet card still says how old it was at its last render").toHaveText(/^\d+m fa$/, { timeout: 5_000 });
  });
});

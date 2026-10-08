/**
 * board-card-updated-ago.spec.ts - the «Nm fa» of a quiet card moves on by itself.
 *
 * WHY. Every card closes its foot row with `fmtUpdatedAt(task.updatedAt)`
 * («ora», «3m fa», «2h fa»). Before `cloud-quality-pass` T2 the label moved
 * forward only by accident: a `task:updated` frame of ANY card re-rendered
 * EVERY card, so on a board with an agent at work the quiet cards were redrawn
 * with the frames. After T2 a card renders only when its own props change, and
 * a quiet card kept saying «ora» for good (defect D1 of the check V2). The
 * label now reads a shared minute clock (`lib/minuteClock.ts`): it moves on
 * when time passes, with or without frames.
 *
 * WHAT IT DOES. The page clock is installed before the app loads, so the
 * app's timers are the clock's. Three minutes pass WITH the timers firing
 * (`page.clock.fastForward`), and the quiet card must say «3m fa»: once on a
 * board that gets no frame at all, once on a board where the OTHER card gets
 * a frame every minute. Without the clock subscription both are red: nothing
 * redraws the quiet card and it stays at «ora».
 *
 * The page clock runs ahead of the server's: a card the server touches now
 * looks minutes old to the page. Only the quiet card's age is asserted.
 *
 * @covers KANBAN-01
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "updatedago-e2e001";
const MINUTE = 60_000;

test.describe("Board: a quiet card's «Nm fa» moves on with time", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const created: string[] = [];

  test.afterAll(async ({ request }) => {
    await Promise.all(created.map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
  });

  /** Seeds a backlog card and returns its id. */
  async function seed(page: Page, text: string): Promise<string> {
    const res = await page.request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text, status: "backlog" } });
    expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
    const { id } = (await res.json()) as { id: string };
    created.push(id);
    return id;
  }

  /** Opens the board with the page clock installed first; returns the quiet card's age label. */
  async function openBoard(page: Page, quiet: string) {
    // Installed before the app loads: `Date.now()` and every timer of the page
    // are the clock's from the first script on.
    await page.clock.install({ time: Date.now() });
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    const age = page.locator(`[data-task-card="${quiet}"] span[title^="Ultimo aggiornamento"]`);
    await expect(age).toHaveText("ora", { timeout: 20_000 });
    return age;
  }

  test("on a board with no frames the quiet card says «3m fa» after three minutes", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    const quiet = await seed(page, `Ago alone ${stamp}`);
    const age = await openBoard(page, quiet);

    await page.clock.fastForward(3 * MINUTE);

    await expect(age, "nothing redrew the quiet card: its age is the one of its first render").toHaveText("3m fa", { timeout: 5_000 });
  });

  test("on a board where another card gets frames the quiet card says «3m fa» after three minutes", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    const quiet = await seed(page, `Ago quiet ${stamp}`);
    const busy = await seed(page, `Ago busy ${stamp}`);
    const age = await openBoard(page, quiet);

    // A minute at a time, and after each one a frame for the OTHER card.
    for (let i = 1; i <= 3; i++) {
      await page.clock.fastForward(MINUTE);
      const text = `Ago busy ${stamp} v${i}`;
      const res = await page.request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${busy}`, { data: { text } });
      expect(res.ok()).toBe(true);
      await expect(page.locator(`[data-task-card="${busy}"]`).getByText(text, { exact: true })).toBeVisible({ timeout: 10_000 });
    }

    await expect(age, "the quiet card still says how old it was at its last render").toHaveText("3m fa", { timeout: 5_000 });
  });
});

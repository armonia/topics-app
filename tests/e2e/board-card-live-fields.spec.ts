/**
 * board-card-live-fields.spec.ts - every field a frame changes reaches the card.
 *
 * WHY. Since `cloud-quality-pass` T2 a `task:updated` frame no longer re-renders
 * every card on the board: `SortableContext` gets the same `items` while the
 * ids hold (`Column`, `idsKey`) and `App` gets the same board while its shape
 * holds (`useGlobalBoard`). A card now renders only when ITS props change. This
 * spec is the independent check (V2) that nothing the card or the drawer shows
 * was being refreshed only by the old render-everything cascade: each test
 * changes one field through the API, the server emits the frame, and the DOM
 * must follow.
 *
 * It must pass with the bundle before T2 and with the bundle after it
 * (`TOPICS_E2E_BUNDLE_DIR`): a field that follows on the first and not on the
 * second is a regression of T2.
 *
 * @covers KANBAN-01
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "livefields-e2e001";

test.describe("Board: a frame's field reaches the card", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const created: string[] = [];

  async function seed(page: Page, text: string): Promise<string> {
    const res = await page.request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
      data: { text, status: "backlog" },
    });
    expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
    const { id } = (await res.json()) as { id: string };
    created.push(id);
    return id;
  }

  async function patch(page: Page, id: string, data: Record<string, unknown>): Promise<void> {
    const res = await page.request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`, { data });
    expect(res.ok(), `PATCH ${JSON.stringify(data)} refused`).toBe(true);
  }

  /** The general board, open and showing `text`. Six neighbours so the column
   *  has cards that must NOT be the ones re-rendered. */
  async function openBoard(page: Page, label: string): Promise<{ target: string; text: string; other: string; otherText: string }> {
    const text = `Live ${label} ${stamp}`;
    const target = await seed(page, text);
    const otherText = `Live ${label} other ${stamp}`;
    const other = await seed(page, otherText);
    for (let i = 0; i < 4; i++) await seed(page, `Live ${label} filler ${i} ${stamp}`);
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    await expect(page.locator(`[data-task-card="${target}"]`).getByText(text, { exact: true })).toBeVisible({ timeout: 20_000 });
    return { target, text, other, otherText };
  }

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < created.length; i += 20) {
      await Promise.all(created.slice(i, i + 20).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
    }
  });

  test("the title of the card follows its frame", async ({ page }) => {
    const { target, text } = await openBoard(page, "title");
    await patch(page, target, { text: `${text} renamed` });
    await expect(page.locator(`[data-task-card="${target}"]`).getByText(`${text} renamed`, { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("the priority badge follows its frame", async ({ page }) => {
    const { target } = await openBoard(page, "priority");
    await patch(page, target, { priority: 3 });
    await expect(page.locator(`[data-task-card="${target}"]`).getByText("Alta", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("the blocked-by chip follows its frame", async ({ page }) => {
    const { target, other, otherText } = await openBoard(page, "blocked");
    await patch(page, target, { blockedByTaskId: other });
    await expect(page.locator(`[data-task-card="${target}"]`).getByText(`aspetta: ${otherText}`)).toBeVisible({ timeout: 10_000 });
  });

  test("the subtask checklist follows a new subtask", async ({ page }) => {
    const { target } = await openBoard(page, "subtasks");
    const res = await page.request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
      data: { text: `Live subtask ${stamp}`, status: "backlog", parentTaskId: target },
    });
    expect(res.ok()).toBe(true);
    created.push(((await res.json()) as { id: string }).id);
    // With the children fetched the card draws them as a checklist; the
    // compact «↳ done/total» chip is only the fallback before they arrive.
    await expect(page.locator(`[data-task-card="${target}"]`).getByText(`Live subtask ${stamp}`, { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("a status change moves the card and the column counts follow", async ({ page }) => {
    const { target } = await openBoard(page, "status");
    const backlogBefore = Number(await page.getByTestId("kanban-column-count-backlog").textContent());
    await patch(page, target, { status: "done" });
    await expect(page.getByTestId("kanban-column-body-done").locator(`[data-task-card="${target}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("kanban-column-count-backlog")).toHaveText(String(backlogBefore - 1));
  });

  test("the open drawer follows a frame of its own card", async ({ page }) => {
    const { target, text } = await openBoard(page, "drawer");
    await page.locator(`[data-task-card="${target}"]`).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await patch(page, target, { text: `${text} renamed`, priority: 4 });
    await expect(drawer.getByText(`${text} renamed`, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-task-card="${target}"]`).getByText("Urgente", { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});

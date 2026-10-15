/** @covers KANBAN-01 */
import { expect, type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { compareTasks } from "../../client/src/lib/boardOrder";

hermetic(test);

const TASK_COUNT = 320;
const PROJECT_PATH = canonicalTmpDir("e2e-board-virtual-drag");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

type TaskRow = { id: string; status: string; kanbanOrder: number; createdAt: string; updatedAt: string; completedAt?: string };

test.describe("Board: drag across the virtual window", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ viewport: { width: 1600, height: 900 } });

  const created: string[] = [];
  const stamp = Date.now();
  let topicId: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board-virtual-drag" }));
    const topic = await createTopic(request, `Virtual drag ${stamp}`, { projectPath: PROJECT_PATH });
    topicId = topic.id;
    for (let start = 0; start < TASK_COUNT; start += 20) {
      const batch = await Promise.all(Array.from({ length: Math.min(20, TASK_COUNT - start) }, async (_, offset) => {
        const index = start + offset;
        const response = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
          data: { text: `Virtual drag ${stamp} ${index}`, status: "backlog" },
        });
        expect(response.ok(), `could not seed backlog task ${index}`).toBe(true);
        const task = (await response.json()) as { id: string };
        return task.id;
      }));
      created.push(...batch);
    }
  });

  test.afterAll(async ({ request }) => {
    for (let start = 0; start < created.length; start += 20) {
      await Promise.all(created.slice(start, start + 20).map((id) => deleteTask(request, PROJECT_ID, id).catch(() => {})));
    }
    if (topicId) await deleteTopic(request, topicId);
    removeTmpDir(PROJECT_PATH);
  });

  async function openProjectBoard(page: Page) {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
    await page.goto("/");
    const section = page.getByRole("button", { name: /sezione Progetti/ });
    if (await section.count() && await section.getAttribute("aria-expanded") === "false") await section.click();
    await projectRow(page, /e2e-board-virtual-drag/).click();
    const project = page.locator(`[data-testid="project-window"][data-project-path="${PROJECT_PATH}"]`);
    await expect(project).toBeVisible({ timeout: 30_000 });
    await project.getByTestId("pane-add-menu-trigger").click();
    await page.getByTestId("pane-add-menu-kanban").click();
    await expect(project.getByTestId("kanban-board")).toBeVisible({ timeout: 30_000 });
  }

  test("mouse autoscroll and keyboard reorder commit beyond the drawn window", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await openProjectBoard(page);

    const listTasks = async (): Promise<TaskRow[]> => {
      const response = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks?status=backlog`);
      expect(response.ok()).toBe(true);
      // In the column's order, the product's own comparator: the list route does not promise one.
      return ((await response.json()) as { tasks: TaskRow[] }).tasks.sort(compareTasks("board"));
    };
    const backlog = page.getByTestId("kanban-column-body-backlog");
    await expect.poll(async () => (await listTasks()).length, { timeout: 30_000 }).toBe(TASK_COUNT);
    const beforeMouse = await listTasks();
    const mouseSource = beforeMouse[0]!;
    const source = page.locator(`[data-task-card="${mouseSource.id}"]`);
    await expect(source).toBeVisible();
    // The cards drawn when the drag starts: the drop must land past all of them.
    const drawnAtStart = await backlog.locator("[data-task-card]").count();
    const sourceBox = (await source.boundingBox())!;
    const bodyBox = (await backlog.boundingBox())!;
    const grab = { x: sourceBox.x + 30, y: sourceBox.y + 12 };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 10, grab.y + 8);
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height - 8);
    await expect.poll(() => backlog.evaluate((el) => el.scrollTop), { timeout: 30_000 }).toBeGreaterThan(3_000);
    // Back to the middle, where the autoscroll stops, and the card is let go there.
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await listTasks()).findIndex((row) => row.id === mouseSource.id), { timeout: 15_000 }).toBeGreaterThanOrEqual(drawnAtStart);

    const beforeKeyboard = await listTasks();
    const keyboardSource = beforeKeyboard[5]!;
    const keyboardTarget = beforeKeyboard[55]!;
    const keyboardCard = page.locator(`[data-task-card="${keyboardSource.id}"]`);
    await keyboardCard.scrollIntoViewIfNeeded();
    await keyboardCard.focus();
    await page.keyboard.press("Space");
    await expect(page.locator("[data-drag-preview]")).toHaveCount(1);
    for (let i = 0; i < 50; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect.poll(async () => {
      const rows = await listTasks();
      return rows.findIndex((row) => row.id === keyboardSource.id) > rows.findIndex((row) => row.id === keyboardTarget.id);
    }, { timeout: 15_000 }).toBe(true);
  });

  test("scrolling up after a jump leaves the cards on screen where the scroll puts them", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await openProjectBoard(page);
    const backlog = page.getByTestId("kanban-column-body-backlog");
    await expect(backlog.locator("[data-task-card]").first()).toBeVisible({ timeout: 30_000 });

    // Distance of a card from the column's top edge; the first card on screen when no id is given.
    const offsetOf = (id?: string) => backlog.evaluate((body, cardId) => {
      const edge = body.getBoundingClientRect().top + body.clientTop;
      for (const card of body.querySelectorAll<HTMLElement>(":scope [data-task-card]")) {
        const top = card.getBoundingClientRect().top;
        if (cardId ? card.dataset.taskCard === cardId : top >= edge) {
          return { id: card.dataset.taskCard ?? "", offset: Math.round(top - edge), height: Math.round(card.getBoundingClientRect().height) };
        }
      }
      return null;
    }, id);
    // Measuring, re-rendering and compensating take a few frames: the same answer twice in a row is rest.
    const atRest = async (id?: string) => {
      let previous = "";
      await expect.poll(async () => {
        const now = JSON.stringify(await offsetOf(id));
        const same = now === previous && now !== "null";
        previous = now;
        return same;
      }, { timeout: 15_000, intervals: [250] }).toBe(true);
      return (await offsetOf(id))!;
    };

    // A jump with the scrollbar lands among cards never measured, laid out at the estimate.
    await backlog.evaluate((body) => { body.scrollTop = Math.round(body.scrollHeight / 2); });
    const anchor = await atRest();
    test.info().annotations.push({ type: "card height", description: `${anchor.height} px, estimate 184` });
    // Going back up draws and measures the cards above: they must not push the anchor.
    await backlog.evaluate((body) => { body.scrollTop -= 400; });
    const after = await atRest(anchor.id);
    // Within 2 px: measured heights are fractional, scroll offsets are not.
    expect(Math.abs(after.offset - (anchor.offset + 400)), "the card on screen moves by the scroll, and by nothing else").toBeLessThanOrEqual(2);
  });
});

/**
 * The per-card auto-merge override ("follow the board" / "yes" / "no") in the
 * task drawer's node menu, next to the existing "Mac only" switch — at a
 * phone width and a desktop one, for the eye (card 9a228f70).
 */
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { deleteTask } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const STAMP = Date.now();
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-auto-merge-intent-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const WIDTHS = [375, 1440] as const;

test.describe("Task drawer: per-card auto-merge intent", () => {
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: `Auto-merge intent ${STAMP}` },
    });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
  });

  for (const width of WIDTHS) {
    test(`the three choices sit next to "Mac only" at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await goToApp(page);
      await page.goto(`/task/${taskId}`);
      await page.getByTestId("task-details-toggle").click();
      await page.getByTestId("task-node-chip").click();
      const stayLocal = page.getByTestId("task-stay-local");
      await expect(stayLocal).toBeVisible();
      const board = page.getByTestId("task-auto-merge-board");
      const yes = page.getByTestId("task-auto-merge-yes");
      const no = page.getByTestId("task-auto-merge-no");
      await expect(board).toBeVisible();
      await expect(yes).toBeVisible();
      await expect(no).toBeVisible();
      // Default: "follow the board" is the one checked.
      await expect(board).toHaveAttribute("aria-checked", "true");
      await expect(yes).toHaveAttribute("aria-checked", "false");
      await page.screenshot({ path: `test-results/task-drawer-auto-merge-intent-${width}.png` });

      await yes.click();
      await expect(yes).toHaveAttribute("aria-checked", "true");
      await expect(board).toHaveAttribute("aria-checked", "false");
    });
  }
});

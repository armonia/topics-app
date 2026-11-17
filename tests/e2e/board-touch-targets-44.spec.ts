/**
 * EVERY BUTTON OF THE BOARD IS A 44px TARGET UNDER A FINGER (card 2501b9b4).
 *
 * Measured at 375 and at 768 with a coarse pointer. `auditSurface` reports for
 * each interactive element the band that answers to the pointer through its
 * centre (`hit`), so a `.tap-expand` target whose glyph is 28px but whose touch
 * area is 44x44 passes, and a box that is really smaller does not.
 *
 * @covers KANBAN-MOBILE-02
 */
import { test, expect, type Page } from "@playwright/test";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";
import { auditSurface } from "./helpers/usability-audit";

hermetic(test);

test.use({ hasTouch: true, isMobile: true });

const STAMP = `tt${Date.now().toString(36)}`;
const PROJECT_ID = projectIdForPath(`${canonicalTmpRoot()}/e2e-board-targets-${STAMP}`);
const MIN_TAP = 44;
const taskIds: string[] = [];

test.beforeAll(async ({ request }) => {
  for (const [text, status] of [[`${STAMP} backlog`, "backlog"], [`${STAMP} todo`, "todo"]]) {
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status, priority: 2, description: "Touch target audit." } });
    expect(res.ok(), await res.text()).toBe(true);
    taskIds.push(((await res.json()) as { id: string }).id);
  }
  await resetPaneStore(request, []);
});

test.afterAll(async ({ request }) => {
  for (const id of taskIds) await deleteTask(request, PROJECT_ID, id).catch(() => {});
  await resetPaneStore(request, []);
});

async function openBoard(page: Page) {
  await page.goto(E2E_BASE);
  const door = page.locator('[data-testid="mobile-chrome-board"]');
  if (await door.isVisible({ timeout: 5000 }).catch(() => false)) await door.tap();
  else await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator("[data-task-card]").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await waitForLayoutSettled(page, '[data-testid="kanban-board"]');
}

test.describe("Board touch targets", () => {
  test.describe.configure({ timeout: 90_000 });

  for (const width of [375, 768]) {
    test(`every button of the board answers to a ${MIN_TAP}x${MIN_TAP} area at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openBoard(page);
      const audit = await auditSurface(page, '[data-testid="kanban-board"]', MIN_TAP);
      expect(audit.coarse, "the audit must run under a coarse pointer").toBe(true);
      // The audit lists only the targets that fall short, so an empty list is the pass.
      const buttons = audit.targets.filter((t) => t.tag === "button");
      const measurable = await page.locator('[data-testid="kanban-board"] button:visible').count();
      expect(measurable, "the board must expose buttons to measure").toBeGreaterThan(0);
      const small = buttons
        .filter((t) => t.hit.w < MIN_TAP || t.hit.h < MIN_TAP)
        .map((t) => `${t.testid ?? t.selector} ${t.hit.w}x${t.hit.h} (box ${t.box.w}x${t.box.h})`);
      expect(small, `buttons under ${MIN_TAP}px at ${width}px`).toEqual([]);
    });
  }
});

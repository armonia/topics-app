/**
 * THE NAMES OF THE TOP ROWS STAY WHOLE: «Automazioni» and «Board» are read in
 * full at every sidebar width the app allows, and what gives way is the tail.
 *
 * The report: with projects open in the sidebar the row read «Auto…», because
 * the tail «4 da sistemare» kept its full width and the name was the only
 * shrinkable piece. Measured in production at 180px: 45px for a name that needs
 * 77. The rule this spec pins: the tail shortens first (the count alone, with
 * the full sentence in its title and aria-label), then goes, and the name never
 * truncates.
 *
 * The scene is the worst realistic one: the fake hub with four automations to
 * fix, a board with work in every column, and two projects open in the list,
 * whose rows bring the scrollbar that eats a few more pixels.
 *
 * Mutation: put `truncate` back on the automations name and drop the short
 * tail, and the 180px case goes red on «name overflows».
 *
 * @covers LAYOUT-01
 */
import { expect, test, type Page } from "@playwright/test";
import { realpathSync } from "node:fs";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const BOARD_PATH = `${realpathSync("/tmp")}/e2e-sidebar-names-${Date.now().toString(36)}`;
const BOARD_ID = boardIdForPath(BOARD_PATH);

async function openAt(page: Page, width: number): Promise<void> {
  await page.addInitScript((w: number) => {
    const raw = localStorage.getItem("app-settings");
    const cur: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    cur.sidebarWidth = w;
    cur.sidebarCollapsed = false;
    localStorage.setItem("app-settings", JSON.stringify(cur));
  }, width);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
}

/** The name box of a row: does it hold its text, and is it inside the row. */
async function readName(page: Page, rowId: string, nameSelector: string) {
  return page.evaluate(([rowSel, nameSel]) => {
    const row = document.querySelector(rowSel) as HTMLElement | null;
    const name = row?.querySelector(nameSel) as HTMLElement | null;
    if (!row || !name) return null;
    const r = row.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    return {
      text: name.textContent,
      scrollWidth: name.scrollWidth,
      clientWidth: name.clientWidth,
      outside: Math.round(n.right - r.right),
    };
  }, [`[data-testid="${rowId}"]`, nameSelector] as const);
}

test.describe("sidebar utility names", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-sidebar-names-${Date.now().toString(36)}`);
    hub = await startFakeHub(undefined, { automations: true });
    await expect.poll(async () => {
      const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown }>;
      return snap.automations?.data !== undefined;
    }, { timeout: 30_000 }).toBe(true);
    for (const status of ["backlog", "todo", "todo", "in_progress", "review", "review"]) {
      const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text: `names ${status}`, status } });
      expect(res.ok()).toBe(true);
    }
  });
  test.afterAll(async ({ request }) => {
    await hub?.close();
    await scene?.cleanup(request);
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
    if (scene) await openSceneInSidebar(request, scene);
  });

  for (const width of [180, 256]) {
    test(`at ${width}px the names read whole and the tails give way`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAt(page, width);
      await expect(page.getByTestId("sidebar-automations")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("sidebar-board-generale")).toBeVisible({ timeout: 20_000 });
      // The tail carries the count in any form: the row must have something to give up.
      await expect(page.getByTestId("sidebar-automations-tail")).toContainText("4", { timeout: 20_000 });

      const auto = await readName(page, "sidebar-automations", '[data-row-name="automations"]');
      const board = await readName(page, "sidebar-board-generale", '[data-row-name="board"]');
      await page.locator('[aria-label="Topics sidebar"]').screenshot({ path: testInfo.outputPath(`sidebar-nomi-${width}.png`) });

      expect(auto, "the automations row has a name box").not.toBeNull();
      expect(auto!.text).toBe("Automazioni");
      expect(auto!.scrollWidth, `name overflows: ${JSON.stringify(auto)}`).toBeLessThanOrEqual(auto!.clientWidth);
      expect(auto!.outside, "name sticks out of the row").toBeLessThanOrEqual(0);
      expect(board, "the board row has a name box").not.toBeNull();
      expect(board!.scrollWidth, `name overflows: ${JSON.stringify(board)}`).toBeLessThanOrEqual(board!.clientWidth);
      expect(board!.outside, "name sticks out of the row").toBeLessThanOrEqual(0);

      // The full sentence never disappears: whatever is painted, the pointer
      // gets it as a title and a screen reader as text.
      const tail = page.getByTestId("sidebar-automations-tail");
      await expect(tail).toHaveAttribute("title", "4 da sistemare");
      await expect(tail).toContainText("4 da sistemare");
      // And the tail is inside the row, not clipped past its edge.
      const tailOut = await tail.evaluate((el) => {
        const row = el.closest('[data-testid="sidebar-automations"]')!.getBoundingClientRect();
        return Math.round(el.getBoundingClientRect().right - row.right);
      });
      expect(tailOut, "the tail sticks out of the row").toBeLessThanOrEqual(0);
    });
  }
});

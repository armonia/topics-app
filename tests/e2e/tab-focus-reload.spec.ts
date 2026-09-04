/**
 * THE TAB YOU WERE ON IS THE TAB YOU COME BACK TO, reload included.
 *
 * Reported on 2026-09-03: "if I refresh while I am on /tab/project/<x> it
 * brings me back to the kanban". The focus is device-local
 * (`pane-store-focused-id`), and `resolveBootFocus` honours it only when that
 * pane is VISIBLE in the store at the moment it runs, i.e. right after the
 * LOCAL snapshot hydrates. When the local snapshot does not carry the pane
 * (opened from another device, snapshot not flushed) the fallback is the LAST
 * tab of the row, and nothing re-resolves the saved focus once the server
 * snapshot arrives with the pane. The board sits last: that is the kanban.
 *
 * @covers CHROME-11
 * @covers CHROME-11b
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PROJECT = join(realpathSync(tmpdir()), `e2e-focus-reload-${Date.now()}`);
const PROJECT_TAB = `pane-tab-project:${encodeURIComponent(PROJECT)}`;
const BOARD_TAB = "pane-tab-__board__";

async function activeTabs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="pane-tab-"][data-active="true"]')).map(
      (t) => t.getAttribute("data-testid") ?? "?",
    ),
  );
}

/**
 * Waits until the active-tab row has STOPPED changing, and returns it.
 *
 * The defect this file is about does not show up at the first frame: the boot
 * focus resolves once on the local snapshot and can be resolved AGAIN when the
 * server snapshot arrives with the pane. A poll that stops at the first reading
 * it likes would be green on exactly the flip we are hunting, and a fixed sleep
 * pays the full budget on every good run. So the condition is stability: the
 * same row of active tabs, unchanged for `quietMs`. A late flip restarts the
 * window instead of being missed, and a clean boot returns as soon as it has
 * settled.
 */
async function settledActiveTabs(page: Page, quietMs = 1500): Promise<string[]> {
  await page.waitForFunction(
    (quiet) => {
      const w = window as unknown as { __tabsSeen?: string; __tabsSince?: number };
      const current = Array.from(document.querySelectorAll('[data-testid^="pane-tab-"][data-active="true"]'))
        .map((t) => t.getAttribute("data-testid") ?? "?")
        .sort()
        .join("+");
      const now = performance.now();
      if (w.__tabsSeen !== current) {
        w.__tabsSeen = current;
        w.__tabsSince = now;
        return false;
      }
      return current !== "" && now - (w.__tabsSince ?? now) >= quiet;
    },
    quietMs,
    { timeout: 30000, polling: "raf" },
  );
  return activeTabs(page);
}

async function openBoardTab(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })),
  );
  await expect(page.getByTestId(BOARD_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
}

test.describe("Tab focus survives a reload", () => {
  let topicId = "";
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT, { recursive: true });
    writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ name: "e2e-focus-reload" }));
    topicId = (await createTopic(request, `E2E-FocusReload-${Date.now()}`, { projectPath: PROJECT })).id;
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    rmSync(PROJECT, { recursive: true, force: true });
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
    await resetProjectPanes(request, PROJECT).catch(() => {});
    await seedProjectPane(request, PROJECT);
  });

  for (const [name, stale] of [
    ["with the local snapshot intact", false],
    ["with a local snapshot that does not carry the pane (opened elsewhere)", true],
  ] as const) {
    test(`CHROME-11: the focused project tab is still focused after a reload, ${name}`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "CHROME-11" });
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.getByTestId(PROJECT_TAB)).toBeVisible({ timeout: 15000 });
      await openBoardTab(page);
      await page.getByTestId(PROJECT_TAB).click();
      await expect(page.getByTestId(PROJECT_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
      // What the sleep was really waiting for: the debounced local snapshot has
      // LANDED, i.e. the focus key names the project pane. That is a thing the
      // page can report, so it is polled instead of slept on. The assertion the
      // test used to make after the sleep IS this condition.
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("pane-store-focused-id")), {
          timeout: 15000,
          message: "the focus key must name the project pane",
        })
        .toContain("project:");
      if (stale) {
        // The pane came from another device: the local snapshot never saw it.
        await page.evaluate(() => localStorage.removeItem("pane-store-v2"));
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.getByTestId(PROJECT_TAB)).toBeVisible({ timeout: 15000 });
      // The four samples at 500/1500/3000/6000ms printed a line and asserted
      // nothing: the verdict was taken at the end anyway. What they were really
      // spelling out is "wait for the focus to stop moving", which is the
      // condition below - and it is the one that catches a late flip.
      const settled = await settledActiveTabs(page);
      await expect(
        page.getByTestId(PROJECT_TAB),
        `after the reload the app must be on the project tab, not on the last tab of the row. Settled on: ${settled.join("+") || "-"}`,
      ).toHaveAttribute("data-active", "true");
      await expect(page.getByTestId(BOARD_TAB)).toHaveAttribute("data-active", "false");
    });
  }

  test("CHROME-11b: leaving the board with its drawer open, then reloading, does not bring the kanban back", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-11b" });
    // The drawer reflects itself into the URL (`/task/<id>`): if switching to
    // another tab leaves that URL behind, the next reload reads it as a boot
    // deep-link and re-opens the board with the drawer. That is exactly "I
    // refresh on the project tab and I am back on the kanban".
    const boardId = projectIdForPath(PROJECT);
    const created = await request.post(`${E2E_BASE}/api/boards/${boardId}/tasks`, { data: { text: `E2E focus reload ${Date.now()}`, status: "backlog" } });
    expect(created.ok(), "task creation").toBe(true);
    const taskId = ((await created.json()) as { id: string }).id;
    try {
      await page.goto(`/task/${taskId}`);
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.getByTestId(BOARD_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
      await expect(page.getByTestId(PROJECT_TAB)).toBeVisible({ timeout: 15000 });
      const onBoard = await page.evaluate(() => location.pathname);
      await page.getByTestId(PROJECT_TAB).click();
      await expect(page.getByTestId(PROJECT_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
      // Same debounce as above, same real condition: the local snapshot has
      // landed with the project pane focused. Only then is the URL the tab
      // switch left behind the one the next reload will actually read.
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("pane-store-focused-id")), {
          timeout: 15000,
          message: "the focus key must name the project pane before the reload",
        })
        .toContain("project:");
      const onProject = await page.evaluate(() => location.pathname);
      console.log(`[focus-reload] drawer: url on board=${onBoard} · url after switching to the project=${onProject}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      const active = await settledActiveTabs(page);
      console.log(`[focus-reload] drawer: after reload active=${active.join("+")} url=${await page.evaluate(() => location.pathname)}`);
      await expect(
        page.getByTestId(PROJECT_TAB),
        `the reload must land on the project tab; the URL left behind by the drawer was ${onProject}`,
      ).toHaveAttribute("data-active", "true");
      await expect(page.getByTestId(BOARD_TAB)).toHaveAttribute("data-active", "false");
    } finally {
      await deleteTask(request, boardId, taskId).catch(() => {});
    }
  });
});

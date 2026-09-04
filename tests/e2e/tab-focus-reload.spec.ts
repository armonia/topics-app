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
import { installUiStateProbe, waitForStableActiveTabs, waitForUiStateHydrated } from "./helpers/ui-state-probe";

hermetic(test);

const PROJECT = join(realpathSync(tmpdir()), `e2e-focus-reload-${Date.now()}`);
const PROJECT_TAB = `pane-tab-project:${encodeURIComponent(PROJECT)}`;
const BOARD_TAB = "pane-tab-__board__";

/**
 * The local snapshot is written on a debounce, and the reload needs the WRITE,
 * not a second and a half of hope: on a busy machine the flush lands after the
 * sleep and the page reboots from the previous state, which is a red about
 * nothing. Two keys matter here, so both are polled: the snapshot a warm boot
 * reads back, and the focus key `resolveBootFocus` honours.
 */
async function waitForLocalSnapshot(page: Page, focusContains: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((needle) => {
          const focused = localStorage.getItem("pane-store-focused-id") ?? "";
          return !!localStorage.getItem("pane-store-v2") && focused.includes(needle);
        }, focusContains),
      { timeout: 15000, message: `the debounced local snapshot never landed with focus on ${focusContains}` },
    )
    .toBe(true);
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
      await installUiStateProbe(page);
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.getByTestId(PROJECT_TAB)).toBeVisible({ timeout: 15000 });
      await openBoardTab(page);
      await page.getByTestId(PROJECT_TAB).click();
      await expect(page.getByTestId(PROJECT_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
      // Let the debounced local snapshot land before the reload.
      await waitForLocalSnapshot(page, "project:");
      const before = await page.evaluate(() => ({
        focused: localStorage.getItem("pane-store-focused-id"),
        snapshot: !!localStorage.getItem("pane-store-v2"),
      }));
      expect(before.focused, "the focus key must name the project pane").toContain("project:");
      if (stale) {
        // The pane came from another device: the local snapshot never saw it.
        await page.evaluate(() => localStorage.removeItem("pane-store-v2"));
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.getByTestId(PROJECT_TAB)).toBeVisible({ timeout: 15000 });
      // The four samples at 500/1500/3000/6000 ms that used to live here were a
      // MEASURE of when the focus settles, not a wait: they printed a timeline
      // and then asserted the last frame of it. What the assertion needs is the
      // end state, and the end state has a condition. The server snapshot has
      // arrived (that is the late hydrate that used to steal the focus), and
      // the row has stopped changing its mind for a stretch of painted frames.
      await waitForUiStateHydrated(page, { timeout: 30_000 });
      const settled = await waitForStableActiveTabs(page, { frames: 30, timeout: 30_000 });
      console.log(`[focus-reload] ${name} · settled on ${settled}`);
      await expect(
        page.getByTestId(PROJECT_TAB),
        `after the reload the app must be on the project tab, not on the last tab of the row. Settled on ${settled}`,
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
      await installUiStateProbe(page);
      await page.goto(`/task/${taskId}`);
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      await expect(page.getByTestId(BOARD_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
      await expect(page.getByTestId(PROJECT_TAB)).toBeVisible({ timeout: 15000 });
      const onBoard = await page.evaluate(() => location.pathname);
      await page.getByTestId(PROJECT_TAB).click();
      await expect(page.getByTestId(PROJECT_TAB)).toHaveAttribute("data-active", "true", { timeout: 15000 });
      await waitForLocalSnapshot(page, "project:");
      const onProject = await page.evaluate(() => location.pathname);
      console.log(`[focus-reload] drawer: url on board=${onBoard} · url after switching to the project=${onProject}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
      // Same as CHROME-11: the six seconds were the guess "by now the boot
      // deep-link has had its say". The condition is the hydrate having landed
      // and the tab row holding still afterwards.
      await waitForUiStateHydrated(page, { timeout: 30_000 });
      const active = await waitForStableActiveTabs(page, { frames: 30, timeout: 30_000 });
      console.log(`[focus-reload] drawer: after reload active=${active} url=${await page.evaluate(() => location.pathname)}`);
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

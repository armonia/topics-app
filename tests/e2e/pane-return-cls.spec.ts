import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { FileExplorerPage, projectRowSelector } from "./fixtures/file-explorer.fixture";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import {
  seedFileProject,
  cleanupFileProject,
  type FileProject,
} from "./helpers/file-project";
import {
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  clickAddShell,
  TERMINAL_PROJECT_PATH,
} from "./helpers/terminal-workspace";
import {
  armFullness,
  armObserver,
  buildReport,
  collectFullness,
  collectShifts,
  settledUntilQuiet,
  summarize,
  waitForLocalCopy,
  writeReport,
  type ClsReport,
} from "./helpers/cls-return";

hermetic(test);

/**
 * THE RETURN, PANE BY PANE.
 *
 * `refresh-cls.spec.ts` proved the gesture on the chat: reload a topic and
 * nothing moves. The same contract holds for every other surface a reload can
 * land on - the board, a terminal, the file tree, an open file - and until it
 * was measured per surface it was only true where somebody had looked.
 *
 * The method is the one declared in `refresh-cls.spec.ts` and implemented once
 * in `helpers/cls-return.ts`: observer armed before any line of the app, second
 * load (the first only warms what the client keeps locally), observation without
 * a single interaction until the page is quiet (no request, no shift),
 * web-vitals session windows.
 *
 * TWO numbers per surface, because one alone can be gamed:
 *   CLS       nothing moved  (budget 0.01, the noise of a presence dot)
 *   FULLNESS  and something was there  (budget 100ms after DOMContentLoaded)
 * A pane that paints nothing for a second and then draws the finished layout
 * scores a perfect zero on the first and fails the second, which is exactly the
 * spinner-then-content flash the card is about.
 *
 * @covers PERF-01
 */

const RETURN_BUDGET = 0.01;
/**
 * From the app's FIRST PAINT to the pane having content. Not from
 * `DOMContentLoaded`: see the note on `Fullness` in `helpers/cls-return.ts` -
 * that one includes the bundle boot, which on a shared machine swings by two
 * orders of magnitude and would make this gate a load meter. 100 ms is six
 * frames: a synchronous read of the local copy lands inside one, a fetch does
 * not land inside any.
 */
const FULL_BUDGET_MS = 100;
const LABEL = process.env.E2E_CLS_LABEL || "run";

/** Phone and desktop: the two viewports declared by the method. */
const PHONE = { name: "390x844", width: 390, height: 844 } as const;
const WIDE = { name: "1440x900", width: 1440, height: 900 } as const;
const VIEWPORTS = [PHONE, WIDE] as const;

/**
 * WHY THE PROJECT PANES ARE MEASURED ON THE DESKTOP ONLY.
 *
 * At 390px a project does not tile its panes: the window shows one at a time
 * and the file tree is not on screen at all - `gotoProject` waits fifteen
 * seconds for a tree that the phone layout never mounts. Measuring it there
 * would mean building a navigation the product does not have, and reporting a
 * number for a surface nobody is looking at. The phone is covered where the
 * phone actually lands: the chat (`refresh-cls.spec.ts`) and the board, both
 * below.
 */
const PROJECT_VIEWPORTS = [WIDE] as const;

async function measureReturn(page: Page, selector: string, name: string): Promise<ClsReport> {
  await armObserver(page);
  await armFullness(page, selector);
  await page.reload({ waitUntil: "commit" });
  await settledUntilQuiet(page);
  const report = buildReport(await collectShifts(page), {
    fullness: await collectFullness(page, selector),
  });
  const file = writeReport(LABEL, name, report);
  console.log(
    `\n[cls:${LABEL}:${name}] CLS=${report.cls.toFixed(4)} total=${report.total.toFixed(4)} shifts=${report.count} full=${report.fullness?.afterShellMs ?? "never"}ms-after-shell (${report.fullness?.ms ?? "?"}ms from DCL)` +
    `\n${summarize(report)}\n-> ${file}\n`,
  );
  return report;
}

/** The two assertions, always together and always with the attribution attached. */
function expectQuietAndFull(report: ClsReport): void {
  expect(report.cls, `who moved:\n${summarize(report)}`).toBeLessThanOrEqual(RETURN_BUDGET);
  expect(
    report.fullness?.afterShellMs ?? Number.MAX_SAFE_INTEGER,
    `the pane was still empty ${report.fullness?.afterShellMs ?? "forever"}ms after the app had painted` +
      ` (${report.fullness?.ms ?? "?"}ms after DOMContentLoaded, boot included)`,
  ).toBeLessThanOrEqual(FULL_BUDGET_MS);
}

/** A board with rows on it: an empty board cannot shift, and cannot prove anything. */
async function seedBoardTasks(request: APIRequestContext, projectPath: string): Promise<void> {
  const projectId = projectIdForPath(projectPath);
  const rows = [
    { text: "Return without a jump", status: "todo" },
    { text: "The columns keep their height", status: "in_progress" },
    { text: "Cards drawn from the local copy", status: "review" },
  ];
  for (const row of rows) {
    await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: row });
  }
}

test.describe("BOARD - the kanban returns without moving", () => {
  for (const vp of VIEWPORTS) {
    test.describe(`viewport ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      test(`a return does not move the board (${vp.name})`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        await seedBoardTasks(request, TERMINAL_PROJECT_PATH);
        await resetPaneStore(request, []);
        await goToApp(page);
        await page.getByTestId("pane-add-menu-trigger").first().click();
        await page.getByTestId("pane-add-menu-board").click();
        await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
        await waitForLocalCopy(page, "board-rows-cache:");
        await waitForPaneStoreQuiet(request);
        expectQuietAndFull(await measureReturn(page, '[data-testid="kanban-board"]', `board-${vp.name}`));
      });
    });
  }
});

test.describe("FILES - the tree and the open file return without moving", () => {
  let project: FileProject | undefined;

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "cls");
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  for (const vp of PROJECT_VIEWPORTS) {
    test.describe(`viewport ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test(`a return does not move the file tree (${vp.name})`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        const explorer = new FileExplorerPage(page);
        await explorer.gotoProject(project!.tmpDir, project!.topicName);
        await waitForPaneStoreQuiet(request);
        expectQuietAndFull(await measureReturn(page, '[data-testid="file-tree"]', `files-${vp.name}`));
      });

      test(`a return does not move an open file (${vp.name})`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        const explorer = new FileExplorerPage(page);
        await explorer.gotoProject(project!.tmpDir, project!.topicName);
        const item = explorer.fileTree.getByRole("treeitem", { name: /package\.json/ }).first();
        await item.click();
        await expect(page.getByTestId("file-pane").first()).toBeVisible({ timeout: 15000 });
        await waitForLocalCopy(page, "file-content-cache");
        await waitForPaneStoreQuiet(request);
        expectQuietAndFull(await measureReturn(page, '[data-testid="file-pane"]', `editor-${vp.name}`));
      });
    });
  }
});

/**
 * OPENING a file, not returning to it. The card's second half: "opening a file
 * has to be instant too". The gesture is a click, so the clock starts on the
 * click itself (inside the page, on the capture phase) and stops on the frame
 * where the pane shows that file's text.
 */
/**
 * The ceiling for a click comes from `tests/e2e/ink-budget.json`, which is the
 * repo's ONE copy of it and says so ("Nothing else may hold a copy of these
 * numbers"). `maxMs` and not `medianMs` because this is a single sample, and
 * `maxMs` is exactly the half of that budget written for single samples: no one
 * gesture stalled. Writing 100 here instead would be a second, quieter budget
 * for the same question.
 */
const OPEN_BUDGET_MS = (
  JSON.parse(readFileSync(resolve(__dirname, "ink-budget.json"), "utf8")) as { budget: { maxMs: number } }
).budget.maxMs;

/**
 * Starts the clock and watches for the text.
 *
 * The start is stamped HERE, from the test, right before the click - not from a
 * listener on the click itself. A capture listener on `document` looked more
 * faithful and was flaky: it never fired once in six runs, and the case then
 * reported "never" for a gesture that had plainly worked. Stamping it a moment
 * EARLY can only make the measured time longer than the truth, so the assertion
 * stays honest and stops depending on which listener wins a race.
 */
async function armOpenClock(page: Page, needle: string): Promise<void> {
  await page.evaluate((text: string) => {
    const w = window as unknown as { __openT0: number | null; __openPaintAt: number | null };
    w.__openT0 = performance.now();
    w.__openPaintAt = null;
    const tick = () => {
      if (w.__openPaintAt !== null) return;
      const el = document.querySelector('[data-testid="file-pane"]');
      if (el && (el.textContent || "").includes(text)) { w.__openPaintAt = performance.now(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, needle);
}

async function readOpenClock(page: Page): Promise<number | null> {
  const raw = await page.evaluate(() => {
    const w = window as unknown as { __openT0?: number | null; __openPaintAt?: number | null };
    return { t0: w.__openT0 ?? null, paint: w.__openPaintAt ?? null };
  });
  if (raw.t0 === null || raw.paint === null) return null;
  return Math.round(raw.paint - raw.t0);
}

test.describe("OPEN - a file already seen opens on the click", () => {
  let project: FileProject | undefined;

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "open");
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test.use({ viewport: { width: WIDE.width, height: WIDE.height } });
  test("the text is on screen within a frame of the click", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "PERF-01" });
    const explorer = new FileExplorerPage(page);
    await explorer.gotoProject(project!.tmpDir, project!.topicName);

    // TWO files are opened first, and neither open is measured: this is what
    // fills the local copy. Two and not one, because the measured gesture has
    // to open a file that is NOT already on screen - with a single file the
    // pane comes back from the reload already showing it, and the clock would
    // stop before the click had done anything.
    const pane = page.getByTestId("file-pane").first();
    await explorer.fileTree.getByRole("treeitem", { name: /package\.json/ }).first().click();
    await expect(pane).toContainText("e2e-test-project", { timeout: 15000 });
    await explorer.fileTree.getByRole("treeitem", { name: /newfile\.txt/ }).first().click();
    await expect(pane).toContainText("new content", { timeout: 15000 });
    // Both files have to be IN the local copy before the reload: the measured
    // gesture is opening the one that is not on screen, and it can only be
    // instant if its text is already there.
    await waitForLocalCopy(page, "file-content-cache", "e2e-test-project");
    await waitForLocalCopy(page, "file-content-cache", "new content");

    // Back to a page showing newfile.txt, with package.json's text in the local
    // copy but nowhere on screen.
    await armObserver(page);
    await page.reload({ waitUntil: "commit" });
    await expect(explorer.fileTree.first()).toBeVisible({ timeout: 20000 });
    await expect(pane).toContainText("new content", { timeout: 20000 });
    await waitForPaneStoreQuiet(request);

    await armOpenClock(page, "e2e-test-project");
    await explorer.fileTree.getByRole("treeitem", { name: /package\.json/ }).first().click();
    await expect(pane).toContainText("e2e-test-project", { timeout: 15000 });
    const ms = await readOpenClock(page);
    const report = buildReport(await collectShifts(page));
    writeReport(LABEL, `open-file-${WIDE.name}`, report);
    console.log(`\n[open:${LABEL}] click->text=${ms ?? "never"}ms CLS=${report.cls.toFixed(4)}\n${summarize(report)}\n`);
    expect(ms ?? Number.MAX_SAFE_INTEGER, "click to text").toBeLessThanOrEqual(OPEN_BUDGET_MS);
    expect(report.cls, `who moved:\n${summarize(report)}`).toBeLessThanOrEqual(RETURN_BUDGET);
  });
});

test.describe("TERMINAL - the shell returns without moving", () => {
  let topic: { topicId: string; topicName: string } | undefined;

  test.beforeAll(async ({ request }) => {
    topic = await seedTerminalTopic(request, "cls");
  });
  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topic?.topicId);
  });

  for (const vp of PROJECT_VIEWPORTS) {
    test.describe(`viewport ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      test(`a return does not move the terminal (${vp.name})`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        await seedProjectPane(request, TERMINAL_PROJECT_PATH).catch(() => {});
        await gotoTerminalProject(page, topic!.topicName);
        await clickAddShell(page);
        await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 20000 });
        await waitForLocalCopy(page, "terminal-scrollback-cache");
        await waitForPaneStoreQuiet(request);
        // Either is terminal TEXT on screen: the seed drawn from the local copy
        // on the first frame, or xterm's own rows once the replay has landed.
        expectQuietAndFull(
          await measureReturn(page, '[data-testid="terminal-text"], .xterm-rows', `terminal-${vp.name}`),
        );
      });
    });
  }
});

test.describe("DASHBOARD - the KPI grid returns without moving", () => {
  for (const vp of VIEWPORTS) {
    test.describe(`viewport ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      test(`a return does not move the dashboard (${vp.name})`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        await resetPaneStore(request, []);
        // THE TWO DASHBOARD FETCHES ARE HELD FOR 300 ms. On the e2e server they
        // answer in 0-8 ms (measured: `GET /api/dashboard/kpis 200 0ms`), so a
        // pane that draws nothing until they land is empty for ONE frame and
        // reads 15-17 ms after the shell: inside the budget, and the gate
        // could not tell a pane drawn from the local copy from one waiting on
        // the wire. 300 ms is a real network's answer, and it is what the
        // reader on a phone sees. A pane that reads its local copy does not
        // notice the hold; one that waits for the wire is empty for all of it.
        await page.route("**/api/dashboard/**", async (route) => {
          await new Promise((r) => setTimeout(r, 300));
          await route.continue();
        });
        await goToApp(page);
        // Standalone scope, same gesture as the board: the sidebar's "+".
        await page.getByTestId("pane-add-menu-trigger").first().click();
        await page.getByTestId("pane-add-menu-dashboard").click();
        await expect(page.getByTestId("kpi-card-grid")).toBeVisible({ timeout: 15000 });
        // The copy the next frame has to draw from. A bundle that never writes
        // it is not stopped here: the fullness gate below is the verdict for
        // that case, and it reads the whole 300 ms hold as an empty pane.
        await waitForLocalCopy(page, "dashboard-snapshot-cache").catch(() => {});
        await waitForPaneStoreQuiet(request);
        // The KPI grid, not the pane's frame: the frame can be on screen with
        // nothing in it, the grid only exists once there are numbers to show.
        const report = await measureReturn(page, '[data-testid="kpi-card-grid"]', `dashboard-${vp.name}`);
        // THE PICTURE FOR THE RECORD, on request only (`E2E_CLS_SHOT=<file>`):
        // the dashboard pane's rectangle 150 ms after `DOMContentLoaded` of one
        // more reload, with the fetches still held. Run once per bundle and the
        // two files show the same instant: a spinner in an empty frame, or the
        // grid already drawn. A second reload and not the measured one, so the
        // screenshot's own paint never enters the numbers above.
        if (process.env.E2E_CLS_SHOT && vp.name === WIDE.name) {
          const clip = await page.getByTestId("dashboard-pane").boundingBox();
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForTimeout(150);
          await page.screenshot({ path: process.env.E2E_CLS_SHOT, clip: clip ?? undefined });
          console.log(`[cls:${LABEL}:shot] -> ${process.env.E2E_CLS_SHOT}`);
        }
        expectQuietAndFull(report);
      });
    });
  }
});

/**
 * The "+" on the project row, then one typed row of the add menu: the gesture
 * `clickAddShell` performs for a shell, for any project-scoped pane type.
 *
 * The row is found by `projectRowSelector`, which knows that a project answers
 * to two spellings of its path, and that is not a detail of this file: since
 * 7cd202448 the server serves the project pane under the CANONICAL path, and on
 * macOS the realpath of `/tmp/x` is `/private/tmp/x`.
 */
async function clickAddToProject(page: Page, projectPath: string, type: string): Promise<void> {
  const row = page.locator(projectRowSelector(projectPath)).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.hover();
  const addBtn = row
    .locator("..")
    .locator('button[title="Add to project"], button[data-tip="Add to project"]')
    .first();
  await addBtn.waitFor({ state: "visible", timeout: 5000 });
  await addBtn.click();
  const item = page.getByTestId(`pane-add-menu-${type}`);
  await item.waitFor({ state: "visible", timeout: 5000 });
  await item.click();
}

/**
 * The git PANE, not the git SECTION. Both carry `data-testid="git-changes"`
 * (`GitChanges` draws the sidebar's compact strip and the full pane from the
 * same component), and the compact strip is mounted in every project window,
 * so a bare testid would read "full" before the pane had drawn a single row.
 * The pane lives in the tiles column, the sibling of the project sidebar.
 */
const GIT_PANE =
  '[data-testid="project-window"] > div:not([data-testid="project-sidebar"]) [data-testid="git-changes"]';

test.describe("GIT - the changes pane returns without moving", () => {
  let project: FileProject | undefined;

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "git");
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  for (const vp of PROJECT_VIEWPORTS) {
    test.describe(`viewport ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      test(`a return does not move the git pane (${vp.name})`, async ({ page, request }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        const explorer = new FileExplorerPage(page);
        await explorer.gotoProject(project!.tmpDir, project!.topicName);
        await clickAddToProject(page, project!.tmpDir, "git");
        const pane = page.locator(GIT_PANE).first();
        await expect(pane).toBeVisible({ timeout: 15000 });
        // The seed leaves one modified, one deleted and one untracked file: the
        // list has rows to draw. An empty status could not shift, and could not
        // prove anything.
        await expect(pane).toContainText("newfile.txt", { timeout: 15000 });
        await waitForPaneStoreQuiet(request);
        expectQuietAndFull(await measureReturn(page, GIT_PANE, `git-${vp.name}`));
      });
    });
  }
});

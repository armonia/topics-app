import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { FileExplorerPage } from "./fixtures/file-explorer.fixture";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
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
  summarize,
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
 * load (the first only warms what the client keeps locally), six seconds of
 * observation without a single interaction, web-vitals session windows.
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
const FULL_BUDGET_MS = 100;
const LABEL = process.env.E2E_CLS_LABEL || "run";

/** Phone and desktop: the two viewports declared by the method. */
const PHONE = { name: "390x844", width: 390, height: 844 } as const;
const DESKTOP = { name: "1440x900", width: 1440, height: 900 } as const;
const VIEWPORTS = [PHONE, DESKTOP] as const;

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
const PROJECT_VIEWPORTS = [DESKTOP] as const;

async function measureReturn(page: Page, selector: string, name: string): Promise<ClsReport> {
  await armObserver(page);
  await armFullness(page, selector);
  await page.reload({ waitUntil: "commit" });
  await page.waitForTimeout(6000);
  const report = buildReport(await collectShifts(page), {
    fullness: await collectFullness(page, selector),
  });
  const file = writeReport(LABEL, name, report);
  console.log(
    `\n[cls:${LABEL}:${name}] CLS=${report.cls.toFixed(4)} total=${report.total.toFixed(4)} shifts=${report.count} full=${report.fullness?.ms ?? "never"}ms` +
    `\n${summarize(report)}\n-> ${file}\n`,
  );
  return report;
}

/** The two assertions, always together and always with the attribution attached. */
function expectQuietAndFull(report: ClsReport): void {
  expect(report.cls, `who moved:\n${summarize(report)}`).toBeLessThanOrEqual(RETURN_BUDGET);
  expect(
    report.fullness?.ms ?? Number.MAX_SAFE_INTEGER,
    `the surface was still empty ${report.fullness?.ms ?? "forever"}ms after DOMContentLoaded`,
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
        await page.waitForTimeout(3000);
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

      test(`a return does not move the file tree (${vp.name})`, async ({ page }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        const explorer = new FileExplorerPage(page);
        await explorer.gotoProject(project!.tmpDir, project!.topicName);
        await page.waitForTimeout(3000);
        expectQuietAndFull(await measureReturn(page, '[data-testid="file-tree"]', `files-${vp.name}`));
      });

      test(`a return does not move an open file (${vp.name})`, async ({ page }) => {
        test.info().annotations.push({ type: "spec", description: "PERF-01" });
        const explorer = new FileExplorerPage(page);
        await explorer.gotoProject(project!.tmpDir, project!.topicName);
        const item = explorer.fileTree.getByRole("treeitem", { name: /package\.json/ }).first();
        await item.click();
        await expect(page.getByTestId("file-pane").first()).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(3000);
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
const OPEN_BUDGET_MS = 100;

async function armOpenClock(page: Page, needle: string): Promise<void> {
  await page.evaluate((text: string) => {
    const w = window as unknown as { __openT0: number | null; __openPaintAt: number | null };
    w.__openT0 = null;
    w.__openPaintAt = null;
    document.addEventListener("click", () => { if (w.__openT0 === null) w.__openT0 = performance.now(); }, { capture: true });
    const tick = () => {
      if (w.__openPaintAt !== null) return;
      const el = document.querySelector('[data-testid="file-pane"]');
      if (w.__openT0 !== null && el && (el.textContent || "").includes(text)) { w.__openPaintAt = performance.now(); return; }
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

  test.use({ viewport: { width: DESKTOP.width, height: DESKTOP.height } });
  test("the text is on screen within a frame of the click", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PERF-01" });
    const explorer = new FileExplorerPage(page);
    await explorer.gotoProject(project!.tmpDir, project!.topicName);

    // First open: this is what fills the local copy. Nothing is measured here.
    const item = explorer.fileTree.getByRole("treeitem", { name: /package\.json/ }).first();
    await item.click();
    await expect(page.getByTestId("file-pane").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("file-pane").first()).toContainText("e2e-test-project", { timeout: 15000 });
    await page.waitForTimeout(1500);

    // Back to a page that has never drawn this file, with the copy in hand.
    await armObserver(page);
    await page.reload({ waitUntil: "commit" });
    await expect(explorer.fileTree.first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(3000);

    await armOpenClock(page, "e2e-test-project");
    await explorer.fileTree.getByRole("treeitem", { name: /package\.json/ }).first().click();
    await expect(page.getByTestId("file-pane").first()).toContainText("e2e-test-project", { timeout: 15000 });
    const ms = await readOpenClock(page);
    const report = buildReport(await collectShifts(page));
    writeReport(LABEL, `open-file-${DESKTOP.name}`, report);
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
        await page.waitForTimeout(3000);
        // Either is terminal TEXT on screen: the seed drawn from the local copy
        // on the first frame, or xterm's own rows once the replay has landed.
        expectQuietAndFull(
          await measureReturn(page, '[data-testid="terminal-text"], .xterm-rows', `terminal-${vp.name}`),
        );
      });
    });
  }
});

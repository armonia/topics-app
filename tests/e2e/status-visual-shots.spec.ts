/**
 * STATUS-VISUAL-01 at sight: Board, Plan and Agents in light and dark.
 *
 * The unit tests (client/src/lib/statusVisual*.test.ts) hold the vocabulary
 * and its wiring; what they cannot hold is how the surfaces LOOK once the
 * colours change. This spec photographs the three surfaces the status colours
 * live on, in both themes:
 *
 *   - with `E2E_EVIDENCE=1` every shot is also written to
 *     `test-results/status-visual/<surface>-<scheme>.png`, the input of the
 *     before/after side by side for the review;
 *   - `toHaveScreenshot` compares against the committed baseline. A surface
 *     with no baseline yet is annotated instead of failing on the missing
 *     file: baselines are platform specific (chromium-linux in CI) and are
 *     written by a run with `--update-snapshots`.
 *
 * The Board carries one card per column; the Plan tab is the fixture plan of
 * plan-surface.spec.ts.
 *
 * @covers STATUS-VISUAL-01
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { projectIdForPath as boardIdForPath, PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-status-visual-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);
const FIXTURES = join(__dirname, "..", "..", "client", "src", "components", "Board", "__fixtures__");
const PLAN_TEXT = readFileSync(join(FIXTURES, "plan-comment.md"), "utf8").trim();
const EVIDENCE_DIR = join(__dirname, "..", "..", "test-results", "status-visual");
const PLAN_CARD = "Status visual: plan card";

const createdTasks: string[] = [];
let projectTopicId: string | null = null;
let planTaskId = "";

async function shoot(target: Locator, name: string, testInfo: TestInfo) {
  if (process.env.E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await target.screenshot({ path: join(EVIDENCE_DIR, name) });
  }
  if (!existsSync(testInfo.snapshotPath(name))) {
    testInfo.annotations.push({ type: "baseline", description: `${name}: no baseline yet, run with --update-snapshots` });
    return;
  }
  await expect(target).toHaveScreenshot(name, { maxDiffPixelRatio: 0.01 });
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
    await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-status-visual/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(scheme === "dark");
}

test.describe("Status colours at sight", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-status-visual" }, null, 2));
    const topic = await createTopic(request, "E2E-Status-Visual", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    for (const [text, status] of [
      ["Status visual: queued", "todo"],
      ["Status visual: at work", "in_progress"],
      ["Status visual: in review", "review"],
      ["Status visual: done", "done"],
    ] as const) {
      const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status } });
      expect(res.ok(), `create ${text} → ${res.status()}`).toBe(true);
      createdTasks.push(`${PROJECT_ID}:${((await res.json()) as { id: string }).id}`);
    }
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: PLAN_CARD, status: "in_progress", planFirst: true },
    });
    expect(res.ok()).toBe(true);
    planTaskId = ((await res.json()) as { id: string }).id;
    createdTasks.push(`${PROJECT_ID}:${planTaskId}`);
    const key = `topic:${projectTopicId!.slice(0, 8)}`;
    const comment = await request.post(`${BASE}/api/sessions/${encodeURIComponent(key)}/tasks/${planTaskId}/comments`, {
      data: { content: PLAN_TEXT, options: [PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL] },
    });
    expect(comment.status(), await comment.text()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`STATUS-VISUAL-01 (${scheme}): Board and Plan`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await setScheme(page, scheme);
      await openProjectBoard(page);
      await shoot(page.getByTestId("kanban-board"), `board-${scheme}.png`, testInfo);

      await page.getByTestId("kanban-column-in_progress").getByText(PLAN_CARD).click({ timeout: 15000 });
      const drawer = page.getByTestId("task-detail-drawer");
      await expect(drawer).toBeVisible({ timeout: 10000 });
      const workspace = drawer.getByTestId("task-workspace-toggle");
      if ((await workspace.count()) > 0 && (await workspace.first().getAttribute("data-open")) === "0") {
        await workspace.first().click();
      }
      const tab = page.getByTestId(`pane-tab-plan:${planTaskId}`);
      await expect(tab).toBeVisible({ timeout: 15000 });
      await tab.click();
      const body = page.getByTestId("plan-surface-body");
      await expect(body).toBeVisible({ timeout: 10000 });
      await shoot(body.locator("xpath=.."), `plan-${scheme}.png`, testInfo);
    });

    test(`STATUS-VISUAL-01 (${scheme}): Agents`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await goToApp(page);
      await setScheme(page, scheme);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
      const pane = page.getByTestId("agents-pane");
      await expect(pane).toBeVisible({ timeout: 15_000 });
      await shoot(pane, `agents-${scheme}.png`, testInfo);
    });
  }
});

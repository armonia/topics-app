/**
 * status-visual-shots.spec.ts: the three surfaces where a status colour is
 * read most (the Board, the plan view, the Agents pane) against their
 * reference screenshots, in light and in dark.
 *
 * The unit tests (`client/src/lib/statusVisual*.test.ts`) prove the TOKENS
 * and their WIRING; this proves the pixels, which is where a class that the
 * Tailwind build did not emit, or a parent that overrides the ink, would show.
 * So the seeded world must put every state on screen at once:
 *
 *   - a task in Review with `dispatch_state = 'needs_input'`: the amber chip
 *     with the CircleAlert mark (`STATUS_CHIP.wait`);
 *   - a task with an agent at work (`dispatch_state = 'working'`): the sky chip
 *     (`STATUS_CHIP.working`);
 *   - a failed task (`dispatch_state = 'failed'`): the danger chip;
 *   - an always-on agent's session with a turn in flight, announced `working`
 *     the way the chat route does: the sky dot and ink in the Agents pane.
 *
 * `dispatch_state` is written only by the dispatcher, so it is staged through
 * the test route `bind-topic`, which calls the real service. The agent is
 * recognised by its folder (`lib/agentSessions.ts`, `agentOfPath`): a topic
 * whose project path ends in `/.openclaw` belongs to the main agent.
 *
 * The references are committed next to this file by `--update-snapshots`. A
 * missing reference fails the run the normal Playwright way: nothing here
 * skips when it is absent.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { attentionUpdated } from "./helpers/attention";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();
const ROOT = `${canonicalTmpRoot()}/e2e-status-visual-${STAMP}`;
const PROJECT_PATH = `${ROOT}/shop`;
const AGENT_HOME = `${ROOT}/.openclaw`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const createdTasks: string[] = [];
const createdTopics: string[] = [];

async function createTask(request: APIRequestContext, text: string, status: string): Promise<string> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status } });
  expect(res.ok(), `POST tasks ${text}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  createdTasks.push(id);
  return id;
}

async function bindTopic(request: APIRequestContext, id: string, topicId: string, dispatchState: string): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, { data: { topicId, dispatchState } });
  expect(res.ok(), `bind-topic ${dispatchState}`).toBe(true);
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${BASE}/api/topics`)).json()) as { topics: Record<string, { sessionKey?: string }> };
  const key = body.topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey`);
  return key;
}

async function openGlobalBoard(page: Page): Promise<void> {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
}

/** Relative times and clocks change between runs: they are masked, not frozen. */
const moving = (page: Page) => [
  page.locator('[data-testid*="ago"], [data-testid*="clock"], [data-testid*="elapsed"], time'),
];

const SHOT = { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01 } as const;

let agentTopic = "";
let workTopic = "";
let askTopic = "";
let needsInputTask = "";
let workingTask = "";

test.describe("Status colours on the Board, the plan and the Agents pane", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    mkdirSync(AGENT_HOME, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-status-visual" }, null, 2));
    createdTopics.push((await createTopic(request, "E2E-StatusVisual", { projectPath: PROJECT_PATH })).id);
    workTopic = (await createTopic(request, `Agent at work ${STAMP}`)).id;
    askTopic = (await createTopic(request, `Agent asking ${STAMP}`)).id;
    agentTopic = (await createTopic(request, `Jarvis session ${STAMP}`, { projectPath: AGENT_HOME })).id;
    createdTopics.push(workTopic, askTopic, agentTopic);

    needsInputTask = await createTask(request, "Choose the payment provider", "review");
    await bindTopic(request, needsInputTask, askTopic, "needs_input");
    workingTask = await createTask(request, "Migrate the product photos", "in_progress");
    await bindTopic(request, workingTask, workTopic, "working");
    const failedTask = await createTask(request, "Rebuild the search index", "backlog");
    await bindTopic(request, failedTask, workTopic, "failed");

    // The agent's turn in flight: the same seed `chat-next-waiting.spec.ts` uses.
    const key = await sessionKeyOf(request, agentTopic);
    expect((await request.post(`${BASE}/api/test/streams/partial`, { data: { sessionKey: key } })).ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    for (const id of createdTopics) await deleteTopic(request, id).catch(() => {});
    removeTmpDir(ROOT);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`STATUS-VISUAL-01i (${scheme}): Board, plan and Agents match their references`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "STATUS-VISUAL-01i" });
      await page.emulateMedia({ colorScheme: scheme });
      await resetPaneStore(page.request, []);
      const ws = await interceptWebSocket(page);
      await page.goto("/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");

      // The agent at work, announced as the chat route announces it.
      await expect.poll(() => ws.getByType("attention:init").length, { timeout: 15_000 }).toBeGreaterThan(0);
      ws.send(attentionUpdated(`topic:${agentTopic}`, { state: "working" }));

      // ── Board ────────────────────────────────────────────────────────────
      await openGlobalBoard(page);
      const board = page.getByTestId("kanban-board");
      const asking = page.locator(`[data-task-card="${needsInputTask}"]`);
      await expect(asking).toBeVisible({ timeout: 15_000 });
      await expect(asking.locator('[data-testid="dispatch-chip"][data-state="needs_input"]')).toBeVisible();
      await expect(page.locator(`[data-task-card="${workingTask}"]`)).toBeVisible();
      await expect(board).toHaveScreenshot(`status-visual-board-${scheme}.png`, { ...SHOT, mask: moving(page) });

      // ── Plan ─────────────────────────────────────────────────────────────
      await page.getByTestId("board-plan-toggle").click();
      const plan = page.getByTestId("plan-view");
      await expect(plan).toBeVisible({ timeout: 15_000 });
      await expect(plan.locator(`[data-task-card="${needsInputTask}"]`)).toBeVisible();
      await expect(plan).toHaveScreenshot(`status-visual-plan-${scheme}.png`, { ...SHOT, mask: moving(page) });

      // ── Agents ───────────────────────────────────────────────────────────
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
      const group = page.getByTestId("agents-group").first();
      await expect(group).toBeVisible({ timeout: 15_000 });
      await expect(group.getByTestId("agents-group-counts")).toContainText(/1/);
      await expect(group).toHaveScreenshot(`status-visual-agents-${scheme}.png`, { ...SHOT, mask: moving(page) });
    });
  }
});

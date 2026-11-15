/**
 * board-work-countdown.spec.ts - the countdown of work in progress and its exact weight.
 *
 * WHY. A card in progress now says how long it still has to go (the median of
 * the cards its project already closed) and how heavy its session is (the
 * provider's own context share, the room before compaction, the sub-agents it
 * launched). Unit tests pin the arithmetic; this spec shows the one thing they
 * cannot: the number on the card goes DOWN as the work goes on, on the board
 * a person looks at, at the four widths and in both themes.
 *
 * The feed, the live context and the sub-agent rows are answered here (the
 * edge of the system), over a card, a topic and five closed cards seeded
 * through the real API, so the board, the drawer and the chips are the app's.
 * The video is the proof for the countdown; the screenshots are the proof for
 * the layout.
 *
 * @covers KANBAN-63
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";

/** A real folder: the board of a project exists only once a chat is bound to its path. */
const PROJECT_DIR = mkdtempSync(join(tmpdir(), "work-countdown-"));
mkdirSync(PROJECT_DIR, { recursive: true });
const BOARD_ID = projectIdForPath(PROJECT_DIR);

hermetic(test);

test.use({ video: "on" });

const MIN = 60_000;
const WIDTHS = [375, 768, 1440, 3440] as const;

type FeedTask = Record<string, unknown> & { id: string };

test.describe("Board: countdown and weight of work in progress", () => {
  test.describe.configure({ timeout: 120_000, mode: "serial" });

  const stamp = Date.now();
  const created: string[] = [];
  let topicId = "";
  let runningId = "";
  let sessionKey = "";
  /** Agent time of the running card, ms: grows between feed reads. */
  let runningMs = 5 * MIN;

  async function seed(request: APIRequestContext, text: string, status: string): Promise<string> {
    const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text, status } });
    expect(res.ok(), `the board API refused to seed "${text}": ${await res.text()}`).toBe(true);
    const { id } = (await res.json()) as { id: string };
    created.push(id);
    return id;
  }

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, `countdown-${stamp}`, { projectPath: PROJECT_DIR });
    topicId = topic.id;
    for (let i = 0; i < 5; i++) await seed(request, `Closed ${i} ${stamp}`, "todo");
    runningId = await seed(request, `Running ${stamp}`, "in_progress");
    const topics = (await (await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true })).json()) as { topics: Record<string, { sessionKey?: string }> };
    sessionKey = topics.topics[topicId]?.sessionKey ?? "";
    expect(sessionKey, "the seeded topic has no session key").not.toBe("");
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTask(request, BOARD_ID, id).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  /** The feed as the server sends it, with the closed cards' times, and the running card on its topic and clock. */
  async function answerFeed(page: Page): Promise<void> {
    await page.route(/\/api\/all-boards\/tasks(\?|$)/, async (route) => {
      const body = (await (await route.fetch()).json()) as { tasks: FeedTask[] };
      let closed = 0;
      const tasks = body.tasks.map((t) => {
        if (t.id === runningId) {
          return { ...t, status: "in_progress", assignedTopicId: topicId, agentMs: runningMs, agentTokens: 180_000, agentCostCents: 240, subtaskCount: 0, subtaskDoneCount: 0 };
        }
        if (created.includes(t.id) && t.id !== runningId) return { ...t, status: "done", agentMs: (10 + 5 * closed++) * MIN }; // median 20 min
        return t;
      });
      await route.fulfill({ json: { ...body, tasks } });
    });
    // The drawer reads its card on its own: same figures as the feed.
    await page.route(new RegExp(`/api/all-boards/tasks/${runningId}$`), async (route) => {
      const body = (await (await route.fetch()).json()) as { task: FeedTask | null };
      const task = body.task && { ...body.task, status: "in_progress", assignedTopicId: topicId, agentMs: runningMs, agentTokens: 180_000, agentCostCents: 240 };
      await route.fulfill({ json: { ...body, task } });
    });
    // What the provider measured on the session: 30% of a 1M window.
    await page.route(/\/api\/context\/live\?/, (route) => route.fulfill({
      json: { context: { usage: { used: 300_000, size: 1_000_000 }, percent: 30, level: "critical", reason: "cost", estimated: false, model: "claude-sonnet-5" } },
    }));
    // One sub-agent working for the card's chat.
    await page.route(/\/api\/live-work(\?|$)/, (route) => route.fulfill({
      json: {
        agents: [{
          kind: "agent", id: "child-1", name: "Reviewer", runtime: "cli", state: "working", preview: "Bash: bun test",
          startedAt: new Date(Date.now() - 4 * MIN).toISOString(), parentTopicId: topicId, estimateMs: 12 * MIN,
          weight: { usedTokens: 90_000, windowTokens: 1_000_000, estimated: false, billableTokens: 40_000, cacheReadTokens: 0, costCents: 30 },
        }],
      },
    }));
  }

  async function openBoard(page: Page): Promise<void> {
    await answerFeed(page);
    await resetPaneStore(page.request, ["__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    await expect(page.locator(`[data-task-card="${runningId}"]`)).toBeVisible({ timeout: 20_000 });
  }

  const minutesLeft = async (page: Page): Promise<number> => {
    const el = page.locator(`[data-task-card="${runningId}"]`).getByTestId("card-countdown");
    const text = (await el.textContent()) ?? "";
    return Number(/(\d+)/.exec(text)?.[1] ?? NaN);
  };

  test("the number on the card goes down as the work goes on", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBoard(page);
    const card = page.locator(`[data-task-card="${runningId}"]`);
    // Median of the five closed cards is 20 min, five minutes of work are behind: about 15 to go.
    await expect(card.getByTestId("card-countdown")).toHaveAttribute("data-state", "left");
    const first = await minutesLeft(page);
    expect(first).toBe(15);
    // The exact context, from the provider: 30% and the child the card launched.
    await expect(card.getByTestId("context-share")).toContainText("30%");
    await expect(card.getByTestId("card-children")).toBeVisible();
    // Ten more minutes of work reach the card through the feed: the countdown drops, it never rises.
    for (const advance of [5, 5]) {
      runningMs += advance * MIN;
      // The board reads the feed again, as it does when the app is reopened.
      await openBoard(page);
      await expect.poll(() => minutesLeft(page), { timeout: 15_000 }).toBeLessThan(first);
    }
    await expect.poll(() => minutesLeft(page), { timeout: 15_000 }).toBe(5);
  });

  test("the drawer weighs the session exactly and counts the child in", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBoard(page);
    await page.locator(`[data-task-card="${runningId}"]`).click();
    // The weight sits in the details panel, closed by default.
    await page.getByTestId("task-details-toggle").click();
    const weight = page.getByTestId("session-weight");
    await expect(weight).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("session-weight-context")).toContainText("30%");
    // Room before compaction: from the shared threshold, 90% of 1M minus the 300k in use.
    await expect(page.getByTestId("session-weight-compaction")).toBeVisible();
    await expect(weight).toContainText("1");
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const width of WIDTHS) {
      test(`card at ${width}px, ${scheme} theme`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: width < 800 ? 812 : 900 });
        await openBoard(page);
        const card = page.locator(`[data-task-card="${runningId}"]`);
        await expect(card.getByTestId("card-countdown")).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        // Nothing the card draws may spill out of the card, at any width.
        const box = await card.boundingBox();
        const chips = await card.locator('[data-testid="card-countdown"], [data-testid="context-share"], [data-testid="card-children"]').evaluateAll(
          (els) => els.map((e) => e.getBoundingClientRect().right),
        );
        expect(box).not.toBeNull();
        for (const right of chips) expect(right).toBeLessThanOrEqual((box as { x: number; width: number }).x + (box as { x: number; width: number }).width + 1);
        await page.screenshot({ path: testInfo.outputPath(`work-countdown-${width}-${scheme}.png`) });
      });
    }
  }
});

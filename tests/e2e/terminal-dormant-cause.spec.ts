/**
 * @covers TERM-11
 *
 * A DEAD PANE THAT SAYS WHY.
 *
 * On 2026-09-14 a restart cut twelve cards mid-turn. Every one of their panes
 * showed the same "Session ended" while the board card sat in progress, queued
 * for memory: from the pane there was no cause, no time and no way back to the
 * card, so it read as "stuck, full stop".
 *
 * The pane state is REAL here (a listed session with no PTY behind it, through
 * the orphan fixture); the CARD is stubbed at its boundary, the one door the
 * pane opens to learn the cause. Removing that read makes all three lines
 * disappear and three of these four tests go red.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  createTerminalSession,
  createTopic,
  deleteAllTerminalSessions,
  getTerminalSessionBuffer,
  resetPaneStore,
} from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

// A real PTY, a real bridge, then xterm: the terminal family runs on 75 s, see
// terminal-reconnect.spec.ts for the measurement behind the number.
test.describe.configure({ timeout: 75_000 });

/** The card as the board would send it, with only what the cause line reads. */
function card(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "card-e2e",
    projectId: "p1",
    text: "a card that was working here",
    status: "in_progress",
    priority: 2,
    createdAt: "2026-09-14T22:00:00.000Z",
    updatedAt: "2026-09-14T23:03:00.000Z",
    ...over,
  };
}

/** The only door the pane opens to learn the cause, answered by the test. */
async function stubCard(page: Page, task: Record<string, unknown> | null): Promise<void> {
  await page.route("**/api/all-boards/tasks/by-topic/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task }) }),
  );
}

test.describe("The cause line on a dormant pane", () => {
  let sessionId = "";
  let topicId = "";
  let otherTopicId = "";

  test.beforeEach(async ({ request }) => {
    await deleteAllTerminalSessions(request);
    const topic = await createTopic(request, "E2E cause topic");
    topicId = topic.id;
    const other = await createTopic(request, "E2E resumed topic");
    otherTopicId = other.id;
    const created = await createTerminalSession(request, {
      cwd: "/tmp", type: "shell", name: "E2E-Cause", topicId,
    });
    sessionId = created.id;
    // Orphan only a shell that really came up: a PTY killed mid-startup is a
    // different state, and not the one under test.
    await expect
      .poll(async () => (await getTerminalSessionBuffer(request, sessionId)).trim().length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const orphaned = await request.post(`${E2E_BASE}/api/test/terminal/${sessionId}/orphan`);
    expect(orphaned.ok(), "the orphan seam must be armed (TOPICS_E2E=1) and find the live session").toBe(true);
    await resetPaneStore(request, []);
  });

  async function openPane(page: Page): Promise<void> {
    await page.goto(`/tab/terminal/${sessionId}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
    await expect(page.getByTestId("terminal-dormant-overlay")).toBeVisible({ timeout: 30_000 });
  }

  test("a card cut by the restart: the line carries the hour and the card state", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-11" });
    test.slow();
    await stubCard(page, card({ assignedTopicId: topicId, interruptedAt: "2026-09-14T23:03:00.000Z" }));
    await openPane(page);
    const line = page.getByTestId("terminal-dormant-cause");
    await expect(line).toBeVisible({ timeout: 15_000 });
    // The hour is the reader's own clock, so it is derived here the same way.
    const clock = new Date("2026-09-14T23:03:00.000Z");
    const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
    await expect(line).toContainText(hhmm);
    await expect(line).toContainText("In Progress");
  });

  test("a card waiting on memory: the line carries the queue reason", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-11" });
    test.slow();
    await stubCard(page, card({
      assignedTopicId: topicId,
      dispatchState: "queued",
      interruptedAt: "2026-09-14T23:03:00.000Z",
      queueReason: {
        kind: "resource_floor",
        tone: "blocked",
        key: "board.queue.resourceFloor",
        params: { reason: "Memory 4.2 GB, under the 6 GB floor." },
      },
    }));
    await openPane(page);
    const line = page.getByTestId("terminal-dormant-cause");
    await expect(line).toBeVisible({ timeout: 15_000 });
    // The chip's own words, the ones the card shows: head and detail on the
    // line, and the figure behind the hover, exactly as on the board.
    // The app under test runs in Italian, so these are its words for the chip.
    // allow-italian: the strings the UI renders in this harness
    await expect(line).toContainText("la macchina non ha spazio");
    await expect(line).toHaveAttribute("title", /4\.2 GB/);
  });

  test("a card that restarted elsewhere: the link opens the new session", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-11" });
    test.slow();
    await stubCard(page, card({ assignedTopicId: otherTopicId, interruptedAt: "2026-09-14T23:03:00.000Z" }));
    await openPane(page);
    const link = page.getByTestId("terminal-dormant-resumed-link");
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    // The click is worth nothing if it does not land: the new topic's tab opens
    // and takes the focus.
    await expect(page.getByRole("region", { name: "E2E resumed topic panel" })).toBeVisible({ timeout: 20_000 });
  });

  test("a session no card ever worked: the overlay stays exactly as it was", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-11" });
    test.slow();
    await stubCard(page, null);
    await openPane(page);
    await expect(page.getByTestId("terminal-dormant-info")).toBeVisible();
    await expect(page.getByTestId("terminal-dormant-cause")).toHaveCount(0);
  });
});

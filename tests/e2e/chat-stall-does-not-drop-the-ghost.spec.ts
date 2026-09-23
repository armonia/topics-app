import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { VISIBLE_CHAT_SCROLLER, wheelUpUntilVisible } from "./helpers/wheel-scroll";

hermetic(test);

const BASE = E2E_BASE;

/**
 * THE GHOST `mergeHistoryPage` USED TO DROP.
 *
 * Reproduces from outside the defect fixed in `historyPaging.ts`: an
 * optimistic bubble (a client-generated id whose own `message:new` was
 * dropped as `isOwnStream`, so it never adopted a durable id) sits BEFORE
 * the pivot when a fresh page lands after a server stall. Before the fix,
 * `older = existing.slice(0, pivot).filter(durable)` threw it away, even
 * though `completeHistory` had never replaced it: it just vanished.
 *
 * The server is simulated with `page.route`: the first answer is the whole
 * thread (41 rows, the first one the ghost), the second - triggered by an
 * out-of-band `topic:updated`, the same trigger `chat-inflight-bubble-identity.spec.ts`
 * uses - is what the server actually sends after a stall (the 40 real rows,
 * it never had the ghost). A `setTimeout` before answering stands for the
 * stalled event loop reported on the task (4-7s measured on 23/09).
 *
 * The list is virtualized (react-virtuoso): only rows near the viewport are
 * mounted, so counting `.message-content` proves nothing about the store -
 * it only ever sees whatever is on screen. The ghost is the oldest message,
 * so it is reached with `wheelUpUntilVisible` (a real wheel gesture, the one
 * `chat-history-window.spec.ts` uses for the same reason) and asserted by its
 * own id, both before the stall and after the merge that follows it.
 */
test.use({ video: "on" });

const GHOST_ID = "msg_e2e_ghost_1758";
const GHOST_TEXT = "this message must never disappear from the screen";
const STALL_MS = 5_000;

const durableRow = (n: number) => ({
  id: `e2e-durable-${n}`,
  role: n % 2 ? "user" : "assistant",
  content: `row ${n}`,
  timestamp: new Date(Date.now() - (41 - n) * 1000).toISOString(),
});

test.describe("A pre-pivot ghost stays on screen through a server stall", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;
  let topic: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    topicName = `stall-ghost-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const topics = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const found = Object.values(topics.topics).find((x) => x.id === topicId)!;
    sessionKey = found.sessionKey;
    topic = found as unknown as Record<string, unknown>;
    expect(sessionKey, "the topic must have a sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("the ghost survives the stall and the page merge that follows it", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-HIST-01" });
    test.slow(); // includes the 5s simulated stall

    const durables = Array.from({ length: 40 }, (_, i) => durableRow(i + 1));
    const wholeThread = [{ ...durableRow(0), id: GHOST_ID, content: GHOST_TEXT }, ...durables];

    let historyCalls = 0;
    let lastHistoryAt = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/history/")) {
        historyCalls += 1;
        lastHistoryAt = Date.now();
      }
    });

    let inject: ((data: string) => void) | null = null;
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      if (historyCalls <= 1) {
        // Open: the pane already has the whole thread, ghost included.
        await route.fulfill({
          status: 200,
          json: { total: wholeThread.length, hasOrphanedMessage: false, compactionMarkers: [], messages: wholeThread },
        });
        return;
      }
      // The page after the stall: the real one, the server never saw the
      // ghost. The delay stands for the stalled event loop (task, 23/09).
      await new Promise((r) => setTimeout(r, STALL_MS));
      await route.fulfill({
        status: 200,
        json: { total: wholeThread.length, hasOrphanedMessage: false, compactionMarkers: [], messages: durables },
      });
    });
    // Armed before goto, or the initial connection would bypass it.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      inject = (data: string) => ws.send(data);
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => inject !== null, { timeout: 10_000 }).toBe(true);

    await expect(page.locator(VISIBLE_CHAT_SCROLLER)).toHaveAttribute("data-history", "complete", { timeout: 15_000 });

    // The ghost is the oldest message: reach it with a real wheel gesture,
    // the same one `chat-history-window.spec.ts` uses for an off-screen row.
    const ghost = page.locator(`[data-testid="chat-message"][data-message-id="${GHOST_ID}"]`);
    await wheelUpUntilVisible(page, ghost);
    await expect(ghost).toContainText(GHOST_TEXT);

    // The out-of-band reload: `topic:updated` triggers it (loadHistory's own
    // anti-bounce guard, the same threshold `ws-reconnect-catchup.spec.ts`
    // waits out), so the wait is for that named condition instead of a sleep.
    await expect.poll(() => Date.now() - lastHistoryAt, {
      message: "loadHistory's anti-bounce window has elapsed",
      timeout: 20_000,
      intervals: [500],
    }).toBeGreaterThan(5_500);

    inject!(JSON.stringify({ type: "topic:updated", sessionKey, topicId, topic }));

    await expect.poll(() => historyCalls, {
      message: "the second /api/history has started",
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(2);

    // The wheel gesture already suppressed the auto-scroll-to-bottom pin, so
    // the merge that follows the stall does not yank the view away: the same
    // ghost, at the same id, must still be right here once it lands.
    await expect(ghost).toContainText(GHOST_TEXT, { timeout: STALL_MS + 10_000 });
    await expect(page.locator(VISIBLE_CHAT_SCROLLER)).toHaveAttribute("data-history", "complete");
  });
});

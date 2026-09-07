/**
 * THE CATCH-UP A NEW SOCKET OWES, seen from outside.
 *
 * The connection status the interface shows is smoothed: it keeps saying
 * "connected" for three seconds so the status bar does not blink on a hiccup.
 * The reconnect backoff starts at one second, so an ordinary drop never moves
 * that status, and everything that used to hang off its edge (drain the
 * outbound queue, refresh the topic list, reload the open chats, re-announce
 * presence and subscriptions) simply did not run: the chat stayed on the turn
 * it had before the drop and the server heard nothing from this window.
 *
 * The trigger is now the socket's own re-open. This spec drops one socket
 * through the pass-through proxy and counts, on the socket that replaces it,
 * the two things the fix promises: a `presence:announce` from the client, and
 * a history fetch for the chat that is open.
 *
 * CONVENTION: no waitForTimeout. Condition-based waits only.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
const BASE = E2E_BASE;

test.describe("WS reconnect catch-up", () => {
  test("a dropped socket comes back and the open chat catches up", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "RUNTIME-18" });
    test.slow(); // the reconnect backoff is real time

    const ts = Date.now();
    const topic = await createTopic(page.request, `E2E-Reconnect-${ts}`);
    for (let i = 0; i < 4; i++) {
      await page.request.post(`${BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }

    // Pass-through proxy, installed before navigation so it sees the app's own
    // socket. Every client frame is inspected on its way to the server, which
    // is where `presence:announce` can be counted per socket.
    const serverConnections: { close: () => void }[] = [];
    const clientRoutes: { close: () => void }[] = [];
    let announces = 0;
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      serverConnections.push(server);
      clientRoutes.push(ws);
      ws.onMessage((msg) => {
        if (typeof msg === "string" && msg.includes('"presence:announce"')) announces += 1;
        server.send(msg);
      });
      server.onMessage((msg) => ws.send(msg));
    });

    let historyFetches = 0;
    let lastHistoryAt = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/history/")) {
        historyFetches += 1;
        lastHistoryAt = Date.now();
      }
    });

    await goToApp(page);
    await openTopic(page, new RegExp(`E2E-Reconnect-${ts}`));
    await expect(page.locator(".message-content").first()).toBeVisible({ timeout: 15_000 });

    // The chat has to be SETTLED before the drop, and that is a duration, not a
    // state: `useChat.loadHistory` skips a refetch for five seconds after the
    // previous one (HISTORY_DEDUP_MS), because between two fetches the WS keeps
    // the cache fresh. Dropping the socket inside that window would measure the
    // dedup, not the catch-up. So the precondition is named for what it is - the
    // window has elapsed since the page's own last history fetch - and polled on
    // the clock the request listener reads, instead of slept through.
    await expect.poll(() => Date.now() - lastHistoryAt, {
      message: "the history dedup window has elapsed since the chat loaded",
      timeout: 20_000,
      intervals: [500],
    }).toBeGreaterThan(5_500);

    expect(serverConnections.length).toBeGreaterThanOrEqual(1);
    const connectionsBefore = serverConnections.length;
    // Everything counted from here belongs to the socket that replaces this one.
    announces = 0;
    historyFetches = 0;

    // The drop: the client side of the proxy closes, so the browser fires the
    // real `onclose` and the hook's backoff starts.
    clientRoutes[clientRoutes.length - 1]!.close();

    await expect(async () => {
      expect(serverConnections.length).toBeGreaterThan(connectionsBefore);
    }).toPass({ timeout: 20_000 });

    // What the new socket owes: presence for this window, and the history of
    // the chat that stayed open across the drop. Before the fix both were zero.
    await expect.poll(() => announces, {
      message: "presence:announce on the socket that replaced the dropped one",
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => historyFetches, {
      message: "history refetched for the chat open across the drop",
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(1);

    await deleteTopic(page.request, topic.id);
  });
});

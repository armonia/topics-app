/**
 * A turn silent in a tool keeps its Stop in every window that watches it, and
 * a turn that is over, or was stopped, does not get one back.
 *
 * On 2026-09-25 (topic:3019832f) a live turn dropped out of the server's
 * streaming registry after three minutes without a provider event, which is
 * what a tool that prints nothing looks like. Every window but the sender's
 * reconciles against that registry: two misses and the chat was "finished",
 * the Stop gone, the queue drained, while the turn ran for twenty more
 * minutes. Nothing lit it again.
 *
 * The turns here are real server turns from a fake CLI whose Bash prints
 * nothing (`helpers/fake-claude-silent-tool.ts`). Where the sweep has to act,
 * its silence threshold is cut to 1 s (`/api/test/stale-stream-clock`) so its
 * real 30 s tick runs during the test and asks the child, which is alive. On a
 * checkout where `isStreaming` still had a clock, that cut hid the turn 29 s
 * out of 30.
 *
 * Two things are simulated, both at the network: a reply cut short without
 * [DONE] (a proxy or an idle timeout), by answering the page's own POST here
 * while the real one goes to the server; and a registry that dropped a live
 * turn (the bug above, or an older server), by answering the page's poll.
 *
 * @covers CHAT-REL-05
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { STOP, serverStreaming, openChat, removeSilentToolCli } from "./helpers/silent-tool-live";

hermetic(test);

test.describe("a turn silent in a tool for longer than the stale threshold", () => {
  test.describe.configure({ timeout: 240_000 });
  // The app's service worker has a fetch handler: a page it controls sends
  // `/api/chat` through it, where `page.route` never sees the request.
  test.use({ serviceWorkers: "block" });

  // The threshold is the whole test server's: a spec that dies before its own
  // cleanup must not leave the next ones on 1 s.
  test.afterEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: {} }).catch(() => {});
    removeSilentToolCli();
  });
  test("a viewer that took a live turn for over is lit again by its next line and by its next tool", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "relight");
    try {
      const turn = request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "pulse 50 50" }] },
        timeout: 200_000,
      });
      const stop = page.locator(STOP).first();
      await expect(stop).toBeVisible({ timeout: 30_000 });
      // The registry says nothing is running, to this page only: its reconciler
      // settles the live turn, as every window did before the server fix.
      await page.route("**/api/topics/streaming", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) }));
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 45_000 });
      expect(await serverStreaming(request, sessionKey)).toBe(true);

      // The turn's next line is a live frame of it.
      await expect(page.getByText("PULSE-TEXT").first()).toBeVisible({ timeout: 45_000 });
      await expect(stop, "a live line did not light the turn again").toBeVisible({ timeout: 3_000 });

      // Settled again, and its next tool call is a live frame too.
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 45_000 });
      await expect(page.getByText("echo relit").first()).toBeVisible({ timeout: 45_000 });
      await expect(stop, "a live tool call did not light the turn again").toBeVisible({ timeout: 3_000 });

      await expect(page.getByText("PULSE-DONE").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      expect((await turn).ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

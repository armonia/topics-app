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
import { STOP, watchStop, openChat, cutFirstReply, removeSilentToolCli } from "./helpers/silent-tool-live";

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
  test("the viewer keeps the Stop through the silence, and loses it only when the turn ends", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "silent-tool");
    try {
      expect((await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: { timeoutMs: 1_000 } })).ok()).toBe(true);
      // Sent from outside this page: its own SSE would keep it lit whatever the registry said.
      const turn = request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "silent 50" }] },
        timeout: 150_000,
      });
      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(STOP).first()).toBeVisible({ timeout: 10_000 });

      // Well past the threshold and two registry polls.
      const trace = await watchStop(page, 42_000);
      expect(trace, "the Stop went away during a silent tool").toEqual([{ t: 0, on: true }]);

      // The gate reads the same registry: a second turn waits for this one.
      const second = await request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "a second turn" }] },
      });
      expect(second.status()).toBe(409);

      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      expect((await turn).ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("the sender whose reply was cut short without [DONE] keeps the Stop while the server runs the turn", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "silent-cut");
    try {
      const chat = await cutFirstReply(page, request, sessionKey);
      await chatPage.sendMessage("silent 25");
      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 30_000 });

      const trace = await watchStop(page, 12_000);
      expect(trace, "the Stop went away after the reply was cut").toEqual([{ t: 0, on: true }]);

      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
      await expect(page.locator(STOP)).toHaveCount(0, { timeout: 15_000 });
      expect((await chat.turn())?.ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  /**
   * The race behind the test above failing its first attempt in CI: the page
   * reads the history the moment its reply is cut, and the turn's first line
   * is said while that answer is on its way. The answer does not hold the line
   * yet, and the socket frame that carries it reached the page while its own
   * reply still held the session, which swallows every frame of it. The line
   * showed only at the turn's end, 25 s later, with no Stop in between to see.
   */
});

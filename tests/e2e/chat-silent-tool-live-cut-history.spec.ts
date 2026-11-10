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
 * tick is cut to 1 s too (`tickMs`) and runs during the test and asks the child, which is alive. On a
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
import { STOP, serverStreaming, watchStop, expectStopGoesAndStays, openChat, cutFirstReply, holdNextHistory, recordStreamEnds, recordFrames, removeSilentToolCli } from "./helpers/silent-tool-live";

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
  test("a line the turn says while the cut reply's history is in flight reaches the sender", async ({ page, request, chatPage }) => {
    const said = recordFrames(page, "Starting a silent tool.");
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-line");
    try {
      const history = await holdNextHistory(page, sessionKey);
      await cutFirstReply(page, request, sessionKey, history.arm);
      // Two seconds before the first line: the held read has none of it.
      await chatPage.sendMessage("silent 25 after 2");
      await history.held;
      await expect.poll(() => said.size > 0, { timeout: 15_000, message: "the line reaches the page's socket" }).toBe(true);
      history.release();

      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 5_000 });
      expect(await serverStreaming(request, sessionKey), "the line showed while the turn runs").toBe(true);
      await expect(page.locator(STOP).first()).toBeVisible();
      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a turn that ends while the cut reply's history is in flight gets no Stop back, and shows its end", async ({ page, request, chatPage }) => {
    const ended = recordStreamEnds(page);
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-ends");
    try {
      const history = await holdNextHistory(page, sessionKey);
      await cutFirstReply(page, request, sessionKey, history.arm);
      await chatPage.sendMessage("silent 3");
      // The reload was answered "still streaming", and the turn ends before the
      // page reads it: its stream:end reaches the page while the page's own SSE
      // still holds the session.
      await history.held;
      await expect.poll(() => ended.has(sessionKey), { timeout: 30_000, intervals: [200] }).toBe(true);
      history.release();

      expectStopGoesAndStays(await watchStop(page, 15_000), 3, "a Stop on a finished turn");
      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a turn started from another window while the cut reply's history is in flight gets its Stop", async ({ page, request, chatPage }) => {
    const ended = recordStreamEnds(page);
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-next");
    try {
      // The pane was opened a moment ago, as when this goes wrong: its first
      // history read is still inside the 5 s dedup when the cut reply's reread
      // comes. The page's clock stops here to hold that, whatever the machine's
      // load; its timers keep running.
      await page.clock.setFixedTime(new Date());
      const history = await holdNextHistory(page, sessionKey);
      await cutFirstReply(page, request, sessionKey, history.arm);
      await chatPage.sendMessage("silent 3");
      await history.held;
      await expect.poll(() => ended.has(sessionKey), { timeout: 30_000, intervals: [200] }).toBe(true);
      // The next turn starts elsewhere; its stream:start reaches this page while
      // the page's own SSE still holds the session, so only a fresh read shows it.
      const next = request.post(`${E2E_BASE}/api/chat`, { data: { sessionKey, messages: [{ role: "user", content: "silent 25" }] }, timeout: 150_000 });
      await expect.poll(() => serverStreaming(request, sessionKey), { timeout: 20_000, intervals: [200] }).toBe(true);
      history.release();

      const trace = await watchStop(page, 12_000);
      expect(await serverStreaming(request, sessionKey), "the next turn still runs").toBe(true);
      expect(trace.at(-1)?.on, `a live turn without its Stop: ${JSON.stringify(trace)}`).toBe(true);
      const lastOff = [...trace].reverse().find((x) => !x.on)?.t ?? 0;
      expect(lastOff, `a live turn dark too long: ${JSON.stringify(trace)}`).toBeLessThan(4);
      expect((await next).ok()).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a Stop pressed while the cut reply's history is in flight stays pressed, and the queue stays put", async ({ page, request, chatPage }) => {
    const { topic, sessionKey } = await openChat(page, request, chatPage, "cut-stop", true);
    try {
      const history = await holdNextHistory(page, sessionKey);
      const chat = await cutFirstReply(page, request, sessionKey, history.arm);
      await chatPage.sendMessage("silent 60");
      await history.held;
      const stop = page.locator(STOP).first();
      await expect(stop).toBeVisible({ timeout: 5_000 });
      await chatPage.sendMessage("QUEUED-AFTER-STOP");
      await stop.click();
      await expect.poll(() => serverStreaming(request, sessionKey), { timeout: 15_000, intervals: [200] }).toBe(false);
      history.release();

      expectStopGoesAndStays(await watchStop(page, 15_000), 3, "the stopped turn lit again");
      expect(chat.posts.filter((c) => c.includes("QUEUED-AFTER-STOP")), "a stopped turn's queue fired").toEqual([]);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

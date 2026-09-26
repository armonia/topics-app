import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE COMPOSER REMEMBERS, AND THE CHAT COUNTS WHAT YOU ASKED.
 *
 * Asked on 23/09: ↑ in an empty composer should bring back the previous prompt
 * (the shell and Claude Code both do), and each prompt should say which one it
 * is («#50»). Same day, «Objective still open: ...» showed up as the person's
 * own bubble: the goal loop's continuation reached the live window without the
 * mark that makes it a service line. Three behaviours, one chat:
 *  - ↑/↓ walk the person's prompts, not the machine's rows;
 *  - every person prompt carries its number, machine rows do not move it;
 *  - a continuation arriving LIVE is drawn as a service line, not a bubble.
 * @covers CHAT-04
 */
test.describe("composer history and prompt numbers", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";

  const row = (request: import("@playwright/test").APIRequestContext, role: "user" | "assistant", content: string, blocks?: unknown[]) =>
    request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
      data: { role, content, ...(blocks ? { blocks } : {}) },
      ignoreHTTPSErrors: true,
    });

  test.beforeAll(async ({ request }) => {
    topicName = `prompt-history-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const body = await (await request.get(`/api/topics`, { ignoreHTTPSErrors: true })).json();
    sessionKey = (body.topics ?? {})[topicId]?.sessionKey;
    if (!sessionKey) throw new Error("topic without sessionKey");
    await row(request, "user", "rifai le zanne come nella guida");
    await row(request, "assistant", "Fatto, v12.");
    await row(request, "user", "Objective still open: Kaumat v14. Continue.", [{ kind: "goal-nudge", attempt: 1 }]);
    await row(request, "assistant", "Continuo con i colori.");
    await row(request, "user", "arti più lunghi\ne volto più largo");
    await row(request, "assistant", "Fatto, v13.");
  });
  test.afterAll(async ({ request }) => { if (topicId) await deleteTopic(request, topicId).catch(() => {}); });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, [topicId]); });

  test("↑ recalls the person's prompts, each one is numbered, machine rows are not", async ({ page, chatPage }) => {
    const ws = await interceptWebSocket(page);
    await page.clock.install();
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

    // Numbers: two person prompts, the continuation in between does not count.
    await expect(page.getByTestId("prompt-number")).toHaveText(["#1", "#2"], { timeout: 15_000 });
    await expect(page.getByTestId("goal-loop-row")).toHaveCount(1);

    // The page's clock stands still through the three ↑: where a recall puts
    // the caret has to be settled before the next key, not a frame later. A
    // frame late, it moved the caret back to the last line after ↑ had taken it
    // to the first, and the third ↑ went nowhere (WebKit: 1 run in 4 on main,
    // 3 in 3 on one CI round).
    await page.clock.pauseAt(Date.now() + 1_000);
    // ↑ from empty: the newest prompt, whole (two lines).
    const input = chatPage.messageInput;
    await input.click();
    await input.press("ArrowUp");
    await expect(input).toHaveValue("arti più lunghi\ne volto più largo");
    // The caret is at the end, on the second line: ↑ moves it, it does not skip.
    await input.press("ArrowUp");
    await expect(input).toHaveValue("arti più lunghi\ne volto più largo");
    // Whatever a pending frame would do lands here, between the two keys.
    await page.clock.runFor(100);
    // From the first line, ↑ goes further back, past the machine's row.
    await input.press("ArrowUp");
    await expect(input).toHaveValue("rifai le zanne come nella guida");
    // ↓ comes back, and past the newest the field is empty again.
    await input.press("ArrowDown");
    await expect(input).toHaveValue("arti più lunghi\ne volto più largo");
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("");
    await page.clock.resume();

    // A continuation arriving LIVE, the way the server sends it now: with its
    // marks. It must land as a service line, never as the person's bubble.
    ws.send({
      type: "message:new", topicId, sessionKey, role: "user", messageId: `live-nudge-${Date.now()}`,
      content: "Objective still open: Kaumat v14. Continue.", preview: "Objective still open",
      blocks: [{ kind: "goal-nudge", attempt: 2 }],
    });
    await expect(page.getByTestId("goal-loop-row")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]', { hasText: "Objective still open" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("prompt-history.png") });
  });
});

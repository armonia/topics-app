/**
 * THE ROW OF A LONG COMMAND SHOWS ITS LAST LINES WHILE IT RUNS.
 *
 * Tool UX review of 23/09, finding 7: a `bash` at p90 lasts 65-115 s, and for
 * all that time its row showed a spinner and `$ command`. Nothing said whether
 * it was working, stuck on a prompt or failing at test 3 of 400. The output did
 * reach the client for codex, acp and openclaw (`stream:tool_update`), but the
 * row's typed `shell` detail had no `output` and the card showed nothing.
 *
 * Driven from the wire, not from a local send: `handleStreamEvent` drops the
 * session's frames in a window that owns the turn's SSE (only the exceptions of
 * `senderAlsoSees.ts` pass), so this is the window watching a turn another one
 * started. The frames have the shapes the server sends: a `shell` detail with
 * no output at `stream:tool_call`, the whole current tail in each
 * `stream:tool_update`, and the final output inside `detail` at
 * `stream:tool_result`.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** `r1` … `rN`, one per line, as a command prints them. */
function numbered(n: number, from = 1): string[] {
  return Array.from({ length: n - from + 1 }, (_, i) => `r${from + i}`);
}

test.describe("Running tail of a long command", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";

  test.beforeAll(async ({ request }) => {
    topicName = `live-tail-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    // The server assigns the session key: reading it back makes a change of
    // convention fail loudly here instead of injecting frames nobody collects.
    const body = await (await request.get(`/api/topics`, { ignoreHTTPSErrors: true })).json();
    const found = (body.topics ?? {})[topicId];
    if (!found?.sessionKey) throw new Error("the topic has no sessionKey: the frames cannot be injected");
    sessionKey = found.sessionKey;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("the tail follows the command, then makes way for the result", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-08" });
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    // The history lands after the topic opens and rewrites the session's
    // messages: a frame injected before it would be wiped.
    const history = page
      .waitForResponse((r) => r.url().includes("/history/"), { timeout: 20_000 })
      .catch(() => null);
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await history;
    await expect.poll(() => ws.getByType("subscribe").some(({ direction, data }) =>
      direction === "client" && JSON.parse(data).topicIds?.includes(topicId))).toBe(true);

    const messageId = `live-tail-${Date.now()}`;
    const toolCallId = "toolu_live_tail_e2e";
    const command = "bun test";
    ws.send({ type: "stream:start", sessionKey, topicId, messageId });
    ws.send({
      type: "stream:tool_call",
      sessionKey,
      topicId,
      toolCall: { id: toolCallId, name: "Bash", args: { command }, status: "running", detail: { type: "shell", command } },
    });
    const row = page.getByTestId(`tool-call-row-${toolCallId}`);
    await expect(row).toHaveAttribute("data-status", "running", { timeout: 10_000 });

    const tail = row.getByTestId("shell-running-tail");
    const tailLines = tail.getByTestId("shell-running-tail-line");

    // Twelve lines: the body opens by itself and shows the last eight, with
    // the notice that more sits above them.
    ws.send({ type: "stream:tool_update", sessionKey, topicId, toolCallId, partialResult: numbered(12).join("\n") });
    await expect(tail).toBeVisible({ timeout: 10_000 });
    await expect(tailLines).toHaveText(numbered(12, 5));
    await expect(tail).toContainText("Sopra c'è altro output");

    // The whole tail again, longer: the lines follow, the height does not grow.
    ws.send({ type: "stream:tool_update", sessionKey, topicId, toolCallId, partialResult: numbered(20).join("\n") });
    await expect(tailLines).toHaveText(numbered(20, 13));
    await row.screenshot({ path: test.info().outputPath("running-tail.png") });

    const finalOutput = "400 pass\n0 fail";
    ws.send({
      type: "stream:tool_result",
      sessionKey,
      topicId,
      toolCallId,
      status: "success",
      result: finalOutput,
      detail: { type: "shell", command, output: finalOutput, exitCode: 0 },
    });
    await expect(row).toHaveAttribute("data-status", "success", { timeout: 10_000 });
    await expect(tail).toHaveCount(0);

    // The auto-opened body closes after its dwell (CHAT-TOOL-03, unchanged);
    // waiting for that and opening it by hand reads the result without racing
    // the timer.
    await expect(row.getByTestId("tool-call-args")).toHaveCount(0, { timeout: 10_000 });
    await row.getByRole("button").first().click();
    const result = row.getByTestId("tool-call-result");
    await expect(result).toContainText("400 pass");
    await expect(result).toContainText("0 fail");
    await expect(tail).toHaveCount(0);

    ws.send({ type: "stream:end", sessionKey, topicId, messageId });
  });
});

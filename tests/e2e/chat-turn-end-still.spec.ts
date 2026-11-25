/**
 * NOTHING IN THE TURN MOVES WHEN IT ENDS, NOT EVEN WHEN THE LOADER GOES.
 *
 * The owner's report (30/10, card 40ea050c): "reasoning repositions itself as
 * soon as it has finished", and on 31/10: "even when the loading goes away it
 * must not jump". Measured in production at 100 ms (provider Topics): the row
 * appeared only at the end, then went 562 -> 557 -> 556. The independent check
 * of 31/10 (WebKit, real server, real send) found it again in the window the
 * message was sent from: the row was born 43 ms after the loader had gone and
 * went down 6 px, the answer text and the meta row 6.5 px. The causes:
 *   - the sender reads its turn from its own SSE and drops the WS copies, and
 *     the reasoning travelled only on WS: no row was reserved there, it came
 *     with the history reload after the turn;
 *   - that reload renames the bubble (`msg_…` -> the server's id), and the
 *     rename was taken for a new message: the 6px entrance slide replayed on a
 *     bubble already on screen (`messageEntrance.ts`);
 *   - the native runtime announced a reasoning block that never carries text
 *     (`redacted_thinking`), and the row reserved for it vanished at the end.
 *
 * The turns here are REAL server turns on the native runtime (provider Topics),
 * sent from the composer of the window that is measured; only the model is fake
 * (`helpers/fake-anthropic-api.ts`). A second window on the same chat, which
 * gets the turn over WS, is measured at the same time.
 *
 * Every frame (rAF) from the settled live turn to 1.5 s after the loader has
 * gone, both windows record the top of the reasoning row, of the answer's
 * text and of the meta row. The bar: each of them is on screen in every frame
 * and moves 0 px.
 *
 * @covers USAGE-20
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { deleteTopic } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";
import { judge, judgeFromText, framesOf, nativeRuntime, nativeTopic, openChat, startSampler, spread } from "./helpers/turn-end-sampler";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic, type FakeRound } from "./helpers/fake-anthropic-api";

hermetic(test);
// The entrance slide is part of what is measured: with reduced motion it
// would not play, and its replay on the renamed bubble would go unseen.
test.use({ contextOptions: { reducedMotion: "no-preference" } });

const REASONING = "Let me look at the question first.";
const ANSWER = "ANSWER-STILL the answer, streamed live after the reasoning.";
const ANSWER_REDACTED = "ANSWER-REDACTED the answer after a redacted reasoning block.";
const ANSWER_TOOLS = "ANSWER-TOOLS the answer after a round of tools.";
const ANSWER_QUICK = "ANSWER-QUICK the answer, and the turn ends right behind its last word.";
const echo = (word: string) => ({ name: "bash", input: { command: `echo ${word}` } });

/**
 * How long the fake model keeps a turn live after its answer. The sampler
 * needs the answer on screen and 10 still frames WHILE the turn is live
 * ("the turn ended before it settled" otherwise); with 3 s, two WebKit pages
 * on a loaded CI runner did not always get there (the fold tests, and the
 * wheel test on other commits). A longer hold changes nothing that is judged:
 * recording still ends 1.5 s after the loader goes.
 */
const LIVE_HOLD_MS = 20_000;

const SCRIPTS: Record<string, FakeRound[]> = {
  // The reasoning alone for a while, then the answer, then the turn stays
  // live long enough to settle before it ends.
  still: [{ thinking: REASONING, afterThinkingMs: 1_000, text: ANSWER, holdMs: LIVE_HOLD_MS }],
  // A block that never carries text: nothing to reserve, nothing to vanish.
  redacted: [{ redactedThinking: true, afterThinkingMs: 1_000, text: ANSWER_REDACTED, holdMs: LIVE_HOLD_MS }],
  // Work enough to fold (`turnFold.ts`, two tools or more), then a last round
  // with the answer alone. The turn this window watched must not fold when
  // its reload renames it: the check of 31/10 saw the reasoning row vanish
  // into «N actions», the text and the meta row move 0.6-0.7 px and the
  // transcript above jump 107 px (2 tools) and 218 px (3 tools).
  twotool: [
    { thinking: REASONING, afterThinkingMs: 500, tools: [echo("one"), echo("two")] },
    { text: ANSWER_TOOLS, holdMs: LIVE_HOLD_MS },
  ],
  // The answer's text and the end of the turn back to back, no pause: on
  // the wire they reach the client in the same read. The check of 31/10 saw
  // the text drawn only in the frame the loader went, the row 27 px higher.
  quick: [{ thinking: REASONING, afterThinkingMs: 2_000, text: ANSWER_QUICK }],
  manytool: [
    { thinking: REASONING, afterThinkingMs: 500, tools: [echo("one"), echo("two"), echo("three")] },
    { text: ANSWER_TOOLS, holdMs: LIVE_HOLD_MS },
  ],
};

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

test.describe("the end of a turn moves nothing, in the window that sent it and in another", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    fake = await startFakeAnthropic(SCRIPTS);
    undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
    workspace = mkdtempSync(join(tmpdir(), "turn-end-still-"));
    expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });
  });
  test.afterAll(async () => {
    await nativeRuntime({ on: false }).catch(() => {});
    undoFake?.();
    await fake?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("the reasoning row is reserved live, and row, text and meta stay put through the loader going", async ({ page, request, chatPage, context }) => {
    const topic = await nativeTopic(request, "turn-end-still");
    const viewer = await context.newPage();
    await openChat(viewer, topic.name);
    await openChat(page, topic.name);

    await startSampler(page, "ANSWER-STILL");
    await startSampler(viewer, "ANSWER-STILL");
    await chatPage.sendMessage("SCEN:still go");

    // The row is there while the turn is live, in the window it was sent from.
    const live = page.locator('[data-role="assistant"]').filter({ has: page.getByTestId("reasoning-row") }).last();
    await expect(live.getByTestId("reasoning-row")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-streaming-indicator")).toBeVisible();

    const sender = await framesOf(page);
    const second = await framesOf(viewer);
    await expect(page.getByTestId("chat-streaming-indicator")).toHaveCount(0);
    await expect(live.getByTestId("reasoning-row")).toContainText(`${REASONING.length} chars`);
    judge("sender", sender, { row: true });
    judge("second window", second, { row: true });
    await viewer.close();
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a reasoning block that never carries text reserves no row, so none vanishes", async ({ page, request, chatPage, context }) => {
    const topic = await nativeTopic(request, "turn-end-redacted");
    const viewer = await context.newPage();
    await openChat(viewer, topic.name);
    await openChat(page, topic.name);

    await startSampler(page, "ANSWER-REDACTED");
    await startSampler(viewer, "ANSWER-REDACTED");
    await chatPage.sendMessage("SCEN:redacted go");

    const sender = await framesOf(page);
    const second = await framesOf(viewer);
    judge("sender", sender, { row: false });
    judge("second window", second, { row: false });
    await viewer.close();
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("an answer that ends right behind its last word is drawn before the loader goes, and nothing moves", async ({ page, request, chatPage, context }) => {
    const topic = await nativeTopic(request, "turn-end-quick");
    const viewer = await context.newPage();
    await openChat(viewer, topic.name);
    await openChat(page, topic.name);

    await startSampler(page, "ANSWER-QUICK", "row");
    await startSampler(viewer, "ANSWER-QUICK", "row");
    await chatPage.sendMessage("SCEN:quick go");

    const sender = await framesOf(page);
    const second = await framesOf(viewer);
    judgeFromText("sender", sender);
    judgeFromText("second window", second);
    await viewer.close();
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a reader who scrolled up with the wheel stays where they are when the turn ends", async ({ page, request, chatPage }) => {
    const topic = await nativeTopic(request, "turn-end-wheel");
    await openChat(page, topic.name);
    await chatPage.sendMessage("SCEN:still go");

    // The answer is live; the reader goes up 400 px with a real wheel (`wheelUp`).
    await expect(page.getByText("ANSWER-STILL", { exact: false })).toBeVisible({ timeout: 15_000 });
    const scroller = page.locator('[data-testid="chat-message-list"]:visible');
    const box = await scroller.boundingBox();
    if (!box) throw new Error("the chat scroller has no box to wheel over");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await wheelUp(page, scroller, 400);
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(300);
    await expect(page.getByTestId("chat-streaming-indicator")).toBeVisible();

    await startSampler(page, "ANSWER-STILL");
    const frames = await framesOf(page);
    const report = `wheel: ${frames.length} frames, scroll ${frames[0]?.scroll} -> ${frames[frames.length - 1]?.scroll}, row ${spread(frames.map((f) => f.row)).toFixed(2)} px, above ${spread(frames.map((f) => f.above)).toFixed(2)} px`;
    console.log(`TURN-END ${report}`);
    expect(frames.some((f) => f.loader), report).toBe(true);
    expect(frames.some((f) => !f.loader), report).toBe(true);
    expect(frames.filter((f) => f.scroll === null), report).toHaveLength(0);
    expect(spread(frames.map((f) => f.scroll)), report).toBe(0);
    expect(spread(frames.map((f) => f.row)), report).toBe(0);
    expect(spread(frames.map((f) => f.above)), report).toBe(0);
    await deleteTopic(request, topic.id).catch(() => {});
  });

  for (const scenario of ["twotool", "manytool"] as const) {
    test(`a turn with work enough to fold (${scenario}) does not fold under the eyes of the window that sent it`, async ({ page, request, chatPage, context }) => {
      const topic = await nativeTopic(request, `turn-end-${scenario}`);
      const viewer = await context.newPage();
      await openChat(viewer, topic.name);
      await openChat(page, topic.name);

      await startSampler(page, "ANSWER-TOOLS");
      await startSampler(viewer, "ANSWER-TOOLS");
      await chatPage.sendMessage(`SCEN:${scenario} go`);

      const sender = await framesOf(page);
      const second = await framesOf(viewer);
      judge("sender", sender, { row: true });
      judge("second window", second, { row: true });
      // Spread out, as it streamed: no «N actions» row over the answer.
      const last = page.locator('[data-message-id][data-role="assistant"]').last();
      await expect(last.getByTestId("reasoning-row")).toBeVisible();
      await expect(last.getByTestId("turn-work-fold")).toHaveCount(0);
      await viewer.close();
      await deleteTopic(request, topic.id).catch(() => {});
    });
  }
});

/** How far the view rests from the bottom once a turn of the wheel is over: on WebKit it is animated. */
async function restingDistance(scroller: Locator): Promise<number> {
  let last: number | null = null;
  await expect.poll(async () => {
    const top = await scroller.evaluate((el) => el.scrollTop);
    const resting = top === last;
    last = top;
    return resting;
  }, { intervals: [200] }).toBe(true);
  return scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

/**
 * The reader turns the wheel up over `scroller` for `by` px from the bottom,
 * and turns it again for the rest while the view rests within three quarters
 * of that, as a hand whose turn fell short would.
 *
 * On the Linux runner WebKit animates a turn of the wheel, and a scroll from
 * script stops the animation where it is. On the way up a history row mounts,
 * Virtuoso corrects the height it had estimated for it (144 px for 110) with
 * `scrollBy(-34)`, and when that came early in the animation the turn stopped
 * 140 to 260 px up: the reader never got 300 px away, in 6 runs in 20 on main
 * (run 42344140943) and 4 in 20 with the turn-end fixes (run 42344143197),
 * never in Chromium. Never more than `by` in all: the sampler needs the
 * answer's text mounted, inside Virtuoso's overscan.
 */
async function wheelUp(page: Page, scroller: Locator, by: number): Promise<void> {
  let reached = 0;
  for (let turn = 0; turn < 3 && reached <= by * 0.75; turn++) {
    await page.mouse.wheel(0, -(by - reached));
    reached = await restingDistance(scroller);
  }
}

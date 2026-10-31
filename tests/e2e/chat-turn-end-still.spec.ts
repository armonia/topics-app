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
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
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

const SCRIPTS: Record<string, FakeRound[]> = {
  // The reasoning alone for a while, then the answer, then the turn stays
  // live long enough to settle before it ends.
  still: [{ thinking: REASONING, afterThinkingMs: 1_000, text: ANSWER, holdMs: 3_000 }],
  // A block that never carries text: nothing to reserve, nothing to vanish.
  redacted: [{ redactedThinking: true, afterThinkingMs: 1_000, text: ANSWER_REDACTED, holdMs: 3_000 }],
  // Work enough to fold (`turnFold.ts`, two tools or more), then a last round
  // with the answer alone. The turn this window watched must not fold when
  // its reload renames it: the check of 31/10 saw the reasoning row vanish
  // into «N actions», the text and the meta row move 0.6-0.7 px and the
  // transcript above jump 107 px (2 tools) and 218 px (3 tools).
  twotool: [
    { thinking: REASONING, afterThinkingMs: 500, tools: [echo("one"), echo("two")] },
    { text: ANSWER_TOOLS, holdMs: 3_000 },
  ],
  // The answer's text and the end of the turn back to back, no pause: on
  // the wire they reach the client in the same read. The check of 31/10 saw
  // the text drawn only in the frame the loader went, the row 27 px higher.
  quick: [{ thinking: REASONING, afterThinkingMs: 2_000, text: ANSWER_QUICK }],
  manytool: [
    { thinking: REASONING, afterThinkingMs: 500, tools: [echo("one"), echo("two"), echo("three")] },
    { text: ANSWER_TOOLS, holdMs: 3_000 },
  ],
};

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

async function nativeRuntime(body: { on: boolean; workspace?: string }): Promise<unknown> {
  const res = await fetch(`${E2E_BASE}/api/test/native-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** A provider-Topics chat with enough history to scroll: the turn ends pinned to the bottom. */
async function nativeTopic(request: APIRequestContext, name: string) {
  const topic = await createTopic(request, `${name}-${Date.now()}`);
  await patchTopic(request, topic.id, { provider: "topics" });
  for (let i = 0; i < 12; i++) {
    await request.post(`${E2E_BASE}/api/test/topics/${topic.id}/session-row`, {
      data: { role: i % 2 ? "assistant" : "user", content: `Message ${i}. `.repeat(40) },
    });
  }
  await resetPaneStore(request, [topic.id]);
  return topic;
}

async function openChat(page: Page, name: string) {
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(name));
  await page.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }).waitFor({ state: "visible", timeout: 15_000 });
}

type Frame = { t: number; loader: boolean; row: number | null; text: number | null; meta: number | null; metaLive: boolean; above: number | null; scroll: number | null };

/**
 * Starts, in the page, a per-frame sampler of the LAST assistant bubble: found
 * again every frame by position, because the bubble changes id at the end of
 * the turn. It waits until the answer's text is on screen and every measured
 * top has held for 10 frames, then records until 1.5 s after the loader went.
 * `above` is the prompt's bubble, the last user row: the transcript over the
 * turn, which a bubble that shrank or grew would push. `scroll` is the
 * scroller's `scrollTop`.
 * `settleOn: "row"` starts recording once the reasoning row has held, before
 * any text: for a turn whose text and end come together, the frame the text
 * is first drawn in is part of what is judged.
 */
async function startSampler(page: Page, marker: string, settleOn: "text" | "row" = "text"): Promise<void> {
  await page.evaluate(({ marker, settleOn }) => {
    const w = window as unknown as { __still: { frames: Frame[]; done: boolean; error?: string } };
    w.__still = { frames: [], done: false };
    const topOf = (el: Element | null) => (el ? el.getBoundingClientRect().top : null);
    const textTop = (bubble: Element): number | null => {
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.includes(marker)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        return range.getBoundingClientRect().top;
      }
      return null;
    };
    const sample = () => {
      const bubbles = document.querySelectorAll('[data-message-id][data-role="assistant"]');
      const bubble = bubbles[bubbles.length - 1] ?? null;
      const meta = bubble?.querySelector('[data-testid="message-meta-row"]') ?? null;
      const prompts = document.querySelectorAll('[data-message-id][data-role="user"]');
      return {
        above: topOf(prompts[prompts.length - 1] ?? null),
        loader: !!document.querySelector('[data-testid="chat-streaming-indicator"]'),
        row: bubble ? topOf(bubble.querySelector('[data-testid="reasoning-row"]')) : null,
        text: bubble ? textTop(bubble) : null,
        meta: topOf(meta),
        metaLive: meta?.getAttribute("data-live") === "true",
        scroll: (document.querySelector('[data-testid="chat-message-list"]') as HTMLElement | null)?.scrollTop ?? null,
      };
    };
    let steady = 0;
    let previous: ReturnType<typeof sample> | null = null;
    let recording = false;
    let t0 = 0;
    let stopAt: number | null = null;
    const tick = () => {
      const s = sample();
      if (!recording) {
        const same = !!previous && previous.row === s.row && previous.text === s.text && previous.meta === s.meta && previous.above === s.above;
        const ready = settleOn === "row" ? s.row !== null && s.text === null : s.text !== null;
        steady = s.loader && ready && same ? steady + 1 : 0;
        previous = s;
        if (steady >= 10) { recording = true; t0 = performance.now(); }
        else if (!s.loader && s.text !== null) { w.__still.error = "the turn ended before it settled"; w.__still.done = true; return; }
        requestAnimationFrame(tick);
        return;
      }
      const t = performance.now() - t0;
      w.__still.frames.push({ t: Math.round(t), ...s });
      if (!s.loader && stopAt === null) stopAt = t + 1_500;
      if (stopAt !== null && t >= stopAt) { w.__still.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { marker, settleOn });
}

async function framesOf(page: Page): Promise<Frame[]> {
  await page.waitForFunction(() => (window as unknown as { __still: { done: boolean } }).__still.done, null, { timeout: 30_000 });
  const { frames, error } = await page.evaluate(() => (window as unknown as { __still: { frames: Frame[]; error?: string } }).__still);
  expect(error, "the sampler saw a settled live turn").toBeUndefined();
  return frames;
}

const spread = (values: Array<number | null>) => {
  const ys = values.filter((v): v is number => v !== null);
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
};

/** The end of the turn as one window lived it: the loader went, nothing moved. */
function judge(who: string, frames: Frame[], opts: { row: boolean }) {
  const report = `${who}: ${frames.length} frames, row ${spread(frames.map((f) => f.row)).toFixed(2)} px, text ${spread(frames.map((f) => f.text)).toFixed(2)} px, meta ${spread(frames.map((f) => f.meta)).toFixed(2)} px, above ${spread(frames.map((f) => f.above)).toFixed(2)} px, scroll ${spread(frames.map((f) => f.scroll)).toFixed(2)} px`;
  console.log(`TURN-END ${report}`);
  // The window holds both sides of the end: the loader on, then gone.
  expect(frames.some((f) => f.loader), report).toBe(true);
  expect(frames.some((f) => !f.loader), report).toBe(true);
  expect(frames.some((f) => !f.metaLive), report).toBe(true);
  // On screen in every frame: the end neither removes nor re-inserts them.
  expect(frames.filter((f) => f.text === null), report).toHaveLength(0);
  expect(frames.filter((f) => f.meta === null), report).toHaveLength(0);
  expect(frames.filter((f) => f.above === null), report).toHaveLength(0);
  if (opts.row) expect(frames.filter((f) => f.row === null), report).toHaveLength(0);
  else expect(frames.filter((f) => f.row !== null), report).toHaveLength(0);
  expect(spread(frames.map((f) => f.row)), report).toBe(0);
  expect(spread(frames.map((f) => f.text)), report).toBe(0);
  expect(spread(frames.map((f) => f.meta)), report).toBe(0);
  expect(spread(frames.map((f) => f.above)), report).toBe(0);
}

/**
 * A turn whose text and end come together. The text is drawn while the loader
 * is still on: it grows the bubble and the pin follows it, as with any streamed
 * text. From the last frame of the loader on, the loader going included,
 * nothing moves.
 */
function judgeFromText(who: string, frames: Frame[]) {
  const seen = frames.map((f) => `${f.t}:${f.loader ? "L" : "-"}${f.text === null ? "" : "T"}@${f.row?.toFixed(2)}`).join(" ");
  const lastLoader = frames.map((f) => f.loader).lastIndexOf(true);
  expect(lastLoader, `${who}: the loader was seen (${seen})`).toBeGreaterThanOrEqual(0);
  expect(frames[lastLoader]!.text, `${who}: the text is on screen before the loader goes (${seen})`).not.toBeNull();
  judge(who, frames.slice(lastLoader), { row: true });
}

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

    // The answer is live; the reader goes up 400 px with a real wheel.
    await expect(page.getByText("ANSWER-STILL", { exact: false })).toBeVisible({ timeout: 15_000 });
    const scroller = page.locator('[data-testid="chat-message-list"]:visible');
    const box = await scroller.boundingBox();
    if (!box) throw new Error("the chat scroller has no box to wheel over");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
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

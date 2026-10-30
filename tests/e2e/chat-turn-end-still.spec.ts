import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";

hermetic(test);

/**
 * THE REASONING ROW DOES NOT MOVE WHEN THE TURN ENDS.
 *
 * The owner's report (30/10, card 40ea050c): "reasoning repositions itself as
 * soon as it has finished". Measured in production at 100 ms (provider
 * Topics): the row appeared only at the end, then went 562 -> 557 -> 556 while
 * the meta row of the finished turn replaced the live one. Two causes:
 *   - the native runtime never sent `stream:thinking_start`, so nothing was
 *     reserved (`server/providers/native/thinking-live-signal.test.ts`);
 *   - the live meta row is 14px and the finished one grew to the 16.5px line
 *     of its 11px text: with the chat pinned to the bottom, everything above
 *     went up by the difference.
 *
 * This drives the turn as the native runtime now streams it (the block opens,
 * its summary, the answer) and samples the row's top in the last callback
 * before every paint, from the settled live state through the end of the turn
 * and a second after it. The invariant: 0 px of movement.
 *
 * @covers USAGE-20
 */
test.use({ contextOptions: { reducedMotion: "no-preference" } });

test.describe.serial("reasoning row at the end of the turn", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";

  test.beforeAll(async ({ request }) => {
    topicName = `turn-end-still-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    // Enough history to scroll: the end of the turn happens pinned to the bottom.
    for (let i = 0; i < 12; i++) {
      await request.post(`${E2E_BASE}/api/test/topics/${topicId}/session-row`, {
        data: { role: i % 2 ? "assistant" : "user", content: `Message ${i}. `.repeat(40) },
        ignoreHTTPSErrors: true,
      });
    }
    const topics = (await (await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true })).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)!.sessionKey;
  });
  test.afterAll(async ({ request }) => { if (topicId) await deleteTopic(request, topicId).catch(() => {}); });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, [topicId]); });

  test("the row is reserved live and stays at the same Y through the end of the turn", async ({ page, chatPage }) => {
    const wire = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await expect.poll(() => wire.getByType("subscribe").some(({ direction, data }) =>
      direction === "client" && JSON.parse(data).topicIds?.includes(topicId))).toBe(true);

    const id = `turn-end-still-${Date.now()}`;
    const bubble = page.locator(`[data-message-id="${id}"]`);
    const row = bubble.getByTestId("reasoning-row");
    const answer = "The answer, streamed live after the reasoning.";

    wire.send({ type: "stream:start", sessionKey, topicId, messageId: id });
    await expect(page.getByTestId("chat-streaming-indicator")).toBeVisible({ timeout: 10_000 });
    // The block opens: the row is there before any of its text.
    wire.send({ type: "stream:thinking_start", sessionKey, topicId });
    await expect(row).toBeVisible({ timeout: 5_000 });
    wire.send({ type: "stream:thinking_chunk", sessionKey, topicId, content: "Let me look at the question first." });
    wire.send({ type: "stream:thinking_end", sessionKey, topicId });
    wire.send({ type: "stream:content_chunk", sessionKey, topicId, messageId: id, content: answer });
    await expect(bubble.getByText(answer)).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText("34 chars");

    // Settled live state: the row has not moved for a few frames.
    await page.waitForFunction((sel) => {
      const w = window as unknown as { __still?: { top: number; n: number } };
      const el = document.querySelector(sel);
      if (!el) return false;
      const top = el.getBoundingClientRect().top;
      const s = w.__still ?? { top, n: 0 };
      w.__still = Math.abs(s.top - top) < 0.01 ? { top, n: s.n + 1 } : { top, n: 0 };
      return w.__still.n >= 10;
    }, `[data-message-id="${id}"] [data-testid="reasoning-row"]`, { polling: "raf", timeout: 10_000 });

    // The sampler is already running when the end of the turn is sent, and
    // keeps going until a second after the finished meta row is on screen.
    type Frame = { t: number; top: number | null; live: boolean };
    await page.evaluate((sel) => {
      const w = window as unknown as { __turnEnd: { frames: Frame[]; stopAt: number | null } };
      w.__turnEnd = { frames: [], stopAt: null };
      const t0 = performance.now();
      const tick = () => {
        const el = document.querySelector(`${sel} [data-testid="reasoning-row"]`);
        const live = !!document.querySelector(`${sel} [data-testid="message-meta-row"][data-live="true"]`);
        const t = performance.now() - t0;
        w.__turnEnd.frames.push({ t: Math.round(t), top: el ? el.getBoundingClientRect().top : null, live });
        if (!live && w.__turnEnd.stopAt === null) w.__turnEnd.stopAt = t + 1000;
        if (w.__turnEnd.stopAt === null || t < w.__turnEnd.stopAt) requestAnimationFrame(tick);
        else (w.__turnEnd as { done?: boolean }).done = true;
      };
      requestAnimationFrame(tick);
    }, `[data-message-id="${id}"]`);
    await page.waitForFunction(() => (window as unknown as { __turnEnd: { frames: unknown[] } }).__turnEnd.frames.length >= 5, null, { polling: "raf" });

    // The end exactly as the route sends it: the persisted row, then the close
    // with every number the finished meta row shows.
    wire.send({ type: "message:new", topicId, sessionKey, role: "assistant", messageId: id, content: answer, preview: answer.slice(0, 100) });
    wire.send({
      type: "stream:end", sessionKey, topicId, messageId: id, completed: true,
      latencyMs: 4200, usagePromptTokens: 1200, usageCompletionTokens: 80, costCents: 2, model: "claude-opus-5",
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0,
    });
    await page.waitForFunction(() => (window as unknown as { __turnEnd: { done?: boolean } }).__turnEnd.done === true, null, { timeout: 10_000 });
    const frames = await page.evaluate(() => (window as unknown as { __turnEnd: { frames: Frame[] } }).__turnEnd.frames);

    await expect(page.getByTestId("chat-streaming-indicator")).toHaveCount(0);
    // The window holds both sides of the end: live frames, then finished ones.
    expect(frames.some((f) => f.live)).toBe(true);
    expect(frames.some((f) => !f.live)).toBe(true);
    const tops = frames.map((f) => f.top);
    // Present in every frame: the end of the turn neither removes nor re-inserts it.
    expect(tops.filter((t) => t === null)).toHaveLength(0);
    const ys = tops as number[];
    const shift = Math.max(...ys) - Math.min(...ys);
    console.log(`TURN-END reasoning row: ${frames.length} frames, top ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)}, shift ${shift.toFixed(2)} px`);
    expect(shift).toBeLessThan(0.5);
  });
});

import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { interceptWebSocket } from "./helpers/ws-helpers";

hermetic(test);

/**
 * A CHAT AT REST DOES NOT MOVE.
 *
 * Reported on 23/09: "every now and then the chat scroll goes up and down".
 * `MessageList.tsx` documents a self-feeding pin at rest (pinning the bottom
 * makes Virtuoso unmount an edge row, the height drops ~6px, the row comes
 * back, the observer fires again) and judged it invisible. This spec measures
 * it: nobody touches anything for eight seconds, and every change of
 * `scrollTop` and `scrollHeight` is counted.
 *
 * @covers CHAT-01
 */
test.describe.serial("chat at rest", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    topicName = `rest-test-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    // Mixed heights, like a real conversation: short lines, long paragraphs,
    // fenced code (its own wrapper and scrollbar), lists.
    const bodies = [
      "Short line.",
      "A longer paragraph that wraps over a few lines. ".repeat(8),
      "```ts\n" + Array.from({ length: 14 }, (_, i) => `const v${i} = compute(${i}); // ${"x".repeat(i * 4)}`).join("\n") + "\n```",
      "- one\n- two\n- three\n- four\n- five",
    ];
    for (let i = 0; i < 60; i++) {
      await request.post(`${E2E_BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `#${i + 1} ${bodies[i % bodies.length]}` },
        ignoreHTTPSErrors: true,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("scrollTop does not oscillate while nobody touches the chat", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight > 400 && el.scrollHeight - el.scrollTop - el.clientHeight <= 8), { timeout: 15_000 })
      .toBe(true);
    // No fixed wait: the watch below starts now and ignores its first 1.5 s,
    // which is the opening settle window (OPEN_SETTLE_FRAMES).
    const trace = await scroller.evaluate(async (el) => {
      const out: { t: number; top: number; h: number; w: number }[] = [];
      let last = "";
      const t0 = performance.now();
      await new Promise<void>((done) => {
        const tick = () => {
          const t = performance.now() - t0;
          const s = `${Math.round(el.scrollTop)}|${el.scrollHeight}|${el.clientWidth}`;
          if (t >= 1500 && s !== last) {
            out.push({ t: Math.round(t), top: Math.round(el.scrollTop), h: el.scrollHeight, w: el.clientWidth });
          }
          last = s;
          if (t < 9500) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      return out;
    });
    const changes = trace.length;
    const gutter = await scroller.evaluate((el) => ({ offsetW: el.offsetWidth, clientW: el.clientWidth, cls: el.className }));
    console.log(`[at-rest] scrollbar gutter`, JSON.stringify(gutter));
    test.info().annotations.push({ type: "trace", description: JSON.stringify(trace.slice(0, 40)) });
    console.log(`[at-rest] ${changes} changes in 8s`, JSON.stringify(trace.slice(0, 20)));
    expect(changes, `the chat moved ${changes} times with nobody touching it`).toBeLessThanOrEqual(2);
  });

  /**
   * While an answer streams in, the view follows the bottom and nothing else:
   * `scrollTop` only ever grows. A drop is the "goes up and down" the user saw:
   * nobody scrolls in this test, so any drop is the app pulling the view back.
   */
  test("a streaming answer never pulls the view back up", async ({ page, request }) => {
    const topics = (await (await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true })).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = Object.values(topics.topics).find((t) => t.id === topicId)?.sessionKey;
    expect(sessionKey).toBeTruthy();
    const wire = await interceptWebSocket(page);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));
    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight > 400 && el.scrollHeight - el.scrollTop - el.clientHeight <= 8), { timeout: 15_000 })
      .toBe(true);
    await expect.poll(() => wire.getByType("subscribe").some(({ direction, data }) =>
      direction === "client" && JSON.parse(data).topicIds?.includes(topicId))).toBe(true);

    // Record every frame from here on, in the page, so no sample is lost
    // between two round trips.
    await scroller.evaluate((el) => {
      const w = window as unknown as { __trace: { t: number; top: number; h: number; last?: string }[] };
      w.__trace = [];
      const t0 = performance.now();
      const tick = () => {
        const list = el.querySelector('[data-testid="virtuoso-item-list"]');
        const lastRow = list?.lastElementChild as HTMLElement | null;
        const ind = lastRow?.querySelector('[data-testid="chat-streaming-indicator"]');
        const meta = lastRow?.querySelector('[data-testid="message-meta-row"]');
        const last = lastRow ? `row${Math.round(lastRow.getBoundingClientRect().height)} ind${ind ? Math.round(ind.getBoundingClientRect().height) : "-"} meta${meta ? Math.round(meta.getBoundingClientRect().height) : "-"}` : "";
        w.__trace.push({ t: Math.round(performance.now() - t0), top: Math.round(el.scrollTop), h: el.scrollHeight, last });
        if (performance.now() - t0 < 12_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const id = `at-rest-live-${Date.now()}`;
    wire.send({ type: "stream:start", sessionKey, topicId, messageId: id });
    const words = "The answer grows a few words at a time, the way a model writes it. ".split(" ");
    for (let i = 0; i < 90; i++) {
      wire.send({ type: "stream:content_chunk", sessionKey, topicId, messageId: id, content: `${words[i % words.length]} ` });
      if (i === 30) wire.send({ type: "stream:content_chunk", sessionKey, topicId, messageId: id, content: "\n\n```ts\n" + "const a = 1;\n".repeat(12) + "```\n\n" });
      if (i % 20 === 10) {
        wire.send({ type: "stream:tool_call", sessionKey, topicId, toolCall: { id: `t${i}`, name: "Bash", args: { command: `echo ${i}` }, status: "running" } });
        wire.send({ type: "stream:tool_result", sessionKey, topicId, toolCallId: `t${i}`, result: "ok\n".repeat(6) });
      }
      await page.evaluate(() => new Promise((r) => setTimeout(r, 40)));
    }
    const snap = () => scroller.evaluate((el) => {
      const list = el.querySelector('[data-testid="virtuoso-item-list"]');
      const rows = list ? [...list.children].slice(-3) : [];
      const footer = el.querySelector('[data-testid="chat-bottom-gutter"], [data-testid="chat-footer"]') ?? el.firstElementChild?.lastElementChild;
      return {
        h: el.scrollHeight,
        rows: rows.map((r) => `${(r as HTMLElement).dataset.index}:${Math.round(r.getBoundingClientRect().height)}:${(r.querySelector("[data-testid]") as HTMLElement | null)?.dataset.testid ?? ""}`),
        footer: footer ? Math.round(footer.getBoundingClientRect().height) : null,
        indicator: el.querySelectorAll('[data-testid="streaming-indicator"], [data-testid="turn-phrase"]').length,
      };
    });
    const beforeEnd = await snap();
    wire.send({ type: "stream:end", sessionKey, topicId, messageId: id });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
    console.log(`[at-rest] before end`, JSON.stringify(beforeEnd));
    console.log(`[at-rest] after end `, JSON.stringify(await snap()));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __trace: unknown[] }).__trace.length), { timeout: 20_000 })
      .toBeGreaterThan(300);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 3000)));

    const trace = await page.evaluate(() => (window as unknown as { __trace: { t: number; top: number; h: number }[] }).__trace);
    const drops: { t: number; from: number; to: number; h: number }[] = [];
    for (let i = 1; i < trace.length; i++) {
      if (trace[i]!.top < trace[i - 1]!.top - 1) drops.push({ t: trace[i]!.t, from: trace[i - 1]!.top, to: trace[i]!.top, h: trace[i]!.h });
    }
    console.log(`[at-rest] streaming: ${trace.length} frames, ${drops.length} drops`, JSON.stringify(drops.slice(0, 20)));
    for (const d of drops) {
      const i = trace.findIndex((f) => f.t === d.t);
      console.log(`[at-rest] around t=${d.t}:`, JSON.stringify(trace.slice(Math.max(0, i - 4), i + 6).map((f) => `${f.t}:${f.top}/${f.h} ${(f as { last?: string }).last ?? ""}`)));
    }
    const last = await scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    console.log(`[at-rest] residual from bottom after the stream: ${last}px`);
    expect(drops, "the view was pulled back up while nobody touched it").toEqual([]);
  });
});

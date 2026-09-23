import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE GOAL IS SENT, READ WHOLE, AND THE SPEED OF THE ANSWER SITS WITH ITS NUMBERS.
 *
 * Asked on 23/09, three things about the same corner of the chat:
 *  - `/goal <text>` must also SEND the goal as a turn, like Claude Code: it
 *    only saved it, and the chat stayed idle until the text was typed again;
 *  - a long goal, closed, was readable only through the native tooltip: a
 *    click on the bar must open the whole text;
 *  - tok/s was drawn under the composer, apart from the turn it measures: it
 *    must be in line with the other numbers of the turn, and not under the
 *    composer at all.
 * @covers CTX-GOAL-01
 * @covers USAGE-23
 */
test.describe("goal sent and readable, tok/s in line", () => {
  let topicId = "";
  let topicName = "";
  const LONG_GOAL =
    "Kaumat v14 con zanne dove indica la guida, arti e mani e piedi più grandi e lunghi, volto più largo, colori presi dal geco di Attilio e sfondo neutro";

  test.beforeAll(async ({ request }) => {
    topicName = `goal-send-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
  });
  test.afterAll(async ({ request }) => { if (topicId) await deleteTopic(request, topicId).catch(() => {}); });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, [topicId]); });

  test("/goal sends a turn, the long goal opens whole, tok/s is not in the composer", async ({ page, chatPage }) => {
    // The turn the goal starts, streamed from inside the page so the client's
    // own parser reads it, and held OPEN: a mocked turn is never stored, so the
    // live meta row of the turn in flight is where tok/s must show. The POST
    // bodies are the proof the goal was SENT.
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      const w = window as unknown as { __chatPosts: string[] };
      w.__chatPosts = [];
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!/\/api\/chat$/.test(new URL(url, location.href).pathname) || (init?.method ?? "GET") !== "POST") return realFetch(input, init);
        try { w.__chatPosts.push(JSON.parse(String(init?.body)).messages.at(-1).content); } catch { /* shape changed: the assertion says so */ }
        const enc = new TextEncoder();
        const chunk = (t: string) => enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            let i = 0;
            const tick = setInterval(() => { c.enqueue(chunk(`parola ${i++} `)); }, 60);
            setTimeout(() => clearInterval(tick), 20_000);
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      }) as typeof fetch;
    });
    const chatPosts = () => page.evaluate(() => (window as unknown as { __chatPosts: string[] }).__chatPosts);

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const input = chatPage.messageInput;
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.click();
    await input.fill(`/goal ${LONG_GOAL}`);
    await page.keyboard.press("Escape");
    await input.press("Enter");

    await expect(page.getByTestId("goal-bar")).toBeVisible({ timeout: 10_000 });
    await expect.poll(chatPosts, { timeout: 10_000 }).toEqual([LONG_GOAL]);

    // Closed, the long goal is cut; a click opens it WHOLE, on more lines.
    const text = page.getByTestId("goal-bar-text");
    const closedHeight = (await text.boundingBox())!.height;
    expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.getByTestId("goal-bar-toggle").click();
    await expect.poll(async () => (await text.boundingBox())!.height).toBeGreaterThan(closedHeight * 1.5);
    expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // tok/s: in the meta row of the answer, never inside the composer.
    const rate = page.locator('[data-testid="message-meta-row"] [data-testid="stream-token-rate"]');
    await expect(rate).toHaveCount(1, { timeout: 10_000 });
    await expect(rate).toBeVisible({ timeout: 10_000 });
    await expect(rate).toContainText("tok/s");
    await expect(page.locator('form [data-testid="stream-token-rate"], [data-testid="chat-input-context-ring"] ~ [data-testid="stream-token-rate"]')).toHaveCount(0);
    await rate.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("goal-send.png") });
  });
});

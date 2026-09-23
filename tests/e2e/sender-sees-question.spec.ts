import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE WINDOW YOU SENT FROM SEES THE QUESTION, without a refresh.
 *
 * Reported on 23/09: "sometimes I have to refresh to see the real state of a
 * topic". The window that sends a message owns that turn's SSE and drops the
 * session's WS frames, except a short list (`senderAlsoSees.ts`). The question
 * panel travels only over WS, so the sender showed a spinner while the sidebar
 * said "waiting for you". This drives the sender's real path: a typed message,
 * an SSE held open, the question arriving on the wire.
 * @covers PERM-08
 */
test.describe("sender sees the question", () => {
  let topicId = "";
  let topicName = "";
  let sessionKey = "";

  test.beforeAll(async ({ request }) => {
    topicName = `sender-ask-${Date.now()}`;
    topicId = (await createTopic(request, topicName)).id;
    const body = await (await request.get(`/api/topics`, { ignoreHTTPSErrors: true })).json();
    sessionKey = (body.topics ?? {})[topicId]?.sessionKey;
    if (!sessionKey) throw new Error("topic without sessionKey");
  });
  test.afterAll(async ({ request }) => { if (topicId) await deleteTopic(request, topicId).catch(() => {}); });
  test.beforeEach(async ({ request }) => { await resetPaneStore(request, [topicId]); });

  test("the question form appears in the window that sent the message", async ({ page, chatPage }) => {
    const toolCallId = "toolu_sender_ask";
    // This window's SSE, streamed from inside the page so the client's own
    // parser reads it: the tool call arrives on it, then it stays open, which is
    // what a turn parked on a question does. (`route.fulfill` can only hand over
    // a whole body, so it could never hold the stream open.)
    await page.addInitScript((id: string) => {
      const realFetch = window.fetch.bind(window);
      const w = window as unknown as { __releaseSse?: () => void };
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!/\/api\/chat$/.test(new URL(url, location.href).pathname) || (init?.method ?? "GET") !== "POST") return realFetch(input, init);
        const enc = new TextEncoder();
        const call = { choices: [{ index: 0, delta: { tool_calls: [{ id, function: { name: "mcp__topics__ask_user_question", arguments: "{}" } }] } }] };
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify(call)}\n\n`));
            w.__releaseSse = () => { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); };
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      }) as typeof fetch;
    }, toolCallId);
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    await chatPage.messageInput.fill("which road?");
    await chatPage.messageInput.press("Enter");
    // The tool row came from THIS window's SSE: the sender owns the turn.
    await expect(page.locator(`[data-testid="tool-call-row-${toolCallId}"]`)).toHaveCount(1, { timeout: 15_000 });

    // The question, on the wire only, as the server sends it.
    ws.send({
      type: "stream:tool_user_input_required", sessionKey, topicId, toolCallId,
      schema: { kind: "questions", questions: [{ question: "Road A or B?", header: "Road", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    });

    await expect(page.getByTestId(`tool-input-form-${toolCallId}`)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: test.info().outputPath("sender-sees-question.png") });
    await page.evaluate(() => (window as unknown as { __releaseSse?: () => void }).__releaseSse?.());
  });
});

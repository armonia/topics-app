/**
 * A TURN STREAMED OVER HTTP-SSE KEEPS ITS ANSWER ON ITS OWN BUBBLE, AND A ROW
 * BORN DURING THE TURN KEEPS ITS TEXT (card c714a62c).
 *
 * The chat route falls back to the provider's HTTP stream when the provider is
 * not connected: an openclaw gateway whose socket is down while its HTTP
 * answers. That path wrote the turn's body with `updateLastMessage` and no
 * `rowId`, so on the LAST row of the session. A system message posted during
 * the turn (or a sub-agent's report) was that row: it took the whole answer,
 * and the turn's own row stayed empty and was dropped by the next history
 * read.
 *
 * Both windows on the chat look right while the turn streams: they draw it
 * from the frames, which name the turn's row. The damage is in the database,
 * and a window shows it on its next history read, a reload.
 *
 * The gateway is a fake that answers HTTP and refuses the socket; the test
 * server is restarted pointing at it, and restarted again without it at the
 * end. That is why the whole file is nightly (`NIGHTLY_ONLY_SPECS`).
 *
 * @covers CHAT-01
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { openTwoDevices } from "./helpers/multi-client";
import { restartTestServer } from "./helpers/restart-test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";

/** An OpenAI-style gateway over HTTP only: one streamed answer, written by the test. */
function fakeGateway() {
  let open: ServerResponse | null = null;
  let asked: () => void = () => {};
  const requested = new Promise<void>((r) => { asked = r; });
  // No 'upgrade' listener: the provider's socket never opens, so it stays
  // disconnected and the chat route takes the HTTP fallback.
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      open = res;
      asked();
      return;
    }
    res.writeHead(404).end();
  });
  const frame = (data: string) => open!.write(`data: ${data}\n\n`);
  return {
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port))),
    requested,
    push: (delta: Record<string, unknown>) => frame(JSON.stringify({ choices: [{ index: 0, delta }] })),
    text: (from: number, to: number) => {
      for (let i = from; i <= to; i++) frame(JSON.stringify({ choices: [{ index: 0, delta: { content: `CHAT-${i} ` } }] }));
    },
    done: () => { frame("[DONE]"); open!.end(); },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

/** POST /api/chat from outside the page, its event stream drained in the background. */
function startTurn(sessionKey: string, content: string): Promise<void> {
  const done = (async () => {
    const res = await fetch(`${E2E_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
    const reader = res.body.getReader();
    while (!(await reader.read()).done) { /* drained */ }
  })();
  done.catch(() => {});
  return done;
}

/**
 * What the assistant bubbles of the chat say: whether the system message is
 * there with its own text, and whether the whole answer sits in a bubble
 * before it.
 */
async function bubblesOf(page: Page, topicId: string) {
  const texts = await page
    .locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"] [data-testid="chat-message"][data-role="assistant"]`)
    .allTextContents();
  const note = texts.findIndex((t) => t.includes("SYSTEM-NOTE"));
  // Not `\b`: the tool card's label follows the text in the same bubble.
  const answer = texts.findIndex((t) => /CHAT-15(?!\d)/.test(t));
  return {
    noteKeepsItsText: note >= 0 && !texts[note]!.includes("CHAT-"),
    answerBeforeNote: answer >= 0 && answer < note,
  };
}

const TRUE_STATE = { noteKeepsItsText: true, answerBeforeNote: true };

test.describe("a turn over the HTTP fallback, with a system message posted during it", () => {
  const gateway = fakeGateway();

  test.beforeAll(async ({ request }) => {
    process.env.GATEWAY_URL = `http://127.0.0.1:${await gateway.listen()}`;
    await restartTestServer();
    const providers = (await (await request.get(`${E2E_BASE}/api/providers`)).json()) as { providers: { name: string; connected: boolean }[] };
    expect(providers.providers.find((p) => p.name === "openclaw"), "openclaw registered, its socket down").toMatchObject({ connected: false });
    const put = await request.put(`${E2E_BASE}/api/providers/default`, { data: { provider: "openclaw" } });
    expect(put.ok(), "openclaw is the default").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.put(`${E2E_BASE}/api/app-settings`, { data: { aiProvider: null } }).catch(() => {});
    delete process.env.GATEWAY_URL;
    await restartTestServer();
    await gateway.close();
  });

  test("both windows end with the answer on its bubble and the message with its text @nightly", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    // No provider on the topic: it follows the default, which is not connected.
    const topic = await createTopic(request, "SSE own row");
    const devices = await openTwoDevices(browser, { seed: (r) => resetPaneStore(r, [topic.id]) });
    try {
      const { pageA, pageB } = devices;
      const sk = await sessionKeyOf(request, topic.id);
      const panel = (p: Page) => p.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topic.id}"]`);
      for (const p of [pageA, pageB]) await expect(panel(p)).toBeVisible({ timeout: 20_000 });

      const turn = startTurn(sk, "hello");
      await gateway.requested;
      gateway.text(1, 10);
      for (const p of [pageA, pageB]) await expect(panel(p).getByText(/CHAT-10\b/)).toBeVisible({ timeout: 15_000 });

      const note = await request.post(`${E2E_BASE}/api/topics/${topic.id}/system-message`, { data: { content: "SYSTEM-NOTE" } });
      expect(note.ok()).toBeTruthy();
      for (const p of [pageA, pageB]) await expect(panel(p).getByText("SYSTEM-NOTE")).toBeVisible({ timeout: 10_000 });

      gateway.text(11, 15);
      gateway.push({ tool_calls: [{ id: "tc-e2e", function: { name: "Bash", arguments: "{}" } }] });
      gateway.push({ tool_result: { id: "tc-e2e", status: "success", result: "ok" } });
      gateway.done();
      await turn;

      for (const [name, p] of [["A", pageA], ["B", pageB]] as const) {
        await expect.poll(() => bubblesOf(p, topic.id), { timeout: 10_000, message: `window ${name}, live` }).toEqual(TRUE_STATE);
      }
      // What the database holds, which is what any later read brings.
      for (const [name, p] of [["A", pageA], ["B", pageB]] as const) {
        await p.reload();
        await expect(panel(p)).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => bubblesOf(p, topic.id), { timeout: 15_000, message: `window ${name}, after a reload` }).toEqual(TRUE_STATE);
      }
    } finally {
      await devices.dispose();
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

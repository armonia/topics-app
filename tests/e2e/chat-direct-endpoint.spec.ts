/**
 * A configured endpoint, chosen in a chat and actually used: tokens arriving
 * one at a time, a turn stopped halfway, and the usage the endpoint reported.
 *
 * WHY A REAL SERVER AND NOT page.route. The thing under test is the SERVER
 * path: Topics' own backend resolves `direct-<slug>`, builds the request,
 * opens the SSE and folds the deltas. `page.route` intercepts the BROWSER, so
 * it would stub out `/api/chat` and prove only that the client renders what it
 * is handed, which the chat specs already cover. So this spec stands up a tiny
 * OpenAI-compatible server on loopback, registers it as an endpoint through
 * the real API, and points a topic at it. Nothing is mocked below the wire.
 *
 * Loopback is what the URL guard is built to allow, so no exception is needed
 * for the test to run.
 *
 * @covers MP-DIRECT-01
 * @covers MP-DIRECT-03
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { E2E_BASE } from "./helpers/test-server";
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  patchTopic,
  resetPaneStore,
} from "./helpers/api-fixtures";

// The port the e2e server actually got, not a guess: E2E_PORT moves.
const BASE = E2E_BASE;
const MODEL = "qwen38-27b-200k";
const SLUG = "e2e-local";
const PROVIDER = `direct-${SLUG}`;

/** What the fake endpoint saw, so the test can assert on the far side too. */
interface Recorder {
  /** Bodies of every /v1/chat/completions call. */
  requests: Record<string, unknown>[];
  /** Set when the client hung up before the stream finished. */
  aborted: boolean;
  /** Resolves once a stream has started and is holding. */
  streaming: Promise<void>;
}

/**
 * An OpenAI-compatible server that answers /v1/models and streams
 * /v1/chat/completions one token at a time.
 *
 * `hold: true` keeps the stream open after the first tokens instead of
 * finishing it, which is what makes the abort observable: the turn is still
 * live when the test presses stop.
 */
async function startFakeEndpoint(opts: { hold: boolean }): Promise<{
  url: string;
  close: () => Promise<void>;
  recorder: Recorder;
}> {
  let markStreaming: () => void = () => {};
  const recorder: Recorder = {
    requests: [],
    aborted: false,
    streaming: new Promise<void>((resolve) => { markStreaming = resolve; }),
  };

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      // meta.n_ctx is where the declared context window comes from.
      res.end(JSON.stringify({ data: [{ id: MODEL, meta: { n_ctx: 200192 } }] }));
      return;
    }

    if (req.url?.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try { recorder.requests.push(JSON.parse(raw)); } catch { /* body shape is asserted elsewhere */ }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const frame = (delta: Record<string, unknown>) => ({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          model: MODEL,
          choices: [{ index: 0, delta, finish_reason: null }],
        });

        // The client hanging up is the whole point of the abort case.
        req.on("close", () => { if (!res.writableEnded) recorder.aborted = true; });

        send(frame({ role: "assistant" }));
        for (const word of ["ENDPOINT", "-", "ALIVE"]) {
          if (res.writableEnded) return;
          send(frame({ content: word }));
          await new Promise((r) => setTimeout(r, 60));
        }
        markStreaming();

        if (opts.hold) {
          // Stay open. The test aborts; we never send [DONE].
          const keepAlive = setInterval(() => {
            if (res.writableEnded) { clearInterval(keepAlive); return; }
            res.write(": keep-alive\n\n");
          }, 200);
          req.on("close", () => clearInterval(keepAlive));
          return;
        }

        // usage rides the last frame, which is what stream_options.include_usage buys.
        send({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 41, completion_tokens: 3, total_tokens: 44 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    recorder,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

hermetic(test);

test.describe("a configured endpoint serving a chat", () => {
  test("streams its tokens into the conversation and reports usage", async ({
    page, request, chatPage,
  }) => {
    const fake = await startFakeEndpoint({ hold: false });
    const topic = await createTopic(request, `direct-chat-${Date.now()}`);

    try {
      // 1. Register it through the real API, exactly as the Settings form does.
      const created = await request.post(`${BASE}/api/providers/endpoints`, {
        data: { id: SLUG, label: "E2E local", baseUrl: fake.url, auth: "none" },
      });
      expect(created.ok()).toBeTruthy();

      // 2. Point the topic at it. This is the step that proves a configured
      //    endpoint is selectable for a chat at all.
      await patchTopic(request, topic.id, { provider: PROVIDER, model: MODEL });
      const saved = await request.get(`${BASE}/api/topics/${topic.id}`);
      expect((await saved.json()).provider).toBe(PROVIDER);

      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      // 3. Send, and wait for the endpoint's own words to land in the thread.
      await chatPage.sendMessage("say something");
      await expect(page.getByText(/ENDPOINT-ALIVE/).first())
        .toBeVisible({ timeout: 30_000 });

      // 4. The far side got a streaming request for the right model, and asked
      //    for usage on the stream.
      expect(fake.recorder.requests.length).toBeGreaterThan(0);
      const sent = fake.recorder.requests[0];
      expect(sent.model).toBe(MODEL);
      expect(sent.stream).toBe(true);
      expect(sent.stream_options).toEqual({ include_usage: true });

      // 5. The window the endpoint declared (200192 from meta.n_ctx) is the one
      //    the provider snapshot carries, not the 1M the static table guesses
      //    for a name it has never seen.
      // Polled, not read once: the snapshot is refreshed in the background
      // after the endpoint is registered, so a single read races the refresh.
      await expect.poll(async () => {
        const snapshot = await request.get(`${BASE}/api/providers`);
        const entry = (await snapshot.json()).providers
          .find((p: { name: string }) => p.name === PROVIDER);
        return entry?.modelContextWindows?.[MODEL];
      }, { timeout: 20_000 }).toBe(200192);
    } finally {
      await request.delete(`${BASE}/api/providers/endpoints/${SLUG}`).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      await fake.close();
    }
  });

  test("stopping the turn hangs up on the endpoint", async ({
    page, request, chatPage,
  }) => {
    const fake = await startFakeEndpoint({ hold: true });
    const topic = await createTopic(request, `direct-abort-${Date.now()}`);

    try {
      await request.post(`${BASE}/api/providers/endpoints`, {
        data: { id: SLUG, label: "E2E local", baseUrl: fake.url, auth: "none" },
      });
      await patchTopic(request, topic.id, { provider: PROVIDER, model: MODEL });
      await resetPaneStore(request, [topic.id]);

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      await chatPage.sendMessage("start and wait");

      // Tokens are flowing and the stream is deliberately not finishing.
      await expect(page.getByText(/ENDPOINT/).first()).toBeVisible({ timeout: 30_000 });

      // Stop the turn the way a person does.
      // Both languages, like the composer locator in the chat fixture: the
      // label follows the chosen interface language.
      // allow-italian: it is the exact aria-label shipped in i18n-chat-it.ts.
      const stop = page.getByRole("button", { name: /Stop streaming|Ferma la risposta/ }).first();
      await stop.click({ timeout: 15_000 });

      // The endpoint saw the hang-up: an abort has to reach the far side, not
      // just hide the tokens in the UI while the generation keeps burning VRAM.
      await expect.poll(() => fake.recorder.aborted, { timeout: 30_000 }).toBe(true);
    } finally {
      await request.delete(`${BASE}/api/providers/endpoints/${SLUG}`).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      await fake.close();
    }
  });
});

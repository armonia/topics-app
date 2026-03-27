/**
 * SSE mock helpers for chat streaming E2E tests.
 *
 * The chat endpoint is POST /api/chat/:sessionKey returning text/event-stream.
 * These helpers intercept that endpoint via page.route() and return controlled SSE data.
 *
 * CONVENTION: No waitForTimeout() usage.
 */
import type { Page, Route } from "@playwright/test";

export interface SSEMockOptions {
  /** Content chunks to send as SSE data events */
  chunks: string[];
  /** Whether to send [DONE] to close the stream (default: true) */
  complete?: boolean;
}

/**
 * Mock the chat SSE endpoint to return controlled content.
 * Must be called BEFORE sending the message.
 *
 * Each chunk becomes an SSE `data:` line with OpenAI-format delta.
 * If complete=true (default), appends `data: [DONE]` to close the stream.
 */
export async function mockChatStream(page: Page, opts: SSEMockOptions) {
  const { chunks, complete = true } = opts;

  await page.route("**/chat", async (route: Route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    const lines = chunks.map((chunk) => {
      const data = JSON.stringify({
        choices: [{ index: 0, delta: { content: chunk } }],
      });
      return `data: ${data}\n\n`;
    });

    if (complete) {
      lines.push("data: [DONE]\n\n");
    }

    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
      body: lines.join(""),
    });
  });
}

/**
 * Mock chat endpoint that returns partial content but never sends [DONE].
 * The client will show streaming indicator until aborted.
 * Use for abort/stop-streaming tests.
 */
export async function mockHangingStream(page: Page, partialContent: string) {
  await page.route("**/chat", async (route: Route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    const data = JSON.stringify({
      choices: [{ index: 0, delta: { content: partialContent } }],
    });

    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
      body: `data: ${data}\n\n`,
      // No [DONE] -- client thinks stream is still active
    });
  });
}

/**
 * SSE mock helpers for chat streaming E2E tests.
 *
 * The chat endpoint is POST /api/chat returning text/event-stream.
 * After streaming completes, the client calls POST /api/history/:sessionKey
 * to sync server-side IDs — this REPLACES local messages. So we must also
 * mock the history endpoint to prevent the server from wiping mocked content.
 *
 * CONVENTION: No waitForTimeout() usage.
 */
import type { Page, Route } from "@playwright/test";

/** Route pattern matching POST /api/chat (exact path, no trailing segments). */
export const CHAT_ROUTE_PATTERN = "**/api/chat";

/** Route pattern matching POST /api/history/:sessionKey (post-stream history sync). */
export const HISTORY_ROUTE_PATTERN = /\/api\/history\//;

export interface SSEMockOptions {
  /** Content chunks to send as SSE data events */
  chunks: string[];
  /** Whether to send [DONE] to close the stream (default: true) */
  complete?: boolean;
  /** User message content for the history mock (default: uses chunks joined) */
  userMessage?: string;
}

/**
 * Mock the chat SSE endpoint AND the post-stream history endpoint.
 * Must be called BEFORE sending the message.
 *
 * Each chunk becomes an SSE `data:` line with OpenAI-format delta.
 * If complete=true (default), appends `data: [DONE]` to close the stream.
 *
 * Also mocks POST /api/history/:sessionKey to return the mocked messages,
 * preventing the client from overwriting streamed content with real server data.
 */
export async function mockChatStream(page: Page, opts: SSEMockOptions) {
  const { chunks, complete = true, userMessage } = opts;
  const fullContent = chunks.join("");

  await page.route(CHAT_ROUTE_PATTERN, async (route: Route) => {
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

  // Mock history endpoint to return the mocked messages (prevents content wipe
  // when client syncs after stream completes — see useChat.ts lines 650-662).
  if (complete) {
    await page.route(HISTORY_ROUTE_PATTERN, async (route: Route) => {
      if (route.request().method() !== "POST") {
        return route.fallback();
      }

      await route.fulfill({
        status: 200,
        json: {
          messages: [
            ...(userMessage
              ? [
                  {
                    id: "mock-user-1",
                    role: "user",
                    content: userMessage,
                    timestamp: new Date().toISOString(),
                  },
                ]
              : []),
            {
              id: "mock-assistant-1",
              role: "assistant",
              content: fullContent,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });
    });
  }
}

/**
 * Remove all chat SSE and history mocks set up by mockChatStream.
 */
export async function unmockChatStream(page: Page) {
  await page.unroute(CHAT_ROUTE_PATTERN);
  // History route may or may not be registered; unroute is safe either way
  await page.unroute(HISTORY_ROUTE_PATTERN).catch(() => {});
}

/**
 * Mock chat endpoint that returns partial content but never sends [DONE].
 * The client will show streaming indicator until aborted.
 * Use for abort/stop-streaming tests.
 */
// --- Tool call and attachment mock helpers ---

export interface ToolCallSSEMockOptions {
  /** Text content chunks to interleave (optional) */
  contentChunks?: string[];
  /** Tool calls to include in the SSE stream */
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, any>;
    /** If provided, sends a tool_result event after the tool_call */
    result?: string;
    /** If provided, the result is treated as an error */
    error?: boolean;
    /** Content offset for inline tool calls */
    contentOffset?: number;
  }>;
  /** User message for history mock */
  userMessage?: string;
}

/**
 * Mock the chat SSE endpoint with tool call deltas AND the history endpoint.
 * Sends content chunks first, then tool_calls deltas, then tool_result deltas.
 */
export async function mockChatStreamWithToolCalls(page: Page, opts: ToolCallSSEMockOptions) {
  const { contentChunks = [], toolCalls, userMessage } = opts;
  const fullContent = contentChunks.join("");

  await page.route(CHAT_ROUTE_PATTERN, async (route: Route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    const lines: string[] = [];

    // 1. Content chunks
    for (const chunk of contentChunks) {
      const data = JSON.stringify({
        choices: [{ index: 0, delta: { content: chunk } }],
      });
      lines.push(`data: ${data}\n\n`);
    }

    // 2. Tool call deltas
    for (const tc of toolCalls) {
      const data = JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              id: tc.id,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              ...(tc.contentOffset !== undefined ? { contentOffset: tc.contentOffset } : {}),
            }],
          },
        }],
      });
      lines.push(`data: ${data}\n\n`);
    }

    // 3. Tool result deltas (for those with a result)
    for (const tc of toolCalls) {
      if (tc.result !== undefined) {
        const data = JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_result: {
                id: tc.id,
                status: tc.error ? "error" : "success",
                result: tc.result,
              },
            },
          }],
        });
        lines.push(`data: ${data}\n\n`);
      }
    }

    lines.push("data: [DONE]\n\n");

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

  // Mock history endpoint to return messages with toolCalls
  await page.route(HISTORY_ROUTE_PATTERN, async (route: Route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    const historyToolCalls = toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      status: tc.error ? "error" : "success",
      result: tc.error ? undefined : tc.result,
      error: tc.error ? tc.result : undefined,
      ...(tc.contentOffset !== undefined ? { contentOffset: tc.contentOffset } : {}),
    }));

    await route.fulfill({
      status: 200,
      json: {
        messages: [
          ...(userMessage
            ? [{
                id: "mock-user-1",
                role: "user",
                content: userMessage,
                timestamp: new Date().toISOString(),
              }]
            : []),
          {
            id: "mock-assistant-1",
            role: "assistant",
            content: fullContent,
            toolCalls: historyToolCalls,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
  });
}

export interface MediaHistoryMockOptions {
  /** Media paths to include in the history message */
  mediaPaths: string[];
  /** Message content text */
  content?: string;
  /** User message text */
  userMessage?: string;
}

/**
 * Mock the history endpoint to return messages with media attachments.
 * Use this for testing media/attachment rendering from persisted history.
 */
export async function mockHistoryWithMedia(page: Page, opts: MediaHistoryMockOptions) {
  const { mediaPaths, content = "", userMessage } = opts;

  await page.route(HISTORY_ROUTE_PATTERN, async (route: Route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    await route.fulfill({
      status: 200,
      json: {
        messages: [
          ...(userMessage
            ? [{
                id: "mock-user-1",
                role: "user",
                content: userMessage,
                timestamp: new Date().toISOString(),
              }]
            : []),
          {
            id: "mock-assistant-1",
            role: "assistant",
            content,
            media: mediaPaths,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
  });
}

/**
 * Mock the chat endpoint that returns partial content but never sends [DONE].
 * The client will show streaming indicator until aborted.
 * Use for abort/stop-streaming tests.
 */
export async function mockHangingStream(page: Page, partialContent: string) {
  await page.route(CHAT_ROUTE_PATTERN, async (route: Route) => {
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

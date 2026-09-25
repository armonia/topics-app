/**
 * THE CHAT'S SSE STREAM OUTLIVES A SILENT TOOL.
 * @covers CCLI-03
 *
 * Measured on 2026-09-24 (chat 3019832f): a Bash with a 300 s timeout started
 * at 23:35:30Z, and the SSE response of POST /api/chat closed at 23:39:45Z,
 * 255 s later to the second, with HTTP 200 and no `data: [DONE]`. The turn went
 * on (re-attached at 23:40:23Z). 255 is Bun's `idleTimeout` (server.ts): a
 * response that sends no byte for that long is an idle connection, and nothing
 * in the chat's event stream spoke while the tool ran. `send_chat_message`
 * read that close as the end of the turn and returned half an answer.
 *
 * A real Bun server with a short idle timeout, the real chat route, and a fake
 * provider whose tool stays silent for longer than that timeout.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { Topic } from "../types";

const ROOT = testTmpDir("chat-sse-keepalive");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

// Bun's socket idle timers tick at a granularity of about 4 s, so a 1 s idle
// timeout closes the connection after 4 to 8 s of silence (measured: 4.2 s).
// The tool stays silent past that; the keepalive under test ticks every 300 ms.
const IDLE_TIMEOUT_S = 1;
const SILENT_TOOL_MS = 6_000;

describe("the chat's SSE response during a silent tool", () => {
  test("stays open past the server's idle timeout and ends with [DONE]", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = "topic:sse-keepalive";
    ctx.saveSingleTopic({
      id: "t-sse-keepalive", name: "sse", slug: "sse", parentId: null, links: [], sessionKey,
      color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), archived: false, provider: "claude-code",
    } as unknown as Topic);

    const provider = {
      name: "claude-code",
      capabilities: new Set(["streaming"]),
      contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: () => {},
      unregisterStreamHandler: () => {},
      // A tool that prints nothing for longer than the idle timeout, then the answer.
      sendChat: async (_sk: string, _msg: string, h: StreamHandler) => {
        h.onToolStart("toolu_silent", "Bash", { command: "sleep 300" });
        await Bun.sleep(SILENT_TOOL_MS);
        h.onToolResult("toolu_silent", "done", false);
        h.onTextDelta("finished", "finished");
        h.onDone(undefined as never);
        return { runId: "run-1" };
      },
      defaultModel: () => "fake-model",
      abort: async () => {},
      start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;

    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider,
      detectLocalhostAutoNav: () => {},
      bindTopicToProject: () => {},
      resolveProjectRef: () => null,
      getProjectIdForTopic: () => null,
      getWorkspaceProjects: () => [],
      autoBindProject: () => {},
      watchSessionForSubagents: () => {},
      updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(),
      WORKSPACE_DIR: ROOT,
      sseKeepaliveMs: 300,
    } as never);

    const server = Bun.serve({
      port: 0,
      idleTimeout: IDLE_TIMEOUT_S,
      fetch: async (req) => {
        const url = new URL(req.url);
        return (await chatRouter(req, url, url.pathname, req.method)) ?? new Response("not found", { status: 404 });
      },
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "run the long command" }] }),
      });
      expect(resp.status).toBe(200);
      let body = "";
      try { body = await resp.text(); } catch (err) { body += `\n<read failed: ${String(err)}>`; }

      expect(body).toContain("finished");
      expect(body).toContain("data: [DONE]");
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

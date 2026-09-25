/**
 * THE CHAT'S SSE STREAM OUTLIVES A SILENT TOOL.
 * @covers CCLI-03
 *
 * Measured on 2026-09-24 (chat 3019832f): a Bash with a 300 s timeout started
 * at 23:35:30Z, and the SSE response of POST /api/chat closed at 23:39:45Z,
 * 255 s later to the second, with HTTP 200 and no `data: [DONE]`. The turn went
 * on (re-attached at 23:40:23Z). 255 was Bun's `idleTimeout` (server.ts), and
 * `send_chat_message` read that close as the end of the turn.
 *
 * Three facts, one test each: Bun counts a server write as no activity (so no
 * keepalive can hold a finite idle timeout open, and the timeout has to be off);
 * the production servers run with it off; and the chat's stream still puts a
 * comment line on the wire while a tool is silent, for the proxies between the
 * client and us (relay, tunnel) that do count bytes.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createChatRouter } from "./chat";
import type { AIProvider, StreamHandler } from "../providers/types";
import type { Topic } from "../types";

const ROOT = testTmpDir("chat-sse-keepalive");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Reads a response to the end, keeping what arrived before a reset. */
async function readAll(resp: Response): Promise<{ body: string; cut: boolean }> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { body, cut: false };
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return { body, cut: true };
  }
}

describe("Bun's idle timeout and a streaming response", () => {
  test("a server write every 300 ms does not keep a 1 s idle timeout from closing the response", async () => {
    // The fact the server's configuration rests on: if a future Bun counts a
    // write as activity, this turns red, and a finite idle timeout plus the
    // keepalive becomes enough. Bun's socket timers tick at about 4 s, so a
    // 1 s timeout cuts after 4 to 8 s (measured: 4.07 s, 13 pings through).
    const server = Bun.serve({
      port: 0,
      idleTimeout: 1,
      fetch() {
        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const w = writable.getWriter();
        const ping = setInterval(() => { w.write(encoder.encode(": ping\n\n")).catch(() => {}); }, 300);
        setTimeout(() => {
          clearInterval(ping);
          w.write(encoder.encode("data: [DONE]\n\n")).then(() => w.close()).catch(() => {});
        }, 9_000);
        return new Response(readable, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    try {
      const { body, cut } = await readAll(await fetch(`http://127.0.0.1:${server.port}/`));
      expect(body).toContain(": ping");
      expect(cut || !body.includes("[DONE]")).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("the production servers run with the idle timeout off", () => {
    // Both listeners (main port and tunnel) spread the same options object, so
    // this one line is the whole setting.
    const source = readFileSync(join(REPO_ROOT, "server.ts"), "utf8");
    expect(source).toMatch(/^\s*idleTimeout:\s*0\b/m);
  });
});

describe("the chat's SSE response during a silent tool", () => {
  test("puts a comment line on the wire while the tool is silent, and still ends with [DONE]", async () => {
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
      // A tool that prints nothing for a while, then the answer.
      sendChat: async (_sk: string, _msg: string, h: StreamHandler) => {
        h.onToolStart("toolu_silent", "Bash", { command: "sleep 300" });
        await Bun.sleep(2_000);
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
      ssePingMs: 200,
    } as never);

    // Served as production serves it: idle timeout off.
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
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
      const { body, cut } = await readAll(resp);

      expect(cut).toBe(false);
      // About ten ticks in two seconds; a loaded machine may run fewer.
      expect((body.match(/^: ping$/gm) ?? []).length).toBeGreaterThanOrEqual(3);
      expect(body).toContain("finished");
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

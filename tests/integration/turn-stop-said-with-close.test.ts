/**
 * A PERSON'S STOP TRAVELS WITH THE CLOSE OF THE TURN, NOT AFTER IT.
 * @covers CHAT-QUEUE-07
 *
 * The abort route ends the stream (`endStream`), the ledger closes the turn and
 * says so at once (`turn:state`), and only then does the route broadcast its
 * `stream:end` with `reason: user_abort`. Every window drains its queue on the
 * close: a phone with a message queued read "over" and sent it, and the
 * `user_abort` that should have held it came after the queue had left. With a
 * provider that keeps no CLI turn of its own open (Codex, ACP, the native
 * agent, the gateway) nothing else held the session, and claude-code was in the
 * same place when the Stop came before the child's `system/init`.
 *
 * The real chat route, the real abort route and the real `createAppContext`:
 * the frames are read off a socket, in wire order.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { createTopicsRouter } from "../../server/routes/topics";
import { registerProvider, removeProvider } from "../../server/providers";
import type { AIProvider } from "../../server/providers/types";
import type { Topic } from "../../server/types";

const TEST_DATA = testTmpDir("turn-stop-said-with-close");
beforeAll(() => setupTestDataDir(TEST_DATA));
// The abort route resolves the provider from the registry: `openai` without a
// key is `connected: false`, so the route calls no provider abort.
registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* already removed */ } });

describe("a Stop pressed on another device", () => {
  test("the close of the turn says a person stopped it, before the stream:end", async () => {
    const sk = "topic:stop-with-close";
    const ctx = await createTestAppContext();
    const frames: Array<Record<string, unknown>> = [];
    // The ledger broadcasts through the context's own fan-out (to the sockets);
    // the routes through `ctx.broadcastToAll`, which the test context stubs.
    // Both land in one list, in call order: the order on the wire.
    ctx.wsClients.add({ readyState: 1, data: { id: "phone", remote: false }, send: (p: string) => { frames.push(JSON.parse(p)); return 0; } } as never);
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => { frames.push(JSON.parse(JSON.stringify(m))); };
    ctx.saveSingleTopic({
      id: "t-stop-with-close", name: "stop", slug: "stop", parentId: null, links: [], sessionKey: sk,
      color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "openai",
    } as Topic);
    const provider = {
      name: "fake-stream", capabilities: new Set(["streaming"]), contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: () => {}, unregisterStreamHandler: () => {},
      sendChat: () => new Promise(() => {}),
      defaultModel: () => "fake-model", abort: async () => {}, start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;
    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider, detectLocalhostAutoNav: () => {}, bindTopicToProject: () => {},
      resolveProjectRef: () => null, getProjectIdForTopic: () => null, getWorkspaceProjects: () => [],
      autoBindProject: () => {}, watchSessionForSubagents: () => {}, updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(), WORKSPACE_DIR: testTmpDir("turn-stop-said-with-close-ws"),
    } as never);
    const topicsRouter = createTopicsRouter(ctx);

    const chatUrl = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(new Request(chatUrl.toString(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: sk, messages: [{ role: "user", content: "long job" }] }),
    }), chatUrl, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    resp?.body?.cancel().catch(() => {});
    expect(ctx.turnLedger!.isOpen(sk)).toBe(true);

    const cut = frames.length;
    const abortUrl = new URL("http://topics.test/api/chat/abort");
    const stopped = await topicsRouter(new Request(abortUrl.toString(), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk }),
    }), abortUrl, "/api/chat/abort", "POST");
    expect(stopped?.status).toBe(200);

    const after = frames.slice(cut).filter((f) => f.sessionKey === sk && (f.type === "turn:state" || f.type === "stream:end"));
    const close = after.findIndex((f) => f.type === "turn:state" && f.open === false);
    const end = after.findIndex((f) => f.type === "stream:end");
    // The order the phone reads them in: the close first.
    expect(close).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(close);
    expect(after[close]).toMatchObject({ open: false, stopped: true });
    expect(after[end]).toMatchObject({ reason: "user_abort" });

    // The next turn on the session starts clean: its end is not a Stop.
    const again = await chatRouter(new Request(chatUrl.toString(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: sk, messages: [{ role: "user", content: "again" }] }),
    }), chatUrl, "/api/chat", "POST");
    expect(again?.status).toBe(200);
    again?.body?.cancel().catch(() => {});
    ctx.endStream(sk);
    expect(ctx.turnLedger!.stateOf(sk).stopped).toBeUndefined();
  });
});
